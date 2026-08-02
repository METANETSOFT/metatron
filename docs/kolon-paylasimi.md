# Kolon paylaşımı

Veritabanları — **farklı worker'lardakiler dahil** — kolon paylaşabilir. Bu,
topolojinin "ağaç değil ağ" olan kısmıdır → [mimari](mimari.md). Sihirli
soyutlama yoktur: üç gerçek Postgres mekanizması, panel üretilen SQL'i gösterir.

## Üç mekanizma — üç ayrı bedel

| Mekanizma | Veri | Karşılığı |
|---|---|---|
| `postgres_fdw` | kopyalanmaz, canlı okunur | kaynak düşerse sorgu düşer |
| `logical replication` + kolon listesi (PG15+) | hedefe akar, orada kalır | gecikme ve disk |
| `jsonb` anlık görüntü | tek belgeye katlanır | sorgu için GIN indeks gerekir |

Nasıl seçilir:

- **Canlı gerekiyorsa, kopya istenmiyorsa** → `postgres_fdw`. Kaynakla aynı anda
  ölür; ağ ve kaynak erişilebilirliği senin sorumluluğundadır.
- **Hedefte kalıcı kopya gerekiyorsa** → logical replication, kolon listesiyle.
  Veri akar ve hedefte kalır; kaynak düşse okuma sürer. Bedeli gecikme + disk.
- **Tüketici şemasızsa** (belge gibi kullanıyorsa) → `jsonb` anlık görüntü.
  "NoSQL tarzı" esneklik budur; içinde arama için GIN indeksini sen kurarsın.

Şemalı tüketici kolon listesi alır, şemasız tüketici `jsonb` alır — esneklik
kendi katmanımız değil, Postgres'in kendisidir.

## Kural

PII/sır işaretli kolonlar paylaşıma **seçilemez** — seçim listesinde görünmez.
Maskeleme politikasıyla aynı sözlükten beslenir → [maskeleme](maskeleme.md).

İlgili: [mimari](mimari.md) · [maskeleme](maskeleme.md)

> Kaynak: `PRODUCT.md` (mekanizma tablosu + kural) · tasarım `design/app.html`
> (kolon seç + mekanizma + üretilen SQL yüzeyi)
