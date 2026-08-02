# Docs site planı — Metatron (dbbranch)

Bu klasör (`docs/`) ileride statik bir belge sitesine kaldırılacak. Bu dosya araç
kararını, yapıyı ve yayına geçiş ("lift") adımlarını sabitler. **Bu turda hiçbir araç
kurulmadı, site build edilmedi** — sadece plan + iskelet dosyalar.

## Araç kararı: MkDocs Material

Adaylar: MkDocs Material · Docusaurus · VitePress.

1. Ürün ethos'u "kendi sunucunda, tek compose, sıfır süs" — MkDocs tek `pip install` + tek YAML; çıktı saf statik HTML, herhangi bir HTTP sunucusu (hatta `python3 -m http.server`) yeterli. Node toolchain YOK.
2. Docusaurus elendi: React SPA + node build zinciri (node_modules, bundler); i18n/versioning makinesi bizde karşılığı olmayan ağırlık.
3. VitePress elendi: şık ama yine Vite/Vue build zinciri; daha genç; Türkçe tema çevirileri Material kadar tam değil.
4. İçerik Türkçe: Material'da `theme.language: tr` hazır arayüz çevirisi verir, arama eklentisi `lang: tr` destekler.
5. Arama: Material'ın yerleşik istemci-taraflı araması statik build'e gömülür — ek servis/dizin altyapısı yok.
6. Olgunluk: Material, MkDocs ekosisteminin fiilî standardı; sayfalar düz Markdown kalır, başka araca taşınma bedeli sıfır.
7. Sayfalar generator-agnostic yazıldı: çapraz linkler göreli `.md` linkleri — GitHub'da da MkDocs'ta da çözülür. Lift config-only olur.

## Yapı / nav

Düz dosyalar, klasör yok (bilinçli — sayfa sayısı az, derinlik gereksiz):

```
docs/
├── mkdocs.yml          # site iskeleti (docs_dir: . → bu klasör)
├── PLAN.md             # bu dosya
├── index.md            # Metatron nedir · 30 saniyelik resim · ne DEĞİL
├── mimari.md           # ZFS CoW · worker modeli + heartbeat · gateway · kontrol düzlemi
├── baglanma.md         # sabit adres · kullanıcı adı şeması · TLS · psql örneği
├── dallar.md           # dal açma · PR otomasyonu · ~30 ms gerçeği · kota · şema senkronu
├── maskeleme.md        # iki eksen · dump-time · dürüstlük kuralı · transformer sözlüğü
├── roller.md           # Yönetici/Geliştirici/Okuyucu · yetki tablosu
├── kolon-paylasimi.md  # postgres_fdw / logical replication / jsonb
└── pitr.md             # pgBackRest · saniyelik geri dönüş · saklama · restore akışı
```

`nav` sırası `mkdocs.yml` içinde; yeni sayfa = düz `.md` dosyası + nav'a tek satır.

## Yayına geçiş (lift) adımları — config-only

1. İzole ortamda kur (repoya bağımlılık eklenmez):
   `python3 -m venv .venv-docs && .venv-docs/bin/pip install mkdocs-material`
2. Yerel önizleme: `.venv-docs/bin/mkdocs serve -f docs/mkdocs.yml` → `http://127.0.0.1:8000`
3. Build: `.venv-docs/bin/mkdocs build -f docs/mkdocs.yml` → çıktı repo kökünde `site/`.
   (Lift sırasında `.gitignore`'a `site/` ve `.venv-docs/` eklenmeli — bu turda mevcut dosyalara dokunulmadı.)
4. Yayın — self-hosted ethos'a uygun iki yalın seçenek:
   - Mevcut compose'a tek servis: `nginx:alpine` (veya Caddy) ile `site/` mount et; TLS'i öndeki mevcut reverse proxy sonlandırsın.
   - Dokploy'da "static site" olarak ayrı subdomain (ör. `docs.*`).
5. CI (isteğe bağlı, zorunlu değil): push'ta `mkdocs build` + `site/` upload. El ile build de ethos'a uygun.

## İçerik kuralları (kalıcı)

- Dil Türkçe, ton yalın operatör dili.
- Her iddia `PRODUCT.md` / `FLEET.md` / `TEST-REPORT.md` ya da kilitli kullanıcı kararına dayanır; sayfa sonundaki "Kaynak" satırı izi gösterir. Ölçüm uydurulmaz.
- Çapraz linkler her zaman göreli `.md` (`[mimari](mimari.md)`) — tool değişse bile çalışır.
- Tool'a özel sözdizimi kullanılmaz (admonition gerekirse `!!! note` — Markdown'dan kopmaz).
