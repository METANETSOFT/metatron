# Metatron'a giriş

Metatron, iki fikri tek platformda birleştirir: **Convex tarzı geliştirici deneyimi**
(uygulaman veritabanıyla SQL ile değil, TypeScript fonksiyonları çağırarak konuşur;
veri değişince arayüz kendiliğinden güncellenir) ve **her git dalına gerçek bir
PostgreSQL kopyası** (ZFS copy-on-write ile ~30 ms'de açılan, kendi sunucunda çalışan
dallar).

## 30 saniyelik anlatım

- **Fonksiyonlar backend'indir.** `functions/` altına yazdığın TypeScript
  fonksiyonları `dosya/yol:export` adıyla çağrılır — REST ucu yazmazsın.
  Üç tip vardır: `query` (okur), `mutation` (yazar), `action` (dış dünyayla konuşur).
- **İstemci reaktiftir.** React'te `useQuery("branches:list", {})` çağırırsın;
  sorgunun dokunduğu tablo değişince yeni sonuç SSE ile arayüze düşer.
  Websocket yoktur, polling yazmazsın.
- **Şema kodundur.** Tabloları `defineSchema` ile TypeScript'te tanımlarsın;
  `metatron dev` her kaydettiğinde değişikliği içinde olduğun dalın Postgres'ine
  ~1 saniyede uygular. Migration dosyası yazmazsın.
- **Dallar gerçektir.** `feat/x` dalını açtığında veritabanının gerçek,
  yazılabilir bir kopyası açılır. Şemayı dalda serbestçe değiştirirsin; işin
  bitince şema değişikliklerin `merge_plan → merge_apply` ile güvenli biçimde
  main'e taşınır — kör replay yoktur, çatışma varsa sana kart olarak döner.

## Bu rehber nasıl okunur?

Her sayfa bir kavramı önce tek cümleyle anlatır, sonra **çalışan** kodla gösterir.
Rehberdeki tüm istemci örnekleri canlı bir panele (dogfood) karşı gerçekten
çalıştırılmıştır; terminal çıktıları birebir o çalıştırmalardan alınmadır.

1. [Kurulum ve ilk sorgu](kurulum.md) — paketleri kur, panele bağlan, 5 dakikada
   ilk sorgunu çalıştır.
2. [Şema: React ORM (ORMIM)](react-ormim.md) — tabloları TypeScript'te tanımla,
   `metatron dev` ile dalına anında uygulat.
3. [Fonksiyonlar ve React](react-fonksiyonlar.md) — query/mutation/action yaz,
   React'ten `useQuery` / `useMutation` ile çağır.
4. [CRUD: okuma ve yazma](crud.md) — filtreli okuma, insert/update/delete,
   idempotency, hata zarfı ve roller.
5. [Dallar ve merge](dallar-ve-merge.md) — dal aç, şemayı dalda değiştir,
   çatışma kartlarıyla güvenli merge et.

## Nereden devam edilir?

Rehber öğretir; derinlik teknik sayfalardadır:

- Tel kontratı (uçlar, zarf biçimleri, SSE olayları): [İstemci (Faz 1)](../istemci.md)
- ORMIM referansı ve `metatron dev` iç işleyişi: [ORMIM](../ormim.md)
- Merge motorunun kuralları: [Merge motoru](../merge-motoru.md)
- Dalların ZFS gerçeği ve PR otomasyonu: [Dallar](../dallar.md)
- Bağlantı dizesi ve TLS: [Bağlanma](../baglanma.md)

İlgili: [mimari](../mimari.md) · [roller](../roller.md)

> Kaynak: `metatron/CONTRACT.md` + `ORM-CONTRACT.md` + `MERGE-CONTRACT.md` ·
> rehberdeki canlı çıktılar: dogfood paneli (:55441) ve embedded-postgres
> laboratuvarı (2026-08-02 çalıştırması)
