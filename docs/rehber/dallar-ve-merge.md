# Dallar ve merge

Dal, veritabanının **yazılabilir gerçek bir kopyasıdır**: main'de denemek
istemediğin şema değişikliğini dalda serbestçe yaparsın; iş bitince değişiklik
`merge_plan → merge_apply` ile — kör replay olmadan, çatışma varsa kartlarıyla
— main'e taşınır.

Bu sayfadaki plan ve çatışma çıktıları, merge motorunun iki gerçek PostgreSQL
üzerindeki çalıştırmasından birebir alınmıştır.

## Dal açmak

Üç yol var: paneldeki buton, GitHub webhook'u (git dalı açılınca otomatik), ya
da CLI:

```bash
metatron create feat/x     # dalı aç (bağlantı dizesini basar)
metatron use feat/x        # mevcut dala geç — .env.local'i bu dala yazar
```

Dalın altında ZFS copy-on-write vardır: klon ~30 ms'de doğar, panelden uçtan
uca ~2,5 sn sürer ve diskte yalnızca yazdığın bloklar yer tutar (ölçümler:
[Dallar](../dallar.md)). `metatron use` sonrası `metatron dev` zaten bu dalın
Postgres'ine push'lar — yani **dalda şema değiştirmek için ekstra bir şey
yapmassın**; önceki sayfadaki akış aynen devam eder, hedef dalındır.

## Merge neden iki adım?

Dalın şema geçmişi `_metatron_push_log`'da durur (her `applyPlan` bir satır).
Merge-up, dalın bu günlükteki **delta**'sını main'e uygular. İki adımın
sebebi güvenliktir:

1. **Plan** (`branch:merge_plan`) — delta hesaplanır, statik kontroller koşar
   ve tüm DDL main'de **dry-run** edilir (`BEGIN; …; ROLLBACK` — Postgres
   DDL'i transactionaldır, iz kalmaz). Sonuç: stmt listesi + çatışma kartları.
2. **Apply** (`branch:merge_apply`) — plan yeniden üretilip bütünlüğü
   doğrulanmadan hiçbir şey yazılmaz; çatışma çözülmeden commit yoktur.

İstemciden akış (iki uç da panel fn'idir):

```ts
const { value: plan } = await client.query("branch:merge_plan", { branch: "feat_x" });
if (plan.conflicts.length === 0) {
  await client.mutation("branch:merge_apply", {
    branch: "feat_x",
    planDigest: plan.planDigest,
  });
}
```

## Temiz merge: plan böyle görünür

Dal `posts`'a `likes` kolonu eklemiş, main ata sonrası kımıldamamış — gerçek
plan çıktısı:

```json
{
  "ancestorSeq": 1,
  "deltaSeqs": [2],
  "stmts": ["ALTER TABLE \"posts\" ADD COLUMN \"likes\" integer NOT NULL DEFAULT 0"],
  "conflicts": [],
  "mainHash": "d6aa14c4f21e497e",
  "branchHash": "b3bdcf3d2652b43d",
  "planDigest": "ba6645bf26a3447e"
}
```

> Not: bu, merge motorunun (`planMergeUp`) çıktısıdır. Panel ucu
> `branch:merge_plan` bunun üst kümesini döner — `available`, `branch`,
> `parent`, `stmtCount` alanları ekler; `conflicts` ve `planDigest` birebir aynıdır.

`conflicts: []` ise apply tek transaction'da koşar ve main'in push_log'una
`source: 'merge'` kaydı düşer (gerçek satır):

```json
{
  "seq": "2",
  "schema_hash": "merge:7180887481e945ea",
  "source": "merge",
  "meta": { "deltaSeqs": [2], "fromBranch": "dal", "planDigest": "ba6645bf26a3447e", "planMainHash": "d6aa14c4f21e497e" }
}
```

## Çatışma kartları

Çatışma, merge'in reddi değil **raporudur**: her kart sınıfını, nesnesini,
insan dili açıklamayı ve çözüm seçeneklerini taşır. Üç sınıf vardır:
`schema`, `data`, `constraint`.

**schema — `42701` (nesne main'de zaten var).** İki taraf da `users`'a `email`
kolonunu farklı tiple eklemiş (dalda `text`, main'de `integer`); dry-run'dan
dönen gerçek kart:

```json
{
  "class": "schema",
  "code": "42701",
  "object": "users.email",
  "detail": "nesne main'de zaten var (main bağımsız değişti): column \"email\" of relation \"users\" already exists",
  "options": [
    "dalı güncel main'e rebase et",
    "kolon/tip dönüşümünü planla (expand-migrate-contract)"
  ]
}
```

**constraint — `2BP01` (bağımlı nesne var).** Dal `posts` tablosunu düşürmüş,
ama main ata sonrası `posts`'a FK'lı `comments` eklemiş; gerçek kart:

```json
{
  "class": "constraint",
  "code": "2BP01",
  "object": "posts",
  "detail": "silinen nesneye main'de bağımlı nesne var: cannot drop table posts because other objects depend on it",
  "options": [
    "dalı geri al",
    "bağımlı FK'yı main'de de kaldır (bağlı satırlar kontrol edilmeli)",
    "silmek yerine arşivle"
  ]
}
```

**data — `23505` (unique violation).** v1 delta'sı DDL taşıdığından beklenmez,
ama sınıf eşleştirmesi hazırdır; seçenekler arasında "uuid/uuidv7 PK kullan
(merge lab s9)" vardır — `uuidPk()` önerisinin sebebi budur.

Dry-run'dan önce koşan **statik kontroller** de kart üretir (hızlı ve
açıklanabilir): işaretsiz rename (`rename-suspect` — dalı `.renamedFrom` ile
yeniden push'la), main'de değişmiş nesneyi drop etme (`drop-changed-in-main`),
ve `DROP CONSTRAINT` içeren delta (v1'de apply **edilemez** — bilinçli onay
bayrağı henüz yok).

## Çözülmeden commit yok, bayat planla commit yok

- `conflicts` boş değilse apply reddeder: fn tarafında
  `409 { "error": { "code": "PLAN_CONFLICT", …, "data": { "conflicts": [...] } } }`.
- Plan aldıktan sonra **main değiştiyse** approval düşer. Motor hatası (gerçek
  mesaj): `main plan'dan sonra değişti (plan: d6aa14c4f21e497e, güncel:
  a36464bca3f50abd) — yeniden planla`; panel bunu `409 PLAN_STALE` olarak
  döner. Çift kontrol vardır: apply, planı **yeniden üretir** ve senin
  gönderdiğin `planDigest` tutmazsa hiç koşmaz. Çözüm tek: yeniden planla
  (canlı doğrulandı — yeniden planlanan merge temiz uygulandı).
- Dal bu main'den doğmamışsa (push_log ortak öneki yok): `NO_COMMON_ANCESTOR`.

## Merge sonrası: dal rebase edilir

Merge'den sonra dalın günlüğü main'inkinden farklıdır; aynı dalı tekrar plan'a
sokarsan delta hâlâ oradadır ve dry-run bu kez `42701` üretir — seçeneklerin
ilki "dalı güncel main'e rebase et"tir (canlı çıktı). Bu kör-replay-YOK
ilkesinin doğal sonucudur: merge edilmiş dal, main'in taze fiziksel kopyası
olarak yeniden doğar; ondan sonraki plan `stmts: []` döner ve apply no-op'tur
(`{ appliedSeq: null }` — canlı doğrulandı). Pratikte: merge sonrası dalı
kapat ya da taze kopyadan devam et.

## Dürüst not: veri taşınmaz (v1)

Merge-up v1'de **yalnızca şema delta'sını** taşır. Dalda ürettiğin satırlar
main'e **kopyalanmaz** — hücre seviyesi 3-way veri merge'i ve çakışan id
remap'i bilinçli olarak v1 dışındadır. Merge diyaloğunda/planında buna güvenme;
test verisini dalda tut, main'e yalnız şema geç.

## Yetki

`branch:merge_plan` bir query'dir — Okuyucu dahil herkes planı görebilir.
`branch:merge_apply` mutation kapısından geçer (en az Geliştirici); ek olarak
parent dal korumalı bir ref'teyse (`main`, `release/*` gibi) çağıranın
projedeki efektif yetkisinde `korumali_yaz` şarttır — yoksa `403 FORBIDDEN`.
Rolü olmayan token (tam yetki, geriye uyum) her zaman geçer. Ayrıntı:
[workspace ve yetki](../workspace-yetki.md).

Şimdi şunu yapabileceksin: dalda serbestçe şema değiştirip değişikliği
çatışma kartlarıyla, güvenli ve izlenebilir biçimde main'e taşımak. Rehberin
sonuna geldin — derinlik için teknik sayfalar: [merge motoru](../merge-motoru.md)
· [ORMIM](../ormim.md) · [dallar](../dallar.md).

> Kaynak: `metatron/MERGE-CONTRACT.md` · `packages/orm/src/merge.ts` ·
> `panel/src/fn/merge.ts` (uçlar, yetki, PLAN_STALE) · canlı çıktılar:
> embedded-postgres 18 merge laboratuvarı, 2026-08-02
> (`/tmp/rehber-test/05-merge.mjs`, `06-merge-2bp01.mjs`; çıktılar
> `/tmp/rehber-test/out/s*.json`)
