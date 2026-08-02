# İstemci katmanı (Faz 1)

Uygulama, panele SQL ile değil **fonksiyon çağrısıyla** konuşur:
`metatron-client` + `metatron-react` query/mutation/subscribe verir; reaktivite
NOTIFY→SSE ile akar — **websocket yok**. Bu sayfa tel kontratını ve istemci
API'sini anlatır.

## Kimlik ve versiyon

- `Authorization: Bearer dbb_...` — CLI'nin `metatron login` token'ı; panel doğrular.
  Yetkisiz: `401 { "error": { "code": "UNAUTHENTICATED" } }`.
- Her DB yazısı monoton versiyon üretir: Postgres `txid_current()` (u64, string
  taşınır). Her query/mutation cevabı ve her SSE push versiyon etiketi taşır.
- v1 tutarlılığı: **sorgu başına versiyon** (ara durum kabul).

## Panel uçları (prefix `/fn`)

| Uç | Gövde / parametre | Cevap |
|---|---|---|
| `POST /fn/query` | `{ "fn": "dosya/yol:isim", "args": {...} }` | `200 { "value", "version" }`; hata `4xx/5xx { "error": { code, message, data? } }` — query hatası **retry edilmez** (deterministik) |
| `POST /fn/mutation` | aynı gövde + zorunlu `Idempotency-Key: <uuid>` header'ı | `200 { "value", "version" }`; aynı key ile tekrar: iş **çalışmaz**, saklanan ilk cevap döner (`"replay": true`) |
| `GET /fn/listen` (SSE) | `?subs=<urlencoded JSON [{id, fn, args}]>` + opsiyonel `Last-Event-ID` | olay akışı (aşağıda) |

Mutation throw ederse **hiçbir şey yazılmaz** (tek transaction), hata cevabı döner.

SSE olayları:

| Olay | Anlamı |
|---|---|
| `hello` | bağlanınca bir kez; `data: {"version": "<güncel>"}` |
| `update` | `id: <version>`; bir sub'ın read-set'i değişimle kesişince sorgu yeniden çalışır: `{"version", "updates": [{id, value, version}]}` |
| `resync` | server gap sezerse; client tüm sub'ları yeniden sorgular |
| `: ka` | yorum satırı heartbeat, her 25 sn |

Değişim sinyali Postgres tarafından gelir: yazan transaction içinde
`NOTIFY metatron_changes, '{"table":"t","pk":"...","version":"..."}'` (trigger
veya uygulama). v1 read-set granularity'si **tablo seviyesidir** — server, sub
sorgusunun dokunduğu tabloları registry/ORM üzerinden bilir, kesişim tablo
bazında hesaplanır.

## Client (`metatron-client`)

```ts
new MetatronClient({ url: string, token: string | (() => Promise<string>) })

client.query(fn, args) → Promise<{ value, version }>

client.mutation(fn, args, opts?: { optimisticUpdate?: (store, args) => void })
  → Promise<{ value, version }>
  // Idempotency-Key otomatik (crypto.randomUUID); optimistic katman store'a anında
  // uygulanır, store version ≥ response.version olunca düşer; hata → katman geri
  // alınır + throw.

client.watchQuery(fn, args) → WatchHandle
  interface WatchHandle {
    get(): { value, version } | undefined          // undefined = henüz ilk sonuç yok
    subscribe(cb: (v: { value, version }) => void): () => void  // unsubscribe döner
    close(): void
  }
```

Tek EventSource / client; sub'lar multiplexed. Kopmada backoff (0,5→16 sn,
jitter) + `Last-Event-ID` resume; `resync` olayında veya sekme focus'unda stale
sub'lar yeniden sorgulanır.

## React (`metatron-react`)

```tsx
<MetatronProvider client={client}>…</MetatronProvider>

useQuery(fn, args | "skip") → value | undefined   // undefined = loading; hata → error boundary
useMutation(fn) → mutator                          // stabil referans
  mutator(args) → Promise<{ value, version }>
  mutator.withOptimisticUpdate((store, args) => void) → mutator   // zincirlenir
```

Paket adları **scoped değildir** (kilitli karar): `metatron-client`,
`metatron-react`, `metatron-orm`.

## v1 dışı (bilinçli)

Snapshot-atomik tutarlılık, pagination, app-seviye auth, components, storage
(storage modeli → [storage](storage.md)).

İlgili: [ormim](ormim.md) · [mimari](mimari.md) · [storage](storage.md)

> Kaynak: `metatron/CONTRACT.md` (Faz 1 tel kontratı) · hafıza
> `metatron-oturum-akisi-2026-08-01` (Faz 1 dogfood: 13/13+4/4 test,
> paket adı kilidi, NOTIFY→SSE kararı)
