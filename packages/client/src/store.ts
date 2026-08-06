import { stableStringify } from "./json";

/**
 * Bir izlenen sorgunun materialize edilmiş durumu.
 * Referans olarak SABİTTİR: değişmedikçe aynı obje döner (React useSyncExternalStore
 * için şart). Her anlamlı değişimde yeni obje üretilir.
 */
export type QueryState =
  | { status: "pending" }
  | { status: "ok"; value: unknown; version: string }
  | { status: "error"; error: unknown };

export const PENDING: QueryState = { status: "pending" };

export function queryKeyOf(fn: string, args: unknown): string {
  return fn + " " + stableStringify(args ?? {});
}

/** Versiyonlar u64 string taşınır (CONTRACT) — BigInt ile karşılaştırılır. */
export function versionGte(a: string, b: string): boolean {
  return BigInt(a) >= BigInt(b);
}

/**
 * `optimisticUpdate(store, args)` içine verilen görünüm:
 * o ana kadarki base + önceki katmanlar + bu katmanın şu ana dek yazdıkları.
 */
export interface OptimisticStore {
  get(fn: string, args?: unknown): unknown;
  set(fn: string, args: unknown, value: unknown): void;
}

interface BaseEntry {
  value: unknown;
  version: string;
}

interface Layer {
  id: number;
  /** key → optimistic değer */
  writes: Map<string, unknown>;
  /** mutation cevabının version'ı; resolve edilince dolar. */
  minVersion?: string;
}

function statesEqual(a: QueryState, b: QueryState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "ok" && b.status === "ok") return a.value === b.value && a.version === b.version;
  if (a.status === "error" && b.status === "error") return a.error === b.error;
  return true; // pending
}

/**
 * LocalStore — aktif watch'ların base (server doğrusu) sonuçları + optimistic katmanlar.
 *
 * Katman düşme kuralı (CONTRACT: "store version ≥ response.version olunca düşer"):
 * katmanın YAZDIĞI her sorgunun base version'ı response.version'a ulaşınca katman
 * kaldırılır. Global max version yerine dokunulan-sorgu-bazında kontrol edilir;
 * aksi halde alakasız bir sorgunun güncellemesi katmanı erken düşürüp değeri
 * eskiye döndürürdü (flicker). Yazısız katman hemen düşer.
 */
export class LocalStore {
  private base = new Map<string, BaseEntry>();
  private errors = new Map<string, unknown>();
  private layers: Layer[] = [];
  private states = new Map<string, QueryState>();
  private listeners = new Map<string, Set<() => void>>();
  private nextLayerId = 1;

  getState(key: string): QueryState {
    return this.states.get(key) ?? PENDING;
  }

  subscribeKey(key: string, cb: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /** Server sonucu (query cevabı veya SSE push). Eski versiyonlar yok sayılır. */
  setBase(key: string, value: unknown, version: string): void {
    const prev = this.base.get(key);
    if (prev && BigInt(version) < BigInt(prev.version)) return; // stale
    this.base.set(key, { value, version });
    this.errors.delete(key);
    const affected = this.dropSatisfiedLayers();
    affected.add(key);
    for (const k of affected) this.materialize(k);
  }

  /** Query hatası: elde değer varken hatayı yut (eski değer gösterilmeye devam eder). */
  setError(key: string, error: unknown): void {
    if (this.base.has(key)) return;
    this.errors.set(key, error);
    this.materialize(key);
  }

  /**
   * Optimistic katman açar ve update'i SENKRON çalıştırır → izleyiciler anında görür.
   * Update throw ederse katman hiç eklenmez ve hata çağırana yayılır.
   * Dönen id, mutation cevabıyla `resolveLayer` / hatada `dropLayer` için kullanılır.
   */
  addLayer(update: (store: OptimisticStore, args: unknown) => void, args: unknown): number {
    const layer: Layer = { id: this.nextLayerId++, writes: new Map() };
    const view: OptimisticStore = {
      get: (fn, a = {}) => this.viewValue(queryKeyOf(fn, a), layer),
      set: (fn, a, value) => {
        layer.writes.set(queryKeyOf(fn, a), value);
      },
    };
    update(view, args); // throw → katman eklenmeden yayılır
    this.layers.push(layer);
    for (const key of layer.writes.keys()) this.materialize(key);
    return layer.id;
  }

  /** Mutation başarılı: katmanın düşme eşiğini response.version olarak işaretle. */
  resolveLayer(id: number, version: string): void {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.minVersion = version;
    const affected = this.dropSatisfiedLayers();
    for (const k of affected) this.materialize(k);
  }

  /** Mutation hatası: katmanı geri al. */
  dropLayer(id: number): void {
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx === -1) return;
    const [layer] = this.layers.splice(idx, 1);
    for (const k of layer.writes.keys()) this.materialize(k);
  }

  /** Son watch kapanınca çağrılır — key'in tüm izini siler. */
  deleteKey(key: string): void {
    this.base.delete(key);
    this.errors.delete(key);
    this.states.delete(key);
    this.listeners.delete(key);
  }

  /** base + önceki katmanlar + (henüz eklenmemiş) `extra` katmanının yazıları. */
  private viewValue(key: string, extra?: Layer): unknown {
    let v = this.base.get(key)?.value;
    for (const l of this.layers) if (l.writes.has(key)) v = l.writes.get(key);
    if (extra && extra.writes.has(key)) v = extra.writes.get(key);
    return v;
  }

  private dropSatisfiedLayers(): Set<string> {
    const affected = new Set<string>();
    this.layers = this.layers.filter((l) => {
      if (l.minVersion === undefined) return true;
      const satisfied =
        l.writes.size === 0 ||
        [...l.writes.keys()].every((key) => {
          const b = this.base.get(key);
          return b === undefined || versionGte(b.version, l.minVersion as string);
        });
      if (!satisfied) return true;
      for (const k of l.writes.keys()) affected.add(k);
      return false;
    });
    return affected;
  }

  private materialize(key: string): void {
    const prev = this.states.get(key);
    let next: QueryState;
    const b = this.base.get(key);
    if (b !== undefined) {
      let value: unknown = b.value;
      for (const l of this.layers) if (l.writes.has(key)) value = l.writes.get(key);
      next = { status: "ok", value, version: b.version };
    } else {
      // Base henüz yokken yalnız optimistic yazı varsa o da görünür (version "0").
      let has = false;
      let value: unknown;
      for (const l of this.layers) {
        if (l.writes.has(key)) {
          value = l.writes.get(key);
          has = true;
        }
      }
      const err = this.errors.get(key);
      if (has) next = { status: "ok", value, version: "0" };
      else if (err !== undefined) next = { status: "error", error: err };
      else next = PENDING;
    }
    if (prev && statesEqual(prev, next)) return;
    this.states.set(key, next);
    const set = this.listeners.get(key);
    if (set) for (const cb of [...set]) cb();
  }
}

/** React'siz ortamda store mantığını doğrudan test etmek için fabrika. */
export function createStore(): LocalStore {
  return new LocalStore();
}
