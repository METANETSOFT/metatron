// ORMIM cursor pagination korkuluğu — REGRESYON TESTİ (db-branching#17 / ORM-CONTRACT §8).
// Ölçülen hata: get-convex/convex-backend#508 — split'in ilk parçası cursor'u `null`'a
// (= "tablonun en başı") düşürüyor → 2. ve sonraki sayfalarla duplicate.
//
// Bu dosya bir sorgu motoru test etmiyor (ORMIM'de henüz yok — bkz. pagination.ts başlığı);
// `fetchPage` burada sadece sözleşmeyi (CursorAnchor/SortKey/isAfterCursor) gerçek satır
// verisine karşı sınamak için tanımlanmış YEREL bir yardımcıdır (src/ altında DEĞİL — public
// API'ye dahil edilmedi, kapsam dışına taşmasın diye).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  afterCursor,
  compareBySortKey,
  defineSortKey,
  isAfterCursor,
  mergePages,
  PaginationContractError,
  splitPage,
  START_CURSOR,
} from '../src/pagination.ts';
import type { CursorAnchor, PageRequest, PageResult, SortKey } from '../src/pagination.ts';

interface Row {
  ts: number; // "created_at" — KASITLI OLARAK tekil değil (boundary'de eşit değerler var)
  id: string; // PK — tiebreaker
  val: string;
}

const sortKey: SortKey<Row> = defineSortKey<Row>(['ts', 'id'], 'id');

// 37 satır, pageSize=10 → 4 sayfa (10/10/10/7). Sayfa sınırlarında (idx 9|10, 19|20, 29|30)
// KASITLI aynı `ts` değeri: tiebreaker (id) olmadan boundary'de duplicate/skip olurdu.
function buildRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 37; i++) {
    let ts = 1000 + i * 10;
    if (i === 10) ts = 1000 + 9 * 10; // idx9 ile aynı ts (sayfa1/sayfa2 sınırı)
    if (i === 20) ts = 1000 + 19 * 10; // idx19 ile aynı ts (sayfa2/sayfa3 sınırı)
    if (i === 30) ts = 1000 + 29 * 10; // idx29 ile aynı ts (sayfa3/sayfa4 sınırı)
    rows.push({ ts, id: `id-${String(i).padStart(3, '0')}`, val: `v${i}` });
  }
  return rows;
}

/**
 * YEREL test yardımcısı (src/ değil): bellek-içi bir "tablo"dan sözleşmeye (isAfterCursor)
 * uyan bir sayfa çeker. Gerçek bir implementasyon Postgres'e WHERE (ts,id) > (…) ORDER BY
 * ts,id LIMIT n şeklinde çevirir — semantik BİREBİR aynı (bkz. ORM-CONTRACT §8).
 */
function fetchPage(all: Row[], key: SortKey<Row>, req: PageRequest): PageResult<Row> {
  const sorted = [...all].sort((a, b) => compareBySortKey(a, b, key));
  const filtered = sorted.filter((r) => isAfterCursor(r, req.cursor, key));
  const rows = filtered.slice(0, req.pageSize);
  const hasMore = filtered.length > req.pageSize;
  return {
    rows,
    cursor: req.cursor,
    endCursor: rows.length > 0 ? afterCursor(rows[rows.length - 1], key) : req.cursor,
    hasMore,
  };
}

function paginateAll(all: Row[], key: SortKey<Row>, pageSize: number): PageResult<Row>[] {
  const pages: PageResult<Row>[] = [];
  let cursor: CursorAnchor = START_CURSOR;
  for (;;) {
    const page = fetchPage(all, key, { cursor, pageSize });
    pages.push(page);
    if (!page.hasMore) break;
    cursor = page.endCursor;
  }
  return pages;
}

// ---------------------------------------------------------------- tip korkuluğu (derleme zamanı)

// CursorAnchor'a null/undefined atanamaz — union'da yok. Bu satırlar SİLİNİRSE veya
// tip gevşetilirse `tsc --noEmit` "@ts-expect-error kullanılmadı" hatası verir (ORM-CONTRACT §8).
// @ts-expect-error — CursorAnchor null kabul etmez (korkuluk, tip düzeyinde imkânsız)
const _typeGuardCursorNull: CursorAnchor = null;
// @ts-expect-error — CursorAnchor undefined kabul etmez
const _typeGuardCursorUndef: CursorAnchor = undefined;
// @ts-expect-error — PageRequest.cursor OPSİYONEL DEĞİL; atlanamaz
const _typeGuardReqNoCursor: PageRequest = { pageSize: 10 };
// @ts-expect-error — 'after' varyantında key zorunlu string; eksik olamaz
const _typeGuardAfterNoKey: CursorAnchor = { at: 'after' };
void _typeGuardCursorNull;
void _typeGuardCursorUndef;
void _typeGuardReqNoCursor;
void _typeGuardAfterNoKey;

// ---------------------------------------------------------------- regresyon: normal pagination

test('fetchPage zinciri: 4 sayfa (37 satır / pageSize 10), her satır TAM BİR KEZ, sıralı', () => {
  const all = buildRows();
  const pages = paginateAll(all, sortKey, 10);

  assert.equal(pages.length, 4);
  assert.deepEqual(pages.map((p) => p.rows.length), [10, 10, 10, 7]);

  const ids = pages.flatMap((p) => p.rows.map((r) => r.id));
  assert.equal(ids.length, 37, 'toplam satır sayısı 37 olmalı (skip yok)');
  assert.equal(new Set(ids).size, 37, 'her id TAM BİR KEZ görünmeli (duplicate yok)');
  assert.deepEqual(
    ids,
    [...all].sort((a, b) => compareBySortKey(a, b, sortKey)).map((r) => r.id),
    'sıra, tam sıralama anahtarına göre olmalı',
  );
});

test('boundary satırı: eşit ts değerli satırlar tiebreaker (id) ile doğru sayfaya düşer', () => {
  const all = buildRows();
  const pages = paginateAll(all, sortKey, 10);

  // idx9 (id-009) ve idx10 (id-010) aynı ts'e sahip — id-009 sayfa1'de, id-010 sayfa2'de olmalı.
  assert.ok(pages[0].rows.some((r) => r.id === 'id-009'));
  assert.ok(!pages[0].rows.some((r) => r.id === 'id-010'));
  assert.ok(pages[1].rows.some((r) => r.id === 'id-010'));
  assert.ok(!pages[1].rows.some((r) => r.id === 'id-009'));

  // page1.endCursor ile page2.cursor birebir aynı olmalı (zincir kopuk değil)
  assert.deepEqual(pages[1].cursor, pages[0].endCursor);
});

// ---------------------------------------------------------------- splitPage korkuluğu

test('splitPage: NON-first sayfa bölündüğünde ilk parça, sayfanın KENDİ cursor\'unu devralır (start\'a düşmez)', () => {
  const all = buildRows();
  const [page1] = paginateAll(all, sortKey, 10); // page1.cursor = START_CURSOR
  const page2 = fetchPage(all, sortKey, { cursor: page1.endCursor, pageSize: 10 }); // page2.cursor ≠ start

  assert.equal(page2.cursor.at, 'after', 'page2 tablonun ortasından başlıyor, start DEĞİL');

  const [a, b] = splitPage(page2, sortKey, 4); // 10 satırı 4+6 böl

  // KORKULUK: split'in İLK parçası page2'nin KENDİ cursor'unu devralır — start'a düşürülmez.
  assert.deepEqual(a.cursor, page2.cursor);
  assert.notDeepEqual(a.cursor, START_CURSOR);

  // süreklilik: ikinci parçanın cursor'u ilk parçanın endCursor'u
  assert.deepEqual(b.cursor, a.endCursor);
  // dış sınırlar korunur: ilk parçanın başı ve son parçanın sonu orijinal sayfayla aynı
  assert.deepEqual(b.endCursor, page2.endCursor);
  assert.deepEqual([...a.rows, ...b.rows], page2.rows);
});

test('mergePages: split\'in ürettiği parçalar geri birleşince orijinal sayfayla birebir aynı', () => {
  const all = buildRows();
  const [page1] = paginateAll(all, sortKey, 10);
  const page2 = fetchPage(all, sortKey, { cursor: page1.endCursor, pageSize: 10 });
  const [a, b] = splitPage(page2, sortKey, 4);

  const merged = mergePages([a, b]);
  assert.deepEqual(merged, page2);
});

test('KORKULUK KANITI: split ilk parçası start\'a düşürülürse → sonraki fetch tablonun başından döner (duplicate)', () => {
  const all = buildRows();
  const [page1] = paginateAll(all, sortKey, 10);
  const page2 = fetchPage(all, sortKey, { cursor: page1.endCursor, pageSize: 10 });
  const [correctA] = splitPage(page2, sortKey, 4);

  // Convex#508'i BİLEREK taklit ediyoruz: split'in ilk parçasının cursor'u yanlışlıkla
  // 'start'a düşürülmüş olsun (splitPage'in DOĞRU ürettiği `correctA.cursor` YERİNE).
  const buggyA: PageResult<Row> = { ...correctA, cursor: START_CURSOR };
  assert.notDeepEqual(buggyA.cursor, correctA.cursor, 'sabotaj gerçekten cursor\'u değiştirmiş olmalı');

  // Bu bozuk cursor'la "devam" fetch'i yapılırsa (Convex'in yaptığı şey), tablonun
  // en başından döner → page1'in satırlarıyla ÇAKIŞIR (duplicate).
  const resumed = fetchPage(all, sortKey, { cursor: buggyA.cursor, pageSize: 5 });
  const overlap = resumed.rows.filter((r) => page1.rows.some((p1) => p1.id === r.id));
  assert.ok(overlap.length > 0, 'korkuluk ihlal edilince page1 ile duplicate satır üretilmeli');

  // mergePages ise bu sabotajı SESSİZCE yutmaz: page1'in HEMEN ardından geldiğini iddia eden
  // buggyA'nın cursor'u (= START_CURSOR) page1.endCursor'a eşit DEĞİL — zincir kopukluğu
  // yakalanır ve patlar (duplicate sessizce üretilmez).
  const b = splitPage(page2, sortKey, 4)[1];
  assert.throws(() => mergePages([page1, buggyA, b]), PaginationContractError);
});

test('mergePages: kopuk zincir (cursor ≠ önceki endCursor) → PaginationContractError, sessiz duplicate YOK', () => {
  const all = buildRows();
  const pages = paginateAll(all, sortKey, 10);
  assert.throws(() => mergePages([pages[0], pages[2]]), PaginationContractError); // page1 sonrası page3 (page2 atlanmış)
});

test('defineSortKey: tiebreaker son eleman değilse hata (tekillik şartı, ORM-CONTRACT §8)', () => {
  assert.throws(
    () => defineSortKey<Row>(['id', 'ts'], 'id'),
    /tiebreaker.*columns dizisinin SON elemanı olmalı/,
  );
});
