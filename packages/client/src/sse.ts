/**
 * Minimal SSE (text/event-stream) ayrıştırıcısı — fetch ReadableStream üstünde.
 *
 * Neden EventSource değil: tarayıcıdaki EventSource özel header (Authorization)
 * gönderemez; Node ≥20'de ise EventSource yok. fetch + bu ayrıştırıcı iki
 * ortamda da çalışır ve `Last-Event-ID` header'ını bizim yönetmemize izin verir.
 *
 * Desteklenen alanlar: `event`, `data` (çok satırlı), `id`.
 * Yorum satırları (`: ka` heartbeat) ve `retry` alanı yok sayılır.
 */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export async function* iterateSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let eventType = "";
  let dataLines: string[] = [];
  let lastId: string | undefined;

  const dispatch = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventType = "";
      return undefined;
    }
    const ev: SseEvent = { event: eventType || "message", data: dataLines.join("\n") };
    if (lastId !== undefined) ev.id = lastId;
    eventType = "";
    dataLines = [];
    return ev;
  };

  const processLine = (line: string): SseEvent | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined; // heartbeat / yorum
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) lastId = value;
        break;
      default:
        break; // retry vb. alanlar yok sayılır
    }
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done) {
        buf += decoder.decode();
        if (buf.length > 0) {
          const ev = processLine(buf);
          if (ev) yield ev;
        }
        const tail = dispatch();
        if (tail) yield tail;
        return;
      }
      const lines = buf.split(/\r\n|[\n\r]/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const ev = processLine(line);
        if (ev) yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
