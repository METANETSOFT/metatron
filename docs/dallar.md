# Dallar

Dal = kaynak veritabanının ZFS klonu + kendi Postgres'i + sabit bağlantı dizesi.
Açma yolu ikidir: panelden butonla, ya da GitHub webhook'uyla otomatik.

## ZFS gerçeği

| İddia | Ölçüm |
|---|---|
| Klon süresi | **~30 ms** — 256 MB → 2 GB arası sabit (CoW: kopya yok, blok paylaşımı var) |
| Dal disk maliyeti | **704 KB** — sadece yazılan bloklar yer tutar |
| Kaynak kesintisi | yok — klon, kaynak **çalışırken** alınır |
| Uçtan uca (panelden dal) | **2,5 sn** — klon + Postgres açılışı + şifre rotasyonu + dize |
| Webhook'tan | ~5 sn |

Her dalda superuser şifresi döndürülür ve dalın disk kotası ZFS `refquota` ile
sınırlanır; kota PR yorumundaki tabloda görünür. 100 GB havuzda ~50+ dal rahat sığar.

## PR otomasyonu

GitHub App webhook'u dinlenen olaylar:

| Olay | Panel ne yapar |
|---|---|
| `create` (git dalı) | dal DB'sini kurar |
| `pull_request` opened / reopened / synchronize / ready_for_review | dal yoksa kurar, PR yorumunu tazeler |
| `closed` / `delete` | dalı siler — kaynak geri kazanılır |

PR yorumu **sticky**'dir: her push'ta yeni yorum eklenmez, mevcut güncellenir.
İçerik: dataset/DB/kullanıcı/kota tablosu + bağlantı dizesi + SSH tüneli komutu;
kurulum hata verdiyse hata metni + "merge'den önce çözülmeli" uyarısı.
Yapılandırma: GitHub App (`GITHUB_APP_ID` + private key, `issues:write` izniyle)
ya da hızlı kurulum için `GITHUB_TOKEN`. İkisi de yoksa özellik sessizce kapalıdır.

## Şema senkronu — dal hep kendi ref'inde

Klon, snapshot anındaki şemayı taşır; snapshot eski bir migration'da kalmışsa dalda
yeni tablolar olmaz (gerçekte yaşandı). Bu yüzden dal hazır olur olmaz **o git
ref'indeki** Drizzle migration'ları uygulanır:

- Panel migration SQL'ini GitHub'dan o ref'te okur; worker kendi dalında `psql` ile
  uygular (dal DB'leri iç ağdadır, panel oraya bağlanmaz).
- Takip tablosu `public.fox_migrations`; klon üstünde ilk migration "uygulanmış"
  sayılır (baseline). Her migration tek transaction'dır; ikinci çağrı idempotenttir
  (canlı doğrulama: auth tabloları 0 → 4, 757 ms).
- Sonrasında dal rolüne `grant` tazelenir — yeni tablolar uygulamaya görünür.

Migration klasörü repo bağlantısında ayarlıdır (`repo_links.migrations_dir`;
boş bırakılırsa senkron kapalı).

## Merge kapısı (PR-gate)

PR'da panel geçici test dalı açıp PR'ın migration'larını dener:

- Migration klasörü kapısı (`guard.ts`): journal girdi sayısı = `.sql` sayısı mı,
  numara çakışması, yetim dosya, şema↔migration kayması. (Naif merge migration'ı
  **sessizce düşürür** — bu kapı onu yakalar.)
- Constraint kontrolü: yakalanan SQLSTATE'ler insan diline çevrilir — `23505`
  unique, `23502` not-null, `23503` FK, `23514` check, `42701` duplicate column.
  Dört sınıf da gerçek veride canlı yakalandı.
- Sonuç PR'a yorum: "bunlar çakışıyor, merge'leyeyim mi?"

İlgili: [mimari](mimari.md) · [baglanma](baglanma.md) · [maskeleme](maskeleme.md) · [pitr](pitr.md)

> Kaynak: `PRODUCT.md` · `FLEET.md` (PR durum yorumu, şema senkronu) ·
> `TEST-REPORT.md` (§3 canlı dal, §4 kısıt testi) · `README.md` (kapı)
