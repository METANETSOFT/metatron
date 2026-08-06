/**
 * Derin eşitlik için kanonik JSON: obje anahtarları her seviyede sıralanır.
 * `{ a: 1, b: { c: 2 } }` ile `{ b: { c: 2 }, a: 1 }` aynı anahtarı üretir.
 * Yalnız JSON-değerler (contract gereği args JSON) desteklenir.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.keys(v as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (v as Record<string, unknown>)[k];
            return acc;
          }, {})
      : v,
  );
}
