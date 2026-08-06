# @metatron/react

Metatron platform — React 18 hook katmanı. Çekirdek `metatron-client` içindedir;
bu paket ince bir sarmalayıcıdır (`core.ts` react'sizdir ve öyle test edilir).

## Kullanım

```tsx
import { MetatronProvider, useQuery, useMutation } from "@metatron/react";
import { MetatronClient } from "metatron-client";

const client = new MetatronClient({ url: "https://panel.example.com", token: "dbb_..." });

<MetatronProvider client={client}>
  <Tasks />
</MetatronProvider>

function Tasks() {
  // undefined = yükleniyor; query hatası render'da throw → error boundary.
  // "skip" → subscribe olmaz. Args derin eşitliği JSON anahtarıyla yapılır
  // (render'da yeni obje literal'i güvenli, yeniden subscribe olmaz).
  const tasks = useQuery("tasks/list", { done: false });   // veya "skip"
  if (tasks === undefined) return <Spinner />;
  ...
}

function AddButton() {
  const add = useMutation("tasks/add");        // stabil referans
  // zincirlenebilir: optimistic bağlanmış YENİ mutator döner
  const addOptimistic = add.withOptimisticUpdate((store, args) => {
    store.set("tasks/list", { done: false }, [
      ...((store.get("tasks/list", { done: false }) as any[]) ?? []),
      { title: args.title, pending: true },
    ]);
  });
  return <button onClick={() => addOptimistic({ title: "yeni" })}>Ekle</button>;
}
```

Aynı `(fn, args)`'ı izleyen bileşenler tek watch/sub paylaşır (refcount; son
unmount'ta kapanır). `useMutation(fn)` mutator'ı `useMemo` ile sabittir;
`withOptimisticUpdate` sonucu render başına yeniden üretilir — gerekirse siz
`useMemo` ile sabitleyin.

## Test

```bash
npm test        # çekirdek mantık, react render OLMADAN (jsdom yok)
npm run typecheck
```
