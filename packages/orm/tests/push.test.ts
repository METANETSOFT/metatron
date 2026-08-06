import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineSchema, defineTable, t } from '../src/index';
import { applyPlan, ensurePushLog, LintError, planPush, PUSH_LOG_DDL, schemaHash } from '../src/push';
import type { SqlLike } from '../src/push';
import { UUIDV7_SQL } from '../src/schema';

// ensurePushLog'un çalıştırdığı şema evrimi ALTER'ları (MERGE-CONTRACT §3 — push.ts'te private)
const PUSH_LOG_ALTER_SOURCE = `ALTER TABLE _metatron_push_log ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'push'`;
const PUSH_LOG_ALTER_META = `ALTER TABLE _metatron_push_log ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'`;

// ---------------------------------------------------------------- sahte sql (DI)
// planPush'un information_schema okumasını ve applyPlan'in yazmalarını kaydeder.

interface ColRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}

function colRow(
  table: string,
  column: string,
  dataType: string,
  opts?: { udt?: string; nullable?: boolean; len?: number; def?: string },
): ColRow {
  return {
    table_name: table,
    column_name: column,
    data_type: dataType,
    udt_name: opts?.udt ?? dataType,
    is_nullable: opts?.nullable === false ? 'NO' : 'YES',
    column_default: opts?.def ?? null,
    character_maximum_length: opts?.len ?? null,
  };
}

interface FakeState {
  tables: string[];
  columns: ColRow[];
  /** push_log son hash'i; undefined/'no-table' → tablo yok hatası; null → boş log; string → hash */
  lastHash?: string | null | 'no-table';
}

interface FakeSql extends SqlLike {
  calls: { query: string; values: unknown[] }[];
  unsafeCalls: string[];
}

function fakeSql(state: FakeState): FakeSql {
  const calls: { query: string; values: unknown[] }[] = [];
  const unsafeCalls: string[] = [];
  const tag = (async <T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> => {
    const query = strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, '');
    calls.push({ query, values });
    if (/FROM information_schema\.tables/.test(query)) {
      return state.tables.map((table_name) => ({ table_name })) as T[];
    }
    if (/FROM information_schema\.columns/.test(query)) {
      return state.columns as T[];
    }
    if (/SELECT schema_hash FROM _metatron_push_log/.test(query)) {
      if (state.lastHash === undefined || state.lastHash === 'no-table') {
        throw Object.assign(new Error('relation "_metatron_push_log" does not exist'), { code: '42P01' });
      }
      return (state.lastHash === null ? [] : [{ schema_hash: state.lastHash }]) as T[];
    }
    if (/INSERT INTO _metatron_push_log/.test(query)) {
      return [] as T[];
    }
    throw new Error(`beklenmeyen sorgu: ${query}`);
  }) as FakeSql;
  tag.calls = calls;
  tag.unsafeCalls = unsafeCalls;
  tag.unsafe = async (query: string) => {
    unsafeCalls.push(query);
    return [];
  };
  tag.json = (v: unknown) => JSON.stringify(v);
  return tag;
}

// ---------------------------------------------------------------- fixture şemalar

const fullSchema = defineSchema({
  orgs: defineTable({
    id: t.uuidPk(),
    name: t.text().notNull(),
  }),
  members: defineTable({
    id: t.uuidPk(),
    orgId: t.uuid().notNull().references(() => fullSchema.orgs.id, { onDelete: 'cascade' }),
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

/** fullSchema'nın live'da kurulu halini taklit eden information_schema satırları */
function fullLive(): FakeState {
  return {
    tables: ['orgs', 'members', '_metatron_push_log'],
    columns: [
      colRow('orgs', 'id', 'uuid', { nullable: false, def: 'uuidv7()' }),
      colRow('orgs', 'name', 'text', { nullable: false }),
      colRow('members', 'id', 'uuid', { nullable: false, def: 'uuidv7()' }),
      colRow('members', 'orgId', 'uuid', { nullable: false }),
      colRow('members', 'email', 'text', { nullable: false }),
      colRow('members', 'role', 'text', { nullable: false, def: `'okuyucu'::text` }),
      colRow('members', 'search', 'tsvector'),
      colRow('members', 'emb', 'USER-DEFINED', { udt: 'vector' }),
    ],
    lastHash: null,
  };
}

function silenceWarn(tc: import('node:test').TestContext): void {
  const orig = console.warn;
  console.warn = () => {};
  tc.after(() => {
    console.warn = orig;
  });
}

// ---------------------------------------------------------------- planPush

test('planPush: boş DB → tüm tablolar, bağımlılık sıralı, FK en son, lint yok', async () => {
  const sql = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  const plan = await planPush(sql, fullSchema);

  assert.equal(plan.lint.length, 0);
  assert.equal(plan.stmts[0], 'CREATE EXTENSION IF NOT EXISTS vector');
  assert.equal(plan.stmts[1], UUIDV7_SQL);
  const orgsIdx = plan.stmts.findIndex((s) => s.startsWith('CREATE TABLE "orgs"'));
  const membersIdx = plan.stmts.findIndex((s) => s.startsWith('CREATE TABLE "members"'));
  assert.ok(orgsIdx === 2 && membersIdx === 3, `sıra: ${JSON.stringify(plan.stmts)}`);
  assert.ok(plan.stmts.includes('CREATE INDEX "members_org_idx" ON "members" ("orgId")'));
  const fk = plan.stmts[plan.stmts.length - 1];
  assert.match(fk, /^ALTER TABLE "members" ADD CONSTRAINT "members_orgId_fk" FOREIGN KEY/);
  assert.match(plan.schemaHash, /^[0-9a-f]{16}$/);
});

test('planPush: idempotent — push_log son hash aynıysa stmts=[] (information_schema okunmaz)', async () => {
  const first = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  const plan = await planPush(first, fullSchema);

  const again = fakeSql({ tables: [], columns: [], lastHash: plan.schemaHash });
  const plan2 = await planPush(again, fullSchema);
  assert.deepEqual(plan2.stmts, []);
  assert.deepEqual(plan2.lint, []);
  assert.equal(plan2.schemaHash, plan.schemaHash);
  // kısa devre: information_schema sorgusu atılmadı
  assert.equal(again.calls.length, 1);
  assert.match(again.calls[0].query, /_metatron_push_log/);
});

test('planPush: push_log yok ama live şema tam → diff boş, stmts=[]', async () => {
  const sql = fakeSql(fullLive());
  const plan = await planPush(sql, fullSchema);
  assert.deepEqual(plan.stmts, []);
  assert.deepEqual(plan.lint, []);
});

test('planPush: kolon ekleme → ADD COLUMN (enum CHECK + default ile), FK/constraint sızıntısı yok', async () => {
  const live = fullLive();
  live.columns = live.columns.filter((c) => !(c.table_name === 'members' && c.column_name === 'role'));
  const sql = fakeSql(live);
  const plan = await planPush(sql, fullSchema);

  assert.equal(plan.stmts.length, 1);
  assert.equal(
    plan.stmts[0],
    `ALTER TABLE "members" ADD COLUMN "role" text NOT NULL DEFAULT 'okuyucu' CHECK ("role" IN ('yonetici', 'gelistirici', 'okuyucu'))`,
  );
  assert.equal(plan.lint.length, 0);
});

test('planPush: vector kolonu eklenince CREATE EXTENSION plan başında', async () => {
  const live = fullLive();
  live.columns = live.columns.filter((c) => !(c.table_name === 'members' && c.column_name === 'emb'));
  const sql = fakeSql(live);
  const plan = await planPush(sql, fullSchema);

  assert.equal(plan.stmts[0], 'CREATE EXTENSION IF NOT EXISTS vector');
  assert.equal(plan.stmts[1], 'ALTER TABLE "members" ADD COLUMN "emb" vector(1536)');
  assert.equal(plan.stmts.length, 2);
});

test('planPush: DROP COLUMN → stmt + destructive lint', async () => {
  const live = fullLive();
  live.columns.push(colRow('members', 'legacy', 'text'));
  const sql = fakeSql(live);
  const plan = await planPush(sql, fullSchema);

  assert.deepEqual(plan.stmts, ['ALTER TABLE "members" DROP COLUMN "legacy"']);
  assert.deepEqual(plan.lint, [
    { kind: 'destructive', table: 'members', detail: 'DROP COLUMN members.legacy — veri silinir' },
  ]);
});

test('planPush: DROP TABLE → stmt + destructive lint; _metatron_push_log asla düşmez', async () => {
  const live = fullLive();
  live.tables.push('old_stuff');
  live.columns.push(colRow('old_stuff', 'x', 'integer'));
  const sql = fakeSql(live);
  const plan = await planPush(sql, fullSchema);

  assert.deepEqual(plan.stmts, ['DROP TABLE "old_stuff"']);
  assert.deepEqual(plan.lint, [
    { kind: 'destructive', table: 'old_stuff', detail: 'DROP TABLE old_stuff — tüm veri silinir' },
  ]);
});

test('planPush: numerik PK → numeric-pk lint (ORM-CONTRACT §6); uuidPk sessiz', async () => {
  const numericSchema = defineSchema({
    counters: defineTable({ id: t.bigint().pk(), name: t.text() }),
  });
  const sql = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  const plan = await planPush(sql, numericSchema);
  assert.equal(plan.lint.length, 1);
  assert.equal(plan.lint[0].kind, 'numeric-pk');
  assert.equal(plan.lint[0].table, 'counters');
  assert.match(plan.lint[0].detail, /23505/);
  assert.match(plan.lint[0].detail, /uuidPk/);

  // uuidPk lint ÜRETMEZ (kilitli kararın varsayılanı sessiz kalmalı)
  const uuidSchema = defineSchema({ things: defineTable({ id: t.uuidPk(), name: t.text() }) });
  const sql2 = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  const plan2 = await planPush(sql2, uuidSchema);
  assert.equal(plan2.lint.filter((l) => l.kind === 'numeric-pk').length, 0);
});

test('planPush: renamedFrom → RENAME COLUMN (drop+add YOK, lint YOK)', async () => {
  const s = defineSchema({
    people: defineTable({
      id: t.uuidPk(),
      isim: t.text().notNull().renamedFrom('ad'),
    }),
  });
  const live: FakeState = {
    tables: ['people'],
    columns: [colRow('people', 'id', 'uuid', { nullable: false }), colRow('people', 'ad', 'text', { nullable: false })],
    lastHash: null,
  };
  const plan = await planPush(fakeSql(live), s);

  assert.deepEqual(plan.stmts, ['ALTER TABLE "people" RENAME COLUMN "ad" TO "isim"']);
  assert.equal(plan.lint.length, 0);
});

test('planPush: rename şüphesi — aynı tabloda drop+add, benzer tip → lint', async () => {
  const s = defineSchema({
    people: defineTable({
      id: t.uuidPk(),
      isim: t.text(), // renamedFrom YOK
    }),
  });
  const live: FakeState = {
    tables: ['people'],
    columns: [colRow('people', 'id', 'uuid', { nullable: false }), colRow('people', 'ad', 'text')],
    lastHash: null,
  };
  const plan = await planPush(fakeSql(live), s);

  // drop+add üretilir ama rename-suspect lint'i eşlik eder
  assert.deepEqual(plan.stmts, [
    'ALTER TABLE "people" ADD COLUMN "isim" text',
    'ALTER TABLE "people" DROP COLUMN "ad"',
  ]);
  assert.equal(plan.lint.length, 2);
  const kinds = plan.lint.map((l) => l.kind).sort();
  assert.deepEqual(kinds, ['destructive', 'rename-suspect']);
  assert.match(plan.lint.find((l) => l.kind === 'rename-suspect')!.detail, /rename şüphesi people\.ad→isim/);
});

test('planPush: widening int→bigint ve varchar(n)→text otomatik ALTER TYPE', async () => {
  const s = defineSchema({
    t1: defineTable({
      id: t.uuidPk(),
      n: t.bigint(),
      m: t.text(),
    }),
  });
  const live: FakeState = {
    tables: ['t1'],
    columns: [
      colRow('t1', 'id', 'uuid', { nullable: false }),
      colRow('t1', 'n', 'integer'),
      colRow('t1', 'm', 'character varying', { len: 50 }),
    ],
    lastHash: null,
  };
  const plan = await planPush(fakeSql(live), s);

  assert.deepEqual(plan.stmts, [
    'ALTER TABLE "t1" ALTER COLUMN "n" TYPE bigint',
    'ALTER TABLE "t1" ALTER COLUMN "m" TYPE text',
  ]);
  assert.equal(plan.lint.length, 0);
});

test('planPush: narrowing bigint→integer → lint, ALTER TYPE üretilmez', async () => {
  const s = defineSchema({
    t1: defineTable({
      id: t.uuidPk(),
      n: t.integer(),
    }),
  });
  const live: FakeState = {
    tables: ['t1'],
    columns: [colRow('t1', 'id', 'uuid', { nullable: false }), colRow('t1', 'n', 'bigint')],
    lastHash: null,
  };
  const plan = await planPush(fakeSql(live), s);

  assert.deepEqual(plan.stmts, []);
  assert.deepEqual(plan.lint, [
    { kind: 'narrowing', table: 't1', detail: 'daralan tip t1.n: bigint → integer — otomatik uygulanmaz' },
  ]);
});

test('planPush: mevcut tabloya FK\'lı kolon → fk-risk lint + FK en sonda', async () => {
  const s = defineSchema({
    orgs: fullSchema.tables.orgs,
    members: defineTable({
      id: t.uuidPk(),
      orgId: t.uuid().notNull().references(() => s.orgs.id, { onDelete: 'cascade' }),
    }),
  });
  const live: FakeState = {
    tables: ['orgs', 'members'],
    columns: [
      colRow('orgs', 'id', 'uuid', { nullable: false }),
      colRow('orgs', 'name', 'text', { nullable: false }),
      colRow('members', 'id', 'uuid', { nullable: false }),
    ],
    lastHash: null,
  };
  const plan = await planPush(fakeSql(live), s);

  assert.deepEqual(plan.stmts, [
    'ALTER TABLE "members" ADD COLUMN "orgId" uuid NOT NULL',
    'ALTER TABLE "members" ADD CONSTRAINT "members_orgId_fk" FOREIGN KEY ("orgId") REFERENCES "orgs" ("id") ON DELETE CASCADE',
  ]);
  assert.deepEqual(plan.lint, [
    {
      kind: 'fk-risk',
      table: 'members',
      detail: 'yeni FK members.orgId → orgs.id — mevcut satırlar kısıtı ihlal edebilir',
    },
  ]);
});

test('planPush: FK sırası — yeni tablolar topo, tüm FK\'lar tüm CREATE/ALTER\'lardan sonra', async () => {
  const s = defineSchema({
    comments: defineTable({
      id: t.uuidPk(),
      postId: t.uuid().notNull().references(() => s.posts.id),
    }),
    posts: defineTable({
      id: t.uuidPk(),
      orgId: t.uuid().notNull().references(() => s.orgs.id),
    }),
    orgs: defineTable({
      id: t.uuidPk(),
    }),
  });
  const plan = await planPush(fakeSql({ tables: [], columns: [], lastHash: 'no-table' }), s);

  const body = plan.stmts.filter((x) => x !== UUIDV7_SQL);
  const createIdx = body.map((x, i) => (x.startsWith('CREATE TABLE') ? i : -1)).filter((i) => i >= 0);
  const fkIdx = body.map((x, i) => (x.includes('FOREIGN KEY') ? i : -1)).filter((i) => i >= 0);
  assert.equal(createIdx.length, 3);
  assert.equal(fkIdx.length, 2);
  assert.ok(Math.max(...createIdx) < Math.min(...fkIdx), 'FK\'lar en sonda olmalı');
  // orgs önce, posts, comments (bağımlılık sırası)
  assert.ok(body[createIdx[0]].includes('"orgs"'));
  assert.ok(body[createIdx[1]].includes('"posts"'));
  assert.ok(body[createIdx[2]].includes('"comments"'));
});

// ---------------------------------------------------------------- external tablolar (R1=b)

// Better Auth'ın text-PK'lı 4 tablosu — ORMIM yönetmez (foxapp göç haritası §6 R1=b).
const BA_TABLES = ['user', 'session', 'account', 'verification'] as const;

function baLiveColumns(): ColRow[] {
  return [
    colRow('user', 'id', 'text', { nullable: false }),
    colRow('user', 'email', 'text', { nullable: false }),
    colRow('session', 'id', 'text', { nullable: false }),
    colRow('session', 'userId', 'text', { nullable: false }),
    colRow('session', 'expiresAt', 'timestamp with time zone', { nullable: false }),
    colRow('account', 'id', 'text', { nullable: false }),
    colRow('account', 'providerId', 'text', { nullable: false }),
    colRow('verification', 'id', 'text', { nullable: false }),
    colRow('verification', 'identifier', 'text', { nullable: false }),
  ];
}

/** orgs (kurulu) + 4 BA tablosu live'da duruyor */
function orgsPlusBaLive(): FakeState {
  return {
    tables: ['orgs', ...BA_TABLES],
    columns: [
      colRow('orgs', 'id', 'uuid', { nullable: false, def: 'uuidv7()' }),
      colRow('orgs', 'name', 'text', { nullable: false }),
      ...baLiveColumns(),
    ],
    lastHash: null,
  };
}

test('planPush: external beyanlı → live\'daki BA tabloları için DROP/lint YOK; yoksa CREATE de yok', async () => {
  const s = defineSchema({ orgs: fullSchema.tables.orgs }, { external: [...BA_TABLES] });

  const plan = await planPush(fakeSql(orgsPlusBaLive()), s);
  assert.deepEqual(plan.stmts, []);
  assert.deepEqual(plan.lint, []);

  // external listede ama live'da YOK → CREATE de planlanmaz (diff'ten tamamen dışarıda)
  const noBa: FakeState = {
    tables: ['orgs'],
    columns: [
      colRow('orgs', 'id', 'uuid', { nullable: false, def: 'uuidv7()' }),
      colRow('orgs', 'name', 'text', { nullable: false }),
    ],
    lastHash: null,
  };
  const plan2 = await planPush(fakeSql(noBa), s);
  assert.deepEqual(plan2.stmts, []);
  assert.deepEqual(plan2.lint, []);
});

test('planPush: kontrast — external BEYANSIZ aynı live → 4 BA tablosu DROP + destructive lint (mevcut davranış)', async () => {
  const s = defineSchema({ orgs: fullSchema.tables.orgs }); // external YOK
  const plan = await planPush(fakeSql(orgsPlusBaLive()), s);

  assert.deepEqual(plan.stmts, [
    'DROP TABLE "user"',
    'DROP TABLE "session"',
    'DROP TABLE "account"',
    'DROP TABLE "verification"',
  ]);
  assert.deepEqual(
    plan.lint,
    BA_TABLES.map((n) => ({
      kind: 'destructive',
      table: n,
      detail: `DROP TABLE ${n} — tüm veri silinir`,
    })),
  );
});

test('planPush: external adı şema tablosuyla çakışırsa hata fırlatır (açık çelişki, sessizlik yok)', async () => {
  const s = defineSchema(
    { user: defineTable({ id: t.uuidPk() }) },
    { external: ['user'] },
  );
  const sql = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  await assert.rejects(planPush(sql, s), /'user' hem şema tablosu hem external/);
  // çakışma live okunmadan önce yakalanır — hiçbir sorgu atılmadı
  assert.equal(sql.calls.length, 0);
});

test('schemaHash: external listesi hash\'e dahil — değişince hash değişir; boşken eski hash korunur', () => {
  const tables = { orgs: fullSchema.tables.orgs };
  const base = schemaHash(defineSchema(tables));
  const iki = schemaHash(defineSchema(tables, { external: ['user', 'session'] }));
  const tek = schemaHash(defineSchema(tables, { external: ['user'] }));

  assert.notEqual(iki, base); // beyan eklemek davranış değişikliği → hash değişir
  assert.notEqual(iki, tek); // listeden çıkarma da hash değiştirir
  // küme semantiği: aynı listenin sırası hash'i değiştirmez
  assert.equal(schemaHash(defineSchema(tables, { external: ['session', 'user'] })), iki);
  // boş liste = beyansız: external'sız şemaların mevcut hash formatı korunur
  assert.equal(schemaHash(defineSchema(tables, { external: [] })), base);
});

test('planPush: foxapp senaryosu — 26 uygulama tablosu + 4 BA external; live\'da hepsi varken stmts=[]', async () => {
  const appNames = Array.from({ length: 26 }, (_, i) => `app_t${String(i + 1).padStart(2, '0')}`);
  const appTables = Object.fromEntries(
    appNames.map((n) => [n, defineTable({ id: t.uuidPk(), name: t.text().notNull() })]),
  );
  const s = defineSchema(appTables, { external: [...BA_TABLES] });
  const live: FakeState = {
    tables: [...appNames, ...BA_TABLES, '_metatron_push_log'],
    columns: [
      ...appNames.flatMap((n) => [
        colRow(n, 'id', 'uuid', { nullable: false, def: 'uuidv7()' }),
        colRow(n, 'name', 'text', { nullable: false }),
      ]),
      ...baLiveColumns(),
    ],
    lastHash: null,
  };
  const plan = await planPush(fakeSql(live), s);
  assert.deepEqual(plan.stmts, []);
  assert.deepEqual(plan.lint, []);
});

// ---------------------------------------------------------------- applyPlan

test('ensurePushLog: push_log DDL + §3 iki ALTER sırayla', async () => {
  const sql = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  await ensurePushLog(sql);
  assert.deepEqual(sql.unsafeCalls, [PUSH_LOG_DDL, PUSH_LOG_ALTER_SOURCE, PUSH_LOG_ALTER_META]);
});

test('applyPlan: onLint=log → ensurePushLog + stmts sırayla + INSERT satırı (source=push)', async (tc) => {
  silenceWarn(tc);
  const sql = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  const plan = {
    stmts: ['CREATE TABLE "x" (id uuid)', 'CREATE INDEX "x_i" ON "x" (id)'],
    lint: [{ kind: 'destructive' as const, table: 'x', detail: 'DROP TABLE x — tüm veri silinir' }],
    schemaHash: 'abc123',
  };
  await applyPlan(sql, plan, { onLint: 'log' });

  assert.deepEqual(sql.unsafeCalls, [
    PUSH_LOG_DDL,
    PUSH_LOG_ALTER_SOURCE,
    PUSH_LOG_ALTER_META,
    'CREATE TABLE "x" (id uuid)',
    'CREATE INDEX "x_i" ON "x" (id)',
  ]);
  const insert = sql.calls.find((c) => /INSERT INTO _metatron_push_log/.test(c.query))!;
  assert.equal(insert.values[0], 'abc123');
  assert.deepEqual(JSON.parse(insert.values[1] as string), plan.stmts);
  assert.deepEqual(JSON.parse(insert.values[2] as string), plan.lint);
  assert.equal(insert.values[3], 'push'); // source
  assert.deepEqual(JSON.parse(insert.values[4] as string), {}); // meta='{}'
});

test('applyPlan: onLint=fail → lint varken LintError, hiçbir stmt çalışmaz', async () => {
  const sql = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  const plan = {
    stmts: ['DROP TABLE "x"'],
    lint: [{ kind: 'destructive' as const, table: 'x', detail: 'DROP TABLE x — tüm veri silinir' }],
    schemaHash: 'abc123',
  };
  await assert.rejects(applyPlan(sql, plan, { onLint: 'fail' }), (err: unknown) => {
    assert.ok(err instanceof LintError);
    assert.equal(err.lint.length, 1);
    assert.match(err.message, /DROP TABLE x/);
    return true;
  });
  assert.equal(sql.unsafeCalls.length, 0);
  assert.equal(sql.calls.length, 0);
});

test('applyPlan: lint yoksa fail modu da uygular', async () => {
  const sql = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  const plan = { stmts: ['CREATE TABLE "y" (id uuid)'], lint: [], schemaHash: 'h' };
  await applyPlan(sql, plan, { onLint: 'fail' });
  assert.deepEqual(sql.unsafeCalls, [PUSH_LOG_DDL, PUSH_LOG_ALTER_SOURCE, PUSH_LOG_ALTER_META, 'CREATE TABLE "y" (id uuid)']);
});

test('uçtan uca (sahte): planPush → applyPlan → aynı hash\'le planPush → stmts=[]', async (tc) => {
  silenceWarn(tc);
  // 1) boş DB'ye ilk plan
  const db1 = fakeSql({ tables: [], columns: [], lastHash: 'no-table' });
  const plan1 = await planPush(db1, fullSchema);
  assert.ok(plan1.stmts.length > 0);

  // 2) uygula — push_log INSERT'i hash'i taşır
  await applyPlan(db1, plan1, { onLint: 'log' });
  const insert = db1.calls.find((c) => /INSERT INTO _metatron_push_log/.test(c.query))!;
  assert.equal(insert.values[0], plan1.schemaHash);

  // 3) ikinci tur: live şema kurulu + push_log hash'i aynı → boş plan
  const db2 = fakeSql({ ...fullLive(), lastHash: plan1.schemaHash });
  const plan2 = await planPush(db2, fullSchema);
  assert.deepEqual(plan2.stmts, []);
  assert.deepEqual(plan2.lint, []);
});
