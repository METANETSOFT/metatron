# CRUD: okuma ve yazma

React tarafında CRUD'un karşılığı iki hook'tur: okuma `useQuery` + filtre
argümanları, yazma `useMutation` + bir mutation fonksiyonu. "get/set/put"
yoktur — her iş, adı olan bir fonksiyon çağrısıdır; bu sayede her okuma
reaktiftir ve her yazma tek transaction'dır.

Bu sayfadaki istemci çıktıları canlı dogfood paneline karşı çalıştırılmıştır.

## Okuma: filtre = sorgunun argümanı

Okuma işini bir `query` fonksiyonu yapar; filtre, fonksiyonun `args`'ıdır.
Arayüz tarafında `useQuery(fn, args)` args değişince sorguyu kendiliğinden
yeniler — `useEffect` ile senkronlama yazmazsın.

Fn tarafı (repodaki `examples/candidates.ts` deseniyle):

```ts
// functions/blog/posts.ts
import { query } from '../runtime'

export const list = query({
  handler: async (ctx, args: { publishedOnly?: boolean; limit?: number }) => {
    const res = await ctx.db.query('data/posts:list', {
      publishedOnly: args.publishedOnly ?? false,
      limit: Math.min(Math.max(args.limit ?? 50, 1), 100),
    })
    return res.value
  },
})
```

React tarafı:

```tsx
function Yazilar({ publishedOnly }: { publishedOnly: boolean }) {
  const posts = useQuery("blog/posts:list", { publishedOnly });
  if (posts === undefined) return <span>yükleniyor…</span>;
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
```

`publishedOnly` değiştiğinde sorgu yeniden koşar; `posts` tablosuna başka bir
istemci yazsa bile sonuç SSE ile düşer. Koşullu sorgu için `useQuery(fn, "skip")`.

> **data/\* fonksiyonları nereden geliyor?** `ctx.db.query/mutation` ile
> çağrılan `data/posts:list` gibi isimler, panel tarafında registry'ye
> yazdığın kendi veri fonksiyonlarındır (`candidates.ts`'deki desenin aynısı;
> registry kaydı `kind` + `tables` + `run` ister). ORMIM şemasından otomatik
> data-fn üretimi v1 kapsamı dışındadır — o gelene kadar CRUD fn'leri bu desenle
> elle yazılır. Worker'sız küçük kurulumlarda panel-içi registry tek başına
> yeterlidir (dogfood'daki `branches:list` böyledir).

## Yazma: insert / update / delete = üç mutation

Yazma işleri `mutation` ile tanımlanır. Üç temel iş aynı kapıdan geçer; ayrı
fn'ler olarak yazılır çünkü her birinin argümanı ve read-set beyanı farklıdır:

```ts
// functions/blog/posts.ts (devamı)
import { mutation } from '../runtime'

export const create = mutation({
  handler: async (ctx, args: { title: string; body: string }) => {
    const res = await ctx.db.mutation<{ id: string }>('data/posts:create', args)
    return res.value                      // { id } — id'yi uuidv7() üretti
  },
})

export const update = mutation({
  handler: async (ctx, args: { id: string; title?: string; body?: string }) => {
    const res = await ctx.db.mutation('data/posts:update', args)
    return res.value
  },
})

export const remove = mutation({
  handler: async (ctx, args: { id: string }) => {
    await ctx.db.mutation('data/posts:remove', { id: args.id })
    return { ok: true }
  },
})
```

React tarafında her biri stabil bir mutator'dır:

```tsx
function YaziFormu() {
  const create = useMutation("blog/posts:create");
  return (
    <button onClick={async () => {
      const { value } = await create({ title: "ilk yazı", body: "merhaba" });
      console.log("yeni yazı:", value.id);
    }}>
      Yayınla
    </button>
  );
}
```

Mutation'ın throw etmesi **hiçbir şey yazılmadı** demektir — iş tek
transaction'dır; yarım kayıt kalmaz.

## Idempotency: tekrar denemek güvenli

Her mutation isteği zorunlu `Idempotency-Key: <uuid>` header'ı taşır; client
bunu her çağrıda otomatik üretir. Aynı key ile gelen tekrar işi **çalıştırmaz**,
saklanan ilk cevabı `"replay": true` ile döner. Ağ koptu, kullanıcı çift
tıkladı, retry attı — hepsi aynı kayda düşer.

Canlı kanıt (aynı key ile iki istek, birebir çıktı):

```
# birinci istek
{"value":{"id":"019fbfd8-5404-7249-af81-52f503d33a41","message":"rehber dogfood testi 1"},"version":"1347"}
# aynı Idempotency-Key ile tekrar
{"value":{"id":"019fbfd8-5404-7249-af81-52f503d33a41",...},"version":"1347","replay":true}
# key'siz mutation
{"error":{"code":"IDEMPOTENCY_KEY_REQUIRED","message":"Idempotency-Key header zorunlu"}}
```

Aynı `id`'nin döndüğüne dikkat et — ikinci çağrıda insert koşmadı.

## Hata zarfı ve `MetatronError`

Hatalar her uçta aynı zarfla döner: `{ "error": { "code", "message", "data"? } }`.
Client bunu `MetatronError`'a çevirir — `code`, `message`, `data`, `status`
alanlarıyla yakalarsın:

```ts
import { MetatronError } from "metatron-client";

try {
  await client.query("branches:get", {});          // slug eksik
} catch (e) {
  if (e instanceof MetatronError) {
    e.code;     // "BAD_ARGS"
    e.status;   // 400
    e.message;  // "args.slug (string) gerekli"
  }
}
```

Canlı panelden doğrulanan kodlar:

| HTTP | code | Ne zaman |
|---|---|---|
| 400 | `BAD_ARGS` | fn argüman doğrulaması reddetti |
| 400 | `WRONG_KIND` | query'yi `/fn/mutation`'a (veya tersi) gönderdin |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | mutation'da key header'ı yok |
| 401 | `UNAUTHENTICATED` | token eksik/geçersiz |
| 403 | `FORBIDDEN` | rolün yetmiyor (aşağıda) |
| 404 | `FN_NOT_FOUND` / `NOT_FOUND` | fonksiyon ya da kayıt yok |
| 409 | `PLAN_STALE` / `PLAN_CONFLICT` | merge akışı ([sonraki sayfa](dallar-ve-merge.md)) |
| 500 | `FN_ERROR` | fn içinde beklenmeyen hata |

İki kural:

- **Query hatası retry edilmez.** Deterministik fonksiyon aynı arg'larla aynı
  hatayı verir; client hatayı doğrudan fırlatır. React'te bu, error boundary'ye
  düşer.
- **Fn kendi kodunu dönebilir.** Panel-içi fn'lerde `FnError(code, message, data?)`
  fırlatırsan zarfın kodu aynen iletilir, HTTP status'ü tablodan seçilir.

## Roller: Okuyucu okur, Geliştirici yazar

`/fn/query` ve `/fn/listen` rol kapısı yoktur — Okuyucu dahil her token okur.
`/fn/mutation` en az **Geliştirici** ister. Okuyucu token'ıyla yazma denemesi:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "bu islem icin en az Geliştirici rolu gerekir (mevcut rol: Okuyucu)"
  }
}
```

Rol hiyerarşisi `yonetici > gelistirici > okuyucu`'dur. Rol alanı olmayan eski
token'lar tam yetkili sayılır (geriye uyum); tanınmayan rol değeri güvenli
tarafa, Okuyucu'ya düşer. Token'a rol panelde API token'ı üretilirken verilir
— uygulama içi kullanıcı yetkisi (workspace modeli) ayrı bir katmandır:
[workspace ve yetki](../workspace-yetki.md).

## Optimistic yazma + hata geri alması

`withOptimisticUpdate` katmanı cevaptan önce görünür; mutation hata verirse
katman **geri alınır** ve hata çağırana fırlar (canlı doğrulandı: hatalı
mutation sonrası izlenen sorgunun değeri katman öncesi hâline döndü). Yani
optimistic UI için ayrıca "geri al" kodu yazmazsın — tek kural, update
fonksiyonunun saf ve senkron olması.

Şimdi şunu yapabileceksin: filtreli, reaktif okuma; tek transaction'lık
insert/update/delete; idempotent ve rol-farkındaki yazma. Son adım: bu işi
dallar arasında taşımak — [Dallar ve merge](dallar-ve-merge.md).

İlgili: [istemci](../istemci.md) · [roller](../roller.md) · [fonksiyonlar ve React](react-fonksiyonlar.md)

> Kaynak: `metatron/CONTRACT.md` · `panel/src/fn/routes.ts` (rol kapısı, hata
> tablosu) + `panel/src/roles.ts` (FORBIDDEN zarfı) · canlı çıktılar: dogfood
> :55441, 2026-08-02 (idempotency replay, hata zarfları, optimistic geri alma)
