# Merge motoru (Faz 2.5)

Dalın şema değişikliği main'e **güvenli** taşınır: kör replay yok, çözülmeden
commit yok, dry-run her zaman. Bu sayfa merge lab'in 9 senaryoluk kanıt matrisini
ve Faz 2.5 kontratını özetler.

> **Durum:** kontrat sabit (`MERGE-CONTRACT.md`), motor kodu **yazıldı ve 9/9 lab
> kanıtlı** (`packages/orm/src/merge.ts`), panel uçları **canlı ve dogfood kanıtlı**
> (Faz 2.5b — `branch:merge_plan` / `branch:merge_apply`, `panel/src/fn/merge.ts`;
> üretimde panel dal ağına kapalı olduğundan uçlar dürüst `available:false` zarfı
> döner, canlı kanıt dogfood'da `MERGE_BRANCH_SQL_DSN` ile yapıldı).

## Lab sonuçları — 9 senaryo (embedded PG, fiziksel hata kodlarıyla)

| # | Senaryo | PG kodu | Kural |
|---|---|---|---|
| s1 | A `email text` ekler, B `email integer` | `42701` duplicate_column | dal diff'i main'in **güncel** şemasıyla kesişim kontrolünden geçer; rapor + seçenekler (rebase · yeniden adlandır · tip dönüşüm planı) |
| s2 | kolon rename | — (sessiz) | information_schema rename'i **drop+add** görür → "drop X + add Y" çiftinde merge DURUR, rename şüphesini sorar (`.renamedFrom` ile işaretle) |
| s3 | iki dal aynı PK ile farklı satır | `23505` unique_violation | uuid/uuidv7 PK · dal-başına offset blok · ours/theirs/manual |
| s4 | dal FK'yı kaldırıp parent'ı düşürür; main'de bağlı satır var | `2BP01` dependent_objects | merge DURUR; "bağımlı nesne + N satır" raporu ve seçenekler |
| s5 | dal tabloyu siler, main aynı tabloya yazmış | — | drop edilen nesne main'de **atadan sonra** değiştiyse çatışma; değişmediyse drop serbest |
| s6 | şema + veri diff | — | `+ / - / ~ / =` raporu çalışıyor; büyük tabloda fdw/CDC (Faz 2+) |
| s7 | aynı hücre iki tarafta değişti | — | 3-way zorunlu: `base_/our_/their_` üçlüsüyle rapor; **last-writer-wins yok** |
| s8 | main parent siler, dalın child'ı merge'lenir | `23503` foreign_key_violation | DEFERRED ve immediate modda **garantili** yakalanır; ihlaller tabloya dökülür, çözülmeden commit yok |
| s9 | PK strateji matrisi | `23505` (serial) | serial → çakışma; uuid → temiz; offset → temiz ama id uzayı parçalı. Kilitli karar: **uuid/uuidv7 varsayılan PK** |

Literatür doğrulaması: sonuçlar Dolt/PlanetScale/migra ile birebir uyumlu
(Dolt sırası: schema → data → violations → commit; migra maintainer'ı da rename'in
güvenilir algılanamadığını doğruluyor). Neon/Supabase/Xata'da veri merge'i **yok**
(reset-from-parent) — Metatron'un ayrışma noktası.

## Ata ve delta

Dal DB'si main'in fiziksel kopyası olarak doğar → `_metatron_push_log`'u main'le
ortak önek paylaşır (`seq + schema_hash` çifti birebir aynı).

- **ata**: iki günlüğün en uzun ortak öneki — `(seq, schema_hash)` eşleşen son satır.
- **delta**: dalın ata sonrası girdileri (sıralı stmts birleşimi).
- **mainMoved**: main'in ata sonrası girdileri (statik kontrollerde + approval hash'inde).
- Ortak önek boşsa (dal bu main'den doğmamış) → `MergeError('no-common-ancestor')`.

## Statik kontroller (dry-run öncesi)

ORMIM'in ürettiği DDL makine-üretimi ve sabit kalıplıdır — regex yeterli:

- **rename-suspect** → `schema` çatışması: delta lint'inde `rename-suspect` varsa
  VEYA delta'da aynı tabloda `DROP COLUMN x` + `ADD COLUMN y` çifti varsa. (s2)
- **drop-changed-in-main** → `schema` çatışması: delta'da `DROP TABLE t` /
  `DROP COLUMN t.c` var VE mainMoved aynı nesneye dokunuyorsa. (s5)
- Parse edilemeyen stmt lint **değildir** — dry-run'a bırakılır.

## Dry-run: BEGIN / ROLLBACK

Statik conflict olmasa bile **her zaman**: `BEGIN; stmts sırayla; ROLLBACK;`
PG DDL'i transactionaldır — ROLLBACK main'de **iz bırakmaz**. Hata → sınıf
eşleştirme:

| PG kodu | Sınıf | Anlamı |
|---|---|---|
| `42701` / `42P07` | schema | nesne main'de zaten var (main bağımsız değişti) |
| `42P01` | schema | dal, main'de olmayan nesneyi değiştiriyor (main'de silinmiş) |
| `2BP01` | constraint | silinen nesneye main'de bağımlı nesne var (s4) |
| `23503` | constraint | FK ihlali (s8) |
| `23505` | data | unique ihlali (v1'de DDL delta'sında beklenmez, eşleştirme hazır) |
| `42804` / `42883` | schema | tip uyuşmazlığı |
| tanınmayan | schema | orijinal kod + PG mesajı, "sınıflandırılamadı" |

Her çatışma `MergeConflict` olarak raporlanır: `class` (schema/data/constraint),
`code`, `object` (`people.email` gibi), insan dili `detail`, lab'dan gelen çözüm
`options` listesi.

## Apply ve approval düşmesi

- `plan.conflicts` boş değilse → `MergeConflictError` (**çözülmeden commit yok**).
- Plan anındaki `mainHash` ile main'in güncel hash'i farklıysa →
  `MergeApprovalError`: **main plan'dan sonra değiştiyse approval düşer**
  (PlanetScale modeli); yeniden plan gerekir.
- Uygulama tek transaction'dır: stmts sırayla + push_log'a `source='merge'` kaydı
  (meta: `fromBranch, deltaSeqs, planMainHash, planDigest`). Yarışta PG hatası →
  **yarım kayıt yok** (hepsi aynı transaction'da).
- Panel uçları (Faz 2.5b): `branch_merge_plan({branch})` ve
  `branch_merge_apply({branch, planDigest})` — plan yeniden üretilir, digest
  eşleşmezse `409 "plan bayat"`; hedef dal korumalıysa `korumali_yaz` şart →
  [workspace-yetki](workspace-yetki.md).

## v1 dışı (bilinçli)

Satır-seviyesi **veri merge** (hücre 3-way, `base_/our_/their_` — dalın verisi
main'e **taşınmaz**, merge diyaloğunda bu açık yazar), id remap escape hatch'i,
büyük tablo data diff (fdw/CDC), çoklu ata (criss-cross), `metatron deploy` UI'ı.

İlgili: [ormim](ormim.md) · [dallar](dallar.md) · [workspace-yetki](workspace-yetki.md)

> Kaynak: `metatron/MERGE-CONTRACT.md` (Faz 2.5 kontratı) · hafıza
> `metatron-merge-lab-sonuclari` (9 senaryo, fiziksel PG hata kodları)
