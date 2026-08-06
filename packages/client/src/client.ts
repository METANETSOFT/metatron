import { MetatronError } from "./errors";
import { iterateSSE } from "./sse";
import type { SseEvent } from "./sse";
import { LocalStore, PENDING, queryKeyOf } from "./store";
import type { OptimisticStore, QueryState } from "./store";

export interface MetatronClientOptions {
  /** Panel base URL'i, ör. "https://panel.example.com" (sondaki / yok sayılır). */
  url: string;
  /** `metatron login` token'ı (dbb_...) veya token üreten async fonksiyon. */
  token: string | (() => Promise<string>);
  /** Gelişmiş: SSE reconnect backoff'u (ms). Varsayılan 500 → 16000, jitter'lı. */
  retry?: { baseMs?: number; maxMs?: number };
}

export interface QueryResult<V = unknown> {
  value: V;
  version: string;
}

export interface MutationResult<V = unknown> extends QueryResult<V> {
  /** Aynı Idempotency-Key tekrarında server işi çalıştırmadan saklanan cevabı döner. */
  replay?: boolean;
}

export type OptimisticUpdate = (store: OptimisticStore, args: any) => void;

export interface WatchHandle {
  /** İlk sonuç gelmediyse undefined. Hata durumunda da undefined (bkz. watchState). */
  get(): { value: unknown; version: string } | undefined;
  /** Her yeni değerde çağrılır; unsubscribe döner. */
  subscribe(cb: (v: { value: unknown; version: string }) => void): () => void;
  close(): void;
}

interface WatchEntry {
  key: string;
  fn: string;
  args: unknown;
  subId: string;
  refs: number;
  /** Durum değişimlerinin tamamı (pending/ok/error) — watchSubscribe. */
  stateListeners: Set<() => void>;
  /** Yalnız ok değerleri — contract subscribe. */
  valueListeners: Set<(v: { value: unknown; version: string }) => void>;
}

interface Sub {
  id: string;
  fn: string;
  args: unknown;
}

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // crypto yoksa (eski ortam) v4 benzeri üret
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  const u = (t as { unref?: unknown }).unref;
  if (typeof u === "function") (u as () => void).call(t);
}

/** Tarayıcıda `document`, Node'da undefined — DOM lib'siz çalışmak için yapısal tip. */
interface VisibilityDocument {
  visibilityState: string;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

class WatchHandleImpl implements WatchHandle {
  private closed = false;
  constructor(
    readonly _client: MetatronClient,
    readonly _entry: WatchEntry,
  ) {}

  get(): { value: unknown; version: string } | undefined {
    const st = this._state();
    return st.status === "ok" ? { value: st.value, version: st.version } : undefined;
  }

  subscribe(cb: (v: { value: unknown; version: string }) => void): () => void {
    this._entry.valueListeners.add(cb);
    return () => {
      this._entry.valueListeners.delete(cb);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this._client._releaseWatch(this._entry);
  }

  /** Gelişmiş (react paketi kullanır): pending/ok/error tam durum, stabil referans. */
  _state(): QueryState {
    return this._client.store.getState(this._entry.key);
  }

  /** Gelişmiş: her durum geçişinde (error dahil) çağrılır. */
  _subscribeState(cb: () => void): () => void {
    this._entry.stateListeners.add(cb);
    return () => {
      this._entry.stateListeners.delete(cb);
    };
  }
}

/**
 * Gelişmiş API (react katmanı için): handle'ın tam durumu.
 * Düz WatchHandle'larda (sahte implementasyonlar) get() üstünden türetilir.
 */
export function watchState(handle: WatchHandle): QueryState {
  const h = handle as Partial<WatchHandleImpl>;
  if (typeof h._state === "function") return h._state.call(handle);
  const v = handle.get();
  return v === undefined ? PENDING : { status: "ok", value: v.value, version: v.version };
}

/** Gelişmiş API: error geçişleri dahil her durum değişiminde çağrılır. */
export function watchSubscribe(handle: WatchHandle, cb: () => void): () => void {
  const h = handle as Partial<WatchHandleImpl>;
  if (typeof h._subscribeState === "function") return h._subscribeState.call(handle, cb);
  return handle.subscribe(() => cb());
}

/**
 * Tek SSE bağlantısı / client; tüm sub'lar `GET /fn/listen?subs=[...]` üstünde multiplexed.
 * Sub seti değişince bağlantı yeni setle yeniden kurulur (server subs'ı yalnız bağlanırken
 * alır — CONTRACT). Kopmada backoff (base → max, jitter) + `Last-Event-ID` ile resume.
 */
class SseConnection {
  private subs: Sub[] = [];
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private lastEventId?: string;
  private connectScheduled = false;
  private closed = false;

  constructor(
    private host: {
      baseUrl: string;
      token(): Promise<string>;
      retryBaseMs: number;
      retryMaxMs: number;
      applyUpdate(subId: string, value: unknown, version: string): void;
      resync(): void;
    },
  ) {}

  setSubs(subs: Sub[]): void {
    this.subs = subs;
    if (this.closed) return;
    if (subs.length === 0) {
      this.clearTimer();
      this.teardownStream();
      return;
    }
    // Aynı microtask'taki watch patlaması tek bağlantıya konsolide olur.
    if (this.connectScheduled) return;
    this.connectScheduled = true;
    queueMicrotask(() => {
      this.connectScheduled = false;
      if (this.closed || this.subs.length === 0) return;
      this.clearTimer();
      void this.connect();
    });
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
    this.teardownStream();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private teardownStream(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  private async connect(): Promise<void> {
    this.teardownStream();
    const ac = new AbortController();
    this.abort = ac;
    try {
      const token = await this.host.token();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
      };
      if (this.lastEventId !== undefined) headers["last-event-id"] = this.lastEventId;
      const url =
        this.host.baseUrl + "/fn/listen?subs=" + encodeURIComponent(JSON.stringify(this.subs));
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok || !res.body) {
        throw new MetatronError("LISTEN_FAILED", `SSE bağlantısı kurulamadı (HTTP ${res.status})`, {
          status: res.status,
        });
      }
      for await (const ev of iterateSSE(res.body)) {
        if (this.abort !== ac) return; // yerimize yeni bağlantı açıldı
        this.attempt = 0; // olay akıyor → bağlantı sağlıklı
        this.handleEvent(ev);
      }
      if (this.abort === ac) this.scheduleReconnect(); // server stream'i kapattı
    } catch (err) {
      if (this.abort !== ac || ac.signal.aborted) return; // bilinçli kapatma
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.subs.length === 0) return;
    const cap = Math.min(this.host.retryMaxMs, this.host.retryBaseMs * 2 ** this.attempt);
    this.attempt++;
    const delay = cap * (0.5 + Math.random() * 0.5); // jitter: %50–%100
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
    unrefTimer(this.timer);
  }

  private handleEvent(ev: SseEvent): void {
    if (ev.id !== undefined) this.lastEventId = ev.id;
    switch (ev.event) {
      case "hello":
        break; // {"version": "<güncel>"} — versiyon güncellemeler update id'siyle izlenir
      case "update": {
        let data: { updates?: { id: string; value: unknown; version: string }[] };
        try {
          data = JSON.parse(ev.data) as typeof data;
        } catch {
          return; // bozuk olay — atla
        }
        for (const u of data.updates ?? []) this.host.applyUpdate(u.id, u.value, u.version);
        break;
      }
      case "resync":
        this.host.resync(); // server gap sezdi → tüm sub'lar yeniden sorgulanır
        break;
      default:
        break;
    }
  }
}

export class MetatronClient {
  /** Gelişmiş: local store (optimistic katmanlar + base sonuçlar). */
  readonly store = new LocalStore();

  private readonly baseUrl: string;
  private readonly tokenFn: () => Promise<string>;
  private readonly conn: SseConnection;
  private watches = new Map<string, WatchEntry>();
  private nextSubId = 1;
  private closed = false;
  private visibilityDoc?: VisibilityDocument;
  private onVisibility?: () => void;

  constructor(opts: MetatronClientOptions) {
    this.baseUrl = opts.url.replace(/\/+$/, "");
    const t = opts.token;
    this.tokenFn = typeof t === "function" ? t : async () => t;
    this.conn = new SseConnection({
      baseUrl: this.baseUrl,
      token: () => this.tokenFn(),
      retryBaseMs: opts.retry?.baseMs ?? 500,
      retryMaxMs: opts.retry?.maxMs ?? 16000,
      applyUpdate: (subId, value, version) => this.applyUpdate(subId, value, version),
      resync: () => void this.resyncAll(),
    });
    // Sekme focus'unda (visibilitychange) stale sub'lar yeniden sorgulanır — yalnız tarayıcı.
    const doc = (globalThis as { document?: VisibilityDocument }).document;
    if (doc && typeof doc.addEventListener === "function") {
      this.visibilityDoc = doc;
      this.onVisibility = () => {
        if (doc.visibilityState === "visible") void this.resyncAll();
      };
      doc.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  async query<V = unknown>(fn: string, args: unknown = {}): Promise<QueryResult<V>> {
    return this.post<QueryResult<V>>("/fn/query", { fn, args });
  }

  async mutation<V = unknown>(
    fn: string,
    args: unknown = {},
    opts?: { optimisticUpdate?: OptimisticUpdate },
  ): Promise<MutationResult<V>> {
    // Idempotency-Key otomatik: her mutation çağrısı yeni bir uuid üretir.
    const idempotencyKey = uuid();
    let layerId: number | undefined;
    if (opts?.optimisticUpdate) {
      // Store'a ANINDA uygulanır (senkron) — izleyiciler fetch'ten önce görür.
      layerId = this.store.addLayer(opts.optimisticUpdate, args);
    }
    let result: MutationResult<V>;
    try {
      result = await this.post<MutationResult<V>>("/fn/mutation", { fn, args }, {
        "idempotency-key": idempotencyKey,
      });
    } catch (err) {
      if (layerId !== undefined) this.store.dropLayer(layerId); // hata → katman geri alınır
      throw err;
    }
    if (layerId !== undefined) this.store.resolveLayer(layerId, result.version);
    return result;
  }

  watchQuery(fn: string, args: unknown = {}): WatchHandle {
    if (this.closed) {
      throw new MetatronError("CLIENT_CLOSED", "MetatronClient.close() çağrılmış client kullanılamaz");
    }
    const key = queryKeyOf(fn, args);
    let entry = this.watches.get(key);
    if (!entry) {
      entry = {
        key,
        fn,
        args,
        subId: String(this.nextSubId++),
        refs: 0,
        stateListeners: new Set(),
        valueListeners: new Set(),
      };
      this.watches.set(key, entry);
      this.store.subscribeKey(key, () => this.fanout(entry as WatchEntry));
      this.conn.setSubs(this.activeSubs());
      void this.refetch(entry); // ilk sonuç: POST /fn/query (sonrası SSE push)
    }
    entry.refs++;
    return new WatchHandleImpl(this, entry);
  }

  /** Tüm aktif sub'ları /fn/query ile yeniden sorgular (resync olayı + sekme focus'u). */
  async resyncAll(): Promise<void> {
    await Promise.all([...this.watches.values()].map((e) => this.refetch(e)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
    if (this.visibilityDoc && this.onVisibility) {
      this.visibilityDoc.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.watches.clear();
  }

  /** @internal WatchHandleImpl.close() çağırır. */
  _releaseWatch(entry: WatchEntry): void {
    entry.refs--;
    if (entry.refs > 0) return;
    if (this.watches.get(entry.key) !== entry) return;
    this.watches.delete(entry.key);
    this.store.deleteKey(entry.key);
    this.conn.setSubs(this.activeSubs());
  }

  private activeSubs(): Sub[] {
    return [...this.watches.values()].map((e) => ({ id: e.subId, fn: e.fn, args: e.args }));
  }

  private applyUpdate(subId: string, value: unknown, version: string): void {
    for (const e of this.watches.values()) {
      if (e.subId === subId) {
        this.store.setBase(e.key, value, version);
        return;
      }
    }
    // Bilinmeyen sub id (yarış: kapanmış watch'a geç push) — yok say.
  }

  private fanout(entry: WatchEntry): void {
    const st = this.store.getState(entry.key);
    for (const cb of [...entry.stateListeners]) cb();
    if (st.status === "ok") {
      const v = { value: st.value, version: st.version };
      for (const cb of [...entry.valueListeners]) cb(v);
    }
  }

  private async refetch(entry: WatchEntry): Promise<void> {
    try {
      const res = await this.query(entry.fn, entry.args);
      if (this.watches.get(entry.key) === entry) this.store.setBase(entry.key, res.value, res.version);
    } catch (err) {
      if (this.watches.get(entry.key) === entry) this.store.setError(entry.key, err);
    }
  }

  private async post<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const token = await this.tokenFn();
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; data?: unknown } } | undefined)
        ?.error;
      throw new MetatronError(e?.code ?? `HTTP_${res.status}`, e?.message ?? res.statusText, {
        data: e?.data,
        status: res.status,
      });
    }
    return json as T;
  }
}
