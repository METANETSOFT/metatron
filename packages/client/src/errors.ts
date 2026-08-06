/**
 * Panel hata zarfı: `{ "error": { "code", "message", "data?" } }` (CONTRACT.md).
 * Query hataları deterministik sayılır — client bunları retry ETMEZ, doğrudan fırlatır.
 */
export class MetatronError extends Error {
  readonly code: string;
  readonly data?: unknown;
  readonly status?: number;

  constructor(code: string, message: string, opts?: { data?: unknown; status?: number }) {
    super(message);
    this.name = "MetatronError";
    this.code = code;
    this.data = opts?.data;
    this.status = opts?.status;
  }
}
