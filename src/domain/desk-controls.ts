/**
 * What an admin can pause on the desk, and the notice the desk shows. A pause stops new payments and new vault links of one kind; it never stops confirming a
 * payment already signed, claiming a link or refunding one, so no one's funds wait on HaPaPay. Shared by the server,
 * which enforces the pauses, and the pages, which show them.
 */
export const DESK_FEATURES = {
  "solana.transfers": "Solana payments in USDC and USDG",
  "solana.stocks": "Solana stock tokens (xStocks)",
  "solana.vault": "New Solana vault links",
  "arc.payments": "Arc USDC payments",
  "arc.vault": "New Arc vault links",
  "robinhood.transfers": "Robinhood Chain payments",
  "robinhood.vault": "New Robinhood Chain vault links",
} as const;

export type DeskFeature = keyof typeof DESK_FEATURES;
export const DESK_FEATURE_KEYS = Object.keys(DESK_FEATURES) as DeskFeature[];
export const isDeskFeature = (value: unknown): value is DeskFeature => typeof value === "string" && Object.prototype.hasOwnProperty.call(DESK_FEATURES, value);

export type DeskPause = { message: string; since: string };
export type DeskNotice = { text: string; tone: "info" | "warning"; since: string };
export type DeskControlsView = { paused: Partial<Record<DeskFeature, DeskPause>>; notice: DeskNotice | null };

export const DEFAULT_PAUSE_MESSAGE = "Paused by HaPaPay for a moment. Claims and refunds still work.";
export const DESK_NOTICE_MAX_LENGTH = 280;
export const PAUSE_MESSAGE_MAX_LENGTH = 200;

/** Plain text in one line: no markup reaches the desk, and nothing longer than the limit. */
export function cleanDeskText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) : "";
}
