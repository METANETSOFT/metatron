/**
 * ORMIM cursor pagination — SÖZLEŞME + korkuluk (ORM-CONTRACT §8; db-branching#17,
 * METANETSOFT/metatron#2 "Bonus korkuluk").
 *
 * KAPSAM: ORMIM'de bugün bir sorgu runtime'ı / `usePaginatedQuery` YOK (bkz. kök
 * `PLAN.md` → "Açık işler"). Bu dosya, gelecekte pagination yazılırken uyulması
 * ZORUNLU olan TİP + KURAL seviyesindeki korkuluktur — sayfaları gerçekten bir
 * Postgres tablosundan çeken bir motor DEĞİLDİR; o motorun cursor'ları için
 * sözleşmedir (tipler + split/merge invariant'ları + cursor karşılaştırma anlamı).
 *
 * Ölçülen hata (kaynak): https://github.com/get-convex/convex-backend/issues/508
 * Convex'in `splitPaginatedQueryPage`i, büyük bir sayfayı ikiye bölerken İLK parça
 * için cursor'u `null`'a düşürüyor. Protokolde `null` = "tablonun en başı" demek
 * olduğundan, split ilk parça tablonun ortasından bir yerden geliyor olsa da
 * ikinci ve sonraki gerçek sayfalarla ÇAKIŞAN (duplicate) satırlar üretiliyor.
 *
 * Korkuluk (bu dosyada uygulanan):
 *   1) `CursorAnchor` union'ında `null`/`undefined` YOKTUR — TypeScript seviyesinde
 *      atanamaz (bkz. tests/pagination.test.ts içindeki `@ts-expect-error` kanıtları).
 *      "Tablonun en başı" anlamı yalnız `{ at: 'start' }` ile ifade edilir; bu değer
 *      YALNIZCA gerçekten "tablonun en başı" isteniyorsa kullanılır.
 *   2) `splitPage`: ilk parçanın `cursor`'u ORİJİNAL sayfanın kendi `cursor`'undan
 *      DEVRALINIR — asla `{ at: 'start' }`'a sıfırlanmaz (sayfa zaten oradan
 *      başlamıyorsa). İkinci parçanın `cursor`'u ilk parçanın `endCursor`'udur.
 *   3) `mergePages`: ardışık parçaların `cursor`/`endCursor` zincirini YAPISAL
 *      olarak doğrular; kopuksa (ör. biri yanlışlıkla 'start'a düşürülmüşse)
 *      SESSİZCE birleştirip duplicate üretmez — `PaginationContractError` fırlatır.
 *   4) Sıralama anahtarı TEKİL olmak ZORUNDADIR: `defineSortKey` son kolonun
 *      `tiebreaker` (genelde PK) olmasını runtime'da doğrular — aksi halde eşit
 *      sıralama değerine sahip satırlarda boundary'de hem duplicate hem skip olur.
 */

// ---------------------------------------------------------------- cursor anchor

/**
 * Bir sayfanın "nereden başladığı/nereye kadar gittiği" bilgisi. KASITLI OLARAK
 * `null` içermeyen bir discriminated union: "tablonun en başı" `{ at: 'start' }`
 * ile açıkça ifade edilir; başka HİÇBİR varyant bu anlama gelmez. `{ at: 'after' }`
 * varyantında `key` alanı ZORUNLU `string`tir — opsiyonel değildir.
 */
export type CursorAnchor = { readonly at: 'start' } | { readonly at: 'after'; readonly key: string };

/** "Tablonun en başı" — bu değeri döndürmek/kullanmak İSTEYEREK yapılan bir seçimdir. */
export const START_CURSOR: CursorAnchor = { at: 'start' };

// ---------------------------------------------------------------- sıralama anahtarı

/**
 * Sayfalama sıralaması. `columns` soldan sağa öncelik sırasıyla karşılaştırılır.
 * `tiebreaker`, tekilliği garanti eden kolondur (genelde PK) ve `columns`'un
 * SON elemanı OLMAK ZORUNDADIR — `defineSortKey` bunu runtime'da doğrular.
 * Tekil olmayan bir sıralama anahtarı, eşit sıralama değerine sahip satırlarda
 * boundary'de hem duplicate hem skip üretir (ORM-CONTRACT §8).
 */
export interface SortKey<Row> {
  readonly columns: readonly (keyof Row & string)[];
  readonly tiebreaker: keyof Row & string;
}

export function defineSortKey<Row>(
  columns: readonly (keyof Row & string)[],
  tiebreaker: keyof Row & string,
): SortKey<Row> {
  if (columns.length === 0) {
    throw new Error('defineSortKey: columns boş olamaz — en az tiebreaker (PK) gerekir');
  }
  if (columns[columns.length - 1] !== tiebreaker) {
    throw new Error(
      `defineSortKey: tiebreaker ('${tiebreaker}') columns dizisinin SON elemanı olmalı ` +
        `(şu an sonuncu: '${columns[columns.length - 1]}') — tekillik şartı (ORM-CONTRACT §8); ` +
        `aksi halde eşit sıralama değerli satırlarda boundary'de hem duplicate hem skip olur`,
    );
  }
  return { columns, tiebreaker };
}

// ---------------------------------------------------------------- karşılaştırma

function compareScalar(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  throw new Error(`compareScalar: karşılaştırılamayan çift (${typeof a} vs ${typeof b})`);
}

/** İki satırı `sortKey.columns` sırasıyla (soldan sağa, ilk fark eden kolon kazanır) karşılaştırır. */
export function compareBySortKey<Row>(a: Row, b: Row, sortKey: SortKey<Row>): number {
  for (const col of sortKey.columns) {
    const c = compareScalar((a as Record<string, unknown>)[col], (b as Record<string, unknown>)[col]);
    if (c !== 0) return c;
  }
  return 0;
}

// ---------------------------------------------------------------- cursor encode/decode

function cursorPart(v: unknown): unknown {
  if (v instanceof Date) return { __date: v.toISOString() };
  if (typeof v === 'bigint') return { __bigint: v.toString() };
  return v;
}

function decodeCursorPart(v: unknown): unknown {
  if (v !== null && typeof v === 'object') {
    if ('__date' in (v as Record<string, unknown>)) return new Date((v as { __date: string }).__date);
    if ('__bigint' in (v as Record<string, unknown>)) return BigInt((v as { __bigint: string }).__bigint);
  }
  return v;
}

/** Bir satırın sıralama anahtarı değerlerini opak (base64url) bir cursor string'ine kodlar. */
export function encodeCursorKey<Row>(row: Row, sortKey: SortKey<Row>): string {
  const values = sortKey.columns.map((c) => cursorPart((row as Record<string, unknown>)[c]));
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

/** `encodeCursorKey` ile üretilmiş bir cursor'u sıralama anahtarı değerlerine geri çevirir. */
export function decodeCursorKey(cursor: string): unknown[] {
  const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
  return raw.map(decodeCursorPart);
}

/** `row`dan SONRA gelen konumu işaret eden bir `CursorAnchor` üretir (bir sonraki sayfanın `cursor`'u). */
export function afterCursor<Row>(row: Row, sortKey: SortKey<Row>): CursorAnchor {
  return { at: 'after', key: encodeCursorKey(row, sortKey) };
}

/**
 * `row`, `cursor`'un işaret ettiği konumdan KESİN OLARAK SONRA mı? `cursor.at === 'start'`
 * her satır için `true`dur (tanım gereği: tablonun en başından her şey "sonra"dır).
 * Tam eşitlik (satır cursor'un TAM kendisiyse) `false` döner — cursor bir satırı değil,
 * bir ARADAKİ konumu işaret eder.
 */
export function isAfterCursor<Row>(row: Row, cursor: CursorAnchor, sortKey: SortKey<Row>): boolean {
  if (cursor.at === 'start') return true;
  const decoded = decodeCursorKey(cursor.key);
  for (let i = 0; i < sortKey.columns.length; i++) {
    const c = compareScalar((row as Record<string, unknown>)[sortKey.columns[i]], decoded[i]);
    if (c !== 0) return c > 0;
  }
  return false;
}

function cursorEquals(a: CursorAnchor, b: CursorAnchor): boolean {
  if (a.at !== b.at) return false;
  return a.at === 'start' || a.key === (b as { key: string }).key;
}

// ---------------------------------------------------------------- sayfa tipleri

/**
 * Bir sayfa isteği. `cursor` ZORUNLU alandır (opsiyonel DEĞİL) — çağıran taraf
 * ilk sayfa için bilinçli olarak `START_CURSOR` geçmek zorundadır; alanı atlamak
 * (ya da `null`/`undefined` geçmek) derleme hatasıdır.
 */
export interface PageRequest {
  readonly cursor: CursorAnchor;
  readonly pageSize: number;
}

/**
 * Çekilmiş bir sayfa. `cursor`/`endCursor` de ZORUNLU alanlardır. `cursor`, bu
 * sayfanın BAŞLADIĞI konumdur (isteğin cursor'unun echo'su); `endCursor`, bu
 * sayfadan sonraki konumdur (bir sonraki `PageRequest.cursor`'u).
 */
export interface PageResult<Row> {
  readonly rows: readonly Row[];
  readonly cursor: CursorAnchor;
  readonly endCursor: CursorAnchor;
  readonly hasMore: boolean;
}

export class PaginationContractError extends Error {}

/**
 * Zaten çekilmiş TEK bir sayfayı ikiye böler (ör. adaptif sayfa boyutlandırma —
 * bir sayfa öngörülenden büyük çıktığında daha küçük parçalara ayrılması).
 *
 * KORKULUK (db-branching#17 / ORM-CONTRACT §8 — Convex convex-backend#508'in
 * ÖNLENMESİ): ilk parça `page.cursor`'u DEVRALIR — sayfa zaten `{ at: 'start' }`
 * değilse HİÇBİR KOŞULDA `{ at: 'start' }`'a düşürülmez. İkinci parçanın
 * `cursor`'u ilk parçanın `endCursor`'udur (süreklilik; kopukluk yok).
 */
export function splitPage<Row>(
  page: PageResult<Row>,
  sortKey: SortKey<Row>,
  at: number,
): [PageResult<Row>, PageResult<Row>] {
  if (!Number.isInteger(at) || at <= 0 || at >= page.rows.length) {
    throw new PaginationContractError(
      `splitPage: 'at' (${at}) 0 < at < rows.length (${page.rows.length}) aralığında tam sayı olmalı`,
    );
  }
  const boundary = afterCursor(page.rows[at - 1], sortKey);
  const first: PageResult<Row> = {
    rows: page.rows.slice(0, at),
    cursor: page.cursor, // <-- KORKULUK: orijinal sayfanın cursor'u; ASLA start'a sıfırlanmaz
    endCursor: boundary,
    hasMore: true, // ikinci parça hemen ardından geliyor
  };
  const second: PageResult<Row> = {
    rows: page.rows.slice(at),
    cursor: boundary, // <-- süreklilik: ilk parçanın endCursor'u
    endCursor: page.endCursor,
    hasMore: page.hasMore,
  };
  return [first, second];
}

/**
 * `splitPage` ile üretilmiş (veya ayrı ayrı çekilmiş ama ARDIŞIK olması gereken)
 * sayfaları TEK sayfaya geri birleştirir.
 *
 * KORKULUK: her parçanın `cursor`'u, ÖNCEKİ parçanın `endCursor`'una YAPISAL
 * olarak eşit olmalı — eşit değilse (ör. biri yanlışlıkla `{ at: 'start' }`'a
 * düşürülmüşse) SESSİZCE birleştirip duplicate/skip üretmez; `PaginationContractError`
 * fırlatır. Bu, split'in cursor'u yanlış taşıdığı durumda hatanın SESSİZCE
 * yayılmayıp erken patlamasını sağlar.
 */
export function mergePages<Row>(pages: readonly PageResult<Row>[]): PageResult<Row> {
  if (pages.length === 0) throw new PaginationContractError('mergePages: boş liste birleştirilemez');
  for (let i = 1; i < pages.length; i++) {
    if (!cursorEquals(pages[i].cursor, pages[i - 1].endCursor)) {
      throw new PaginationContractError(
        `mergePages: sayfa ${i}'in cursor'u önceki sayfanın endCursor'una eşit değil ` +
          `(${JSON.stringify(pages[i].cursor)} ≠ ${JSON.stringify(pages[i - 1].endCursor)}) — ` +
          `kopuk zincir; bir parça yanlışlıkla 'start'a düşürülmüş olabilir (ORM-CONTRACT §8)`,
      );
    }
  }
  return {
    rows: pages.flatMap((p) => p.rows),
    cursor: pages[0].cursor,
    endCursor: pages[pages.length - 1].endCursor,
    hasMore: pages[pages.length - 1].hasMore,
  };
}
