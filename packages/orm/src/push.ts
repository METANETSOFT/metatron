/**
 * ORMIM push — live-DB diff → plan → uygula (ORM-CONTRACT §2/§3).
 *
 * `metatron-orm/push` subpath export'u. Bağımlılık yok: sql, postgres.js
 * imzasına uyan minimal `SqlLike` tipiyle DI edilir (testlerde sahte sql).
 */

import { createHash } from 'node:crypto';
import {
  columnDdl,
  columnEntries,
  columnValues,
  createTableSql,
  fkSql,
  indexSql,
  quoteIdent,
  resolveRef,
  sqlType,
  tableFks,
  topoSortTables,
  UUIDV7_SQL,
} from './schema.ts';
import type { AnyColumn, AnyTable, FkDef, Schema } from './schema.ts';

/** postgres.js'in kullandığımız alt kümesi (tagged template + unsafe + json). */
export interface SqlLike {
  <T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  /** Değeri jsonb parametresi olarak gömer (postgres.js sql.json; sahte sql'lerde JSON.stringify yeterli). */
  json(value: unknown): unknown;
}

export interface LintIssue {
  kind: 'rename-suspect' | 'destructive' | 'narrowing' | 'fk-risk' | 'numeric-pk';
  table: string;
  detail: string;
}

export interface PushPlan {
  stmts: string[];
  lint: LintIssue[];
  /** Normalize şema hash'i — idempotensi + _metatron_push_log için. */
  schemaHash: string;
}

const INTERNAL_TABLES = new Set(['_metatron_push_log']);

export const PUSH_LOG_DDL = `CREATE TABLE IF NOT EXISTS _metatron_push_log (
  seq bigserial PRIMARY KEY,
  applied_at timestamptz DEFAULT now(),
  schema_hash text NOT NULL,
  stmts jsonb NOT NULL,
  lint jsonb NOT NULL DEFAULT '[]'
)`;

// push_log şema evrimi (MERGE-CONTRACT §3) — geriye dönük uyumlu, eski DB'ler sessizce yükselir.
const PUSH_LOG_ALTER_SOURCE = `ALTER TABLE _metatron_push_log ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'push'`;
const PUSH_LOG_ALTER_META = `ALTER TABLE _metatron_push_log ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'`;

/** push_log tablosunu kurar/yükseltir: PUSH_LOG_DDL + MERGE-CONTRACT §3'teki iki ALTER. */
export async function ensurePushLog(sql: SqlLike): Promise<void> {
  await sql.unsafe(PUSH_LOG_DDL);
  await sql.unsafe(PUSH_LOG_ALTER_SOURCE);
  await sql.unsafe(PUSH_LOG_ALTER_META);
}

// ---------------------------------------------------------------- tip normalizasyonu

interface InfoColRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}

/** information_schema satırını kanonik tip adına çevirir (`vector` boyutu typmod'dadır, görünmez). */
function canonInfoType(row: InfoColRow): string {
  const dt = row.data_type;
  if (dt === 'USER-DEFINED') return row.udt_name; // pgvector: 'vector'
  if (dt === 'character varying') return `varchar(${row.character_maximum_length ?? ''})`;
  if (dt === 'timestamp with time zone') return 'timestamptz';
  return dt; // text, integer, bigint, boolean, jsonb, uuid, tsvector, ...
}

/** Şema kolonunun kanonik tip adı (enum → text; vector boyutsuz). */
function canonColType(col: AnyColumn): string {
  return col._type === 'enum' ? 'text' : col._type;
}

/**
 * Güvenli widening — ORM-CONTRACT §2. Yalnız bunlar otomatik ALTER TYPE olur:
 *   integer → bigint · varchar(a) → varchar(b>a) · varchar(n) → text
 * (CONTRACT'taki "text→varchar(n>b)" maddesi varchar genişlemesi olarak yorumlandı;
 *  text → varchar(n) daralmadır ve lint üretir.)
 */
function isWidening(from: string, to: string): boolean {
  if (from === to) return false;
  if (from === 'integer' && to === 'bigint') return true;
  const fv = /^varchar\((\d+)\)$/.exec(from);
  const tv = /^varchar\((\d+)\)$/.exec(to);
  if (fv && tv) return Number(tv[1]) > Number(fv[1]);
  if (fv && to === 'text') return true;
  return false;
}

/** Rename şüphesi için "benzer tip": eşit veya iki yönden birine widening. */
function typesCompatible(liveType: string, wantedType: string): boolean {
  return liveType === wantedType || isWidening(liveType, wantedType) || isWidening(wantedType, liveType);
}

// ---------------------------------------------------------------- şema hash'i

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (typeof val === 'bigint') return `${val}n`;
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      return Object.fromEntries(
        Object.keys(val as Record<string, unknown>)
          .sort()
          .map((k) => [k, (val as Record<string, unknown>)[k]]),
      );
    }
    return val;
  });
}

/**
 * Normalize edilmiş şemanın deterministik hash'i (ORM-CONTRACT §3 `schema_hash`).
 * `schema.external` listesi (sıralanmış) hash'e DAHİLDİR — listeden çıkarma davranış
 * değişikliğidir ve push'ta görünmelidir. Liste boşsa eski hash formatı korunur
 * (external'sız şemaların mevcut hash'i değişmez).
 */
export function schemaHash<T extends Record<string, AnyTable>>(schema: Schema<T>): string {
  const norm: Record<string, unknown> = {};
  for (const [tn, table] of Object.entries(schema.tables)) {
    const cols: Record<string, unknown> = {};
    for (const [cn, c] of columnEntries(table)) {
      cols[cn] = {
        type: canonColType(c),
        dims: c._vectorDims,
        values: c._enumValues,
        nullable: c._nullable,
        pk: c._pk,
        unique: c._unique,
        default: c._hasDefault ? (c._defaultRaw ?? c._default) : undefined,
        ref: c._ref ? `${resolveRef(c, tn, cn).refTable}.${resolveRef(c, tn, cn).refCol}` : undefined,
        onDelete: c._ref?.onDelete,
        renamedFrom: c._renamedFrom,
      };
    }
    norm[tn] = { columns: cols, extras: table.extras };
  }
  const external = [...schema.external].sort();
  const payload = external.length > 0 ? { tables: norm, external } : norm;
  return createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- live şema okuma

async function readLastHash(sql: SqlLike): Promise<string | null> {
  try {
    const rows = await sql<{ schema_hash: string }>`
      SELECT schema_hash FROM _metatron_push_log ORDER BY seq DESC LIMIT 1`;
    return rows[0]?.schema_hash ?? null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e?.code === '42P01' || /_metatron_push_log/.test(String(e?.message))) return null; // tablo henüz yok
    throw err;
  }
}

async function readLiveSchema(sql: SqlLike): Promise<Map<string, Map<string, string>>> {
  const live = new Map<string, Map<string, string>>();
  const tRows = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  for (const r of tRows) {
    if (!INTERNAL_TABLES.has(r.table_name)) live.set(r.table_name, new Map());
  }
  const cRows = await sql<InfoColRow>`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position`;
  for (const r of cRows) {
    const t = live.get(r.table_name);
    if (t) t.set(r.column_name, canonInfoType(r));
  }
  return live;
}

// ---------------------------------------------------------------- diff

function diffType(
  tableName: string,
  colName: string,
  col: AnyColumn,
  liveType: string,
  stmts: string[],
  lint: LintIssue[],
): void {
  const want = canonColType(col);
  if (liveType === want) return;
  if (isWidening(liveType, want)) {
    stmts.push(`ALTER TABLE ${quoteIdent(tableName)} ALTER COLUMN ${quoteIdent(colName)} TYPE ${sqlType(col)}`);
  } else {
    lint.push({
      kind: 'narrowing',
      table: tableName,
      detail: `daralan tip ${tableName}.${colName}: ${liveType} → ${want} — otomatik uygulanmaz`,
    });
  }
}

/**
 * Live şemayı information_schema'dan okur, diff üretir (ORM-CONTRACT §2).
 * Sıra: extension/uuidv7 → CREATE TABLE (topo) → index → ALTER (rename, add, type, drop) → FK'ler (en son).
 * Idempotent: push_log'daki son hash aynıysa veya diff boşsa `stmts=[]`.
 * `schema.external`'daki tablolar diff'ten TAMAMEN dışlanır (R1=b): live'da varsa DROP
 * planlanmaz, yoksa CREATE planlanmaz, ALTER/tip karşılaştırması ve lint ÜRETİLMEZ.
 * External adı şema tablosuyla çakışırsa açık çelişkidir — hata fırlatır (sessizlik yok).
 */
export async function planPush<T extends Record<string, AnyTable>>(
  sql: SqlLike,
  schema: Schema<T>,
): Promise<PushPlan> {
  for (const n of schema.external) {
    if (n in schema.tables) {
      throw new Error(
        `planPush: '${n}' hem şema tablosu hem external beyanlı — çelişki; birini kaldırın`,
      );
    }
  }

  const hash = schemaHash(schema);
  const last = await readLastHash(sql);
  if (last !== null && last === hash) return { stmts: [], lint: [], schemaHash: hash };

  const live = await readLiveSchema(sql);
  // external tablolar (ör. Better Auth user/session/account/verification) ORMIM yönetiminde
  // değil: live haritasından düşünce DROP/ALTER/lint yollarının hiçbirine girmezler.
  for (const n of schema.external) live.delete(n);
  const wanted = schema.tables;
  const stmts: string[] = [];
  const lint: LintIssue[] = [];
  const fks: string[] = [];
  let needsVectorExt = false;

  // ORM-CONTRACT §6: numerik PK lint'i — integer/bigint PK branch merge'de 23505
  // çakışma riski (lab s3/s9); uuid/uuidv7 önerilir. Yasak DEĞİL, uyarı.
  for (const [name, table] of Object.entries(wanted)) {
    for (const c of columnValues(table)) {
      if (!c._pk) continue;
      if (c._type === 'integer' || c._type === 'bigint') {
        lint.push({
          kind: 'numeric-pk',
          table: name,
          detail: `numerik PK (${c._type}) — branch merge'de çakışma riski (23505); uuid/uuidv7 önerilir (t.uuidPk()). Çakışma remap'i gelene kadar risk kabulüdür.`,
        });
      }
    }
  }

  const newTableNames = Object.keys(wanted).filter((n) => !live.has(n));
  const newTables: Record<string, AnyTable> = Object.fromEntries(newTableNames.map((n) => [n, wanted[n]]));
  const orderedNew = topoSortTables(newTables);
  if (orderedNew.some((tb) => columnValues(tb).some((c) => c._type === 'vector'))) {
    needsVectorExt = true;
  }

  for (const tb of orderedNew) stmts.push(createTableSql(tb));
  for (const tb of orderedNew) for (const idx of tb.extras.indexes) stmts.push(indexSql(tb._name, idx));
  for (const tb of orderedNew) for (const fk of tableFks(tb)) fks.push(fkSql(fk));

  for (const [name, table] of Object.entries(wanted)) {
    const liveCols = live.get(name);
    if (!liveCols) continue; // yeni tablo — yukarıda üretildi
    const renamedSources = new Set<string>();

    // 1) renamedFrom → RENAME COLUMN (drop+add DEĞİL; veri korunur)
    for (const [colName, col] of columnEntries(table)) {
      if (liveCols.has(colName)) continue;
      const from = col._renamedFrom;
      if (from && liveCols.has(from) && !(from in table.columns)) {
        stmts.push(`ALTER TABLE ${quoteIdent(name)} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(colName)}`);
        renamedSources.add(from);
        diffType(name, colName, col, liveCols.get(from)!, stmts, lint);
      }
    }

    // 2) eklenen kolonlar
    const added: [string, AnyColumn][] = [];
    for (const [colName, col] of columnEntries(table)) {
      if (liveCols.has(colName)) continue;
      if (col._renamedFrom && renamedSources.has(col._renamedFrom)) continue; // rename ile geldi
      added.push([colName, col]);
      if (col._type === 'vector') needsVectorExt = true;
      stmts.push(`ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${columnDdl(colName, col)}`);
      if (col._ref) {
        const fk: FkDef = resolveRef(col, name, colName);
        fks.push(fkSql(fk));
        lint.push({
          kind: 'fk-risk',
          table: name,
          detail: `yeni FK ${name}.${colName} → ${fk.refTable}.${fk.refCol} — mevcut satırlar kısıtı ihlal edebilir`,
        });
      }
    }

    // 3) düşen kolonlar (destructive → lint)
    const dropped: string[] = [];
    for (const colName of liveCols.keys()) {
      if (colName in table.columns || renamedSources.has(colName)) continue;
      dropped.push(colName);
      stmts.push(`ALTER TABLE ${quoteIdent(name)} DROP COLUMN ${quoteIdent(colName)}`);
      lint.push({
        kind: 'destructive',
        table: name,
        detail: `DROP COLUMN ${name}.${colName} — veri silinir`,
      });
    }

    // 4) rename şüphesi: aynı tabloda drop+add çifti, benzer tip
    for (const d of dropped) {
      const liveType = liveCols.get(d)!;
      const suspect = added.find(([, c]) => typesCompatible(liveType, canonColType(c)));
      if (suspect) {
        lint.push({
          kind: 'rename-suspect',
          table: name,
          detail: `rename şüphesi ${name}.${d}→${suspect[0]} (${liveType}) — kasıtlıysa .renamedFrom('${d}') kullanın`,
        });
      }
    }

    // 5) tip değişimleri (güvenli widening otomatik; narrowing lint)
    for (const [colName, col] of columnEntries(table)) {
      if (!liveCols.has(colName)) continue;
      diffType(name, colName, col, liveCols.get(colName)!, stmts, lint);
    }
  }

  // düşen tablolar (destructive → lint)
  for (const n of live.keys()) {
    if (n in wanted) continue;
    stmts.push(`DROP TABLE ${quoteIdent(n)}`);
    lint.push({ kind: 'destructive', table: n, detail: `DROP TABLE ${n} — tüm veri silinir` });
  }

  stmts.push(...fks); // FK'ler en son (ORM-CONTRACT §2)

  if (stmts.length > 0) {
    const head: string[] = [];
    if (needsVectorExt) head.push('CREATE EXTENSION IF NOT EXISTS vector');
    if (orderedNew.some((tb) => columnValues(tb).some((c) => c._pk))) head.push(UUIDV7_SQL);
    stmts.unshift(...head);
  }

  return { stmts, lint, schemaHash: hash };
}

// ---------------------------------------------------------------- uygula

export class LintError extends Error {
  readonly lint: LintIssue[];
  constructor(lint: LintIssue[]) {
    super(`push lint nedeniyle durdu (${lint.length}): ` + lint.map((l) => l.detail).join('; '));
    this.name = 'LintError';
    this.lint = lint;
  }
}

/**
 * Planı uygular; her push'u `_metatron_push_log`'a yazar (ORM-CONTRACT §3).
 * Tablo ensurePushLog ile kurulur/yükseltilir (MERGE-CONTRACT §3: source + meta kolonları).
 * Push girdileri `source='push'`, `meta='{}'` yazar (merge girdileri için merge.ts).
 * onLint 'log' (varsayılan): lint'leri console.warn ile logla, devam et.
 * onLint 'fail': lint varsa hiçbir stmt çalıştırmadan LintError fırlat.
 */
export async function applyPlan(
  sql: SqlLike,
  plan: PushPlan,
  opts?: { onLint?: 'log' | 'fail' },
): Promise<void> {
  const onLint = opts?.onLint ?? 'log';
  if (plan.lint.length > 0) {
    if (onLint === 'fail') throw new LintError(plan.lint);
    for (const l of plan.lint) console.warn(`⚠ lint: ${l.detail}`);
  }
  await ensurePushLog(sql);
  for (const s of plan.stmts) await sql.unsafe(s);
  await sql`
    INSERT INTO _metatron_push_log (schema_hash, stmts, lint, source, meta)
    VALUES (${plan.schemaHash}, ${sql.json(plan.stmts)}, ${sql.json(plan.lint)}, ${'push'}, ${sql.json({})})`;
}
