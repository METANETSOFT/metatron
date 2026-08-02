# Kimlik: Better Auth

Metatron'da kimlik **iki ayrı katmandır**: **panel kimliği** (Metatron'a kim
erişir — `dbb_` token ve roller; bugün canlı) ve **uygulama kimliği** (senin
yazdığın uygulamaya kim girer — son kullanıcı). Bu sayfa ikisini birbirinden
ayırır ve uygulama tarafı için önerilen yolu — **Better Auth** — Metatron'la
nasıl köprüleyeceğini gösterir.

Bu sayfanın panel tarafı canlıda doğrulanmış davranıştır; uygulama tarafı ise
bilinçli olarak v1 dışıdır ve köprünün Faz 4 parçaları açıkça "taslak" diye
işaretlidir.

## İki katman: panel kimliği ≠ uygulama kimliği

Panel kimliği, panelin ve CLI'nin konuştuğu kimliktir; uygulama kimliği ise
senin ürününün login/signup akışıdır. İkisini tek tabloda görelim:

| | Panel kimliği | Uygulama kimliği |
|---|---|---|
| Kim | Sen, ekibin, CI | Uygulamanın son kullanıcısı |
| Taşıyıcı | `Authorization: Bearer dbb_…` header'ı | Oturum cookie'si |
| Rol modeli | Yönetici · Geliştirici · Okuyucu | Senin modelin (ör. owner / member) |
| Nereden üretilir | Panel Token sayfası, `metatron login` | Senin auth katmanın |
| Durum | **Bugün canlı** | v1 dışı — bu sayfadaki köprüyle |

Panel tarafı [kurulum](kurulum.md) sayfasındaki gibidir: token panelden
üretilir, token'sız istek `401 UNAUTHENTICATED` döner, okuma her role açık,
yazma en az Geliştirici ister ([CRUD](crud.md) — roller bölümü).

Uygulama tarafı içinse CONTRACT açıktır: **"app-seviye auth v1 DIŞI"** —
Metatron son kullanıcının login'ini bilmez, bilmesi de gerekmez. Son
kullanıcılar senin tablolarında yaşar; Metatron'a akan tek şey fn
çağrılarındaki kimlik bilgisidir.

## Öneri: uygulama auth'ında varsayılan Better Auth'tur

Kilitli karar: app-seviye auth'da **Better Auth varsayılan ve önerilen
sağlayıcıdır** — Metatron'la yeni bir uygulamaya kimlik katarken ilk bakacağın
yol budur. Sebepleri pratiktir:

- Kendi Postgres'inde çalışır — Metatron'un "kendi sunucunda" felsefesiyle
  birebir uyumludur; üçüncü parti servise kullanıcı verisi açmazsın.
- Şeması düz dört Postgres tablosudur (`user`, `session`, `account`,
  `verification`); veritabanınla aynı yerde, aynı yedekleme ve dal
  topolojisinde yaşar.
- Oturum cookie ile taşınır — aşağıdaki köprü modeli buna göre kuruludur.

Bu kalıp hayali değildir: foxapp'ın canlı v2'si tam olarak böyle çalışır
(email+password, 8 saatlik cookie oturumu, dört tablo; göç haritası §4.1).

> **Başka sağlayıcı kullanılabilir.** Clerk, Auth0 ya da kendi custom auth'ın
> da bağlanabilir — köprü modeli değişmez: önemli olan, oturumun fn
> çağrılarına kimlik olarak taşınmasıdır. Bu sayfadaki örnekler varsayılan
> olduğu için Better Auth iledir.

## Kurulum taslağı: Better Auth'ı Metatron'un yanına kur

Better Auth, Metatron'dan bağımsız bir pakettir ve kendi tablolarını kendi
yönetir. Genel kurulum kalıbı:

```bash
npm install better-auth
```

```ts
// server/auth.ts — genel kalıp (Better Auth dokümanındaki kurulum)
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }), // db: senin drizzle bağlantın
  emailAndPassword: { enabled: true },
})
```

Dört tabloyu — `user`, `session`, `account`, `verification` — Metatron değil,
Better Auth'ın kendi adapter'ı oluşturur ve yönetir. Login/signup uçları,
oturum doğrulaması ve cookie işleri de onundur; Metatron'un bu aşamada rolü
yoktur.

### Better Auth tabloları şema dışıdır: `external` beyanı (R1=b)

Bu dört tablonun primary key'i `text`'tir; ORMIM v1 ise yalnız `uuidPk` tanır
— yani tablolar şemana **dahil edilemez**. Yetmez, bir de korunmaları gerekir:
`planPush` şemada tanımlı olmayan tablo için `DROP TABLE` planlar ve dev
akışında (`onLint: 'log'`) bu DROP **uygulanır** (göç haritası, risk R1).

Karar (R1=b): ORMIM'e "external table" beyanı eklenir — tabloyu şemada anarsın,
ORMIM ona hiç dokunmaz (ne create, ne diff, ne DROP):

```ts
// metatron/schema.ts — external beyanının hedef hâli (taslak)
export const schema = defineSchema({
  posts: defineTable({ /* ... */ }),
  // ...senin uygulama tabloların
}, {
  external: ['user', 'session', 'account', 'verification'],
})
```

> **Dürüst not: `external` beyanı henüz yok.** Beyan şu anda yazılıyor ve
> **Faz 4'te** gelecek. O güne kadar kural tek cümledir: Better Auth
> tablolarını ORMIM'in yönettiği şemadan **ayrı tut** — ayrı bir database ya
> da ayrı bir Postgres schema'sında çalıştır. Aynı veritabanında ve `public`'
> te bırakırsan, `metatron dev`'in ilk push'unda DROP planıyla karşılaşırsın
> (göç haritası Adım 1'deki (a) seçeneği).

## Köprü: oturum cookie'sinden fn çağrısına kimlik

Köprü, son kullanıcının cookie'sini Metatron'un anlayacağı kimliğe çeviren
katmandır. v1'de panel `/fn/*` uçlarına giden tek kimlik `dbb_` token'ıdır;
son kullanıcının cookie'si panel için anlamsızdır. Bu yüzden köprü **senin
kenarındadır** (göç haritası §4.2, seçenek A — kararlaşan geçiş deseni):

1. Tarayıcı → senin sunucun: istek, Better Auth oturum cookie'si taşır.
2. Kenar (Hono, Next route handler, vb.) cookie'yi Better Auth'a doğrulatır ve
   kullanıcıyı çözer.
3. Kenar → panel: `/fn/query|mutation` çağrısı, **sunucuda duran servis
   `dbb_` token'ıyla** yapılır; çözülen kullanıcı kimliği fn'e açık argüman
   olarak geçer.
4. Fn, kimliği argümandan okur; tenant/yetki kontrolünü kendi içinde yapar
   (foxapp'taki `requireTenant(ctx, userId)` deseninin karşılığı).

Fn tarafında bugün çalışan desen:

```ts
// functions/blog/posts.ts — v1 deseni: kimlik açık argümanla gelir
import { query } from '../runtime'

export const listMine = query({
  handler: async (ctx, args: { userId: string }) => {
    // userId'yi kenar çözüp geçti; yetki kontrolü burada, fn içinde
    const res = await ctx.db.query('data/posts:listByAuthor', {
      authorId: args.userId,
    })
    return res.value
  },
})
```

### `ctx.auth`: bugün stub, Faz 4'te köprünün hedefi

`ctx` imzasında `auth` bugünden vardır ama **stub**'tır: her zaman null
identity döner (`functions/README.md`: "panel token köprüsü sonra"). Faz 4'te
köprü Metatron'a taşınacak — kenarın çözdüğü oturum, fn'e `ctx.auth`
üzerinden görünecek. Taslak (imza Faz 4'te netleşir, kesin API değildir):

```ts
// Faz 4 taslağı — isimler kesin değil
export const listMine = query({
  handler: async (ctx, _args) => {
    const me = await ctx.auth.getUserIdentity() // v1'de: null (stub)
    if (!me) throw new FnError('UNAUTHENTICATED', 'giriş gerekli')
    // ...
  },
})
```

Pratik sonuç: bugün fn'lerini kimliği argümandan okuyan desenle yaz — Faz 4
geldiğinde değişen tek şey "kimliğin nereden okunduğu" olur.

> **SSE detayı (risk R2):** tarayıcı `EventSource`'u header gönderemez,
> `/fn/listen` ise `Bearer` ister. Reaktif sorguları son kullanıcıya açarken
> ya panele token'ı query parametresiyle alan küçük bir proxy ya da
> fetch-tabanlı bir SSE okuyucu gerekir — bu da Faz 4 köprüsünün parçasıdır.

!!! warning "Yapmayın: son kullanıcıya asla `dbb_` panel token'ı verilmez"

    `dbb_` token **panel kimliğidir** — taşıyıcısına panel rolleriyle
    (Geliştirici dahil) fn çağırma yetkisi verir ve uygulamanın
    tenant/kullanıcı sınırını **bilmez**. Son kullanıcının tarayıcısına
    `dbb_` koymak, ona panel anahtarını teslim etmektir: token'ı okuyan
    herkes senin adına mutation çalıştırır. Doğru model yukarıdaki köprüdür:
    kullanıcı cookie ile **senin kenarına** gelir, `dbb_` yalnızca sunucunda
    durur. (Köprünün doğal hedefi — login karşılığı kısa ömürlü, kısıtlı
    token üretmek, göç haritası §4.2 seçenek B — Metatron'a app-auth
    geldiğinde mümkün olacak; o bile bugünkü anlamıyla panel token'ı
    değildir.)

Şimdi şunu yapabileceksin: panel kimliğiyle uygulama kimliğini karıştırmadan
yeni bir Metatron uygulamasına Better Auth kurmak, auth tablolarını şema
dışında güvende tutmak ve son kullanıcı kimliğini fn'lere bugünden — argümanla
— güvenle taşımak. Rehberin ana hattına dönelim: [Dallar ve merge](dallar-ve-merge.md).

İlgili: [roller](../roller.md) · [workspace ve yetki](../workspace-yetki.md) ·
[istemci](../istemci.md) · [kurulum](kurulum.md)

> Kaynak: `metatron/CONTRACT.md` ("app-seviye auth v1 DIŞI") ·
> `metatron/foxapp-migration-map.md` §4 (canlı v2 Better Auth, A/B/C köprü
> seçenekleri) + R1/R2 riskleri · `functions/README.md` (`ctx.auth` stub) ·
> Better Auth kurulum kalıbı: better-auth.com dokümanı
