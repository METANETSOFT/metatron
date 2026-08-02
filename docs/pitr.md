# PITR — saniyelik geri dönüş

"Şu ana dön" işi ZFS snapshot ile **olmaz**; **WAL arşivleme** ile olur. İkisi
ayrı iş yapar, Metatron ikisini birlikte kullanır:

| Araç | Ne verir | Rolü |
|---|---|---|
| ZFS snapshot/clone | anlık nokta kopyası, ~30 ms | dal açma → [dallar](dallar.md) |
| pgBackRest (full/diff + WAL) | herhangi bir **saniyeye** restore | PITR |

`archive_command` her WAL segmentini repoya iter; `restore --type=time
--target="2026-07-30 13:41:07"` o ana döner. Saniyelik çözünürlük **ekstra yer
istemez** — WAL zaten üretiliyor; arada replay ile herhangi bir ana ulaşılır.

## Geri yükleme akışı — canlıya DOKUNMAZ

1. Panelde "Geri dön" → tarih-saat seç.
2. Worker hedef zamana **yeni bir dal olarak** restore eder; canlı DB'ye dokunulmaz.
   (Recovery, yani WAL replay, restore container'ında tamamlanır; asıl container
   temiz PGDATA ile açılır — orkestrasyon bu yüzden güvenilir.)
3. Yeni dalda doğrularsın → [baglanma](baglanma.md) ile bağlan, veriye bak.
4. İstersen terfi ettirirsin; istemezsen dalı silersin. ZFS dal felsefesiyle
   birebir aynı akış.

Canlı ölçümler (fox, gerçek veri): PITR açma (`archive_mode` + stanza + ilk full
backup) **3,9 sn**, **6,7:1** sıkışma · hedef zamana restore **6,1 sn** (kanıt:
T1+T2 yazıldı → T1'e restore → yeni dalda sadece T1, canlı dokunulmadı).

## Saklama (retention)

Karar (2026-07-30): varsayılan **3 gün** + aç/kapa toggle + seçici
(1/3/7/14/30 gün). Gerekçe, arşiv/DB boyutu oranı:

| Saklama | Arşiv ≈ DB boyutunun |
|---|---|
| 3 gün | ~1 katı |
| 7 gün | 1,5–2 katı |
| 30 gün | 3–5 katı |

Repo yeri iki seçenek: worker ile aynı VDS'te ayrı ZFS dataset (yalın, VDS'e
bağımlı) ya da merkezi MinIO/S3 (VDS ölse de arşiv durur) — açık karar.
Not: dal imajı pgBackRest'i **gömülü** taşır (`pgbackrest-pg:18`) çünkü iç ağda
internet yoktur.

## Kapsam

Varsayılan: **yalnız ana DB (main)**. Dallar ucuz ve kısa ömürlüdür, yedeklenmez;
ayardan "tüm dallar" / "seçili dallar" seçilebilir.

İlgili: [dallar](dallar.md) · [mimari](mimari.md)

> Kaynak: `FLEET.md` (§3 PITR, retention kararı, Task #36 canlı ölçümler) ·
> `PRODUCT.md`
