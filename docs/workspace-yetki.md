# Workspace ve yetki modeli

Kullanıcılar **workspace**'te toplanır, **takım**lara girer; her takım üyeliği
workspace'in **rol şemasından** bir rol taşır. Projedeki efektif yetki, kişinin o
projeye bağlı takımlardaki rollerinin **en güçlüsüdür**. Bu sayfa [roller](roller.md)'deki
düz "DB başına rol" modelinin yerini alan yapıyı anlatır.

## Üç kavram

- **Workspace**: kullanıcı açar, üye ekler. (Organization yerine "workspace" —
  kullanıcı tercihi.)
- **Rol şeması**: workspace başına, **şema olarak dizayn edilir** — özel rol
  tanımları: anahtar, etiket, yetki seti (PERM sözlüğünden). Varsayılan üç rol
  (Yönetici / Geliştirici / Okuyucu) tanıdıktır → [roller](roller.md); workspace
  kendi rollerini ekleyip silebilir. **Kullanımdaki rol silinemez** — API `409`
  döner: "N üyede kullanımda — önce onları başka role taşı."
- **Takım**: workspace içinde kurulur; projelere çok-çok bağlanır/çıkarılır.

PERM sözlüğü backend'de sabit 10 anahtardır:
`dal_ac · dal_sil · ayar · uye · filo · jeton · tasima · veri_oku · veri_yaz · korumali_yaz`.

## Kişi × takım → rol; efektif = en güçlü

Takım üyeliği kişi × takım başına rol şemasından **bir** rol taşır. Kişi birden
çok takımda **farklı rol** olabilir — birinde Yönetici, diğerinde Okuyucu
(fiziksel kanıt: aynı kişi `core=yonetici` + `qa=okuyucu` üyeliğiyle).

Proje bazında **efektif yetki**, kişinin o projeye bağlı takımlardaki rollerinin
en güçlüsüdür (rank = yetki sayısı). Backend ucu:
`GET /api/effective-role?memberId&projectId`.

## Dal koruması — `korumali_yaz`

- `project_protection` tablosu: `projectId + refPattern` — varsayılan desen
  `'main'`; desenler LIKE ile çalışır (`'release/*'` tutar).
- Rol sözlüğündeki **`korumali_yaz`** yetkisi, korumalı ref'e yazan eylemi kapılar.
  Varsayılanda Yönetici'de var, Geliştirici'de yok; rol şemasından özelleştirilebilir.
- Kural: **dallar serbest, main (ve desen tutanlar) korumalı.** Fiziksel kanıt:
  yönetici → main ✓ · geliştirici → main ✗ engelli, `feat/x` ✓, `release/1.2` ✗
  (desen tuttu).
- Merge apply ucu da bu kapıdan geçer → [merge-motoru](merge-motoru.md).

## Worker görünürlüğü

- **Yönetici**: tüm worker'ları (tüm workspace'ler) görür.
- **Geliştirici ve altı**: yalnız **kendi workspace'ine atanmış** worker'ları görür.

Bunun için worker'a workspace ataması (`workers.workspaceId`) + filo görünümünde
rol-bazlı filtre gerekir; tasarım yüzeyi işlendi, **backend Faz 3 listesinde**.

## Önceki modelle ilişki

- Düz "DB başına rol" modelinin ([roller](roller.md)) yerini bu yapı alır.
- **API token rolleri** (`yonetici/gelistirici/okuyucu`, `api_tokens.role`)
  şimdilik rol şemasından bağımsızdır; Faz 3'te birleştirilebilir.
- **Maskeleme üyelik bayrağı** workspace üyeliğinde kalır — takım/rolden bağımsız
  niteliktir → [maskeleme](maskeleme.md).

## Şema (ORMIM ile yazıldı)

`panel/db/metatron-schema.ts` — 6 tablo: `workspaces, workspace_members,
role_definitions, teams, team_members, team_projects` + `project_protection`;
FK cascade + composite unique'ler. Drizzle→ORMIM göçünün ilk parçası; fiziksel
kanıtlar: `(workspaceId, email)` unique → `23505`, workspace silince cascade ile
`team_members` boşalır. Uygulama: `npm run migrate:ormim` (panel tablolarını
koruyan DROP süzgeciyle).

İlgili: [roller](roller.md) · [maskeleme](maskeleme.md) · [merge-motoru](merge-motoru.md) · [ormim](ormim.md)

> Kaynak: hafıza `metatron-workspace-yetki-modeli` (kullanıcı kilidi + fiziksel
> kanıtlar) · `panel/db/metatron-schema.ts` · `panel/src/workspace.ts`
