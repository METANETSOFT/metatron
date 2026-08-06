# metatron-orm (ORMIM)

Metatron platform'un şema paketi: TS'te şema tanımı → bağımlılık sıralı DDL →
dev-push (live-DB diff → plan → uygula). Sözleşme: `../../ORM-CONTRACT.md` (Faz 2, TEK doğru).

## Şema tanımı

```ts
import { defineSchema, defineTable, t } from 'metatron-orm'

export const schema = defineSchema({
  orgs: defineTable({
    id:   t.uuidPk(),                        // uuid PK, DEFAULT uuidv7() (üretici fonksiyon paket kurar)
    name: t.text().notNull(),
  }),
  members: defineTable({
    id:    t.uuidPk(),
    orgId: t.uuid().notNull().references(() => schema.orgs.id, { onDelete: 'cascade' }),
    role:  t.enum(['a', 'b']).notNull().default('a'),
    emb:   t.vector(1536).nullable(),        // pgvector → DDL/plan başına CREATE EXTENSION vector
  }, (c) => [c.unique('role'), c.index('m_idx').on('orgId'), c.check('ck', 'role is not null')]),
})

type Member = Infer<typeof schema.tables.members>   // TS tip çıkarımı
const stmts = schema.ddl()                          // CREATE TABLE'lar (referenced önce) → index → FK (en son)
```

Tipler: `text integer bigint boolean timestamptz jsonb uuid enum vector tsvector` (+ `uuidPk`).
Zincirler: `.notNull() .nullable() .default(v) .unique() .references(fn, {onDelete}) .renamedFrom(eskiAd)`.
Kolon varsayılanı nullable'dır; `Infer` çıktısında `T | null` üretir.

### External tablolar (R1=b)

ORMIM'in yönetmediği tablolar (ör. Better Auth'ın text-PK'lı `user/session/account/verification`'ı)
ikinci argümanla beyan edilir:

```ts
export const schema = defineSchema({ /* ... */ }, {
  external: ['user', 'session', 'account', 'verification'],
})
```

`planPush` bu adları diff'ten **tamamen** dışlar: live'da varsa `DROP TABLE` planlanmaz, yoksa
`CREATE` planlanmaz, ALTER/tip karşılaştırması yapılmaz ve lint (destructive dahil) üretilmez.
Liste `schema.external`'da taşınır ve `schemaHash`'e dahildir — listeden çıkarma davranış
değişikliğidir, bir sonraki push'ta görünür. External adı şemada tanımlı bir tabloyla çakışırsa
`planPush` hata fırlatır (açık çelişki; sessiz geçilmez). Beyan edilmeyen şema-dışı tablolar için
mevcut davranış korunur: `DROP TABLE` + destructive lint.

## Push (`metatron-orm/push`)

```ts
import { planPush, applyPlan } from 'metatron-orm/push'

const plan = await planPush(sql, schema)       // live şemayı information_schema'dan okur, diff üretir
// plan: { stmts, lint, schemaHash } — LintIssue.kind: rename-suspect | destructive | narrowing | fk-risk
await applyPlan(sql, plan, { onLint: 'log' })  // 'log' | 'fail'; her push _metatron_push_log'a yazılır
```

Diff: ADD TABLE / ADD COLUMN / ALTER TYPE (yalnız güvenli widening: int→bigint, varchar büyütme,
varchar→text; narrowing yalnız lint) / DROP (destructive lint) / RENAME (yalnız `.renamedFrom` ile;
işaretsiz drop+add çifti "rename şüphesi" lint'i). Idempotent: aynı şema hash'i → `stmts=[]`.

`sql`, postgres.js'in minimal alt kümesiyle (`SqlLike`) uyumludur; paketin runtime bağımlılığı yoktur.

## Cursor pagination korkuluğu (`metatron-orm/pagination`)

Sorgu runtime'ı / `usePaginatedQuery` henüz YOK — bu subpath sadece gelecekte pagination
yazılırken uyulacak tip+kural sözleşmesi (ORM-CONTRACT §8; db-branching#17). Kaynak hata:
Convex `splitPaginatedQueryPage` split'in ilk parçası için cursor'u `null`'a ("tablonun en başı")
düşürüyor → duplicate. Burada `CursorAnchor` `null` içermez (tip düzeyinde imkânsız); `splitPage`
ilk parçanın cursor'unu her zaman devralır, `mergePages` kopuk zinciri `PaginationContractError`
ile reddeder. Sıralama anahtarı `defineSortKey(columns, tiebreaker)` ile TEKİL olmak zorunda
(tiebreaker = son kolon, genelde PK). Kanıt: `tests/pagination.test.ts`.

## Scriptler

- `npm test` — node:test (sahte sql ile DI; gerçek PG gerektirmez)
- `npm run typecheck` — tsc --noEmit (Infer tip assert'leri tests/ içinde)
