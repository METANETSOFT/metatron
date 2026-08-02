# Maskeleme (PII temizliği)

PII = kişisel veri (ad, e-posta, jeton). Maskeli dal, PII kolonları geri
döndürülemez değiştirilmiş kopyadır. Hacim korunur; 9 PII kontrolü temiz çıkana
kadar bağlantı verilmez. Ölçülen süre: **745–909 ms**.

## İki eksen — rol değil

Maskeleme bir **rol değildir**. Birbirinden bağımsız iki kural vardır:

1. **Üyelik bayrağı** — kişiye bağlı garanti. Bayrağı açık üyenin **açtığı her dal**
   maskeli kurulur. Yönetici de maskeli çalışabilir; bayrak Üyeler listesinden
   açılıp kapatılır (yalnız Yönetici → [roller](roller.md)).
2. **Dal deseni zorunluluğu** — `qa/*` ve `ext/*` desenine uyan dal, üyenin
   bayrağından **bağımsız** maskeli kurulur.

## Mekanizma: dump-time

Kurallar maskeli dal **kurulurken** uygulanır: gerçek değer, değiştirilerek
yazılır ve **dalın diskine gerçek haliyle hiç bulunmaz**.

## Dürüstlük kuralı — vaat edilmeyen

- Superuser'a karşı **DB-içi bir kural VAAT EDİLMEZ.** Dalın superuser'ı maskeyi
  "atlatamaz" demeyiz; **atlatılacak gerçek veri dalda yoktur** deriz. Güvence bir
  erişim kilidi değil, verinin yokluğudur.
- Bayrak/desen **geriye dönük çalışmaz**: önceden açılmış normal dalları değiştirmez;
  kural yeni kurulan dallara uygulanır.
- PII/sır işaretli kolonlar kolon paylaşımına **seçilemez** →
  [kolon-paylasimi](kolon-paylasimi.md).

## Dönüştürücü sözlüğü

Kural = `tablo.kolon → dönüştürücü`. Sözlük Greenmask/pgstream gönderim
adlarından gelir; kural editörü Ayarlar → Gelişmiş'tedir, örnek çıktı önizlemesi
deterministiktir.

| Dönüştürücü | Ne yapar |
|---|---|
| `Masking` | kısmi karakter — başı tutar, gerisini yıldızlar |
| `Hash` | deterministik özet — aynı girdi, aynı çıktı (join'ler bozulmaz) |
| `RandomEmail` | biçimli sahte e-posta |
| `RandomUsername` | sahte kullanıcı adı |
| `RandomPhoneNumber` | sahte telefon numarası |

Örnek kural seti (canlı testten): `candidates.email → Masking`,
`candidates.name → Masking`, `candidates.invite_token → Hash`.

İlgili: [roller](roller.md) · [dallar](dallar.md) · [kolon-paylasimi](kolon-paylasimi.md)

> Kaynak: `PRODUCT.md` (ölçümler) · tasarım `design/app.html` (pass 4: iki eksen,
> dürüstlük dili, sözlük) · `TEST-REPORT.md` (§5 maskeli dal canlı)
