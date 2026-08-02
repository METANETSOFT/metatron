# Metatron

Postgres icin ZFS copy-on-write tabanli **dal (branch) kontrol duzlemi**: her git dali icin
saniyeler icinde izole, kota'li, maskelenebilir bir Postgres kopyasi. Kubernetes'siz, tek
`docker compose` ile calisir.

Bu repo Metatron ekosisteminin istemci tarafini tutar:

| Yol | Aciklama |
| --- | --- |
| [`cli/`](./cli) | **`metatron-cli`** — AI ajanlarinin ve insanlarin "su dalda calis" dediginde dogru Postgres dalina otomatik gecmesini saglayan komut satiri araci. |

Kontrol duzlemi (panel + worker) su an ozel `myagizmaktav/db-branching` reposunda yasiyor.

## CLI'yi 30 saniyede kur

```bash
npm install -g metatron-cli

# Panelden urettigin kisisel token ile (dbb_...):
metatron login --url https://panel.tr.foxtools.de --token dbb_...

# Bundan sonra: hangi git dalindaysan o Postgres dalindasin
git checkout -b feat/yeni-ozellik
metatron use feat/yeni-ozellik      # dal yoksa ACAR, .env.local'e DATABASE_URL yazar

# Tam otomatik: her checkout'ta kendisi yapsin
metatron hook install
```

## AI ajanlariyla kullanim

Ajanin (Claude Code / Kimi / Codex) DB dalini otomatik secmesi icin repo `AGENTS.md`'sine
tek kural eklemek yeterli:

```md
- DB isinden once `metatron use $(git branch --show-current)` calistir.
  .env.local'deki DATABASE_URL aktif dalin Postgres'ini gosterir.
```

`metatron use` ciktisi olarak `export DATABASE_URL='...'` basar; ajan bunu `eval` ile
kendi kabuguna da uygulayabilir.

Detay: [cli/README.md](./cli/README.md)

## Belgeler

Urun belgeleri (mimari, baglanma, dallar, maskeleme, roller, PITR ve faz kontratlari)
[`docs/`](./docs) altinda duz Markdown olarak durur ve MkDocs Material ile statik siteye
derlenir:

- **Site:** <https://metanetsoft.github.io/metatron/>
- Yerel onizleme: `mkdocs serve` (kok `mkdocs.yml`; `pip install mkdocs-material` yeterli)
- Yayin: `mkdocs gh-deploy --force` → `gh-pages` dali GitHub Pages'ten sunulur
