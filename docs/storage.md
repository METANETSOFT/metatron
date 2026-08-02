# Storage (S3 / MinIO)

Projeye S3-uyumlu bucket bağlanır; panel **presigned PUT/GET** URL'leri üretir.
Secret DB'de durmaz — env referansıyla çözülür. Üç amaç ayrıdır: `files`,
`backup`, `pitr`.

## Bucket registry

`storage_buckets` kontrol düzlemi tablosu:

| Kolon | Anlamı |
|---|---|
| `name` | bucket adı |
| `endpoint` | S3 ucu (örn. `minio.foxtools.de`) |
| `region` | bölge |
| `access_key_ref` | secret'ın **env anahtar adı** (örn. `STORAGE_MINIO`) — secret'ın kendisi panel env/vault'tadır, **DB'de secret yok** |
| `purpose` | `files` \| `backup` \| `pitr` |
| `created_at` | kayıt zamanı |

İmza bağımlılıksız minimal SigV4'tür (path-style MinIO / virtual-host AWS) —
AWS known-answer vektörü birebir geçti.

## Presigned PUT/GET — bearer-url yok

Erişim, kısa TTL'li ve tek işlemlik imzalı URL'lerdir:

- `POST /api/storage/presign` — PUT için **≤ 600 sn**, GET için **≤ 60 sn** tavan.
- **Bearer-token-url modeli yok** (Convex dersi): URL'i gören değil, **imzalayan**
  yetkilidir. URL sızdığında TTL dolunca ölür; hesap anahtarı asla dolaşmaz.
- Yetki: bucket bağlama/yazma uçları Geliştirici+ kapılıdır; liste/presign her
  role açık.

Canlı dogfood (MinIO): bucket aç → presign PUT → HTTP 200 yükleme → presign
GET → HTTP 200 indirme; **sha256 bayt-bayt eş**.

## Üç amaç

| Amaç | Ne için |
|---|---|
| `files` | uygulama dosyaları (Convex storage karşılığı; fn `ctx.storage` Faz 3) |
| `backup` | pgBackRest/dump hedefi — dal snapshot arşivi |
| `pitr` | WAL arşivi — [PITR](pitr.md)'ın S3 ayağı (şu an lokal ZFS snapshot; S3'e de yedek) |

Panelde yüzey: Ayarlar → Gelişmiş'te Storage bloğu — bucket tablosu (amaç
rozetleriyle), Bucket bağla diyaloğu, dosya tarayıcı (presign GET "60 sn" /
PUT curl "10 dk" ile).

Rakip notu: Neon/Supabase S3-backup import sunar, Xata'da yok — Metatron'da
amaç ayrımı (files/backup/pitr) vardır.

İlgili: [pitr](pitr.md) · [istemci](istemci.md) · [mimari](mimari.md)

> Kaynak: hafıza `metatron-storage-modeli` (kilitli model + canlı MinIO dogfood)
> · `panel/src/storage.ts` (SigV4 + presign uçları, test 7/7)
