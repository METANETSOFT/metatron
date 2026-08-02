# ORMIM (`metatron-orm`) ve `metatron dev`

Şema TypeScript'te tek dosyada tanımlanır; `metatron dev` her değişikliği **içinde
olunan dalın Postgres'ine** anında uygular. Migration dosyası yazılmaz — diff,
canlı DB'ye karşı hesaplanır. Bu sayfa Faz 2'nin şema dilini, push mekanizmasını
ve watch akışını anlatır.

## Şema tanımı

```ts
import { defineSchema, defineTable, t } from 'metatron-orm'

export const schema = defineSchema({
  orgs: defineTable({
    id:   t.uuidPk(),                          // uuidv7 DEFAULT
    name: t.text().notNull(),
  }),
  members: defineTable({
    id:     t.uuidPk(),
    orgId:  t.uuid().notNull().references(() => schema.orgs.id, { onDelete: 'cascade' }),
    email:  t.text().notNull(),
    role:   t.enum(['yonetici','gelistirici','okuyucu']).notNull().default('okuyucu'),
    search: t.tsvector(),
    emb:    t.vector(1536).nullable(),         // pgvector — yoksa push'ta CREATE EXTENSION vector
  }, (c) => [
    c.unique('email'),
    c.index('members_org_idx').on('orgId'),
    c.check('role_ck', "role in ('yonetici','gelistirici','okuyucu')"),
  ]),
})
```

Tipler: `t.text / integer / bigint / boolean / timestamptz / jsonb / uuid /
enum([...]) / vector(n) / tsvector`.
Zincirler: `.notNull() .nullable() .default(v) .unique() .references(fn, {onDelete})`.
Tablo ekleri: `c.unique(...)` (variadic — `c.unique('a','b')`), `c.index(ad).on(kolon)`,
`c.check(ad, sql)`.
TS çıkarımı zorunludur: `type Member = Infer<typeof schema.tables.members>`.

## Rename işareti — veriyi koruyan tek yol

Merge lab dersi (s2): information_schema bir rename'i **drop+add** olarak görür;
işaretsiz rename'de kolon verisi sessizce kaybolur. Bu yüzden:

```ts
t.text().renamedFrom('ad')   // → ALTER TABLE RENAME COLUMN (veri korunur)
```

İşaret yoksa diff "aynı tabloda DROP + ADD" çifti görür ve **rename şüphesi**
lint'i düşer (varsayılan: uyar + logla; push bloklanmaz).

## Push: planPush → applyPlan

```ts
import { planPush, applyPlan } from 'metatron-orm/push'

const plan = await planPush(sql, schema)       // live şema information_schema'dan okunur
// plan: { stmts: string[], lint: LintIssue[] }
await applyPlan(sql, plan, { onLint: 'log' })  // 'log' | 'fail'
```

- DDL **bağımlılık sıralı** üretilir: önce referenced tablolar, sonra index'ler,
  FK'ler en son. pgvector kolonu varsa `CREATE EXTENSION IF NOT EXISTS vector` plan başında.
- Değişiklik türleri: ADD TABLE / ADD COLUMN / güvenli widening ALTER TYPE /
  DROP COLUMN|TABLE / RENAME (yalnız `renamedFrom` ile).
- **Idempotent**: aynı şema tekrar push'lanırsa `schema_hash` eşleşir, `stmts=[]` döner.

Lint türleri (`LintIssue.kind`):

| Tür | Ne zaman |
|---|---|
| `rename-suspect` | aynı tabloda işaretsiz DROP+ADD çifti |
| `destructive` | DROP COLUMN / DROP TABLE — veri silinir |
| `narrowing` | tip daralması (güvenli olmayan ALTER TYPE) |
| `fk-risk` | FK hedefiyle ilgili riskli değişiklik |

## Push günlüğü: `_metatron_push_log`

Her dal DB'sinde; merge-up'ın zemini budur:

```sql
CREATE TABLE IF NOT EXISTS _metatron_push_log (
  seq bigserial PRIMARY KEY,
  applied_at timestamptz DEFAULT now(),
  schema_hash text NOT NULL,        -- normalize edilmiş şemanın hash'i
  stmts jsonb NOT NULL,             -- uygulanan DDL listesi
  lint jsonb NOT NULL DEFAULT '[]'
);
```

Merge motoru bu günlüğün iki taraflı diff'iyle çalışır →
[merge-motoru](merge-motoru.md).

## `metatron dev` — watch akışı

```
metatron dev [--dir .] [--schema metatron/schema.ts]
```

- Şema dosyasını (ve push sırasında okunan import zincirini) `fs.watch` ile izler;
  değişiklikte **500 ms sessizlik** bekler, sonra push döngüsü.
- Hedef `.env.local`'deki `DATABASE_URL`'dir. **Dal takibi**: `.env.local`
  değişirse (post-checkout hook'u başka dala geçirdi) watcher URL'yi yeniden okur
  ve aynı şemayı **yeni dalın DB'sine** kurar. Log'da hedef db/host her zaman görünür.
- Hata davranışı: lint fail değilse logla + izlemeye devam; transient (bağlantı)
  hatasında 0,5→16 sn backoff+jitter; kalıcı hatada (syntax) düzeltmeyi bekler —
  **crash yok**.
- Çıktı dili: `✓ pushed · 2 stmt · 0 lint → main@fox-01:55432` /
  `⚠ lint: rename şüphesi people.ad→isim`.

Dogfood'da birebir kanıtlı akış: ilk push tabloları kurar → kolon ekle ~1 sn içinde
`ALTER TABLE` → kolon sil + destructive lint → `renamedFrom` ile rename, satır aynen
durur → `.env.local` başka dala çevrilince şema yeni hedefe kurulur.

## PK kuralı (kilitli)

- **UUID (uuidv7) her zaman önerilen** — merge lab s9 kanıtlı: serial PK iki dalda
  `23505` üretir, uuid çarpışmasız. `t.uuidPk()` varsayılan desendir.
- **Numerik PK yasak değil ama lint uyarısı**: `integer/bigint` PK görülünce push
  lint'e düşer — "numerik PK: branch merge'de çakışma riski (23505); uuid önerilir.
  Çakışma remap'i gelene kadar risk kabulüdür."
- Merge remap (çakışan id'yi merge'de yeniden yazma + FK güncelleme) escape
  hatch'tir; Faz 2.5 konusu.

## v1 dışı (bilinçli)

nullability/default diff'i, sonradan `references()` ekleme diff'i, index/constraint
diff'i, vector boyut diff'i, generated column/trigger, RLS, çoklu şema dosyası,
`metatron deploy` (prod push, onay akışıyla).

İlgili: [merge-motoru](merge-motoru.md) · [istemci](istemci.md) · [dallar](dallar.md) · [workspace-yetki](workspace-yetki.md)

> Kaynak: `metatron/ORM-CONTRACT.md` (Faz 2 kontratı) · hafıza
> `metatron-faz2-orm-dev` (dogfood kanıtları: orm 24/24, cli dev 7/7) ·
> `metatron-merge-lab-sonuclari` (s2 rename, s9 PK matrisi)
