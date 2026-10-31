/** JSON over fetch: the server's error message on failure, never a raw status. */
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const init: RequestInit = body === undefined && !method
    ? { cache: "no-store" }
    : { method: method ?? "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) };
  const response = await fetch(path, init);
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok && response.status !== 202) throw new Error(result.error ?? `The request failed (${response.status}).`);
  return result;
}

export const short = (value?: string | null) => !value ? "" : value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
export const usd = (value: number, digits = 2) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) });
export const compact = (value: number) => value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const pct = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
