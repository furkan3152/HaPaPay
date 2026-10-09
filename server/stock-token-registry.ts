import { getAddress } from "viem";
import { z } from "zod";
import { ROBINHOOD_CHAIN, type StockTokenKind, type StockTokenListing } from "../src/domain/stock-tokens.js";

/** Official, read-only Robinhood Stock Token endpoints (https://docs.robinhood.com/chain/stock-token-apis/). */
export const STOCK_TOKEN_REGISTRY_URL = "https://api.robinhood.com/rhj/assets";
export const STOCK_TOKEN_PRICES_URL = "https://api.robinhood.com/rhj/prices";

const decimal = z.string().regex(/^\d{1,30}(?:\.\d{1,18})?$/);
const deploymentSchema = z.object({ contractAddress: z.string(), chainId: z.number().int() });
const assetSchema = z.object({
  id: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  tokenSymbol: z.string().regex(/^[A-Z]{1,6}$/),
  tokenName: z.string().min(1).max(160),
  deployments: z.array(deploymentSchema),
  currentMultiplier: decimal,
  status: z.string(),
  tokenDecimals: z.number().int().optional(),
});
const quoteSchema = z.object({
  tokenSymbol: z.string(),
  deployments: z.array(deploymentSchema),
  bid: decimal,
  ask: decimal,
  isTradingHalt: z.boolean(),
  generatedAt: z.string().optional(),
});

export type RegistryStockToken = StockTokenListing & { multiplier: string; uid?: `0x${string}` };
export type RegistryQuote = { symbol: string; address: `0x${string}`; bid: string; ask: string; halted: boolean; generatedAt?: string };

const fundName = /\b(?:ETF|Trust|Fund|fund|QQQ|iShares|SPDR|Vanguard|Invesco|Schwab|VanEck|State Street)\b/;

export function stockTokenKind(name: string): StockTokenKind {
  return fundName.test(name) ? "etf" : "stock";
}

export function stockTokenDisplayName(tokenName: string) {
  return tokenName.replace(/\s*•\s*Robinhood Token\s*$/i, "").replace(/[\s,]+$/, "").trim();
}

function robinhoodDeployment(deployments: Array<z.infer<typeof deploymentSchema>>) {
  const matches = deployments.filter((deployment) => deployment.chainId === ROBINHOOD_CHAIN.id);
  if (matches.length !== 1) return undefined;
  try {
    return getAddress(matches[0].contractAddress);
  } catch {
    return undefined;
  }
}

function payloadItems(payload: unknown, key: "assets" | "quotes") {
  if (!payload || typeof payload !== "object") throw new Error("Stock token response is malformed.");
  const items = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(items)) throw new Error("Stock token response is malformed.");
  return items;
}

/**
 * Active, 18-decimal Robinhood Chain assets from the official registry. Malformed entries are skipped and
 * any duplicated ticker or contract is dropped entirely rather than guessed.
 */
export function readStockTokenRegistry(payload: unknown): RegistryStockToken[] {
  const tokens: RegistryStockToken[] = [];
  for (const item of payloadItems(payload, "assets")) {
    const parsed = assetSchema.safeParse(item);
    if (!parsed.success || parsed.data.status !== "ASSET_STATUS_ACTIVE") continue;
    if (parsed.data.tokenDecimals !== undefined && parsed.data.tokenDecimals !== 18) continue;
    const address = robinhoodDeployment(parsed.data.deployments);
    const name = stockTokenDisplayName(parsed.data.tokenName);
    if (!address || !name || Number(parsed.data.currentMultiplier) <= 0) continue;
    tokens.push({
      symbol: parsed.data.tokenSymbol,
      name,
      kind: stockTokenKind(name),
      address,
      multiplier: parsed.data.currentMultiplier,
      ...(parsed.data.id ? { uid: parsed.data.id.toLowerCase() as `0x${string}` } : {}),
    });
  }
  const count = (value: string) => tokens.filter((token) => token.symbol === value || token.address === value).length;
  return tokens
    .filter((token) => count(token.symbol) === 1 && count(token.address) === 1)
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export function readStockTokenQuotes(payload: unknown): RegistryQuote[] {
  const quotes: RegistryQuote[] = [];
  for (const item of payloadItems(payload, "quotes")) {
    const parsed = quoteSchema.safeParse(item);
    if (!parsed.success) continue;
    const address = robinhoodDeployment(parsed.data.deployments);
    if (!address) continue;
    quotes.push({
      symbol: parsed.data.tokenSymbol,
      address,
      bid: parsed.data.bid,
      ask: parsed.data.ask,
      halted: parsed.data.isTradingHalt,
      generatedAt: parsed.data.generatedAt,
    });
  }
  return quotes;
}
