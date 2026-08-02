# Mimari

Tek kontrol düzlemi, çok worker. Katman modeli:

```
                 ┌──────────────────────────────┐
                 │  KONTROL DÜZLEMİ (tek)        │
                 │  panel + control-pg + pgbouncer│
                 │  GitHub App · Better Auth      │
                 └──────────────┬────────────────┘
             agt_ jetonu ile DIŞA bağlanan ajanlar (panel port AÇMAZ)
        ┌───────────────┬──────┴────────┬───────────────┐
   ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
   │ VDS-1   │     │ VDS-2   │     │ VDS-3   │   …
   │ ZFS pool│     │ ZFS pool│     │ ZFS pool│
   │ ajan    │     │ ajan    │     │ ajan    │
   │ ana DB  │     │ ana DB  │     │ dallar  │
   │ +replika│     │ +dallar │     │ +maskeli│
   └─────────┘     └─────────┘     └─────────┘
```

## ZFS copy-on-write — neden host'ta zorunlu

Dal, `zfs snapshot` + `zfs clone`'dur. Klon, snapshot'la blok paylaşır; yazılan
blok kadar yer yer. Bu yüzden klon **~30 ms** (256 MB → 2 GB arası sabit) ve dal
başına **~704 KB**. ZFS bir çekirdek modülüdür: **host'ta kurulmak zorundadır,
container içinde çalışamaz.** Ajan, privileged + `pid:host` + docker.sock ile
host'un ZFS'ine ve Docker'ına erişir (Windmill worker'ı deseni).

## Worker modeli + heartbeat

- Her VDS bir worker; bire bir aynı ajan imajı, tek fark `POOL_NAME` ve `agt_` jetonu.
- Ajan panele **kendisi bağlanır** (`DBBRANCH_TOKEN=agt_...`); panel worker'a port açmaz.
- Registry: worker `/internal/workers/register` + `/heartbeat` (15 sn); panel reaper'ı
  45 sn sessizlikte worker'ı `down` sayar. Canlı ölçüm: worker durdu → 62 sn'de down,
  başladı → 20 sn'de online.
- Girişte envanter: her ajan `zpool free`, dal sayısı ve kapasitesini bildirir; panel
  "elinde şu worker'lar var, şu kadar boş yer" cevabını tek şeritte verir.
- Worker rolü vardır (`db` / `backup` / `replica` / `idle`) ve her worker'ın ZFS
  dataset bölmesi ayrılabilir (`DATASET_ROOT` + refquota) — kapasiteler ayrışır.
- Bir worker'da birden çok DB çalışır: ana DB + streaming replika (yazılan satır
  **0,5 sn**'de replikada) + dallar + maskeli dallar. Replika→primary terfisi
  (`pg_promote`) ölçülen **340 ms** — failover.

## Gateway — tek sabit port, değişmeyen bağlantı dizesi

İstemci ile worker'lar arasına kendi gateway'imiz girer (projenin parçası):

- Dışarıya **tek sabit adres/port** açılır; her DB ve dal oradan çıkar.
- Yönlendirme **içeride** yapılır: gateway, Postgres başlangıç paketindeki kullanıcı
  adından (`br_<slug>` — dalın rolü) hedef dalı okur; dbname dalın gerçek veritabanıdır
  (`main`), dal parametresi yoktur.
- Sonuç: DB bir worker'dan diğerine taşınsa bile **bağlantı dizesi bayt bayt aynı
  kalır** — değişen tek şey gateway'in içindeki yönlendirme kuralıdır.
  (Kilitli karar, 2026-07-31.) Ayrıntı → [baglanma](baglanma.md).
- TLS gateway/PgBouncer'da sonlanır: internet bacağı şifreli, iç ağ bacağı değil.
  Sertifika şu an **kendinden imzalı**.

## Kontrol düzlemi

Tek noktada toplanır: panel (UI + API) · `control-pg` (Better Auth +
branches/projects/tokens + worker registry) · PgBouncer/gateway · GitHub App
(webhook: dal ve PR olayları). Panel dal DB'lerine doğrudan bağlanmaz — dallar
iç ağdadır; migration SQL'ini panel GitHub'dan okur, worker kendi dalına uygular →
[dallar](dallar.md).

## Topoloji: ağaç değil ağ

Worker → ana DB → dal/replika/maskeli dal dikine; üstüne **çapraz kenarlar**:
farklı worker'lardaki DB'ler dahil, veritabanları kolon paylaşır
(`postgres_fdw` / logical replication / `jsonb`) → [kolon-paylasimi](kolon-paylasimi.md).

> Kaynak: `PRODUCT.md` · `FLEET.md` (worker registry, Task #36) · `TEST-REPORT.md`
