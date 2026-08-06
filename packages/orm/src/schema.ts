/**
 * ORMIM — şema tanımı + DDL üretimi (ORM-CONTRACT.md §1).
 *
 * Tek kaynak: bu dosyadaki builder'lar hem TS tip çıkarımını (Infer)
 * hem de bağımlılık sıralı CREATE TABLE / index / FK DDL'ini üretir.
 */

export type ColTypeName =
  | 'text'
  | 'integer'
  | 'bigint'
  | 'boolean'
  | 'timestamptz'
  | 'jsonb'
  | 'uuid'
  | 'enum'
  | 'vector'
  | 'tsvector';

export type OnDelete = 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';

export interface RefDef {
  fn: () => AnyColumn;
  onDelete?: OnDelete;
}

/**
 * Kolon builder'ı. Generic'ler yalnız tip seviyesinde yaşar:
 *   T        — TS değer tipi (text → string, timestamptz → Date, ...)
 *   Nullable — true ise Infer çıktısında `T | null`
 *
 * Zincir metotları aynı nesneyi mutate edip farklı generic ile döndürür
 * (drizzle modeli): runtime tek nesne, tip seviyesinde kesin zincir.
 */
export class ColumnBuilder<T, Nullable extends boolean> {
  declare readonly _tsType: T;
  declare readonly _nullability: Nullable;

  readonly _type: ColTypeName;
  readonly _enumValues?: readonly string[];
  readonly _vectorDims?: number;
  _pk = false;
  _nullable = true;
  _unique = false;
  _default: unknown;
  _hasDefault = false;
  _defaultRaw?: string;
  _ref?: RefDef;
  _renamedFrom?: string;
  /** defineSchema sırasında bağlanır */
  _table?: AnyTable;
  _name = '';

  constructor(type: ColTypeName, opts?: { enumValues?: readonly string[]; vectorDims?: number }) {
    this._type = type;
    this._enumValues = opts?.enumValues;
    this._vectorDims = opts?.vectorDims;
  }

  notNull(): ColumnBuilder<T, false> {
    this._nullable = false;
    return this as unknown as ColumnBuilder<T, false>;
  }

  nullable(): ColumnBuilder<T, true> {
    this._nullable = true;
    return this as unknown as ColumnBuilder<T, true>;
  }

  /** JS değeri alır; SQL literal'ına çevrilir. uuidPk'nın DEFAULT'u raw `uuidv7()`'dir. */
  default(value: T): this {
    this._default = value;
    this._hasDefault = true;
    this._defaultRaw = undefined;
    return this;
  }

  /**
   * SQL ifadesini OLDUĞU GİBİ DEFAULT yapar — tırnaklanmaz.
   *
   * ⚠ NİYE GEREKLİ: `default('now()')` JS değeri olarak ele alınır ve
   * `DEFAULT 'now()'` üretir. Postgres bu TIRNAKLI metni tablo yaratılırken
   * BİR KEZ değerlendirip sabit bir damgaya dönüştürür — sonraki her satır
   * aynı tarihi alır. Gerçek Postgres'te ölçüldü:
   *   DEFAULT 'now()' → '2026-08-06 10:25:27+00'::timestamptz   (DONMUŞ)
   *   DEFAULT now()   → now()                                    (her satırda)
   * Bu tuzağa db-branching'in kontrol düzlemi düştü: 8 tablonun createdAt
   * varsayılanı canlı DB'de tek bir tarihe çakılıydı.
   */
  defaultRaw(sql: string): this {
    this._defaultRaw = sql;
    this._hasDefault = true;
    return this;
  }

  unique(): this {
    this._unique = true;
    return this;
  }

  /**
   * FK hedefi. NOT: fn'in dönüş tipi kasıtlı `any` — `references(() => schema.orgs.id)`
   * deseninde `schema` kendi initializer'ında referans edildiğinden, dönüş tipi
   * `AnyColumn`/`unknown` olsa TS çıkarım döngüsüne (TS7022/7024) giriyor.
   * Hedefin kolon olduğu runtime'da resolveRef ile doğrulanır.
   */
  references(fn: () => any, opts?: { onDelete?: OnDelete }): this {
    this._ref = { fn, onDelete: opts?.onDelete };
    return this;
  }

  /** push diff'inde drop+add yerine RENAME COLUMN üretilmesini sağlar (veri korunur). */
  renamedFrom(oldName: string): this {
    this._renamedFrom = oldName;
    return this;
  }

  /** Birincil anahtar işareti (nullable değil). uuid dışı PK için: t.integer().pk() —
   *  planPush'ta numeric-pk lint'i düşer (ORM-CONTRACT §6; uuid/uuidv7 önerilir). */
  pk(): ColumnBuilder<T, false> {
    this._pk = true;
    this._nullable = false;
    return this as unknown as ColumnBuilder<T, false>;
  }
}

export type AnyColumn = ColumnBuilder<any, any>;

function uuidPkCol(): ColumnBuilder<string, false> {
  const c = new ColumnBuilder<string, false>('uuid');
  c._pk = true;
  c._nullable = false;
  c._hasDefault = true;
  c._defaultRaw = 'uuidv7()';
  return c;
}

/** Kolon fabrikaları — ORM-CONTRACT §1'deki liste. Varsayılan: nullable. */
export const t = {
  text: () => new ColumnBuilder<string, true>('text'),
  integer: () => new ColumnBuilder<number, true>('integer'),
  bigint: () => new ColumnBuilder<bigint, true>('bigint'),
  boolean: () => new ColumnBuilder<boolean, true>('boolean'),
  timestamptz: () => new ColumnBuilder<Date, true>('timestamptz'),
  jsonb: <J = unknown>() => new ColumnBuilder<J, true>('jsonb'),
  uuid: () => new ColumnBuilder<string, true>('uuid'),
  /** uuidv7 DEFAULT'lu PK (kilitli karar; üretici fonksiyonu DDL paket içinde kurar). */
  uuidPk: (): ColumnBuilder<string, false> => uuidPkCol(),
  /** SQL tarafında `text` + inline CHECK (native PG enum DEĞİL — widening/ALTER derdi yok). */
  enum: <const V extends readonly [string, ...string[]]>(values: V) =>
    new ColumnBuilder<V[number], true>('enum', { enumValues: values }),
  vector: (dims: number) => new ColumnBuilder<number[], true>('vector', { vectorDims: dims }),
  tsvector: () => new ColumnBuilder<string, true>('tsvector'),
};

// ---------------------------------------------------------------- tablo ekleri

export type ExtraDef =
  | { kind: 'unique'; cols: [string, ...string[]] }
  | { kind: 'index'; name: string; cols: [string, ...string[]] }
  | { kind: 'check'; name: string; expr: string };

export interface TableExtrasBuilder {
  unique(...cols: [string, ...string[]]): ExtraDef;
  index(name: string): { on(...cols: [string, ...string[]]): ExtraDef };
  check(name: string, expr: string): ExtraDef;
}

const extrasBuilder: TableExtrasBuilder = {
  unique: (...cols) => ({ kind: 'unique', cols }),
  index: (name) => ({ on: (...cols) => ({ kind: 'index', name, cols }) }),
  check: (name, expr) => ({ kind: 'check', name, expr }),
};

export interface TableExtras {
  uniques: [string, ...string[]][];
  indexes: { name: string; cols: [string, ...string[]] }[];
  checks: { name: string; expr: string }[];
}

export interface TableDef<Cols extends Record<string, AnyColumn>> {
  readonly columns: Cols;
  readonly extras: TableExtras;
  /** defineSchema sırasında bağlanır */
  _name: string;
}

export type AnyTable = TableDef<any>;

/** `columns: any` üzerinde Object.entries/values unknown döndürür — tip'li erişim yardımcıları. */
export function columnEntries(table: AnyTable): [string, AnyColumn][] {
  return Object.entries(table.columns) as [string, AnyColumn][];
}
export function columnValues(table: AnyTable): AnyColumn[] {
  return Object.values(table.columns) as AnyColumn[];
}

/**
 * Dönüş değeri kolonlara doğrudan erişim de verir (`schema.orgs.id` deseni —
 * references(() => ...) ve Infer için). `columns`/`extras` adlı kolon isimleri
 * bu yüzden kullanılamaz.
 */
export function defineTable<Cols extends Record<string, AnyColumn>>(
  columns: Cols,
  extras?: (c: TableExtrasBuilder) => ExtraDef[],
): TableDef<Cols> & Cols {
  const ex: TableExtras = { uniques: [], indexes: [], checks: [] };
  for (const e of extras?.(extrasBuilder) ?? []) {
    if (e.kind === 'unique') ex.uniques.push(e.cols);
    else if (e.kind === 'index') ex.indexes.push({ name: e.name, cols: e.cols });
    else ex.checks.push({ name: e.name, expr: e.expr });
  }
  const table: TableDef<Cols> = { columns, extras: ex, _name: '' };
  return Object.assign(table, columns) as TableDef<Cols> & Cols;
}

// ---------------------------------------------------------------- şema

export type Schema<T extends Record<string, AnyTable>> = {
  readonly tables: T;
  /**
   * ORMIM'in YÖNETMEDİĞİ tablolar (ör. Better Auth'ın text-PK'lı user/session/account/
   * verification'ı) — foxapp göç haritası R1=b kararı. planPush bu adları diff'ten tamamen
   * dışlar: live'da varsa DROP planlanmaz, yoksa CREATE planlanmaz, lint üretilmez.
   * Liste schemaHash'e dahildir (listeden çıkarma davranış değişikliğidir, push'ta görünür).
   * Şema tablosuyla çakışan external adı planPush'ta hata fırlatır (sessizlik yok).
   */
  readonly external: readonly string[];
  /** Bağımlılık sıralı DDL: extension → uuidv7() → CREATE TABLE'lar → index'ler → FK'ler (en son). */
  ddl(): string[];
} & T;

export function defineSchema<T extends Record<string, AnyTable>>(
  tables: T,
  opts?: { external?: readonly string[] },
): Schema<T> {
  for (const reserved of ['tables', 'ddl', 'external'] as const) {
    if (reserved in tables) throw new Error(`'${reserved}' adında tablo tanımlanamaz (ayrılmış)`);
  }
  for (const [name, table] of Object.entries(tables)) {
    table._name = name;
    for (const [colName, col] of columnEntries(table)) {
      col._table = table;
      col._name = colName;
    }
  }
  const schema = {
    tables,
    external: Object.freeze([...new Set(opts?.external ?? [])]),
    ddl: () => buildDdl(tables),
  };
  return Object.assign(schema, tables) as Schema<T>;
}

// ---------------------------------------------------------------- TS tip çıkarımı

export type InferColumn<C> = C extends ColumnBuilder<infer T, infer N>
  ? N extends true
    ? T | null
    : T
  : never;

/** `type Member = Infer<typeof schema.tables.members>` (ORM-CONTRACT §1). */
export type Infer<T extends AnyTable> = {
  [K in keyof T['columns']]: InferColumn<T['columns'][K]>;
};

// ---------------------------------------------------------------- SQL üretimi

/**
 * uuidv7 üretici — paket içinde (kilitli karar). PG13+ (gen_random_uuid built-in).
 * İlk 6 byte = unix ms (big-endian), version bitleri 0111; variant bitleri
 * gen_random_uuid'den hazır gelir (10xx).
 */
export const UUIDV7_SQL =
  "CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid LANGUAGE sql VOLATILE AS $$ " +
  "SELECT encode(set_bit(set_bit(set_bit(set_bit(" +
  'overlay(uuid_send(gen_random_uuid()) placing ' +
  'substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6)' +
  ", 48, 0), 49, 1), 50, 1), 51, 1), 'hex')::uuid $$";

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString().replace(/'/g, "''")}'`;
  if (Array.isArray(v)) return `'[${v.join(',')}]'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Kolonun SQL tip metni. enum → text (CHECK ayrıca eklenir), vector → vector(n). */
export function sqlType(col: AnyColumn): string {
  switch (col._type) {
    case 'enum':
      return 'text';
    case 'vector':
      return `vector(${col._vectorDims})`;
    default:
      return col._type;
  }
}

export function columnDdl(name: string, col: AnyColumn): string {
  const parts = [quoteIdent(name), sqlType(col)];
  if (col._pk) {
    parts.push('PRIMARY KEY');
  } else {
    if (!col._nullable) parts.push('NOT NULL');
    if (col._unique) parts.push('UNIQUE');
  }
  if (col._hasDefault) parts.push(`DEFAULT ${col._defaultRaw ?? sqlLiteral(col._default)}`);
  if (col._type === 'enum' && col._enumValues?.length) {
    parts.push(`CHECK (${quoteIdent(name)} IN (${col._enumValues.map(sqlLiteral).join(', ')}))`);
  }
  return parts.join(' ');
}

export function createTableSql(table: AnyTable): string {
  const lines: string[] = [];
  for (const [name, col] of columnEntries(table)) lines.push('  ' + columnDdl(name, col));
  for (const cols of table.extras.uniques) lines.push(`  UNIQUE (${cols.map(quoteIdent).join(', ')})`);
  for (const ck of table.extras.checks) lines.push(`  CONSTRAINT ${quoteIdent(ck.name)} CHECK (${ck.expr})`);
  return `CREATE TABLE ${quoteIdent(table._name)} (\n${lines.join(',\n')}\n)`;
}

export function indexSql(tableName: string, idx: { name: string; cols: string[] }): string {
  return `CREATE INDEX ${quoteIdent(idx.name)} ON ${quoteIdent(tableName)} (${idx.cols.map(quoteIdent).join(', ')})`;
}

export interface FkDef {
  table: string;
  col: string;
  refTable: string;
  refCol: string;
  onDelete?: OnDelete;
}

export function resolveRef(col: AnyColumn, tableName: string, colName: string): FkDef {
  if (!col._ref) throw new Error(`${tableName}.${colName}: references() tanımsız`);
  const refCol = col._ref.fn();
  if (!refCol._table || !refCol._table._name) {
    throw new Error(`${tableName}.${colName}: references() hedefi bir şema tablosuna bağlı değil`);
  }
  return {
    table: tableName,
    col: colName,
    refTable: refCol._table._name,
    refCol: refCol._name,
    onDelete: col._ref.onDelete,
  };
}

export function tableFks(table: AnyTable): FkDef[] {
  const fks: FkDef[] = [];
  for (const [name, col] of columnEntries(table)) {
    if (col._ref) fks.push(resolveRef(col, table._name, name));
  }
  return fks;
}

export function fkSql(fk: FkDef): string {
  let s =
    `ALTER TABLE ${quoteIdent(fk.table)} ADD CONSTRAINT ${quoteIdent(`${fk.table}_${fk.col}_fk`)} ` +
    `FOREIGN KEY (${quoteIdent(fk.col)}) REFERENCES ${quoteIdent(fk.refTable)} (${quoteIdent(fk.refCol)})`;
  if (fk.onDelete) s += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
  return s;
}

/** referenced tablo önce; döngüde kalanlar tanım sırasıyla sona (FK'ler zaten en sonda üretilir). */
export function topoSortTables(tables: Record<string, AnyTable>): AnyTable[] {
  const deps = new Map<string, Set<string>>();
  for (const name of Object.keys(tables)) deps.set(name, new Set());
  for (const [name, table] of Object.entries(tables)) {
    for (const fk of tableFks(table)) {
      if (fk.refTable !== name && fk.refTable in tables) deps.get(name)!.add(fk.refTable);
    }
  }
  const done = new Set<string>();
  const out: AnyTable[] = [];
  let progress = true;
  while (done.size < deps.size && progress) {
    progress = false;
    for (const [name, d] of deps) {
      if (done.has(name)) continue;
      if ([...d].every((x) => done.has(x))) {
        done.add(name);
        out.push(tables[name]);
        progress = true;
      }
    }
  }
  for (const [name] of deps) if (!done.has(name)) out.push(tables[name]);
  return out;
}

/** Tüm şemanın DDL'i — ORM-CONTRACT §1: bağımlılık sıralı, FK'ler en son, vector extension başta. */
export function buildDdl(tables: Record<string, AnyTable>): string[] {
  const stmts: string[] = [];
  const ordered = topoSortTables(tables);
  const allCols = ordered.flatMap((tb) => columnValues(tb));
  if (allCols.some((c) => c._type === 'vector')) stmts.push('CREATE EXTENSION IF NOT EXISTS vector');
  if (allCols.some((c) => c._pk)) stmts.push(UUIDV7_SQL);
  for (const tb of ordered) stmts.push(createTableSql(tb));
  for (const tb of ordered) for (const idx of tb.extras.indexes) stmts.push(indexSql(tb._name, idx));
  for (const tb of ordered) for (const fk of tableFks(tb)) stmts.push(fkSql(fk));
  return stmts;
}
