import type { MetatronClient, QueryState } from "metatron-client";
import { PENDING, watchSubscribe } from "metatron-client";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { argsKey, createMutator, WatchCache } from "./core";
import type { Mutator } from "./core";

export { WatchCache, argsKey, createMutator } from "./core";
export type { Mutator } from "./core";

interface MetatronContextValue {
  client: MetatronClient;
  cache: WatchCache;
}

const MetatronContext = createContext<MetatronContextValue | null>(null);

export function MetatronProvider(props: {
  client: MetatronClient;
  children?: ReactNode;
}): ReactNode {
  const value = useMemo<MetatronContextValue>(
    () => ({ client: props.client, cache: new WatchCache(props.client) }),
    [props.client],
  );
  return createElement(MetatronContext.Provider, { value }, props.children);
}

function useCtx(): MetatronContextValue {
  const ctx = useContext(MetatronContext);
  if (!ctx) throw new Error("metatron-react: <MetatronProvider> altında kullanılmalı");
  return ctx;
}

/**
 * `useQuery(fn, args)` → value | undefined (undefined = henüz yükleniyor).
 * `useQuery(fn, "skip")` → subscribe olmaz, hep undefined.
 * Query hatası render sırasında throw edilir → en yakın error boundary yakalar.
 *
 * Args derin eşitliği JSON anahtarıyla yapılır: içerik değişmedikçe yeniden
 * subscribe olunmaz (render'da yeni obje literal'i güvenli).
 */
export function useQuery<V = unknown>(fn: string, args: unknown): V | undefined {
  const ctx = useCtx();
  const skipped = args === "skip";
  const key = argsKey(fn, args);
  // args referansı her render'da değişebilir; kimlik `key`de sabitlendiği için
  // deps'e key yeterli — closure'daki args, key'i aynı olan ilk args'tır (JSON-eş).
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (skipped) return () => {};
      const { handle, release } = ctx.cache.acquire(fn, args);
      const unsub = watchSubscribe(handle, onChange);
      return () => {
        unsub();
        release();
      };
    },
    [ctx, key, skipped], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const getSnapshot = useCallback((): QueryState => {
    if (skipped) return PENDING;
    return ctx.cache.peek(fn, args);
  }, [ctx, key, skipped]); // eslint-disable-line react-hooks/exhaustive-deps
  // SSR: sunucuda store'da veri olmaz — hep PENDING (loading) döner, hydration sonrası
  // gerçek snapshot'a geçer (TanStack Start / Next SSR uyumu; dogfood bulgusu).
  const getServerSnapshot = useCallback((): QueryState => PENDING, []);
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (state.status === "error") throw state.error;
  return state.status === "ok" ? (state.value as V) : undefined;
}

/**
 * `useMutation(fn)` → stabil mutator.
 * `mutator(args)` → Promise<{ value, version }>.
 * `mutator.withOptimisticUpdate((store, args) => ...)` → optimistic bağlı yeni mutator.
 */
export function useMutation<A = unknown, V = unknown>(fn: string): Mutator<A, V> {
  const ctx = useCtx();
  return useMemo(() => createMutator<A, V>(ctx.client, fn), [ctx, fn]);
}
