# Kurulum ve ilk sorgu

Bu sayfanın sonunda Metatron paketlerini kurmuş, panele bağlanmış ve ilk
sorgunu — hem ham HTTP ile hem istemciyle — çalıştırmış olacaksın.

## Paketler

Üç paket var; adları **scoped değildir** (kilitli karar):

| Paket | Ne işe yarar |
|---|---|
| `metatron-client` | React'siz çekirdek istemci: `query` / `mutation` / `watchQuery`, versiyon takibi, SSE |
| `metatron-react` | React hook katmanı: `MetatronProvider`, `useQuery`, `useMutation` |
| `metatron-orm` | ORMIM: şema tanımı (`defineSchema`/`defineTable`/`t`), push ve merge motoru |
| `metatron-cli` | `metatron` komutu: `login`, `use`, `dev`, `hook` (repoda `cli/` altında) |

Paketler henüz bir registry'de yayınlı değil; monorepo'dan `file:` ile bağlanırlar.
Kaynak TS olarak tüketilirler (`main: ./src/index.ts`), bu yüzden TS anlayan bir
zincir gerekir (Vite, Next, ya da Node tarafında `tsx`):

```json
{
  "dependencies": {
    "metatron-client": "file:../metatron/packages/client",
    "metatron-react":  "file:../metatron/packages/react",
    "metatron-orm":    "file:../metatron/packages/orm"
  }
}
```

## Kimlik: `dbb_` token

Panelle tüm konuşma tek header'la yapılır: `Authorization: Bearer dbb_...`.
Token'ı panelin Token sayfasından üretirsin (REST: `POST /api/tokens`), ya da
mevcut bir token'ı CLI'ye kaydedersin:

```bash
metatron login --url http://localhost:55441 --token dbb_dogfood_8aeee39c81c8435bf13ec000
```

Kimlik `~/.config/metatron/config.json`'a yazılır; CI'da `METATRON_URL` ve
`METATRON_TOKEN` ortam değişkenleri config'i ezer. Token'sız istek
`401 { "error": { "code": "UNAUTHENTICATED" } }` döner.

## İlk sorgu — ham HTTP ile

Fonksiyon çağırmak `POST /fn/query`'dir; gövde `{ "fn", "args" }`, cevap
`{ "value", "version" }` zarfıdır. Paneldeki demo fonksiyonlardan
`branches:get` tek dal döner:

```bash
curl -X POST http://localhost:55441/fn/query \
  -H "authorization: Bearer dbb_dogfood_8aeee39c81c8435bf13ec000" \
  -H "content-type: application/json" \
  -d '{"fn":"branches:get","args":{"slug":"merge-main"}}'
```

Canlı cevap (dogfood paneli, birebir):

```json
{
  "value": {
    "slug": "merge-main",
    "gitRef": "main",
    "status": "ready",
    "role": "primary",
    "projectId": "019fba56-848e-7f29-88b3-12196497a8bb",
    "dbName": "merge_main",
    "dbUser": "postgres",
    "localPort": null,
    "createdAt": "2026-08-01T20:34:45.062Z"
  },
  "version": "1351"
}
```

`version`, cevabın hangi veritabanı anına ait olduğunu söyleyen monoton
etikettir (Postgres `txid_current()`; string taşınır). Şimdilik bilmen yeterli —
reaktivite sayfasında anlam kazanacak.

## İlk sorgu — istemci ile

`MetatronClient` aynı uçlara gider; zarfı açar, hatayı `MetatronError`'a çevirir:

```ts
import { MetatronClient } from "metatron-client";

const client = new MetatronClient({
  url: "http://localhost:55441",
  token: "dbb_dogfood_8aeee39c81c8435bf13ec000", // veya async () => token üreten fonksiyon
});

const { value, version } = await client.query("branches:get", { slug: "merge-main" });
console.log(value.slug, value.gitRef, version);
```

Çıktı (canlı çalıştırmadan):

```
merge-main main 1351
```

`token` alanı sabit string ya da `() => Promise<string>` olabilir — kısa ömürlü
token üreten ortamlarda ikincisini kullanırsın, client her istekte taze token ister.

## React tarafı

React'te istemciyi doğrudan kullanmazsın; bir kez `MetatronProvider` ile
ağacın tepesine koyarsın, bileşenler hook'larla konuşur:

```tsx
import { MetatronClient } from "metatron-client";
import { MetatronProvider, useQuery } from "metatron-react";

const client = new MetatronClient({ url: "http://localhost:55441", token: "dbb_..." });

function DalListesi() {
  const dallar = useQuery("branches:list", {});
  if (dallar === undefined) return <span>yükleniyor…</span>; // undefined = henüz ilk sonuç yok
  return <span>{dallar.length} dal: {dallar[0].slug}</span>;
}

export default function App() {
  return (
    <MetatronProvider client={client}>
      <DalListesi />
    </MetatronProvider>
  );
}
```

Bu bileşen gerçek render testinde (react-test-renderer, canlı panele karşı)
şu çıktıyı üretti: `20 dal: merge-dal`. Hook'ların tamamı
[Fonksiyonlar ve React](react-fonksiyonlar.md) sayfasında.

## CLI ile dal seçimi

`metatron use <dal>`, panelden dalın bağlantı dizesini alır (dal yoksa **açar**)
ve repo kökündeki `.env.local`'e `DATABASE_URL` olarak yazar. Bundan sonra
`metatron dev` ve diğer tüm araçlar o dalın veritabanına gider:

```bash
metatron list                      # dalları gör
metatron use feat/x                # dala geç + .env.local yaz
metatron hook install              # git checkout'unda otomatik `use` (post-checkout)
```

Şimdi şunu yapabileceksin: panele bağlanıp fonksiyon çağırmak ve React
ağacına canlı veri bağlamak. Sıra kendi şemanı tanımlamakta:
[Şema: React ORM (ORMIM)](react-ormim.md).

İlgili: [istemci](../istemci.md) · [bağlanma](../baglanma.md) · [roller](../roller.md)

> Kaynak: `metatron/CONTRACT.md` (kimlik, uçlar, client sözleşmesi) ·
> `metatron/cli/metatron.js` (komutlar) · canlı çıktılar: dogfood paneli
> :55441, 2026-08-02 (`/tmp/rehber-test/01-client.mjs`, `03-react-render.mjs`)
