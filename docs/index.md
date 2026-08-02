# Metatron (dbbranch)

**Her git dalı kendi gerçek PostgreSQL veritabanını alır** — ZFS copy-on-write
klonu olarak, prod verisiyle, isteğe bağlı maskelenmiş, sabit bağlantı dizesiyle.
Kendi sunucunda, tek `docker compose` ile. Kubernetes yok.

## 30 saniyelik resim

1. PR açarsın → panel webhook'u yakalar → o dal için ZFS klonu açılır:
   **~30 ms** (256 MB → 2 GB arası sabit), dal başına **~704 KB** disk.
2. Dal, kaynak DB **çalışırken** alınır; kesinti yok. Postgres ayağa kalkar,
   o git ref'indeki migration'lar uygulanır, bağlantı dizesi PR'a tek yorum olarak düşer.
3. Uçtan uca: panelden **2,5 sn**, webhook'tan **~5 sn**.
4. Bağlantı hep aynı adrese gider: tek sabit gateway portu. DB worker'lar arasında
   taşınsa bile bağlantı dizesi değişmez → [baglanma](baglanma.md).
5. PR kapanınca dal silinir, kaynak geri kazanılır.

Ölçümler bu projede gerçekten koşuldu (canlı, FoxApplicant verisiyle):

| Ölçüm | Değer |
|---|---|
| ZFS klon (dal açma çekirdeği) | ~30 ms, boyuttan bağımsız |
| Dal disk maliyeti (CoW) | 704 KB |
| Uçtan uca dal (panel) | 2,5 sn |
| Streaming replika gecikmesi | 0,5 sn |
| Maskeleme (9 PII kontrolü temiz) | 745–909 ms |

## Ne DEĞİL

- **Bulut servisi değil.** Kontrol düzlemi sende. Xata/Neon aynı işi yapar ama kontrol
  düzlemleri kapalı kaynak ve bulutta; Xata'nın açık sürümü Kubernetes ister. Metatron'un
  iddiası: aynı mekanizma, kendi sunucunda, tek `docker compose`.
- **Kubernetes değil.** Tek düğüm Docker + host'ta ZFS. ZFS çekirdek modülü ister —
  container içinde çalışamaz, host'ta kurulur.
- **Otomatik scale-to-zero değil.** Uykuya alma çekirdeği var (`/sleep` → `/wake`,
  ölçülen uyanma 581 ms, veri kayıpsız) ama otomatik boşta-yakalama henüz bağlı değil.
- **Sihirli veri katmanı değil.** Kolon paylaşımı = `postgres_fdw` / logical
  replication / `jsonb` — üçü de düz Postgres, üretilen SQL'i görürsün →
  [kolon-paylasimi](kolon-paylasimi.md).
- **DB-içi erişim kilidi vaadi yok.** Maskeleme garantisi "superuser maskeyi atlatamaz"
  değil, "gerçek veri maskeli dalda hiç bulunmaz" → [maskeleme](maskeleme.md).

## Sayfalar

- [Mimari](mimari.md) — ZFS CoW, worker modeli, gateway, kontrol düzlemi
- [Bağlanma](baglanma.md) — sabit adres, kullanıcı adı şeması, TLS, psql
- [Dallar](dallar.md) — dal açma, PR otomasyonu, kota, şema senkronu
- [Maskeleme](maskeleme.md) — iki eksen, dump-time, dürüstlük kuralı
- [Roller](roller.md) — Yönetici / Geliştirici / Okuyucu
- [Kolon paylaşımı](kolon-paylasimi.md) — fdw / logical replication / jsonb
- [PITR](pitr.md) — saniyelik geri dönüş, saklama, restore akışı

> Kaynak: `PRODUCT.md` · `FLEET.md` · `TEST-REPORT.md`
