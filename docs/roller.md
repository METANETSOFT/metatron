# Roller

Üç rol vardır: **Yönetici · Geliştirici · Okuyucu**. Rol, kiracıdaki üyeliğe
bağlıdır ve **veritabanı başına** anlam kazanır: **DB'yi kuran otomatik Yönetici
olur** (PlanetScale modeli); sahiplik satırı sabittir, rolü yalnız Yönetici atar.

## Kim ne yapar

| Yetki | Yönetici | Geliştirici | Okuyucu |
|---|:---:|:---:|:---:|
| Dal aç / sil / maskele / replika / rebase | ✓ | ✓ | — |
| Ayarlar: Kaydet, GitHub bağ/kes, maskeleme kuralları | ✓ | — | — |
| Üyeler: davet, rol ata, kaldır, maskeleme bayrağı | ✓ | — | — |
| Filo: worker rolü, drain, filodan çıkar, terfi | ✓ | — | — |
| Ajan jetonu: üret / döndür / iptal | ✓ | — | — |
| DB'yi worker'lar arası taşı | ✓ | — | — |
| Görüntüleme (topoloji, şema, dallar, bağlantı) | ✓ | ✓ | ✓ |

Okuyucu bakar; kurucu butonlar ona **sebebiyle birlikte** devre dışı görünür.
Geliştirici günlük işi yapar (dal açar/siler) ama ayar, üye, filo ve jeton
yönetemez. Taşıma yetkisi yalnız Yöneticide çünkü `zfs send/receive` filo
seviyesinde bir operasyondur.

## Bağlantı ve parola

Bağlantı dizesi dalın rolüne aittir (`br_<dal-slug>` →
[baglanma](baglanma.md)); üye bazlı kimlik ileride geliyor. Parola bir kez
gösterilir; kendi bilgini yeniden döndürebilirsin, **başkasınınkini yalnız
Yönetici döndürür.**

## Maskeleme bayrağı rol değildir

Rolden bağımsız ikinci eksen: bayrağı açık üyenin açtığı her dal maskeli kurulur —
Yönetici dahil. Ayrıntı ve dürüstlük kuralı → [maskeleme](maskeleme.md).

## `agt_` jetonu ≠ üye anahtarı

`agt_...` bir **makineye** aittir: worker ajanının panele kimliğidir; sızarsa iptal
edip döndürürsün, üyelik etkilenmez. Üye anahtarı ise kişinin panele girişidir.
Biri diğerinin yerine asla kullanılmaz.

İlgili: [maskeleme](maskeleme.md) · [baglanma](baglanma.md) · [mimari](mimari.md) · ayrıca bkz [workspace-yetki](workspace-yetki.md) (workspace + takım modeli)

> Kaynak: tasarım `design/app.html` (pass 4: PERM tablosu, DB'yi kuran otomatik
> Yönetici, jeton ayrımı) · `FLEET.md` (worker registry, `agt_`)
