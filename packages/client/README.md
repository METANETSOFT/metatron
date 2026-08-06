# @metatron/client

Metatron platform — React'siz çekirdek istemci. Tel kontratı: `../../CONTRACT.md`.
Bağımlılığı yoktur; tarayıcı ve Node ≥20'de çalışır (global `fetch`; SSE, fetch +
`ReadableStream` üstünde ayrıştırılır — EventSource gerekmez ve `Authorization`
header'ı gönderemediği için zaten kullanılmaz).

## Kullanım

```ts
import { MetatronClient } from "@metatron/client";

const client = new MetatronClient({
  url: "https://panel.example.com",
  token: "dbb_...", // veya async () => token
});

// Query — hata retry EDİLMEZ (deterministik), MetatronError fırlatır (.code/.data)
const { value, version } = await client.query("tasks/list", {});

// Mutation — Idempotency-Key otomatik (crypto.randomUUID)
await client.mutation("tasks/add", { title: "x" });

// Optimistic update: katman store'a anında uygulanır; base version response.version'a
// yetişince düşer; hata → katman geri alınır + throw.
await client.mutation("tasks/add", { title: "x" }, {
  optimisticUpdate: (store, args) => {
    store.set("tasks/list", {}, [...(store.get("tasks/list", {}) as any[]), args]);
  },
});

// Watch — tek SSE bağlantısı üstünde multiplexed
const handle = client.watchQuery("tasks/list", {});
const unsub = handle.subscribe(({ value, version }) => render(value));
handle.get();   // ilk sonuç yoksa undefined
unsub(); handle.close();
```

Davranışlar: kopmada backoff (0.5→16 sn, jitter) + `Last-Event-ID` resume; `resync`
olayında ve sekme focus'unda (`visibilitychange`) tüm sub'lar yeniden sorgulanır.
Aynı `(fn, args)` (JSON derin eşitliği) tek sub paylaşır; ilk sonuç `POST /fn/query`
ile alınır, sonrası SSE push. Gelişmiş: `watchState`/`watchSubscribe` (error durumu
dahil — react paketi kullanır), `createStore`, `retry: { baseMs, maxMs }`.

## Test

```bash
npm test        # node --import tsx --test (sahte server: node:http)
npm run typecheck
```
