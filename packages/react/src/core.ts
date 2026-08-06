import type { MetatronClient, OptimisticUpdate, QueryResult, WatchHandle } from "metatron-client";
import { PENDING, stableStringify, watchState } from "metatron-client";
import type { QueryState } from "metatron-client";

/**
 * Args derin eşitliği JSON anahtarıyla: aynı içerikli fakat farklı referanslı
 * (hatta farklı anahtar sıralı) args aynı key'i üretir → hook yeniden subscribe olmaz.
 */
export function argsKey(fn: string, args: unknown): string {
  if (args === "skip") return "skip";
  return fn + " " + stableStringify(args ?? {});
}

/**
 * Aynı (fn, args) için tek WatchHandle paylaşımı + refcount'lu kapatma.
 * React'sizdir; hook katmanı (useSyncExternalStore subscribe içinde) acquire/release çağırır.
 */
export class WatchCache {
  private entries = new Map<string, { handle: WatchHandle; refs: number }>();

  constructor(private client: MetatronClient) {}

  acquire(fn: string, args: unknown): { handle: WatchHandle; release: () => void } {
    const key = argsKey(fn, args);
    let e = this.entries.get(key);
    if (!e) {
      e = { handle: this.client.watchQuery(fn, args ?? {}), refs: 0 };
      this.entries.set(key, e);
    }
    e.refs++;
    let released = false;
    return {
      handle: e.handle,
      release: () => {
        if (released) return;
        released = true;
        e.refs--;
        if (e.refs === 0) {
          this.entries.delete(key);
          e.handle.close();
        }
      },
    };
  }

  /** Acquire edilmemiş sorgu için PENDING döner (useSyncExternalStore getSnapshot). */
  peek(fn: string, args: unknown): QueryState {
    const e = this.entries.get(argsKey(fn, args));
    return e ? watchState(e.handle) : PENDING;
  }
}

export interface Mutator<A = unknown, V = unknown> {
  (args: A): Promise<QueryResult<V>>;
  /** Zincirlenir: optimistic update bağlanmış YENİ bir mutator döner. */
  withOptimisticUpdate(update: OptimisticUpdate): Mutator<A, V>;
}

/** React'siz mutator fabrikası — useMutation'ın çekirdeği. */
export function createMutator<A = unknown, V = unknown>(
  client: MetatronClient,
  fn: string,
  update?: OptimisticUpdate,
): Mutator<A, V> {
  const mutator = ((args: A) =>
    client.mutation<V>(fn, args, update ? { optimisticUpdate: update } : undefined)) as Mutator<A, V>;
  mutator.withOptimisticUpdate = (u: OptimisticUpdate) => createMutator<A, V>(client, fn, u);
  return mutator;
}
