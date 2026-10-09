/**
 * The payment-network preferences the prepare endpoints accept. The desk sends the Arc network it reviewed a USDC
 * payment on; it offers no choice, because each request runs where its asset lives.
 */
export type PaymentNetworkId = "arc-testnet" | "arc-mainnet" | "robinhood-testnet" | "robinhood-mainnet";
export type PaymentNetworkPreference = "auto" | PaymentNetworkId;
export type PaymentNetworkCatalogEntry = { id: PaymentNetworkId; label: string; available: boolean; reason?: string };

export class PaymentNetworkSelectionError extends Error {
  constructor(readonly status: 400 | 503, message: string) { super(message); }
}

export function paymentNetworkCatalog(arcTestnetReady: boolean, arcMainnetReady = false): PaymentNetworkCatalogEntry[] {
  return [
    { id: "arc-testnet", label: "Arc Testnet", available: arcTestnetReady, reason: arcTestnetReady ? undefined : "Arc Testnet payment route is not ready." },
    { id: "arc-mainnet", label: "Arc Mainnet", available: arcMainnetReady, reason: arcMainnetReady ? undefined : "Arc Mainnet payment route is not ready." },
    { id: "robinhood-testnet", label: "Robinhood Testnet", available: false, reason: "USDC payments run on Arc. Robinhood Chain Testnet carries stock-token transfers, which have their own review." },
    { id: "robinhood-mainnet", label: "Robinhood Mainnet", available: false, reason: "USDC payments run on Arc. Robinhood Chain carries stock-token transfers, which have their own review." },
  ];
}

export function resolvePaymentNetwork(preference: unknown, arcTestnetReady: boolean, arcMainnetReady = false): PaymentNetworkId {
  const selected = preference === undefined ? "auto" : preference;
  if (selected !== "auto" && selected !== "arc-testnet" && selected !== "arc-mainnet" && selected !== "robinhood-testnet" && selected !== "robinhood-mainnet") {
    throw new PaymentNetworkSelectionError(400, "Invalid payment network preference.");
  }
  const id = selected === "auto"
    ? arcTestnetReady ? "arc-testnet" : arcMainnetReady ? "arc-mainnet" : "arc-testnet"
    : selected;
  const entry = paymentNetworkCatalog(arcTestnetReady, arcMainnetReady).find((candidate) => candidate.id === id)!;
  if (!entry.available) throw new PaymentNetworkSelectionError(503, entry.reason ?? "Payment network is unavailable.");
  return id;
}
