import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyMergeUp,
  MergeApprovalError,
  MergeConflictError,
  MergeError,
  planMergeUp,
} from '../src/merge';
import type { TxCapable } from '../src/merge';
import { PUSH_LOG_DDL } from '../src/push';
import type { SqlLike } from '../src/push';

// ensurePushLog'un çalıştırdığı şema evrimi ALTER'ları (MERGE-CONTRACT §3 — push.ts'te private)
const PUSH_LOG_ALTER_SOURCE = `ALTER TABLE _metatron_push_log ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'push'`;
const PUSH_LOG_ALTER_META = `ALTER TABLE _metatron_push_log ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'`;

// ---------------------------------------------------------------- sahte sql (DI)
// Log-merkezli: push_log satırlarını durumda tutar; begin tek bağlantı taklidi
// (callback'ten fırlatılan sentinel/hata propagate edilir — rollback kaydı tutulmaz).

interface LogRow {
  seq: number;
  schema_hash: string;
  stmts: string[];
  lint: { kind?: string; table?: string; detail?: string }[];
}

interface FakeState {
  /** 'no-table' → SELECT 42P01 fırlatır (push_log henüz kurulmamış) */
  log: LogRow[] | 'no-table';
  /** eşleşen unsafe sorguda sahte PG hatası fırlat (dry-run sınıflandırma testleri) */
  failOnUnsafe?: { match: RegExp; err: { code: string; message: string; table_name?: string; column_name?: string } };
}

interface FakeSql extends TxCapable {
  calls: { query: string; values: unknown[] }[];
  unsafeCalls: string[];
  beginCalls: number;
  state: FakeState;
}

function logRow(seq: number, schemaHash: string, stmts: string[], lint: LogRow['lint'] = []): LogRow {
  return { seq, schema_hash: schemaHash, stmts, lint };
}

function fakeSql(state: FakeState): FakeSql {
  const calls: { query: string; values: unknown[] }[] = [];
  const unsafeCalls: string[] = [];
  const tag = (async <T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> => {
    const query = strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, '');
    calls.push({ query, values });
    if (/SELECT seq, schema_hash, stmts, lint FROM _metatron_push_log/.test(query)) {
      if (state.log === 'no-table') {
        throw Object.assign(new Error('relation "_metatron_push_log" does not exist'), { code: '42P01' });
      }
      return state.log as T[];
    }
    if (/INSERT INTO _metatron_push_log/.test(query)) {
      if (state.log === 'no-table') throw new Error('no-table durumunda INSERT beklenmez');
      const rows = state.log as LogRow[];
      const seq = rows.length + 1;
      rows.push({
        seq,
        schema_hash: values[0] as string,
        stmts: JSON.parse(values[1] as string),
        lint: JSON.parse(values[2] as string),
      });
      return (/RETURNING seq/.test(query) ? [{ seq }] : []) as T[];
    }
    throw new Error(`beklenmeyen sorgu: ${query}`);
  }) as FakeSql;
  tag.calls = calls;
  tag.unsafeCalls = unsafeCalls;
  tag.beginCalls = 0;
  tag.state = state;
  tag.unsafe = async (query: string) => {
    unsafeCalls.push(query);
    const f = state.failOnUnsafe;
    if (f && f.match.test(query)) {
      throw Object.assign(new Error(f.err.message), {
        code: f.err.code,
        table_name: f.err.table_name,
        column_name: f.err.column_name,
      });
    }
    return [];
  };
  tag.begin = async <T>(fn: (tx: SqlLike) => Promise<T>): Promise<T> => {
    tag.beginCalls++;
    return fn(tag); // tek bağlantı taklidi
  };
  tag.json = (v: unknown) => JSON.stringify(v);
  return tag;
}

/** merge girdisinin INSERT'ini ve değerlerini bulur */
function mergeInsert(sql: FakeSql): { query: string; values: unknown[] } {
  return sql.calls.find((c) => /INSERT INTO _metatron_push_log/.test(c.query))!;
}

// ---------------------------------------------------------------- ata / delta

test('ata/delta: (seq,hash) çiftiyle ortak önek — aynı seq farklı hash öneki keser, sıra korunur', async () => {
  const main = fakeSql({
    log: [
      logRow(1, 'h1', ['CREATE TABLE "a" (\n  "id" uuid PRIMARY KEY\n)']),
      logRow(2, 'h2m', ['ALTER TABLE "a" ADD COLUMN "b" text']),
    ],
  });
  const branch = fakeSql({
    log: [
      logRow(1, 'h1', ['CREATE TABLE "a" (\n  "id" uuid PRIMARY KEY\n)']),
      logRow(2, 'h2d', ['ALTER TABLE "a" ADD COLUMN "x" text']), // aynı seq, FARKLI hash → önek burada biter
      logRow(3, 'h3d', ['ALTER TABLE "a" ADD COLUMN "y" text', 'ALTER TABLE "a" ADD COLUMN "z" text']),
    ],
  });
  const plan = await planMergeUp(main, branch);

  assert.equal(plan.ancestorSeq, 1);
  assert.deepEqual(plan.deltaSeqs, [2, 3]);
  // girdi sırası + girdi içi stmt sırası korunur (düz birleşim)
  assert.deepEqual(plan.stmts, [
    'ALTER TABLE "a" ADD COLUMN "x" text',
    'ALTER TABLE "a" ADD COLUMN "y" text',
    'ALTER TABLE "a" ADD COLUMN "z" text',
  ]);
  assert.equal(plan.mainHash, 'h2m');
  assert.equal(plan.branchHash, 'h3d');
  assert.match(plan.planDigest, /^[0-9a-f]{16}$/);
  assert.deepEqual(plan.conflicts, []); // temiz delta: statik yok, dry-run (sahte) hatasız
  assert.equal(main.beginCalls, 1); // dry-run koştu (her zaman)
});

test('ata/delta: loglar aynıysa delta boş → plan no-op (dry-run bile koşmaz)', async () => {
  const rows = [logRow(1, 'h1', ['CREATE TABLE "a" (id uuid)']), logRow(2, 'h2', ['ALTER TABLE "a" ADD COLUMN "b" text'])];
  const main = fakeSql({ log: [...rows] });
  const branch = fakeSql({ log: [...rows] });
  const plan = await planMergeUp(main, branch);

  assert.equal(plan.ancestorSeq, 2);
  assert.deepEqual(plan.deltaSeqs, []);
  assert.deepEqual(plan.stmts, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(main.beginCalls, 0);
});

test('ata/delta: boş main logu → ata "boş önek", delta = dalın tüm logu; tablo yoksa (42P01) da boş sayılır', async () => {
  for (const empty of [[] as LogRow[], 'no-table' as const]) {
    const main = fakeSql({ log: empty });
    const branch = fakeSql({
      log: [logRow(1, 'h1', ['CREATE TABLE "a" (id uuid)']), logRow(2, 'h2', ['ALTER TABLE "a" ADD COLUMN "x" text'])],
    });
    const plan = await planMergeUp(main, branch);

    assert.equal(plan.ancestorSeq, null);
    assert.deepEqual(plan.deltaSeqs, [1, 2]);
    assert.equal(plan.mainHash, 'empty');
    assert.equal(plan.branchHash, 'h2');
    assert.deepEqual(plan.conflicts, []);
  }
});

test("ata/delta: main dolu + ortak önek yok → MergeError('no-common-ancestor')", async () => {
  const main = fakeSql({ log: [logRow(1, 'hX', ['CREATE TABLE "a" (id uuid)'])] });
  const branch = fakeSql({ log: [logRow(1, 'hY', ['CREATE TABLE "b" (id uuid)'])] });

  await assert.rejects(planMergeUp(main, branch), (err: unknown) => {
    assert.ok(err instanceof MergeError);
    assert.equal(err.code, 'no-common-ancestor');
    return true;
  });
});

// ---------------------------------------------------------------- statik kontroller

test('statik: delta DROP TABLE + mainMoved aynı tabloya ADD COLUMN → drop-changed-in-main (dry-run temiz kalsa da)', async () => {
  const main = fakeSql({
    log: [
      logRow(1, 'h1', ['CREATE TABLE "t" (id uuid)']),
      logRow(2, 'h2m', ['ALTER TABLE "t" ADD COLUMN "yeni" text']),
    ],
  });
  const branch = fakeSql({
    log: [logRow(1, 'h1', ['CREATE TABLE "t" (id uuid)']), logRow(2, 'h2d', ['DROP TABLE "t"'])],
  });
  const plan = await planMergeUp(main, branch);

  assert.equal(plan.conflicts.length, 1); // yalnız statik — sahte dry-run hatasız
  const c = plan.conflicts[0];
  assert.equal(c.class, 'schema');
  assert.equal(c.code, 'static');
  assert.equal(c.object, 't');
  assert.match(c.detail, /main'de ata sonrası değişti/);
  assert.deepEqual(c.options, ['dalı güncel main\'e rebase et', 'main\'deki değişikliği önce geri al']);
});

test('statik: delta DROP COLUMN nesne kesişimi — main aynı tabloya dokunduysa çatışma, başka tabloysa yok', async () => {
  const branchLog = [
    logRow(1, 'h1', ['CREATE TABLE "t" (id uuid)', 'CREATE TABLE "u" (id uuid)']),
    logRow(2, 'h2d', ['ALTER TABLE "t" DROP COLUMN "c"']),
  ];
  // main "t"ye dokunmuş → çatışma (object t.c)
  const dokunmus = fakeSql({
    log: [
      logRow(1, 'h1', ['CREATE TABLE "t" (id uuid)', 'CREATE TABLE "u" (id uuid)']),
      logRow(2, 'h2m', ['ALTER TABLE "t" ADD COLUMN "d" text']),
    ],
  });
  const plan1 = await planMergeUp(dokunmus, fakeSql({ log: branchLog.map((r) => ({ ...r })) }));
  assert.equal(plan1.conflicts.length, 1);
  assert.equal(plan1.conflicts[0].code, 'static');
  assert.equal(plan1.conflicts[0].object, 't.c');

  // main yalnız "u"ya dokunmuş → statik çatışma yok
  const dokunmamis = fakeSql({
    log: [
      logRow(1, 'h1', ['CREATE TABLE "t" (id uuid)', 'CREATE TABLE "u" (id uuid)']),
      logRow(2, 'h2m', ['ALTER TABLE "u" ADD COLUMN "d" text']),
    ],
  });
  const plan2 = await planMergeUp(dokunmamis, fakeSql({ log: branchLog.map((r) => ({ ...r })) }));
  assert.deepEqual(plan2.conflicts, []);
});

test('statik: aynı tabloda DROP COLUMN + ADD COLUMN çifti → rename-suspect (lint jsonb olmasa da)', async () => {
  const main = fakeSql({ log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid, ad text)'])] });
  const branch = fakeSql({
    log: [
      logRow(1, 'h1', ['CREATE TABLE "people" (id uuid, ad text)']),
      logRow(2, 'h2d', ['ALTER TABLE "people" ADD COLUMN "isim" text', 'ALTER TABLE "people" DROP COLUMN "ad"']),
    ],
  });
  const plan = await planMergeUp(main, branch);

  assert.equal(plan.conflicts.length, 1);
  const c = plan.conflicts[0];
  assert.equal(c.class, 'schema');
  assert.equal(c.code, 'static');
  assert.equal(c.object, 'people');
  assert.match(c.detail, /rename şüphesi/);
  assert.match(c.options[0], /\.renamedFrom\('ad'\)/);
});

test("statik: rename-suspect lint jsonb'den — stmt parse edilemese bile (parse edilemeyen sessizce dry-run'a bırakılır)", async () => {
  const main = fakeSql({ log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid, ad text)'])] });
  const branch = fakeSql({
    log: [
      logRow(1, 'h1', ['CREATE TABLE "people" (id uuid, ad text)']),
      logRow(2, 'h2d', ['/* elle yazılmış, kalıba uymayan stmt */'], [
        {
          kind: 'rename-suspect',
          table: 'people',
          detail: "rename şüphesi people.ad→isim (text) — kasıtlıysa .renamedFrom('ad') kullanın",
        },
      ]),
      logRow(3, 'h3d', ['ALTER TABLE "people" ADD COLUMN "extra" text'], [
        { kind: 'destructive', table: 'people', detail: 'DROP COLUMN people.extra — veri silinir' }, // rename-suspect DEĞİL
      ]),
    ],
  });
  const plan = await planMergeUp(main, branch);

  assert.equal(plan.conflicts.length, 1); // destructive lint çatışma üretmez, dry-run (sahte) temiz
  const c = plan.conflicts[0];
  assert.equal(c.code, 'static');
  assert.equal(c.class, 'schema');
  assert.equal(c.object, 'people');
  assert.match(c.detail, /rename şüphesi/);
  assert.match(c.options[0], /\.renamedFrom\('ad'\)/);
});

// ---------------------------------------------------------------- dry-run sınıf eşleştirme

test('statik: delta DROP CONSTRAINT + mainMoved boş → kısıt düşümü çatışması (dry-run temiz geçse bile)', async () => {
  // lab s8b dersi: bağımlılıksız PK düşümünü PG engellemez — statik kontrolde varsayılan çatışma
  const main = fakeSql({ log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)'])] });
  const branch = fakeSql({
    log: [
      logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)']),
      logRow(2, 'h2d', ['ALTER TABLE "people" DROP CONSTRAINT "people_pkey"']),
    ],
  });
  const plan = await planMergeUp(main, branch);

  assert.equal(plan.conflicts.length, 1); // yalnız statik — sahte dry-run hatasız
  const c = plan.conflicts[0];
  assert.equal(c.class, 'constraint');
  assert.equal(c.code, 'static');
  assert.equal(c.object, 'people.people_pkey');
  // detail/options kontrat §4.3 metniyle birebir
  assert.equal(c.detail, 'kısıt düşümü — PK/unique/FK düşümü bağımlılıksızsa PG engellemez, bilinçli onay gerek');
  assert.deepEqual(c.options, ['dalı rebase et ve kısıtı koru', 'kısıt gerçekten düşmeli ise dalda yeni plan üret']);
});

test('applyMergeUp: kısıt düşümü çatışmalı plan → MergeConflictError (bilinçli-onay bayrağı v1de YOK, apply edilemez)', async () => {
  const main = fakeSql({ log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)'])] });
  const branch = fakeSql({
    log: [
      logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)']),
      logRow(2, 'h2d', ['ALTER TABLE "people" DROP CONSTRAINT "people_pkey" CASCADE']),
    ],
  });
  const plan = await planMergeUp(main, branch);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].class, 'constraint');
  assert.equal(plan.conflicts[0].object, 'people.people_pkey'); // CASCADE'li kalıp da yakalanır
  const unsafeBefore = main.unsafeCalls.length;

  await assert.rejects(applyMergeUp(main, plan), (err: unknown) => {
    assert.ok(err instanceof MergeConflictError);
    assert.deepEqual(err.conflicts, plan.conflicts);
    return true;
  });
  assert.equal(main.unsafeCalls.length, unsafeBefore); // apply hiçbir şey çalıştırmadı
});

// ---------------------------------------------------------------- dry-run sınıf eşleştirme

test('dry-run: PG hata kodu → çatışma sınıfı eşleştirmesi (sahte PG hata nesneleri)', async () => {
  const cases: { code: string; message: string; cls: string; object?: string; detailMatch?: RegExp }[] = [
    { code: '42701', message: 'column "email" of relation "people" already exists', cls: 'schema', object: 'people.email' },
    { code: '42P07', message: 'relation "people" already exists', cls: 'schema', object: 'people' },
    { code: '42P01', message: 'relation "org" does not exist', cls: 'schema', object: 'org' },
    { code: '2BP01', message: 'cannot drop table org because other objects depend on it', cls: 'constraint', object: 'org' },
    {
      code: '2BP01',
      message: 'cannot drop constraint people_pkey on table people because other objects depend on it',
      cls: 'constraint',
      object: 'people.people_pkey',
    },
    {
      code: '23503',
      message: 'insert or update on table "ch" violates foreign key constraint "ch_pid_fkey"',
      cls: 'constraint',
      object: 'ch',
    },
    { code: '23505', message: 'duplicate key value violates unique constraint "u_pkey"', cls: 'data' },
    { code: '42804', message: 'column "n" is of type bigint but expression is of type integer', cls: 'schema' },
    { code: 'XX999', message: 'tuhaf bir hata', cls: 'schema', detailMatch: /sınıflandırılamadı/ },
  ];
  for (const kase of cases) {
    const main = fakeSql({
      log: [logRow(1, 'h1', ['CREATE TABLE "a" (id uuid)'])],
      failOnUnsafe: { match: /ADD COLUMN/, err: { code: kase.code, message: kase.message } },
    });
    const branch = fakeSql({
      log: [logRow(1, 'h1', ['CREATE TABLE "a" (id uuid)']), logRow(2, 'h2d', ['ALTER TABLE "a" ADD COLUMN "x" text'])],
    });
    const plan = await planMergeUp(main, branch);
    const c = plan.conflicts.find((x) => x.code === kase.code);
    assert.ok(c, `${kase.code}: çatışma raporlanmalı`);
    assert.equal(c.class, kase.cls, `${kase.code}: sınıf`);
    assert.equal(c.code, kase.code, `${kase.code}: orijinal kod korunur`);
    if (kase.object !== undefined) assert.equal(c.object, kase.object, `${kase.code}: object`);
    assert.ok(c.options.length > 0, `${kase.code}: options dolu`);
    assert.match(c.detail, kase.detailMatch ?? new RegExp(kase.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// ---------------------------------------------------------------- applyMergeUp

test('applyMergeUp: çatışmalı plan → MergeConflictError (çözülmeden commit YOK, hiçbir stmt çalışmaz)', async () => {
  const main = fakeSql({
    log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)'])],
    failOnUnsafe: { match: /ADD COLUMN/, err: { code: '42701', message: 'column "x" of relation "people" already exists' } },
  });
  const branch = fakeSql({
    log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)']), logRow(2, 'h2d', ['ALTER TABLE "people" ADD COLUMN "x" text'])],
  });
  const plan = await planMergeUp(main, branch);
  assert.equal(plan.conflicts.length, 1);
  const unsafeBefore = main.unsafeCalls.length;

  await assert.rejects(applyMergeUp(main, plan), (err: unknown) => {
    assert.ok(err instanceof MergeConflictError);
    assert.deepEqual(err.conflicts, plan.conflicts);
    assert.match(err.message, /çözülmemiş çatışma/);
    return true;
  });
  assert.equal(main.unsafeCalls.length, unsafeBefore); // apply hiçbir şey çalıştırmadı
});

test('applyMergeUp: main plan\'dan sonra değişti → MergeApprovalError; yeniden plan → temiz apply', async () => {
  const main = fakeSql({ log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)'])] });
  const branch = fakeSql({
    log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)']), logRow(2, 'h2d', ['ALTER TABLE "people" ADD COLUMN "x" text'])],
  });
  const plan1 = await planMergeUp(main, branch);
  assert.equal(plan1.mainHash, 'h1');

  // main bağımsız ilerler (yeni push)
  main.state.log = [...(main.state.log as LogRow[]), logRow(2, 'h2m', ['ALTER TABLE "people" ADD COLUMN "b" text'])];

  await assert.rejects(applyMergeUp(main, plan1), (err: unknown) => {
    assert.ok(err instanceof MergeApprovalError);
    assert.match(err.message, /yeniden planla/);
    return true;
  });

  // yeniden plan → approval yeni mainHash'e bağlanır → temiz apply
  const plan2 = await planMergeUp(main, branch);
  assert.equal(plan2.mainHash, 'h2m');
  assert.deepEqual(plan2.conflicts, []);
  const { appliedSeq } = await applyMergeUp(main, plan2);
  assert.equal(appliedSeq, 3);

  const insert = mergeInsert(main);
  assert.match(insert.values[0] as string, /^merge:[0-9a-f]{16}$/);
  assert.equal(insert.values[3], 'merge');
  const meta = JSON.parse(insert.values[4] as string);
  assert.deepEqual(meta.deltaSeqs, [2]);
  assert.equal(meta.planMainHash, 'h2m');
  assert.equal(meta.planDigest, plan2.planDigest);
  assert.ok(!('fromBranch' in meta)); // opts verilmedi → anahtar yok
});

test('applyMergeUp: no-op — delta boş plan → { appliedSeq: null }, transaction açılmaz', async () => {
  const main = fakeSql({
    log: [logRow(1, 'h1', ['CREATE TABLE "a" (id uuid)']), logRow(2, 'h2', ['ALTER TABLE "a" ADD COLUMN "b" text'])],
  });
  const branch = fakeSql({ log: [logRow(1, 'h1', ['CREATE TABLE "a" (id uuid)'])] }); // dal kıpırdamadı
  const plan = await planMergeUp(main, branch);
  assert.deepEqual(plan.stmts, []);
  assert.deepEqual(plan.conflicts, []);

  const result = await applyMergeUp(main, plan);
  assert.deepEqual(result, { appliedSeq: null });
  assert.equal(main.beginCalls, 0); // ne dry-run ne apply transaction'ı
});

test("applyMergeUp: başarılı apply — tek transaction'da ensurePushLog + stmts + source='merge' girdisi", async () => {
  const main = fakeSql({ log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)'])] });
  const branch = fakeSql({
    log: [logRow(1, 'h1', ['CREATE TABLE "people" (id uuid)']), logRow(2, 'h2d', ['ALTER TABLE "people" ADD COLUMN "x" text'])],
  });
  const plan = await planMergeUp(main, branch);
  const { appliedSeq } = await applyMergeUp(main, plan, { fromBranch: 'feat-x' });

  assert.equal(appliedSeq, 2);
  assert.deepEqual(main.unsafeCalls, [
    'ALTER TABLE "people" ADD COLUMN "x" text', // plan dry-run
    PUSH_LOG_DDL, // apply transaction'ı başlar: ensurePushLog
    PUSH_LOG_ALTER_SOURCE,
    PUSH_LOG_ALTER_META,
    'ALTER TABLE "people" ADD COLUMN "x" text', // delta stmts
  ]);
  assert.equal(main.beginCalls, 2); // dry-run + apply

  const insert = mergeInsert(main);
  assert.match(insert.values[0] as string, /^merge:[0-9a-f]{16}$/);
  assert.deepEqual(JSON.parse(insert.values[1] as string), plan.stmts);
  assert.deepEqual(JSON.parse(insert.values[2] as string), []); // lint
  assert.equal(insert.values[3], 'merge');
  const meta = JSON.parse(insert.values[4] as string);
  assert.equal(meta.fromBranch, 'feat-x');
  assert.deepEqual(meta.deltaSeqs, [2]);
  assert.equal(meta.planMainHash, plan.mainHash);
  assert.equal(meta.planDigest, plan.planDigest);
});

test('applyMergeUp: boş main loguna apply (mainHash empty) → ilk girdi seq 1', async () => {
  const main = fakeSql({ log: [] });
  const branch = fakeSql({
    log: [logRow(1, 'h1', ['CREATE TABLE "a" (id uuid)']), logRow(2, 'h2', ['ALTER TABLE "a" ADD COLUMN "x" text'])],
  });
  const plan = await planMergeUp(main, branch);
  assert.equal(plan.mainHash, 'empty');

  const { appliedSeq } = await applyMergeUp(main, plan);
  assert.equal(appliedSeq, 1);
});

test("applyMergeUp: planDigest stmts ile uyuşmazsa MergeError('plan-digest-mismatch')", async () => {
  const main = fakeSql({ log: [logRow(1, 'h1', ['CREATE TABLE "a" (id uuid)'])] });
  const branch = fakeSql({
    log: [logRow(1, 'h1', ['CREATE TABLE "a" (id uuid)']), logRow(2, 'h2d', ['ALTER TABLE "a" ADD COLUMN "x" text'])],
  });
  const plan = await planMergeUp(main, branch);
  plan.stmts.push('ALTER TABLE "a" ADD COLUMN "sizma" text'); // plan kurcalandı → digest bozuldu

  await assert.rejects(applyMergeUp(main, plan), (err: unknown) => {
    assert.ok(err instanceof MergeError);
    assert.equal(err.code, 'plan-digest-mismatch');
    return true;
  });
});
