# Sorgu içgörüleri (query insights)

Google Cloud SQL tarzı: hangi sorgu, kaç kez çalıştı, ne kadar zaman yedi,
nereden atıldı. Temel `pg_stat_statements`; "nereden" boyutu
`pg_stat_activity` örneklemesiyle kapanır.

## Temel: pg_stat_statements

- Dağıtımda `pg_stat_statements.so` hazır (contrib) — ek kurulum yok; sadece
  `shared_preload_libraries='pg_stat_statements'` + her dal DB'sinde
  `CREATE EXTENSION IF NOT EXISTS pg_stat_statements`. İzleme için
  `pg_stat_statements.track=all`.
- **Normalize**: 12 farklı `tenant = <değer>` sorgusu tek satırda `tenant = $1`
  olarak toplanır (`calls=12`); `count(*)` 3 çağrı ayrı satır (PG 18.4'te kanıtlı).
- PG 18 kolon zenginliği: `plans/plan_time`, WAL (records/bytes), JIT, paralel
  worker'lar, temp blks, shared/local blk hit/read + I/O süreleri, `stats_since`.

## Dürüst sınır: application_name

`application_name` **pg_stat_statements'te yoktur** — "sorgu nereden atıldı"
boyutunu tek başına veremez. Üç yol (sırayla):

1. Panel periyodik `pg_stat_activity` örneklemesi alır; query metni/queryid ile
   statements'a bağlar (canlıya yakın).
2. `log_line_prefix '%a %u %d'` + log satırlarından kaynak çıkarımı (İzleme'deki
   log akışı zaten var).
3. `pg_stat_monitor` (Percona) — daha fazla boyut ama **harici** kurulum; v1'de yok.

## Toplayıcı modeli

Worker üzerinden dal başına periyodik okuma → `_query_insights`:

```
(dal, queryid, query, calls, total_exec, mean_exec, rows, sources jsonb, seen_at)
```

`sources` = örneklemeyle bağlanan application_name kümesi.

## İzleme ekranı — iki sütun

- **Sol**: top sorgular listesi (toplam yük sıralı; çağrı sayısı, ortalama süre).
- **Sağ**: seçili sorgunun derin içgörüsü — normalize SQL, ort/çağrı/toplam,
  kaynak (application_name) ve uyarılar.
- "Seq scan" uyarısı `rows/calls` oranı yüksekse düşer.
- Tasarım dili zaten pg_stat_statements terminolojisiyle konuşuyor — mock'tan
  gerçek veriye geçişte **yüzey değişmez, besleme değişir**.

İlgili: [mimari](mimari.md) · [istemci](istemci.md) · [dallar](dallar.md)

> Kaynak: hafıza `metatron-query-insights` (PG 18.4 fiziksel kanıt +
> application_name sınırı + entegrasyon planı)
