import http from "node:http";
import type { AddressInfo } from "node:net";

/** CONTRACT tel formatı: POST /fn/query|mutation, GET /fn/listen (SSE). */

export interface RecordedCall {
  fn: string;
  args: unknown;
  headers: http.IncomingHttpHeaders;
}

export interface RecordedListen {
  subs: { id: string; fn: string; args: unknown }[];
  lastEventId?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface FakeServerOptions {
  /** Değer döner → { value, version: auto }; version'ı kendin vermek için { value, version }. */
  queryHandler?: (fn: string, args: unknown) => unknown | Promise<unknown>;
  mutationHandler?: (fn: string, args: unknown) => unknown | Promise<unknown>;
  /** Verilirse Authorization: Bearer <token> zorunlu; aksi halde 401 UNAUTHENTICATED. */
  expectToken?: string;
}

export interface FakeServer {
  url: string;
  queryCalls: RecordedCall[];
  mutationCalls: RecordedCall[];
  listenCalls: RecordedListen[];
  mutationExecutions: number;
  close(): Promise<void>;
  /** Tüm aktif SSE bağlantılarına update push'lar (`id: <version>` + event: update). */
  pushUpdate(subId: string, value: unknown, version: string): void;
  pushResync(): void;
  /** SSE stream'lerini server tarafından kapatır → client reconnect tetiklenir. */
  dropConnections(): void;
  activeConnections(): number;
}

function sseWrite(res: http.ServerResponse, ev: { event?: string; data: string; id?: string }): void {
  if (ev.id !== undefined) res.write(`id: ${ev.id}\n`);
  if (ev.event) res.write(`event: ${ev.event}\n`);
  for (const line of ev.data.split("\n")) res.write(`data: ${line}\n`);
  res.write("\n");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function createFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  let clock = 0n;
  const nextVersion = () => String(++clock);
  const queryCalls: RecordedCall[] = [];
  const mutationCalls: RecordedCall[] = [];
  const listenCalls: RecordedListen[] = [];
  const connections = new Set<http.ServerResponse>();
  const idempotencyStore = new Map<string, unknown>();
  let mutationExecutions = 0;

  const unwrap = (r: unknown): { value: unknown; version?: string } =>
    r !== null && typeof r === "object" && "value" in (r as Record<string, unknown>)
      ? (r as { value: unknown; version?: string })
      : { value: r };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (opts.expectToken !== undefined && req.headers.authorization !== `Bearer ${opts.expectToken}`) {
        sendJson(res, 401, { error: { code: "UNAUTHENTICATED" } });
        return;
      }
      try {
        if (req.method === "POST" && (url.pathname === "/fn/query" || url.pathname === "/fn/mutation")) {
          const body = JSON.parse(await readBody(req)) as { fn: string; args: unknown };
          const rec: RecordedCall = { fn: body.fn, args: body.args, headers: req.headers };
          if (url.pathname === "/fn/query") {
            queryCalls.push(rec);
            const handler = opts.queryHandler ?? (() => null);
            const r = unwrap(await handler(body.fn, body.args));
            sendJson(res, 200, { value: r.value, version: r.version ?? nextVersion() });
            return;
          }
          // /fn/mutation — Idempotency-Key zorunlu (CONTRACT)
          const key = req.headers["idempotency-key"];
          if (typeof key !== "string" || key === "") {
            sendJson(res, 400, { error: { code: "MISSING_IDEMPOTENCY_KEY", message: "header yok" } });
            return;
          }
          mutationCalls.push(rec);
          if (idempotencyStore.has(key)) {
            // İş ÇALIŞMAZ; saklanan ilk cevap replay:true ile döner (CONTRACT)
            sendJson(res, 200, { ...(idempotencyStore.get(key) as object), replay: true });
            return;
          }
          mutationExecutions++;
          const handler = opts.mutationHandler ?? (() => null);
          const r = unwrap(await handler(body.fn, body.args));
          const stored = { value: r.value, version: r.version ?? nextVersion() };
          idempotencyStore.set(key, stored);
          sendJson(res, 200, stored);
          return;
        }
        if (req.method === "GET" && url.pathname === "/fn/listen") {
          const subs = JSON.parse(url.searchParams.get("subs") ?? "[]") as RecordedListen["subs"];
          listenCalls.push({ subs, lastEventId: req.headers["last-event-id"] as string | undefined });
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          sseWrite(res, { event: "hello", data: JSON.stringify({ version: String(clock) }) });
          connections.add(res);
          req.on("close", () => connections.delete(res));
          return;
        }
        sendJson(res, 404, { error: { code: "NOT_FOUND", message: url.pathname } });
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, {
            error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) },
          });
        } else {
          sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
        }
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    queryCalls,
    mutationCalls,
    listenCalls,
    get mutationExecutions() {
      return mutationExecutions;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of connections) res.end();
        server.close(() => resolve());
        // Idle keep-alive soketler (undici pool) close()'u ~4sn bekletir — zorla kapat.
        server.closeAllConnections();
      }),
    pushUpdate: (subId, value, version) => {
      const data = JSON.stringify({ version, updates: [{ id: subId, value, version }] });
      for (const res of connections) sseWrite(res, { event: "update", id: version, data });
    },
    pushResync: () => {
      for (const res of connections) sseWrite(res, { event: "resync", data: "{}" });
    },
    dropConnections: () => {
      for (const res of connections) res.end();
    },
    activeConnections: () => connections.size,
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: zaman aşımı");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
