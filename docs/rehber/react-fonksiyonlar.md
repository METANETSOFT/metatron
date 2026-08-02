# Fonksiyonlar ve React

Metatron'da backend, HTTP uçları yerine **adlandırılmış TypeScript
fonksiyonlarıdır**: `functions/` altına yazdığın her export `dosya/yol:export`
adıyla çağrılır, React tarafında `useQuery` ve `useMutation` bu adları string
olarak kullanır.

Bu sayfadaki React örneklerinin tamamı canlı panele karşı render edilerek
doğrulanmıştır (react-test-renderer + dogfood paneli).

## Fonksiyon yazmak

Bir fonksiyon, `query` / `mutation` / `action` helper'larından biriyle
tanımlanmış bir export'tur. İsim kontratı: `functions/` köküne göre dosya yolu
+ `:` + export adı — `functions/examples/demo.ts` içindeki `export const hello`,
istemciden **`examples/demo:hello`** diye çağrılır. `_` ile başlayan dosyalar
altyapı sayılır ve yüklenmez.

Gerçek bir örnek (repodaki `functions/examples/demo.ts`'den):

```ts
import { query, mutation } from '../runtime'

export const hello = query({
  handler: (_ctx, args: { name?: string }) => ({
    message: `merhaba ${args.name ?? 'metatron'}`,
  }),
})

export const bump = mutation({
  handler: (_ctx, args: { by?: number }) => {
    state.bumpCount += args.by ?? 1
    return { count: state.bumpCount }
  },
})
```

## Üç tip: query, mutation, action

Ayrım yetkiyle ilgilidir — fonksiyonun neye *izinli* olduğunu tip belirler:

| | query | mutation | action |
|---|---|---|---|
| DB erişimi | okuma (`ctx.db.query`) | okuma + yazma | yok — `ctx.runQuery/runMutation/runAction` ile dolaylı |
| Transactional | evet | evet (tek tx; throw → **hiçbir şey yazılmaz**) | hayır |
| Deterministik | zorunlu | zorunlu | serbest |
| `fetch` / dış dünya | yok | yok | evet |
| Cache + reaktif subscribe | evet | hayır | hayır |

Anti-pattern: istemciden doğrudan action çağırmak. Önerilen desen: mutation
intent'i yazar ve `ctx.scheduler.runAfter(0, 'dosya/yol:isim', args)` ile
action'ı arka planda tetikler.

## ctx: fonksiyonun elindekiler

Handler'ın ilk argümanı `ctx`, tipe göre kısıtlanır:

- **QueryCtx**: `{ db, auth, storage }` — `db` salt-okur (`ctx.db.query`),
  scheduler yok.
- **MutationCtx**: `{ db, auth, scheduler, storage }` — `db` okur+yazar
  (`ctx.db.mutation`), `scheduler.runAfter / runAt / cancel`.
- **ActionCtx**: `{ auth, scheduler, storage, runQuery, runMutation, runAction }` —
  `db` yok.

`ctx.db`'nin imzası istemciyinkiyle aynıdır (kilitli karar: worker doğrudan
Postgres'e gitmez; kullanıcı verisi trafiği panel `/fn` uçları üzerinden akar):

```ts
// functions/examples/candidates.ts'den (gerçek):
export const list = query({
  handler: async (ctx, args: { status?: CandidateStatus; limit?: number }) => {
    const res = await ctx.db.query<Candidate[]>('data/candidates:list', {
      status: args.status ?? null,
      limit: Math.min(Math.max(args.limit ?? 50, 1), 100),
    })
    return res.value
  },
})
```

## Determinizm kuralı

Query ve mutation **deterministik** olmak zorundadır — query cache, reaktivite
ve retry semantiği buna dayanır. Bunu sana bırakmaz; runtime shim'i sağlar
(`functions/_determinism.ts`, Faz 3c):

- `Math.random()` → seeded PRNG (tohum, çağrının implicit parametresi),
- `Date.now()` / `new Date()` → fonksiyon başlangıcında **donmuş**,
- `crypto.getRandomValues` / `randomUUID` → seeded.

Action'da shim yoktur: `fetch`, saat, rastgelelik serbesttir; karşılığında DB'ye
doğrudan erişemez ve scheduled çalışma garantisi at-most-once'tur. Pratik sonuç:
query/mutation içinde rastgelelik ve saat kullanmaktan çekinme — aynı arg'larla
aynı cevabı ürettiğin sürece shim senin tarafındadır; ama dış API'ye sadece
action'dan çık.

## Panel tarafı: registry ve read-set

Fonksiyonlar panelde bir registry'ye `kind` + `tables` + `run` ile kaydolur
(v1'de panel içi; fn-worker'a taşınması Faz 3 hattındadır). `tables` beyanı
zorunludur — **read-set**'tir: hangi tablo değişince bu sorgunun yeniden
koşacağını reaktivite buradan bilir (v1'de kesişim tablo seviyesindedir).

Dogfood panelinde kayıtlı demo fonksiyonlar (rehberin canlı örnekleri bunlarla
koşuldu):

| Ad | kind | read-set | Ne yapar |
|---|---|---|---|
| `branches:list` | query | `branches` | canlı dalları listeler |
| `branches:get` | query | `branches` | tek dal (`args.slug` zorunlu) |
| `audit:note` | mutation | `audit_log` | deney notu yazar; `{ id, message }` döner |

## React'ten çağırmak: `useQuery`

`useQuery(fn, args)`, sorguyu çalıştırır, sonucu döner ve **subscribe olur** —
read-set'le kesişen bir yazma olunca yeni sonuç kendiliğinden düşer. Ayrı bir
`useSubscribe` hook'u yoktur; `useQuery` zaten subscribe'dır.

```tsx
import { useQuery } from "metatron-react";

function DalListesi() {
  const dallar = useQuery("branches:list", {});
  if (dallar === undefined) return <span>yükleniyor…</span>;
  return <span>{dallar.length} dal: {dallar[0].slug}</span>;
}
```

Üç davranışı bil (üçü de canlı render testinde doğrulandı):

- **`undefined` = yükleniyor.** İlk sonuç gelene kadar hook `undefined` döner;
  loading dalını sen yazarsın.
- **Hata → error boundary.** Sorgu hatası render sırasında throw edilir; en
  yakın error boundary yakalar (canlı testte `BAD_ARGS` boundary'de göründü).
- **`"skip"` = şimdilik sorma.** `useQuery(fn, "skip")` subscribe olmaz, hep
  `undefined` döner — koşullu sorgular için:

```tsx
function TekDal({ slug }: { slug: string | null }) {
  const dal = useQuery("branches:get", slug ? { slug } : "skip");
  return <span>{dal ? dal.gitRef : "kapalı"}</span>;
}
```

Args derin eşitliği JSON anahtarıyla yapılır: render'da yeni obje literal'i
yazman yeniden subscribe'a yol açmaz; içerik değişince sorgu kendiliğinden
yenilenir.

## Yazmak: `useMutation`

`useMutation(fn)` stabil referanslı bir **mutator** döner; `mutator(args)`
`Promise<{ value, version }>` verir:

```tsx
import { useMutation } from "metatron-react";

function NotYazan() {
  const not = useMutation("audit:note");
  return (
    <button onClick={() => not({ message: "panelden selam" })}>
      Not düş
    </button>
  );
}
```

Mutator referansı render'lar arasında sabittir (canlı testte `mutatorRef === m1`
doğrulandı) — efekt bağımlılıklarına güvenle koyarsın. Her çağrıya
`Idempotency-Key` client tarafından otomatik üretilir; ağ kopup tekrar
denesen bile iş iki kez yazılmaz (ayrıntı: [CRUD](crud.md)).

### Optimistic katman

`mutator.withOptimisticUpdate((store, args) => …)`, mutation cevabı gelmeden
sonucu arayüze yansıtır. Update **senkron** çalışır — izleyiciler fetch'ten
önce görür; cevabın versiyonu yakalanınca katman düşer, hata olursa geri
alınır ve hata fırlar:

```ts
const note = useMutation("audit:note").withOptimisticUpdate((store, args) => {
  const cur = store.get("branches:list", {});     // izlenen sorgunun güncel değeri
  store.set("branches:list", {}, [yeniSatir, ...cur]);
});
```

`store.get(fn, args)` / `store.set(fn, args, value)` — anahtar, `useQuery`'nin
kullandığı `(fn, args)` çiftidir.

## Reaktivite: SSE, websocket YOK

Değişim sinyali Postgres'ten gelir: yazan transaction içinde
`NOTIFY metatron_changes` düşer, panel read-set kesişimini hesaplar ve etkilenen
sorguyu yeniden koşup sonucu **SSE** (`GET /fn/listen`) ile iter. Mimari
tercih bilinçlidir: websocket yoktur — tek EventSource bağlantısı tüm
subscription'ları multiplex'ler, kopmada 0,5→16 sn jitter'lı backoff ve
`Last-Event-ID` ile resume eder, server gap sezerse `resync` olayı tüm
sorguları tazeler; sekme odağa dönünce de stale sub'lar yeniden sorgulanır.

React'siz ortamda (script, worker, test) aynı mekanizma `watchQuery` ile
kullanılır — hook'ların altındaki çekirdek budur:

```ts
const h = client.watchQuery("branches:get", { slug: "merge-main" });
const unsub = h.subscribe(({ value, version }) => console.log(value.slug, version));
h.get();    // son değer senkron (ilk sonuç yoksa undefined)
h.close();  // subscription'ı kapat
```

Şimdi şunu yapabileceksin: fonksiyon yazıp React ağacına canlı, kendiliğinden
güncellenen veri bağlamak. Sıra günlük işlerde: filtreli okuma, insert/update/
delete, hata ve rol yönetimi — [CRUD](crud.md).

İlgili: [istemci](../istemci.md) (tel kontratı) · `functions/README.md` (worker,
cron, loader detayı)

> Kaynak: `metatron/CONTRACT.md` · `functions/runtime.ts` + `_determinism.ts` ·
> `panel/src/fn/registry.ts` (demo registry) · canlı doğrulama: dogfood :55441,
> 2026-08-02 (`/tmp/rehber-test/01-…03-*.mjs` — query/mutation/watch/render)
