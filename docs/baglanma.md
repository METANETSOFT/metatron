# Bağlanma

Her veritabanına ve dala **aynı adresten** bağlanırsın: tek sabit gateway portu.
Worker adı, worker IP'si, dal portu bilmen gerekmez — yönlendirme gateway'in içinde,
kullanıcı adına bakılarak yapılır.

## Bağlantı dizesi şeması

```
postgresql://br_DAL-SLUG:SIFRE@GATEWAY:PORT/main
```

| Parça | Anlamı |
|---|---|
| `br_DAL-SLUG` | dalın rolü — gateway yönlendirmeyi bu kullanıcı adından okur |
| `main` | dalın gerçek veritabanı (her dal kendi Postgres'inde `main` taşır) |
| `GATEWAY:PORT` | her DB ve dal için aynı, sabit |

Sorgu parametresi YOK — dize stok libpq ve her sürücüyle olduğu gibi çalışır.
Slug dal adından türetilir ve proje-kapsam hash'i taşır (`feat/linkedin-url` →
`feat_linkedin_url_9c07b9e1a2` gibi); tam rol adını paneldeki Kopyala düğmesi verir.
Opsiyonel `br_DAL-SLUG@org` biçimi de kabul edilir: `@org` parçası ayrıştırılır,
arka uca her zaman `br_DAL-SLUG` gider.

```bash
psql "postgresql://br_main:SIFRE@GATEWAY:PORT/main?sslmode=require"
psql "postgresql://br_feat_linkedin_url_9c07b9e1a2:SIFRE@GATEWAY:PORT/main?sslmode=require"
```

Dize dalın rolüne aittir — üye bazlı kimlik ileride geliyor; rol parolasını bilen
o dalın yetkisiyle bağlanır. Parola panelde **bir kez** gösterilir. Kendi parolanı
döndürebilirsin; başkasınınkini yalnız Yönetici döndürür → [roller](roller.md).

## Neden sabit dize?

DB bir worker'dan diğerine taşındığında (snapshot → `zfs send` → receive →
yönlendirme güncelleme) değişen tek şey gateway'in içindeki yönlendirme kuralıdır.
Bağlantı dizesi **bayt bayt aynı kalır** — uygulama config'i, CI secret'ı, yerel
`.env` dokunulmaz. Bu kilitli ürün kararıdır (2026-07-31).

## TLS — kendinden imzalı (şu an)

TLS'i gateway/PgBouncer sonlandırır: internet bacağı şifreli, iç ağ bacağı değil.
Sertifika şu an **kendinden imzalı**, yani:

- `sslmode=require` — trafik şifrelenir ama sertifika doğrulanmaz (bugünkü pratik).
- Tam doğrulama (`verify-full`) istersen CA/sertifikayı istemcinin güvenilir
  deposuna eklemen gerekir. Let's Encrypt gibi gerçek sertifika ileride gateway'e
  takılır; dize yine değişmez.

## Dürüst durum

- Bugün canlıda TLS'i **PgBouncer** sonlandırır; dış port varsayılan **6433**
  (`PGB_PUBLIC_PORT` — 5432 bilerek kullanılmaz, dünyanın taradığı ilk porttur).
  Doğrudan PgBouncer'a ve SSH tüneliyle bağlantı canlı testten geçti.
- Kullanıcı-adıyla yönlendiren **gateway katmanı** kilitli karardır ve tasarımın
  parçası olarak kurulmaktadır; üstteki dize şeması o hedefi anlatır. Kurulum
  tamamlanana kadar panelin PR yorumundaki dizeyi ve tünel komutunu kullan.

İlgili: [mimari](mimari.md) · [dallar](dallar.md) · [roller](roller.md)

> Kaynak: `PRODUCT.md` (ürün gerçeği: sabit adres) · tasarım `design/app.html`
> (pass 5: dize şeması) · `docker-compose.panel.yml` (port) · `TEST-REPORT.md`
