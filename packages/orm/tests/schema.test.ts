import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineSchema, defineTable, t } from '../src/index';
import type { Infer } from '../src/index';
import { UUIDV7_SQL } from '../src/schema';

// ORM-CONTRACT §1 örneği (birebir)
const schema = defineSchema({
  orgs: defineTable({
    id: t.uuidPk(),
    name: t.text().notNull(),
  }),
  members: defineTable({
    id: t.uuidPk(),
    orgId: t.uuid().notNull().references(() => schema.orgs.id, { onDelete: 'cascade' }),
    email: t.text().notNull(),
    role: t.enum(['yonetici', 'gelistirici', 'okuyucu']).notNull().default('okuyucu'),
    search: t.tsvector(),
    emb: t.vector(1536).nullable(),
  }, (c) => [
    c.unique('email'),
    c.index('members_org_idx').on('orgId'),
    c.check('role_ck', "role in ('yonetici','gelistirici','okuyucu')"),
  ]),
});

test('ddl(): bağımlılık sıralı — extension, uuidv7, referenced önce, FK en son', () => {
  const ddl = schema.ddl();

  // vector kolonu var → extension en başta
  assert.equal(ddl[0], 'CREATE EXTENSION IF NOT EXISTS vector');
  // uuidPk var → uuidv7() üretici ikinci
  assert.equal(ddl[1], UUIDV7_SQL);
  assert.match(ddl[1], /CREATE OR REPLACE FUNCTION uuidv7\(\)/);

  // orgs (referenced) members'tan ÖNCE
  const orgsIdx = ddl.findIndex((s) => s.startsWith('CREATE TABLE "orgs"'));
  const membersIdx = ddl.findIndex((s) => s.startsWith('CREATE TABLE "members"'));
  assert.ok(orgsIdx > 1 && membersIdx > orgsIdx, `sıra bozuk: orgs=${orgsIdx} members=${membersIdx}`);

  // index, CREATE TABLE'lardan sonra
  const idxIdx = ddl.findIndex((s) => s === 'CREATE INDEX "members_org_idx" ON "members" ("orgId")');
  assert.ok(idxIdx > membersIdx);

  // FK EN SON
  const fk = ddl[ddl.length - 1];
  assert.equal(
    fk,
    'ALTER TABLE "members" ADD CONSTRAINT "members_orgId_fk" FOREIGN KEY ("orgId") REFERENCES "orgs" ("id") ON DELETE CASCADE',
  );
  assert.ok(idxIdx < ddl.length - 1);
});

test('ddl(): kolon SQL üretimi — uuidPk, notNull, enum check, default, tipler', () => {
  const ddl = schema.ddl();
  const orgs = ddl.find((s) => s.startsWith('CREATE TABLE "orgs"'))!;
  assert.equal(orgs, 'CREATE TABLE "orgs" (\n  "id" uuid PRIMARY KEY DEFAULT uuidv7(),\n  "name" text NOT NULL\n)');

  const members = ddl.find((s) => s.startsWith('CREATE TABLE "members"'))!;
  assert.equal(
    members,
    'CREATE TABLE "members" (\n' +
      '  "id" uuid PRIMARY KEY DEFAULT uuidv7(),\n' +
      '  "orgId" uuid NOT NULL,\n' +
      '  "email" text NOT NULL,\n' +
      `  "role" text NOT NULL DEFAULT 'okuyucu' CHECK ("role" IN ('yonetici', 'gelistirici', 'okuyucu')),\n` +
      '  "search" tsvector,\n' +
      '  "emb" vector(1536),\n' +
      '  UNIQUE ("email"),\n' +
      `  CONSTRAINT "role_ck" CHECK (role in ('yonetici','gelistirici','okuyucu'))\n` +
      ')',
  );
});

test('ddl(): tüm kolon tipleri + zincirler (unique, default literal, bigint, jsonb, timestamptz)', () => {
  const s = defineSchema({
    everything: defineTable({
      id: t.uuidPk(),
      a: t.text(),
      b: t.integer().notNull().default(42),
      c: t.bigint().default(9007199254740993n),
      d: t.boolean().default(false),
      e: t.timestamptz().notNull(),
      f: t.jsonb().default({ x: 1 }),
      g: t.uuid().unique(),
      h: t.vector(3),
      i: t.tsvector().notNull(),
    }),
  });
  const ddl = s.ddl();
  assert.deepEqual(
    ddl.filter((x) => x !== UUIDV7_SQL && x !== 'CREATE EXTENSION IF NOT EXISTS vector'),
    [
      'CREATE TABLE "everything" (\n' +
        '  "id" uuid PRIMARY KEY DEFAULT uuidv7(),\n' +
        '  "a" text,\n' +
        '  "b" integer NOT NULL DEFAULT 42,\n' +
        '  "c" bigint DEFAULT 9007199254740993,\n' +
        '  "d" boolean DEFAULT FALSE,\n' +
        '  "e" timestamptz NOT NULL,\n' +
        `  "f" jsonb DEFAULT '{"x":1}',\n` +
        '  "g" uuid UNIQUE,\n' +
        '  "h" vector(3),\n' +
        '  "i" tsvector NOT NULL\n' +
        ')',
    ],
  );
  // vector var → extension başta
  assert.equal(ddl[0], 'CREATE EXTENSION IF NOT EXISTS vector');
});

test('ddl(): renamedFrom DDL üretimini etkilemez (yalnız push diff\'inde anlamlı)', () => {
  const s = defineSchema({
    people: defineTable({
      id: t.uuidPk(),
      isim: t.text().notNull().renamedFrom('ad'),
    }),
  });
  const ddl = s.ddl();
  const create = ddl.find((x) => x.startsWith('CREATE TABLE'))!;
  assert.match(create, /"isim" text NOT NULL/);
  assert.ok(!ddl.some((x) => /RENAME/i.test(x)));
});

test('ddl(): döngüsel FK patlamaz — iki CREATE de üretilir, FK\'ler sonda', () => {
  const s = defineSchema({
    a: defineTable({
      id: t.uuidPk(),
      bId: t.uuid().references(() => s.b.id),
    }),
    b: defineTable({
      id: t.uuidPk(),
      aId: t.uuid().references(() => s.a.id),
    }),
  });
  const ddl = s.ddl();
  const creates = ddl.filter((x) => x.startsWith('CREATE TABLE'));
  const fkCount = ddl.filter((x) => x.includes('FOREIGN KEY')).length;
  assert.equal(creates.length, 2);
  assert.equal(fkCount, 2);
  assert.ok(ddl.indexOf(creates[1]) < ddl.findIndex((x) => x.includes('FOREIGN KEY')));
});

test('defineSchema: schema.orgs.id doğrudan erişim + schema.tables eşleniği', () => {
  assert.equal(schema.orgs, schema.tables.orgs);
  assert.equal(schema.orgs.id, schema.tables.orgs.columns.id);
  assert.throws(
    () => defineSchema({ tables: defineTable({ id: t.uuidPk() }) }),
    /ayrılmış/,
  );
});

// ---------------------------------------------------------------- Infer (type-level)

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

type MemberExpected = {
  id: string;
  orgId: string;
  email: string;
  role: 'yonetici' | 'gelistirici' | 'okuyucu';
  search: string | null;
  emb: number[] | null;
};
type _Member = Assert<Equal<Infer<typeof schema.tables.members>, MemberExpected>>;

type OrgExpected = { id: string; name: string };
type _Org = Assert<Equal<Infer<typeof schema.tables.orgs>, OrgExpected>>;

// zincirlerin tip etkisi: varsayılan nullable, notNull daraltır, default nullability'yi değiştirmez
const chainSchema = defineSchema({
  c: defineTable({
    a: t.text(),
    b: t.text().notNull(),
    c: t.text().nullable(),
    d: t.integer().notNull().default(1),
    e: t.bigint(),
    f: t.timestamptz().notNull(),
    g: t.jsonb<{ x: number }>().notNull(),
    h: t.uuidPk(),
    i: t.boolean(),
    j: t.vector(8),
    k: t.tsvector(),
  }),
});
type ChainExpected = {
  a: string | null;
  b: string;
  c: string | null;
  d: number;
  e: bigint | null;
  f: Date;
  g: { x: number };
  h: string;
  i: boolean | null;
  j: number[] | null;
  k: string | null;
};
type _Chain = Assert<Equal<Infer<typeof chainSchema.tables.c>, ChainExpected>>;

test('Infer: type-level assert\'ler typecheck\'te kilitli (tsc --noEmit tests/ dahil)', () => {
  // runtime'da kanıt: derlenen çıktıda tip hatası olsaydı typecheck kırmızı olurdu
  const m: Infer<typeof schema.tables.members> = {
    id: 'x',
    orgId: 'y',
    email: 'e@x',
    role: 'okuyucu',
    search: null,
    emb: [0.1, 0.2],
  };
  assert.equal(m.role, 'okuyucu');
});
