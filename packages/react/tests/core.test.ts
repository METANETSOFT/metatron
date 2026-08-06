import assert from "node:assert/strict";
import { test } from "node:test";
import type { MetatronClient, QueryResult, WatchHandle } from "metatron-client";
import { argsKey, createMutator, WatchCache } from "../src/core";

/** React'siz çekirdek testleri — hook katmanı ince sarmalayıcı olduğundan
 *  mantık (args derin eşitliği, watch paylaşımı/refcount, mutator zinciri)
 *  burada, react render olmadan doğrulanır. */

function fakeClient(overrides?: {
  watchQuery?: (fn: string, args: unknown) => WatchHandle;
  mutation?: (fn: string, args: unknown, opts?: unknown) => Promise<QueryResult>;
}) {
  const calls = { watchQuery: [] as { fn: string; args: unknown }[], mutation: [] as unknown[][] };
  const client = {
    watchQuery(fn: string, args: unknown) {
      calls.watchQuery.push({ fn, args });
      if (overrides?.watchQuery) return overrides.watchQuery(fn, args);
      return {
        get: () => undefined,
        subscribe: () => () => {},
        close: () => {},
      } satisfies WatchHandle;
    },
    mutation(fn: string, args: unknown, opts?: unknown) {
      calls.mutation.push([fn, args, opts]);
      return overrides?.mutation?.(fn, args, opts) ?? Promise.resolve({ value: null, version: "1" });
    },
  } as unknown as MetatronClient;
  return { client, calls };
}

test("argsKey: anahtar sırasından bağımsız derin eşitlik (JSON anahtarı)", () => {
  const a = argsKey("tasks/list", { x: 1, y: { b: 2, a: [1, 2] } });
  const b = argsKey("tasks/list", { y: { a: [1, 2], b: 2 }, x: 1 });
  assert.equal(a, b);
  assert.notEqual(argsKey("tasks/list", { x: 1 }), argsKey("tasks/list", { x: 2 }));
  assert.notEqual(argsKey("tasks/list", { x: 1 }), argsKey("tasks/other", { x: 1 }));
  assert.equal(argsKey("tasks/list", "skip"), "skip");
  assert.equal(argsKey("tasks/list", undefined), argsKey("tasks/list", {}));
});

test("WatchCache: JSON-eş args tek handle paylaşır, refcount ile kapanır", () => {
  let closeCount = 0;
  const { client, calls } = fakeClient({
    watchQuery: () => ({
      get: () => ({ value: 1, version: "1" }),
      subscribe: () => () => {},
      close: () => closeCount++,
    }),
  });
  const cache = new WatchCache(client);

  const w1 = cache.acquire("q/a", { a: 1, b: 2 });
  const w2 = cache.acquire("q/a", { b: 2, a: 1 }); // JSON-eş → aynı handle
  const w3 = cache.acquire("q/a", { a: 1, b: 3 }); // farklı → yeni handle
  assert.equal(calls.watchQuery.length, 2);
  assert.equal(w1.handle, w2.handle);
  assert.notEqual(w1.handle, w3.handle);

  // peek: acquire edilmiş sorgunun durumunu döner
  const st = cache.peek("q/a", { b: 2, a: 1 });
  assert.equal(st.status, "ok");
  assert.equal(st.status === "ok" && st.value, 1);
  // acquire edilmemiş → pending
  assert.equal(cache.peek("q/yok", {}).status, "pending");

  w1.release();
  assert.equal(closeCount, 0); // h2 hâlâ tutuyor
  w2.release();
  assert.equal(closeCount, 1); // son referans → close
  w3.release();
  assert.equal(closeCount, 2);

  // release idempotent
  const w4 = cache.acquire("q/b", {});
  w4.release();
  w4.release();
  assert.equal(closeCount, 3);
});

test("createMutator: client.mutation'a delege eder, withOptimisticUpdate zincirlenir", async () => {
  const { client, calls } = fakeClient();
  const mutator = createMutator(client, "tasks/add");

  const r1 = await mutator({ n: 1 });
  assert.deepEqual(r1, { value: null, version: "1" });
  assert.deepEqual(calls.mutation[0], ["tasks/add", { n: 1 }, undefined]);

  const update = () => {};
  const optimistic = mutator.withOptimisticUpdate(update);
  assert.notEqual(optimistic, mutator); // yeni fonksiyon
  await optimistic({ n: 2 });
  assert.deepEqual(calls.mutation[1][2], { optimisticUpdate: update });

  // Orijinal mutator etkilenmez
  await mutator({ n: 3 });
  assert.equal(calls.mutation[2][2], undefined);

  // Zincir: ikinci withOptimisticUpdate birincinin üstüne değil, taze kurulur
  const update2 = () => {};
  const optimistic2 = optimistic.withOptimisticUpdate(update2);
  await optimistic2({ n: 4 });
  assert.deepEqual(calls.mutation[3][2], { optimisticUpdate: update2 });
});

test("createMutator: mutation hatası çağırana yayılır", async () => {
  const { client } = fakeClient({
    mutation: () => Promise.reject(new Error("server hatası")),
  });
  const mutator = createMutator(client, "f/g");
  await assert.rejects(mutator({}), /server hatası/);
});
