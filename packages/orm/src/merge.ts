/**
 * ORMIM merge-up — dalın `_metatron_push_log` delta'sını main'e GÜVENLİ uygular
 * (MERGE-CONTRACT §4, Faz 2.5).
 *
 * `metatron-orm/merge` subpath export'u. Kilitli kurallar: kör replay YOK
 * (statik kontroller + PG dry-run), çözülmeden commit YOK, dry-run her zaman,
 * approval sonrası main değişirse approval düşer (PlanetScale modeli).
 *
 * Bağlantı yakınlığı: postgres.js'te ardışık `sql.unsafe` çağrıları pool'dan
 * FARKLI bağlantılara gidebilir; dry-run ve apply tek transaction istediğinden
 * main tarafı `begin`'i olan `TxCapable` ister. Dal tarafı yalnız okunur.
 */

import { createHash } from 'node:crypto';
import { ensurePushLog } from './push.ts';
import type { SqlLike } from './push.ts';

/** postgres.js `sql.begin` yeteneği — callback tek bağlantıda çalışır (dry-run/apply için şart). */
export interface TxCapable extends SqlLike {
  begin<T>(fn: (tx: SqlLike) => Promise<T>): Promise<T>;
}

export type ConflictClass = 'schema' | 'data' | 'constraint';

export interface MergeConflict {
  class: ConflictClass;
  code?: string; // PG hata kodu (dry-run'dan) veya 'static'
  object?: string; // 'people.email' gibi
  detail: string; // insan dili, Türkçe
  options: string[]; // çözüm seçenekleri (merge lab kurallarından)
}

export interface MergePlan {
  ancestorSeq: number | null;
  deltaSeqs: number[];
  stmts: string[]; // sırayla uygulanacak DDL (delta'nın düz birleşimi)
  conflicts: MergeConflict[];
  mainHash: string; // plan anında main'in son push_log schema_hash'i (approval buna bağlanır)
  branchHash: string;
  planDigest: string; // sha256(stmts.join('\n')).slice(0,16) — apply yeniden hesaplayıp karşılaştırır
}

/** main plan'dan sonra değişti — approval düştü, yeniden planla. */
export class MergeApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeApprovalError';
  }
}

/** Çözülmeden commit YOK — plan çatışmalıyken apply çağrıldı. */
export class MergeConflictError extends Error {
  readonly conflicts: MergeConflict[];
  constructor(conflicts: MergeConflict[]) {
    super(
      `merge çözülmemiş çatışma nedeniyle durdu (${conflicts.length}): ` +
        conflicts.map((c) => c.detail).join('; '),
    );
    this.name = 'MergeConflictError';
    this.conflicts = conflicts;
  }
}

/** Merge altyapı hatası — 'no-common-ancestor' | 'plan-digest-mismatch' | ... */
export class MergeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- push_log okuma

interface PushLogRow {
  seq: number;
  schema_hash: string;
  stmts: string[];
  lint: { kind?: string; table?: string; detail?: string }[];
}

/** jsonb kolon postgres.js'te parse edilmiş gelir; sahte sql'lerde string olabilir. */
function asJsonArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string') return JSON.parse(v) as T[];
  return [];
}

/** push_log'u seq ASC okur; tablo yoksa (42P01) boş log sayılır (push.ts readLastHash deseni). */
async function readPushLog(sql: SqlLike): Promise<PushLogRow[]> {
  try {
    const rows = await sql<{ seq: number | string | bigint; schema_hash: string; stmts: unknown; lint: unknown }>`
      SELECT seq, schema_hash, stmts, lint FROM _metatron_push_log ORDER BY seq ASC`;
    return rows.map((r) => ({
      seq: Number(r.seq),
      schema_hash: r.schema_hash,
      stmts: asJsonArray<string>(r.stmts),
      lint: asJsonArray(r.lint),
    }));
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e?.code === '42P01' || /_metatron_push_log/.test(String(e?.message))) return []; // tablo henüz yok
    throw err;
  }
}

// ---------------------------------------------------------------- makine-üretimi DDL parse

// ORMIM'in ürettiği DDL sabit kalıplıdır (quoteIdent: `ALTER TABLE "x" ...`) — regex yeterli.
// Parse edilemeyen stmt lint/conflict ÜRETMEZ, sessizce dry-run'a bırakılır (MERGE-CONTRACT §4.3).
const Q = '"((?:[^"]|"")+)"'; // quoteIdent: iç tırnak çiftlenerek kaçar
const RE_DROP_TABLE = new RegExp(`^DROP TABLE ${Q}(?:\\s+CASCADE)?$`, 'i');
const RE_DROP_COLUMN = new RegExp(`^ALTER TABLE ${Q} DROP COLUMN ${Q}(?:\\s+CASCADE)?$`, 'i');
const RE_DROP_CONSTRAINT = new RegExp(`^ALTER TABLE ${Q} DROP CONSTRAINT ${Q}(?:\\s+CASCADE)?$`, 'i');
const RE_ADD_COLUMN = new RegExp(`^ALTER TABLE ${Q} ADD COLUMN ${Q}(?=\\s)`, 'i');
const RE_ALTER_TABLE = new RegExp(`^ALTER TABLE ${Q}(?=\\s)`, 'i');
const RE_CREATE_TABLE = new RegExp(`^CREATE TABLE ${Q}(?=\\s)`, 'i');

interface StmtOps {
  dropTables: string[];
  dropCols: { table: string; col: string }[];
  dropConstraints: { table: string; constraint: string }[];
  addCols: { table: string; col: string }[];
  /** Stmt'in dokunduğu tablolar (ALTER/CREATE/DROP TABLE hedefi) — nesne kesişimi için. */
  touchedTables: Set<string>;
}

function parseStmts(stmts: string[]): StmtOps {
  const ops: StmtOps = {
    dropTables: [],
    dropCols: [],
    dropConstraints: [],
    addCols: [],
    touchedTables: new Set(),
  };
  for (const s of stmts) {
    let m = RE_DROP_TABLE.exec(s);
    if (m) {
      ops.dropTables.push(m[1]);
      ops.touchedTables.add(m[1]);
      continue;
    }
    m = RE_DROP_COLUMN.exec(s);
    if (m) {
      ops.dropCols.push({ table: m[1], col: m[2] });
      ops.touchedTables.add(m[1]);
      continue;
    }
    // RE_ALTER_TABLE umbrella'sından ÖNCE — yoksa DROP CONSTRAINT yalnız touchedTables'a yutulur
    m = RE_DROP_CONSTRAINT.exec(s);
    if (m) {
      ops.dropConstraints.push({ table: m[1], constraint: m[2] });
      ops.touchedTables.add(m[1]);
      continue;
    }
    m = RE_ADD_COLUMN.exec(s);
    if (m) {
      ops.addCols.push({ table: m[1], col: m[2] });
      ops.touchedTables.add(m[1]);
      continue;
    }
    m = RE_ALTER_TABLE.exec(s) ?? RE_CREATE_TABLE.exec(s);
    if (m) ops.touchedTables.add(m[1]); // RENAME/ALTER TYPE/ADD CONSTRAINT/CREATE — nesne kesişimi yeterli
  }
  return ops;
}

// ---------------------------------------------------------------- statik kontroller

const RENAME_OPTIONS = (from: string): string[] => [
  `.renamedFrom('${from}') ile işaretle ve dalı yeniden push'la`,
  "kasıtlı drop+add ise main'deki verinin silineceğini onayla",
];
const DROP_CHANGED_OPTIONS = ['dalı güncel main\'e rebase et', 'main\'deki değişikliği önce geri al'];
const DROP_CONSTRAINT_OPTIONS = ['dalı rebase et ve kısıtı koru', 'kısıt gerçekten düşmeli ise dalda yeni plan üret'];

/**
 * Dry-run öncesi hızlı kontroller (MERGE-CONTRACT §4.3):
 *  - rename-suspect: delta lint jsonb'sinde kind='rename-suspect' VEYA delta stmts'lerinde
 *    aynı tabloda DROP COLUMN x + ADD COLUMN y çifti (lab s2: kör merge veri kaybettirir).
 *  - drop-changed-in-main: delta DROP TABLE t / DROP COLUMN t.c + mainMoved aynı nesneye
 *    dokunuyor (lab s5: drop edilen nesne main'de atadan sonra değiştiyse çatışma).
 *  - kısıt düşümü (lab s8b dersi, Faz 2.5+): delta DROP CONSTRAINT içeriyorsa bağımlılık
 *    aranmadan varsayılan 'constraint' çatışması — bağımlılıksız PK/unique/FK düşümünü PG
 *    engellemez; v1'de bilinçli-onay bayrağı YOK, bu delta apply edilemez.
 */
function staticConflicts(
  deltaOps: StmtOps,
  mainOps: StmtOps,
  deltaLint: { kind?: string; table?: string; detail?: string }[],
): MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  const renameReported = new Set<string>();

  for (const l of deltaLint) {
    if (l.kind !== 'rename-suspect') continue;
    const table = l.table ?? '';
    if (renameReported.has(table)) continue;
    renameReported.add(table);
    // push lint detayı: "rename şüphesi people.ad→isim (text) — ..." → eski kolon adı çıkar
    const from = /\w+\.(\w+)→\w+/.exec(l.detail ?? '')?.[1] ?? 'x';
    conflicts.push({
      class: 'schema',
      code: 'static',
      object: table || undefined,
      detail: `rename şüphesi (${l.detail ?? table}) — kör merge main'deki veriyi kaybettirir`,
      options: RENAME_OPTIONS(from),
    });
  }

  // lint'i atlamış olabilecek drop+add çiftleri (stmt seviyesinde, tip koşulu aranmaz)
  for (const d of deltaOps.dropCols) {
    if (renameReported.has(d.table)) continue;
    if (!deltaOps.addCols.some((a) => a.table === d.table && a.col !== d.col)) continue;
    renameReported.add(d.table);
    conflicts.push({
      class: 'schema',
      code: 'static',
      object: d.table,
      detail:
        `rename şüphesi: delta aynı tabloda DROP COLUMN "${d.col}" + ADD COLUMN üretiyor ` +
        `— kör merge main'deki veriyi kaybettirir`,
      options: RENAME_OPTIONS(d.col),
    });
  }

  for (const t of deltaOps.dropTables) {
    if (!mainOps.touchedTables.has(t)) continue;
    conflicts.push({
      class: 'schema',
      code: 'static',
      object: t,
      detail: `delta DROP TABLE "${t}" istiyor ama "${t}" main'de ata sonrası değişti — drop serbest değil`,
      options: DROP_CHANGED_OPTIONS,
    });
  }
  for (const d of deltaOps.dropCols) {
    if (!mainOps.touchedTables.has(d.table)) continue;
    conflicts.push({
      class: 'schema',
      code: 'static',
      object: `${d.table}.${d.col}`,
      detail:
        `delta DROP COLUMN "${d.table}"."${d.col}" istiyor ama "${d.table}" main'de ata sonrası değişti ` +
        `— drop serbest değil`,
      options: DROP_CHANGED_OPTIONS,
    });
  }
  // kısıt düşümü: mainMoved koşulu YOK — bağımlılıksız düşüm dry-run'ı temiz geçer (lab s8b)
  for (const d of deltaOps.dropConstraints) {
    conflicts.push({
      class: 'constraint',
      code: 'static',
      object: `${d.table}.${d.constraint}`,
      detail: 'kısıt düşümü — PK/unique/FK düşümü bağımlılıksızsa PG engellemez, bilinçli onay gerek',
      options: DROP_CONSTRAINT_OPTIONS,
    });
  }
  return conflicts;
}

// ---------------------------------------------------------------- dry-run + PG hata sınıflandırma

/** sql.begin callback'inden fırlatılır: transaction'ı ROLLBACK'e çevirir — main'de İZ YOK. */
class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback (sentinel)');
    this.name = 'DryRunRollback';
  }
}

/** PG hata nesnesinden tablo[/kolon] adı çıkar (önce postgres.js alanları, sonra mesaj regex'i). */
function extractObject(e: { table_name?: string; column_name?: string; message?: string }): string | undefined {
  if (e.table_name && e.column_name) return `${e.table_name}.${e.column_name}`;
  if (e.table_name) return e.table_name;
  const msg = e.message ?? '';
  let m = /column "([^"]+)" of relation "([^"]+)"/.exec(msg); // 42701
  if (m) return `${m[2]}.${m[1]}`;
  m = /relation "([^"]+)"/.exec(msg); // 42P01 / 42P07
  if (m) return m[1];
  m = /table "([^"]+)"/.exec(msg); // 23503 / 23505
  if (m) return m[1];
  m = /cannot drop (?:table|column) ([\w.]+)/.exec(msg); // 2BP01 (tırnaksız gelir)
  if (m) return m[1];
  m = /cannot drop constraint ([\w.]+) on table ([\w.]+)/.exec(msg); // 2BP01 PK/FK düşümü (lab s8a)
  if (m) return `${m[2]}.${m[1]}`;
  return undefined;
}

/** PG hata kodu → çatışma sınıfı eşleştirmesi (MERGE-CONTRACT §4.4, merge lab ölçümleri). */
function classifyPgError(err: unknown): MergeConflict {
  const e = err as { code?: string; message?: string; table_name?: string; column_name?: string };
  const code = e?.code ?? 'unknown';
  const message = e?.message ?? String(err);
  const object = extractObject(e);
  switch (code) {
    case '42701': // duplicate_column
    case '42P07': // duplicate_table
      return {
        class: 'schema',
        code,
        object,
        detail: `nesne main'de zaten var (main bağımsız değişti): ${message}`,
        options: ['dalı güncel main\'e rebase et', 'kolon/tip dönüşümünü planla (expand-migrate-contract)'],
      };
    case '42P01': // undefined_table
      return {
        class: 'schema',
        code,
        object,
        detail: `dal main'de olmayan nesneyi değiştiriyor (main'de silinmiş): ${message}`,
        options: ['dalı güncel main\'e rebase et'],
      };
    case '2BP01': // dependent_objects (lab s4)
      return {
        class: 'constraint',
        code,
        object,
        detail: `silinen nesneye main'de bağımlı nesne var: ${message}`,
        options: [
          'dalı geri al',
          "bağımlı FK'yı main'de de kaldır (bağlı satırlar kontrol edilmeli)",
          'silmek yerine arşivle',
        ],
      };
    case '23503': // foreign_key_violation (lab s8)
      return {
        class: 'constraint',
        code,
        object,
        detail: `FK kısıtı ihlali: ${message}`,
        options: ['dalı geri al', "FK'yı main'de de kaldır veya dalı yeniden planla"],
      };
    case '23505': // unique_violation (v1'de DDL delta'sında beklenmez ama eşleştirme hazır)
      return {
        class: 'data',
        code,
        object,
        detail: `tekil kısıt ihlali: ${message}`,
        options: ['çakışan kayıtları iki tarafta karşılaştır', 'uuid/uuidv7 PK kullan (merge lab s9)'],
      };
    case '42804': // datatype_mismatch
    case '42883': // undefined_function
      return {
        class: 'schema',
        code,
        object,
        detail: `tip uyuşmazlığı: ${message}`,
        options: ['dalı güncel main\'e rebase et', 'tip dönüşümünü planla (expand-migrate-contract)'],
      };
    default:
      return {
        class: 'schema',
        code,
        object,
        detail: `${message} (sınıflandırılamadı)`,
        options: ['dalı güncel main\'e rebase et'],
      };
  }
}

/**
 * Dry-run her zaman (statik conflict olsun ya da olmasın): BEGIN; stmts sırayla; ROLLBACK.
 * PG DDL'i transactionaldır — sentinel hata ile rollback, main'de iz bırakmaz.
 * ORMIM transaction-dışı stmt üretmez (CREATE INDEX CONCURRENTLY yok).
 */
async function dryRun(sqlMain: TxCapable, stmts: string[]): Promise<MergeConflict | null> {
  try {
    await sqlMain.begin(async (tx) => {
      for (const s of stmts) await tx.unsafe(s);
      throw new DryRunRollback();
    });
    return null; // sentinel'sız dönüş olmamalı — savunma amaçlı
  } catch (err) {
    if (err instanceof DryRunRollback) return null; // temiz: ROLLBACK başarılı
    return classifyPgError(err);
  }
}

// ---------------------------------------------------------------- plan

function planDigestOf(stmts: string[]): string {
  return createHash('sha256').update(stmts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Dalın push_log delta'sı için merge planı üretir (MERGE-CONTRACT §4 planMergeUp).
 * Ata: (seq, schema_hash) çiftiyle en uzun ortak önek. Main logu boşsa "boş önek"
 * geçerlidir (delta = dalın tüm logu); main dolu ve ortak önek sıfırsa
 * MergeError('no-common-ancestor').
 */
export async function planMergeUp(sqlMain: TxCapable, sqlBranch: SqlLike): Promise<MergePlan> {
  const [mainLog, branchLog] = await Promise.all([readPushLog(sqlMain), readPushLog(sqlBranch)]);

  let prefix = 0;
  while (
    prefix < mainLog.length &&
    prefix < branchLog.length &&
    mainLog[prefix].seq === branchLog[prefix].seq &&
    mainLog[prefix].schema_hash === branchLog[prefix].schema_hash
  ) {
    prefix++;
  }
  if (prefix === 0 && mainLog.length > 0) {
    throw new MergeError('no-common-ancestor', "dal bu main'den doğmamış — push_log ortak öneki yok");
  }
  const ancestorSeq = prefix > 0 ? branchLog[prefix - 1].seq : null;

  // delta: dalın ata-sonrası girdileri — girdi sırası + girdi içi stmt sırası korunur
  const deltaEntries = branchLog.slice(prefix);
  const stmts = deltaEntries.flatMap((e) => e.stmts);
  const deltaSeqs = deltaEntries.map((e) => e.seq);
  const mainMoved = mainLog.slice(prefix);

  const mainHash = mainLog.at(-1)?.schema_hash ?? 'empty';
  const branchHash = branchLog.at(-1)?.schema_hash ?? 'empty';
  const planDigest = planDigestOf(stmts);

  const conflicts: MergeConflict[] = [];
  if (stmts.length > 0) {
    // 3) statik kontroller (hızlı ve açıklanabilir)
    const deltaOps = parseStmts(stmts);
    const mainOps = parseStmts(mainMoved.flatMap((e) => e.stmts));
    conflicts.push(...staticConflicts(deltaOps, mainOps, deltaEntries.flatMap((e) => e.lint)));
    // 4) dry-run her zaman
    const dry = await dryRun(sqlMain, stmts);
    if (dry) conflicts.push(dry);
  }

  return { ancestorSeq, deltaSeqs, stmts, conflicts, mainHash, branchHash, planDigest };
}

// ---------------------------------------------------------------- apply

/**
 * Onaylanmış planı main'e uygular (MERGE-CONTRACT §4 applyMergeUp).
 * Sıra: çatışma kontrolü → planDigest bütünlüğü → approval (mainHash) → no-op → tek transaction.
 * Transaction içinde PG hatası (yarış) → hata yukarı; push_log'a YARIM KAYIT YOK.
 */
export async function applyMergeUp(
  sqlMain: TxCapable,
  plan: MergePlan,
  opts?: { fromBranch?: string },
): Promise<{ appliedSeq: number | null }> {
  if (plan.conflicts.length > 0) throw new MergeConflictError(plan.conflicts);
  if (planDigestOf(plan.stmts) !== plan.planDigest) {
    throw new MergeError('plan-digest-mismatch', 'planDigest stmts ile uyuşmuyor — planı yeniden üret');
  }

  // approval: main plan anındaki gibi mi? (hash yok taraf için 'empty' karşılaştırması)
  const mainLog = await readPushLog(sqlMain);
  const current = mainLog.at(-1)?.schema_hash ?? 'empty';
  if (current !== plan.mainHash) {
    throw new MergeApprovalError(
      `main plan'dan sonra değişti (plan: ${plan.mainHash}, güncel: ${current}) — yeniden planla`,
    );
  }

  if (plan.stmts.length === 0) return { appliedSeq: null }; // no-op

  // Sentetik hash kasıtlı: sonraki `metatron dev` push'u diff'in boş olduğunu görüp
  // gerçek hash'i kendisi yazar (kendini iyileştirir).
  const mergeHash =
    'merge:' +
    createHash('sha256')
      .update(`${plan.branchHash}+${plan.mainHash}+${plan.planDigest}`)
      .digest('hex')
      .slice(0, 16);
  const meta = {
    fromBranch: opts?.fromBranch,
    deltaSeqs: plan.deltaSeqs,
    planMainHash: plan.mainHash,
    planDigest: plan.planDigest,
  };

  // Tek transaction: ensurePushLog + stmts sırayla + push_log insert (source='merge').
  const appliedSeq = await sqlMain.begin(async (tx) => {
    await ensurePushLog(tx);
    for (const s of plan.stmts) await tx.unsafe(s);
    const rows = await tx<{ seq: number | string | bigint }>`
      INSERT INTO _metatron_push_log (schema_hash, stmts, lint, source, meta)
      VALUES (${mergeHash}, ${tx.json(plan.stmts)}, ${tx.json([])}, ${'merge'}, ${tx.json(meta)})
      RETURNING seq`;
    return Number(rows[0].seq);
  });
  return { appliedSeq };
}
