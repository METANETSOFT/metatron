# Şema: React ORM (ORMIM)

ORMIM, şemanı migration dosyaları yerine **tek bir TypeScript tanımı** olarak
yazmanı sağlar: tablolar `defineSchema` ile kodda yaşar, canlı veritabanıyla
fark `planPush` tarafından hesaplanır ve `metatron dev` her kaydettiğinde bu
farkı içinde olduğun dalın Postgres'ine uygular.

Bu sayfadaki her SQL çıktısı, gösterilen şemayla gerçek bir PostgreSQL 18'e
karşı çalıştırmanın birebir sonucudur.

## İlk şema: blog (posts + comments)

`defineSchema`, tablo tanımlarını alıp hem TS tiplerini hem bağımlılık sıralı
DDL'i üreten tek giriş noktasıdır. Küçük bir blog şeması — yazılar ve onlara
bağlı yorumlar:

```ts
// metatron/schema.ts
import { defineSchema, defineTable, t } from 'metatron-orm'

export const schema = defineSchema({
  posts: defineTable({
    id: t.uuidPk(),
    title: t.text().notNull(),
    body: t.text().notNull(),
    publishedAt: t.timestamptz(),
  }),
  comments: defineTable({
    id: t.uuidPk(),
    postId: t.uuid().notNull().references(() => schema.posts.id, { onDelete: 'cascade' }),
    author: t.text().notNull(),
    body: t.text().notNull(),
  }, (c) => [
    c.index('comments_post_idx').on('postId'),
  ]),
})
```

Bu tanımın ürettiği DDL (`schema.ddl()` — gerçek çıktı):

```sql
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid LANGUAGE sql VOLATILE AS $$ ... $$;

CREATE TABLE "posts" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "title" text NOT NULL,
  "body" text NOT NULL,
  "publishedAt" timestamptz
);

CREATE TABLE "comments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "postId" uuid NOT NULL,
  "author" text NOT NULL,
  "body" text NOT NULL
);

CREATE INDEX "comments_post_idx" ON "comments" ("postId");

ALTER TABLE "comments" ADD CONSTRAINT "comments_postId_fk"
  FOREIGN KEY ("postId") REFERENCES "posts" ("id") ON DELETE CASCADE;
```

Sıra her zaman böyledir: önce `uuidv7()` üreticisi, sonra tablolar (bağımlılık
sıralı — referenced tablo önce), sonra index'ler, **FK'ler en sonda**.

## Tipler ve zincirler

Kolon tipleri `t` fabrikasından gelir; zincir metotları kısıtları ekler:

- Tipler: `t.text()` · `t.integer()` · `t.bigint()` · `t.boolean()` ·
  `t.timestamptz()` · `t.jsonb()` · `t.uuid()` · `t.enum([...])` ·
  `t.vector(n)` (pgvector — plan başına `CREATE EXTENSION IF NOT EXISTS vector`
  eklenir) · `t.tsvector()` · `t.uuidPk()`
- Zincirler: `.notNull()` · `.nullable()` (varsayılan) · `.default(v)` ·
  `.unique()` · `.references(fn, { onDelete })` · `.renamedFrom(eskiAd)`
- Tablo ekleri (ikinci argüman): `c.unique('a', 'b')` (variadic) ·
  `c.index(ad).on(kolon)` · `c.check(ad, sql)`

`t.enum(['a','b'])` native PG enum değildir — `text` + inline `CHECK` üretir;
böylece değer listesi sonradan ağrısız genişler.

TS tarafında satır tipi şemadan çıkarılır, elle yazılmaz:

```ts
import type { Infer } from 'metatron-orm'

type Post = Infer<typeof schema.tables.posts>
// { id: string; title: string; body: string; publishedAt: Date | null }
```

## Neden `uuidPk()`?

`t.uuidPk()`, `DEFAULT uuidv7()`'li bir uuid primary key üretir — insert'te id'yi
veritabanı kendisi yazar (canlı doğrulama: `INSERT INTO posts (title, body) ...`
→ `id = 019fbfdf-bd42-74ae-b574-9cd47c5f1fc0`).

Sebep merge'dir: merge laboratuvarı (s9) gösterdi ki serial/identity PK iki dalda
aynı değeri üretir ve birleşmede `23505` (unique violation) patlar; uuidv7
çarpışmasız çalışır. Numerik PK yasak değildir ama dal merge'i yapacaksan risk
kabulüdür — çakışan id'leri merge'de yeniden yazan "remap" mekanizması gelene
kadar varsayılan desen `uuidPk()`'dır.

## Push: diff → plan → uygula

`planPush` canlı şemayı `information_schema`'dan okur, tanımınla farkını DDL
listesi olarak çıkarır; `applyPlan` uygular ve her push'u `_metatron_push_log`'a
yazar (bu günlük merge-up'ın zeminidir):

```ts
import { planPush, applyPlan } from 'metatron-orm/push'

const plan = await planPush(sql, schema)   // sql: postgres.js
// plan: { stmts: string[], lint: LintIssue[], schemaHash: string }
await applyPlan(sql, plan, { onLint: 'log' }) // 'log' (varsayılan) | 'fail'
```

İlk push'ta plan, yukarıdaki DDL'nin aynısıdır. Push **idempotenttir** — şema
değişmediyse ikinci `planPush` `stmts: []` döner (canlı doğrulandı). Kolon
eklediğinde plan yalnızca farkı taşır:

```ts
// posts'a  likes: t.integer().notNull().default(0)  eklendi
// plan.stmts (gerçek çıktı):
ALTER TABLE "posts" ADD COLUMN "likes" integer NOT NULL DEFAULT 0
```

Güvenli genişlemeler (`integer → bigint`, `varchar(n) → text` gibi widening'ler)
otomatik `ALTER TYPE` olur; daralmalar uygulanmaz, lint'e düşer.

## Lint: push'un erken uyarısı

Lint, planın parçasıdır — push'u bloklamaz (dev akışında loglanır), ama merge
zamanı çatışma tespitinde kullanılır. Dört tür vardır:

| `kind` | Ne zaman düşer |
|---|---|
| `rename-suspect` | aynı tabloda DROP + ADD çifti, benzer tip — rename şüphesi |
| `destructive` | `DROP COLUMN` / `DROP TABLE` — veri silinir |
| `narrowing` | daralan tip değişimi — otomatik uygulanmaz |
| `fk-risk` | mevcut tabloya yeni FK — eski satırlar kısıtı ihlal edebilir |

## Rename: veriyi koruyan tek yol `renamedFrom`

`information_schema` bir rename'i "kolon düştü + kolon eklendi" olarak görür.
İşaretsiz rename'de plan şöyle görünür (gerçek çıktı, `title → baslik`):

```
ALTER TABLE "posts" ADD COLUMN "baslik" text NOT NULL
ALTER TABLE "posts" DROP COLUMN "title"
lint: [
  { kind: 'destructive',    detail: 'DROP COLUMN posts.title — veri silinir' },
  { kind: 'rename-suspect', detail: "rename şüphesi posts.title→baslik (text) — kasıtlıysa .renamedFrom('title') kullanın" },
]
```

Bu haliyle uygulanırsa kolon verisi **silinir**. Doğrusu işaretli rename'dir:

```ts
baslik: t.text().notNull().renamedFrom('title')
```

Plan bu kez tek satırdır ve veri korunur (canlı doğrulama: rename sonrası
`SELECT baslik FROM posts` → `'ilk yazı'` aynen duruyor):

```
ALTER TABLE "posts" RENAME COLUMN "title" TO "baslik"
```

## `metatron dev`: kaydet, dalda uygulanmış bul

`metatron dev`, şema dosyanı izler; her değişiklikte 500 ms sessizlik bekler ve
push döngüsünü koşar. Hedefi `.env.local`'deki `DATABASE_URL`'den okur — o da
`metatron use <dal>` tarafından yazılır:

```bash
metatron dev        # varsayılan: --dir . --schema metatron/schema.ts
```

Gerçek bir oturum (iki embedded Postgres'li dogfood'dan, birebir):

```
izleniyor: /tmp/rehber-test/dev/proje (sema: .../metatron/schema.ts)
✓ pushed · 2 stmt · 0 lint → postgres@127.0.0.1:55730
#   ← schema.ts'e `likes` kolonu eklenip kaydedildi (≈1 sn sonra):
✓ pushed · 1 stmt · 0 lint → postgres@127.0.0.1:55730
#   ← .env.local başka dalın DB'sine çevrildi:
dal degisti → yeni hedef: dal-b@127.0.0.1:55731
✓ pushed · 2 stmt · 0 lint → dal-b@127.0.0.1:55731
```

Üç davranışı bil:

- **Dal takibi:** `.env.local` değişirse (post-checkout hook'u başka dala
  geçirdi) watcher URL'yi yeniden okur ve aynı şemayı yeni dalın DB'sine kurar.
- **Hata tolere eder:** bağlantı koptuysa 0,5→16 sn backoff ile dener; şemada
  syntax hatası varsa çöker ama **crash etmez** — düzeltmeni bekler.
- **Lint bloklamaz:** dev akışında `onLint: 'log'`'dur; `⚠ lint: …` satırı
  düşer, push devam eder.

Küçük not: projenin `package.json`'unda `"type": "module"` olmalı — `dev`,
şema dosyanı ESM olarak yükler.

Şimdi şunu yapabileceksin: şemayı kodda tanımlayıp dalına saniyeler içinde
uygulatmak, rename'leri veri kaybetmeden yapmak. Sıra bu tabloları dolduracak
fonksiyonlarda: [Fonksiyonlar ve React](react-fonksiyonlar.md).

İlgili: [ormim](../ormim.md) (teknik referans) · [dallar ve merge](dallar-ve-merge.md)

> Kaynak: `metatron/ORM-CONTRACT.md` · `packages/orm/src/{schema,push}.ts` ·
> canlı çıktılar: embedded-postgres 18 laboratuvarı, 2026-08-02
> (`/tmp/rehber-test/04-orm.mjs`, `07-dev.mjs`)
