# @metatron/cli

Metatron panelinin komut satiri istemcisi. Gorevi: **hangi git dalindaysan, o git dalina ait
Postgres dalini otomatik secmek.** AI ajanlari (Claude Code, Kimi, Codex) ve insanlar ayni
komutu kullanir.

## Kurulum

```bash
npm install -g @metatron/cli
# veya tek seferlik: npx @metatron/cli ...
```

Node >= 20 gerekir (yerlesik `fetch` kullanir, bagimlilik yok).

## Kimlik

Panelden kisisel API token'i uret (`dbb_...`) ve kaydet:

```bash
metatron login --url https://panel.ornek.com --token dbb_...
# ~/.config/metatron/config.json (chmod 600)
```

CI'da dosya yerine ortam degiskeni: `METATRON_URL`, `METATRON_TOKEN`, `METATRON_PROJECT`.

## Komutlar

| Komut | Ne yapar |
| --- | --- |
| `metatron use <dal> [--project <slug>] [--no-create] [--quiet]` | Dali bulur (yoksa **acar**), baglanti dizesini repo kokundeki `.env.local`'e `DATABASE_URL` olarak yazar, stdout'a `export DATABASE_URL='...'` basar. |
| `metatron list [--project]` | Projedeki canli dallari listeler. |
| `metatron create <dal>` | `use` ile ayni; dal yoksa acar. |
| `metatron destroy <dal>` | Dali kaldirir. |
| `metatron hook install` | `.git/hooks/post-checkout` kurar: her dal degisiminde `metatron use` otomatik kosar (arka planda, checkout'u bloke etmez). |
| `metatron hook uninstall` | Kancayi kaldirir. |

## Nasil calisir

1. **Proje secimi:** `--project` verilmediyse `git remote origin`'den `owner/repo` cikarilip
   paneldeki repo baglantisiyla eslestirilir; tek proje varsa o kullanilir.
2. **Baglanti dizesi:** PgBouncer (tek adres + TLS) > SSH tunelli lokal port > ic ag.
3. **Sifre politikasi:** panel dal sifresini hicbir yerde saklamaz. Mevcut dal icin
   `credentials` ucu sifreyi **dondurup** yeni dize verir — eski dize o anda gecersizlesir.
4. **`.env.local`:** diger satirlar korunur; dosya `chmod 600` ve otomatik `.gitignore`'a
   eklenir. Uygulama tarafinda `.env.local`, `.env`'den ONCE yuklenmeli (Node 20.6+:
   `process.loadEnvFile('.env.local'); process.loadEnvFile('.env')`).

## Drizzle ile akis

```bash
git checkout -b feat/yeni-sema
metatron use feat/yeni-sema          # DB dali hazir + .env.local guncel
# db/schema.ts'i duzenle, sonra:
npx drizzle-kit generate             # migration'i drizzle-kit uretir (elle SQL yazma)
npm run migrate                      # AKTIF DALIN veritabanina uygular
```

`push` KULLANMA — yalnizca `generate` + `migrate`. CI'da migration klasoru kapisini calistir
(journal/sql esitligi, tekil numara, generate sonrasi bos diff).

## AI ajan entegrasyonu

Repo `AGENTS.md`'sine:

```md
- DB isinden once `metatron use $(git branch --show-current)` calistir.
- Semayi db/schema.ts'te degistir, `drizzle-kit generate` ile migration uret, `migrate` kos.
```

`metatron hook install` kuruluysa ajan `git checkout` yaptigi anda DB dali zaten hazir olur.
