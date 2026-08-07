import assert from "node:assert/strict";
import { test } from "node:test";
import { MetatronClient, MetatronError } from "../src/index";
import type { WatchHandle } from "../src/index";
import { createFakeServer, deferred, HttpError, waitFor } from "./helpers";
import type { FakeServer } from "./helpers";

function track(t: import("node:test").TestContext, srv: FakeServer, client: MetatronClient): void {
  t.after(async () => {
    client.close();
    await srv.close();
  });
}

test("query: value+version döner, Authorization Bearer gider", async (t) => {
  const srv = await createFakeServer({
    expectToken: "dbb_test",
    queryHandler: (fn, args) => ({ value: { fn, args }, version: "42" }),
  });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  const res = await client.query("tasks/list", { a: 1 });
  assert.deepEqual(res.value, { fn: "tasks/list", args: { a: 1 } });
  assert.equal(res.version, "42");
  assert.equal(srv.queryCalls.length, 1);
  assert.equal(srv.queryCalls[0].headers.authorization, "Bearer dbb_test");
});

test("query: token async fonksiyon olabilir", async (t) => {
  const srv = await createFakeServer({ expectToken: "dbb_fn", queryHandler: () => "ok" });
  const client = new MetatronClient({ url: srv.url, token: async () => "dbb_fn" });
  track(t, srv, client);
  const res = await client.query("x/y", {});
  assert.equal(res.value, "ok");
});

test("#71: apiKey verilirse X-Metatron-Key başlığı gider, verilmezse GÖNDERİLMEZ", async (t) => {
  // Cift anahtar modeli (#71): sk Bearer'da, pk X-Metatron-Key'de. Basligin
  // YOKLUGU da sozlesmenin parcasi — eski tek parcali token akisi degismez.
  const srv = await createFakeServer({ expectToken: "dbb_sk_test", queryHandler: () => "ok" });
  const client = new MetatronClient({ url: srv.url, token: "dbb_sk_test", apiKey: "dbb_pk_test" });
  track(t, srv, client);
  await client.query("x/y", {});
  assert.equal(srv.queryCalls[0].headers.authorization, "Bearer dbb_sk_test");
  assert.equal(srv.queryCalls[0].headers["x-metatron-key"], "dbb_pk_test");

  const srv2 = await createFakeServer({ expectToken: "dbb_test", queryHandler: () => "ok" });
  const client2 = new MetatronClient({ url: srv2.url, token: "dbb_test" });
  track(t, srv2, client2);
  await client2.query("x/y", {});
  assert.equal(srv2.queryCalls[0].headers["x-metatron-key"], undefined);
});

test("query hatası: MetatronError fırlatır, RETRY EDİLMEZ (deterministik)", async (t) => {
  const srv = await createFakeServer({
    queryHandler: () => {
      throw new HttpError(422, "BAD_ARGS", "geçersiz argüman", { field: "x" });
    },
  });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  await assert.rejects(client.query("a/b", { x: 1 }), (err: unknown) => {
    assert.ok(err instanceof MetatronError);
    assert.equal(err.code, "BAD_ARGS");
    assert.equal(err.status, 422);
    assert.deepEqual(err.data, { field: "x" });
    return true;
  });
  assert.equal(srv.queryCalls.length, 1); // tek deneme
});

test("auth: 401 → UNAUTHENTICATED", async (t) => {
  const srv = await createFakeServer({ expectToken: "dbb_dogru" });
  const client = new MetatronClient({ url: srv.url, token: "dbb_yanlis" });
  track(t, srv, client);
  await assert.rejects(client.query("a/b", {}), (err: unknown) => {
    assert.ok(err instanceof MetatronError);
    assert.equal(err.code, "UNAUTHENTICATED");
    return true;
  });
});

test("mutation: Idempotency-Key otomatik (uuid), her çağrı yeni key", async (t) => {
  const srv = await createFakeServer({ mutationHandler: (_fn, args) => ({ value: args }) });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  await client.mutation("tasks/add", { n: 1 });
  await client.mutation("tasks/add", { n: 2 });
  assert.equal(srv.mutationExecutions, 2);
  const keys = srv.mutationCalls.map((c) => c.headers["idempotency-key"]);
  assert.ok(keys.every((k) => typeof k === "string"));
  assert.match(keys[0] as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(keys[0], keys[1]);
});

test("idempotency replay: aynı key ile tekrar → iş çalışmaz, replay:true", async (t) => {
  const srv = await createFakeServer({ mutationHandler: (_fn, args) => ({ value: args }) });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  const first = await client.mutation("tasks/add", { n: 1 });
  const key = srv.mutationCalls[0].headers["idempotency-key"] as string;

  // Aynı key ile ham tekrar (ör. ağ koptu, client yeniden denedi senaryosunun server tarafı)
  const raw = await fetch(srv.url + "/fn/mutation", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ fn: "tasks/add", args: { n: 1 } }),
  });
  const replayed = (await raw.json()) as { value: unknown; version: string; replay?: boolean };
  assert.equal(srv.mutationExecutions, 1); // iş tekrar ÇALIŞMADI
  assert.equal(replayed.replay, true);
  assert.deepEqual(replayed.value, first.value);
  assert.equal(replayed.version, first.version);
});

test("watchQuery: ilk sonuç /fn/query'den, SSE update cb'ye düşer, stale push yok sayılır", async (t) => {
  const srv = await createFakeServer({ queryHandler: () => ({ value: 0, version: "1" }) });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  const handle: WatchHandle = client.watchQuery("counter/get", {});
  const seen: { value: unknown; version: string }[] = [];
  const unsub = handle.subscribe((v) => seen.push(v));
  assert.equal(handle.get(), undefined); // ilk sonuç gelmeden undefined

  await waitFor(() => handle.get() !== undefined);
  assert.deepEqual(handle.get(), { value: 0, version: "1" });
  assert.equal(seen.length, 1);

  // SSE bağlantısı kurulmuş ve sub multiplexed olarak gitmiş olmalı
  await waitFor(() => srv.listenCalls.length >= 1);
  assert.equal(srv.listenCalls[0].subs.length, 1);
  assert.equal(srv.listenCalls[0].subs[0].fn, "counter/get");
  const subId = srv.listenCalls[0].subs[0].id;

  srv.pushUpdate(subId, 5, "2");
  await waitFor(() => seen.length === 2);
  assert.deepEqual(seen[1], { value: 5, version: "2" });

  // Eski versiyonlu (stale) push yok sayılır
  srv.pushUpdate(subId, 99, "1");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.length, 2);
  assert.deepEqual(handle.get(), { value: 5, version: "2" });

  unsub();
  handle.close();
});

test("watchQuery: aynı (fn,args) tek sub paylaşır; son close sub'ı kaldırır", async (t) => {
  const srv = await createFakeServer({ queryHandler: () => ({ value: "x", version: "1" }) });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  const h1 = client.watchQuery("q/a", { b: 2, a: 1 });
  const h2 = client.watchQuery("q/a", { a: 1, b: 2 }); // anahtar sırası farklı, JSON-eş
  await waitFor(() => srv.listenCalls.length >= 1);
  assert.equal(srv.listenCalls[0].subs.length, 1); // tek sub

  h1.close();
  assert.equal(srv.listenCalls.length, 1); // hâlâ h2 açık → reconnect yok
  h2.close();
  await waitFor(() => srv.activeConnections() === 0 || srv.listenCalls.length >= 2);
});

test("optimistic katman: anında görünür, base versiyonu yetişince düşer", async (t) => {
  const gate = deferred<{ value: null; version: string }>();
  const srv = await createFakeServer({
    queryHandler: () => ({ value: [] as string[], version: "1" }),
    mutationHandler: () => gate.promise,
  });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  const handle = client.watchQuery("tasks/list", {});
  await waitFor(() => handle.get() !== undefined);
  await waitFor(() => srv.listenCalls.length >= 1);
  const subId = srv.listenCalls[0].subs[0].id;
  assert.deepEqual(handle.get()?.value, []);

  const mutationPromise = client.mutation(
    "tasks/add",
    { item: "a" },
    {
      optimisticUpdate: (store, args: { item: string }) => {
        const cur = store.get("tasks/list", {}) as string[];
        store.set("tasks/list", {}, [...cur, args.item]);
      },
    },
  );
  // Fetch daha dönmeden optimistic değer görünür
  assert.deepEqual(handle.get()?.value, ["a"]);

  // Mutation cevabı döndü ama SSE push henüz yok → katman hâlâ durur (base v1 < response v2)
  gate.resolve({ value: null, version: "2" });
  const res = await mutationPromise;
  assert.equal(res.version, "2");
  assert.deepEqual(handle.get()?.value, ["a"]);

  // SSE push v2 gelince katman düşer, server doğrusu kalır
  srv.pushUpdate(subId, ["a"], "2");
  await waitFor(() => handle.get()?.version === "2");
  assert.deepEqual(handle.get()?.value, ["a"]);

  // Sonraki normal push'lar çalışmaya devam eder
  srv.pushUpdate(subId, ["a", "b"], "3");
  await waitFor(() => handle.get()?.version === "3");
  assert.deepEqual(handle.get()?.value, ["a", "b"]);
  handle.close();
});

test("optimistic katman: mutation hatası → geri alınır + throw", async (t) => {
  const srv = await createFakeServer({
    queryHandler: () => ({ value: [] as string[], version: "1" }),
    mutationHandler: () => {
      throw new HttpError(500, "BOOM", "patladi");
    },
  });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  const handle = client.watchQuery("tasks/list", {});
  await waitFor(() => handle.get() !== undefined);

  await assert.rejects(
    client.mutation(
      "tasks/add",
      { item: "a" },
      {
        optimisticUpdate: (store) => {
          store.set("tasks/list", {}, ["a"]);
        },
      },
    ),
    (err: unknown) => {
      assert.ok(err instanceof MetatronError);
      assert.equal(err.code, "BOOM");
      return true;
    },
  );
  assert.deepEqual(handle.get()?.value, []); // katman geri alındı
  handle.close();
});

test("reconnect: kopmada backoff ile yeniden bağlanır, Last-Event-ID ile resume eder", async (t) => {
  const srv = await createFakeServer({ queryHandler: () => ({ value: 0, version: "1" }) });
  const client = new MetatronClient({
    url: srv.url,
    token: "dbb_test",
    retry: { baseMs: 50, maxMs: 50 }, // test hızı için
  });
  track(t, srv, client);

  const handle = client.watchQuery("counter/get", {});
  const seen: unknown[] = [];
  handle.subscribe((v) => seen.push(v.value));
  await waitFor(() => handle.get() !== undefined);
  await waitFor(() => srv.listenCalls.length >= 1);
  const subId = srv.listenCalls[0].subs[0].id;

  srv.pushUpdate(subId, 7, "7");
  await waitFor(() => seen.includes(7));

  // Bağlantı kopar → client yeniden bağlanmalı ve Last-Event-ID: 7 göndermeli
  srv.dropConnections();
  await waitFor(() => srv.listenCalls.length >= 2);
  assert.equal(srv.listenCalls[1].lastEventId, "7");
  assert.equal(srv.listenCalls[1].subs.length, 1); // sub seti korunuyor

  // Yeni bağlantıdan push akmaya devam eder
  srv.pushUpdate(subId, 8, "8");
  await waitFor(() => seen.includes(8));
  handle.close();
});

test("resync olayı: tüm sub'lar /fn/query ile yeniden sorgulanır", async (t) => {
  let counter = 0;
  const srv = await createFakeServer({ queryHandler: () => ({ value: counter }) });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  const handle = client.watchQuery("counter/get", {});
  await waitFor(() => handle.get() !== undefined);
  assert.equal(handle.get()?.value, 0);
  await waitFor(() => srv.listenCalls.length >= 1);
  assert.equal(srv.queryCalls.length, 1);

  counter = 99;
  srv.pushResync();
  await waitFor(() => handle.get()?.value === 99);
  assert.equal(srv.queryCalls.length, 2); // stale refetch yapıldı
  handle.close();
});

test("watchQuery: ilk sorgu hatası → get() undefined, store error durumunda", async (t) => {
  const srv = await createFakeServer({
    queryHandler: () => {
      throw new HttpError(422, "BAD_QUERY", "bozuk sorgu");
    },
  });
  const client = new MetatronClient({ url: srv.url, token: "dbb_test" });
  track(t, srv, client);

  const { watchState } = await import("../src/index");
  const handle = client.watchQuery("bad/query", {});
  await waitFor(() => watchState(handle).status === "error");
  assert.equal(handle.get(), undefined);
  const st = watchState(handle);
  assert.equal(st.status, "error");
  assert.ok(st.status === "error" && st.error instanceof MetatronError);
  handle.close();
});
