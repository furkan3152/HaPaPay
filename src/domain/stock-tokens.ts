import { decodeFunctionData, formatUnits, getAddress, parseUnits } from "viem";
import { erc20TransferAbi } from "./arc-transaction.js";
import { DISTRIBUTIVE_ENDING, EVERYDAY_TICKER_WORDS, numberReadings, numberWordsBefore, parseSocialRecipient, platformName, type Platform } from "./payment-intent.js";
import { isPreparedFeeWithinSchedule, type PreparedPlatformFee, type FeeSchedule } from "./fees.js";
import { matchesRoutedBatch, matchesRoutedCall, routedApproveCall, routedPayCall, type PreparedBatch } from "./routed-payments.js";
import type { StockClaimAvailability } from "./stock-claims.js";

export type StockNetworkId = "robinhood-mainnet" | "robinhood-testnet";

/**
 * Robinhood chains that carry Stock Tokens. Mainnet assets come from the official registry; the registry
 * publishes no testnet deployments, so testnet uses the verified faucet test tokens.
 */
export const STOCK_CHAINS = {
  "robinhood-mainnet": {
    id: 4663,
    name: "Robinhood Chain",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    testAssets: false,
  },
  "robinhood-testnet": {
    id: 46630,
    name: "Robinhood Chain Testnet",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    testAssets: true,
  },
} as const;
export const ROBINHOOD_CHAIN = STOCK_CHAINS["robinhood-mainnet"];
export const ROBINHOOD_TESTNET = STOCK_CHAINS["robinhood-testnet"];
export type StockChainId = (typeof STOCK_CHAINS)[StockNetworkId]["id"];

/** Every Robinhood Stock Token is an 18-decimal ERC-20. Never mix these units with six-decimal USDC. */
export const STOCK_TOKEN_DECIMALS = 18;

/**
 * "stock" and "etf" are Robinhood Stock Tokens. "cash" is a dollar stablecoin (USDG) and "community" a project
 * or community token; neither is a Stock Token, so the Stock Token eligibility rules do not apply to them.
 */
export type StockTokenKind = "stock" | "etf" | "cash" | "community";
/** One allowlisted Robinhood Chain token. Stock Tokens use 18 decimals; any other asset names its own. */
export type StockTokenListing = { symbol: string; name: string; kind: StockTokenKind; address: `0x${string}`; decimals?: number };

export type StockTokenQuote = StockTokenListing & { price?: string; multiplier?: string; halted?: boolean };
type Availability = { enabled: boolean; reason?: string };
/**
 * Whether this server prepares and verifies wallet-signed transfers on a network, and why not when it does not.
 * `enabled` covers Robinhood Stock Tokens; `tokens` covers every other listed asset (USDG).
 */
export type StockTransferAvailability = Availability & { tokens?: Availability };

/** Decimals of an allowlisted token: 18 unless the listing names another value. */
export function tokenDecimals(token: { decimals?: number }) {
  return token.decimals ?? STOCK_TOKEN_DECIMALS;
}

/** Robinhood Stock Tokens (companies and funds) carry the issuer's eligibility rules; USDG does not. */
export function isStockToken(token: { kind: StockTokenKind }) {
  return token.kind === "stock" || token.kind === "etf";
}

/** Whether transfers of this token run on the network, from the network's availability. */
export function transferAvailabilityFor(availability: StockTransferAvailability | undefined, token: { kind: StockTokenKind }): Availability {
  if (!availability) return { enabled: false };
  if (isStockToken(token)) return { enabled: availability.enabled, reason: availability.reason };
  return availability.tokens ?? { enabled: false, reason: "Token transfers are not configured on this server." };
}
export type StockTokenSnapshot = {
  network: StockNetworkId;
  chain: { id: number; name: string; explorerUrl: string };
  allowlistVerifiedOn: string;
  /** "test_assets": testnet tokens have no market price. */
  prices: { status: "live" | "unavailable" | "test_assets"; asOf?: string; source?: string };
  tokens: StockTokenQuote[];
  transfers?: StockTransferAvailability;
  /** Claim links for GitHub and X accounts that have not joined yet, and the escrow they fund. */
  claims?: StockClaimAvailability;
  /** The fee contracts every payment on this network goes through; null while no fee router is registered. */
  fees?: FeeSchedule | null;
};

/** Stock preview network for a payment-network preference. Only an explicit testnet choice uses test tokens. */
export function stockNetworkFor(preference: unknown): StockNetworkId {
  return preference === "robinhood-testnet" ? "robinhood-testnet" : "robinhood-mainnet";
}

/** The verified allowlist for one network, with no market data. */
export function stockTokenCatalog(network: StockNetworkId, tokens: readonly StockTokenListing[], allowlistVerifiedOn: string): StockTokenSnapshot {
  const chain = STOCK_CHAINS[network];
  return {
    network,
    chain: { id: chain.id, name: chain.name, explorerUrl: chain.explorerUrl },
    allowlistVerifiedOn,
    prices: { status: chain.testAssets ? "test_assets" : "unavailable" },
    tokens: tokens.map((token) => ({ ...token })),
  };
}

export type StockTransferIntent = {
  kind: "send";
  /** Any allowlisted Robinhood Chain token; `kind` tells a Stock Token from USDG. */
  asset: {
    type: "stock-token";
    kind: StockTokenKind;
    symbol: string;
    name: string;
    address: `0x${string}`;
    chainId: StockChainId;
    decimals: number;
  };
  /** ERC-20 token units as typed by the sender, not share-equivalents. */
  amount: string;
  recipient: { platform: Platform; username: string };
  sourcePlatform?: Platform;
  status: "draft";
};

/**
 * The ticker a reply asked the sender to write instead of shares or a company name, with what the request already
 * says, so a desk whose main network lists the same stock under another symbol can offer that one instead.
 */
export type StockTickerHint = { symbol: string; name: string; shares: boolean; amount?: string; username?: string; platform?: Platform };

export type StockTransferParse =
  | { status: "none" }
  | { status: "parsed"; intent: StockTransferIntent }
  | { status: "invalid"; message: string; suggestions?: string[]; ticker?: StockTickerHint };

const WAD = 10n ** 18n;

/** Words that are also tickers but usually mean something else when written in lowercase. */
const lowercaseWords = new Set([
  "now", "run", "fix", "net", "app", "path", "snap", "fly", "bull", "lite", "shop", "team", "poet", "elf", "mod", "fig",
]);

export function stockChainById(chainId: number) {
  return Object.values(STOCK_CHAINS).find((chain) => chain.id === chainId);
}

export function stockTokenExplorerUrl(address: string, chainId: number = ROBINHOOD_CHAIN.id) {
  return `${(stockChainById(chainId) ?? ROBINHOOD_CHAIN).explorerUrl}/token/${address}`;
}

/** Canonical token-unit amount, or undefined when it is not a positive quantity with at most `decimals` decimals. */
export function normalizeStockAmount(input: string, decimals: number = STOCK_TOKEN_DECIMALS): string | undefined {
  if (!Number.isInteger(decimals) || decimals < 1 || decimals > STOCK_TOKEN_DECIMALS) return undefined;
  const value = input.trim().replace(",", ".");
  if (!new RegExp(`^\\d{1,30}(?:\\.\\d{1,${decimals}})?$`).test(value)) return undefined;
  const units = parseUnits(value, decimals);
  return units > 0n ? formatUnits(units, decimals) : undefined;
}

export function stockTokenUnits(amount: string, decimals: number = STOCK_TOKEN_DECIMALS): bigint {
  const normalized = normalizeStockAmount(amount, decimals);
  if (!normalized) throw new Error(`Enter a token amount greater than zero with at most ${decimals} decimals.`);
  return parseUnits(normalized, decimals);
}

function decimalUnits(value: string) {
  if (!/^\d{1,30}(?:\.\d{1,18})?$/.test(value)) return undefined;
  return parseUnits(value, STOCK_TOKEN_DECIMALS);
}

function roundedDecimal(value: bigint, fractionDigits: number, mode: "floor" | "nearest") {
  const step = 10n ** BigInt(STOCK_TOKEN_DECIMALS - fractionDigits);
  const rounded = mode === "nearest" ? (value + step / 2n) / step : value / step;
  const whole = rounded / 10n ** BigInt(fractionDigits);
  const fraction = (rounded % 10n ** BigInt(fractionDigits)).toString().padStart(fractionDigits, "0");
  return fractionDigits ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Share-equivalent of a token amount under the ERC-8056 UI multiplier
 * (shares = tokens × multiplier). Rounded down; display only.
 */
export function shareEquivalent(amount: string, multiplier: string, fractionDigits = 4): string | undefined {
  const tokens = decimalUnits(amount);
  const ratio = decimalUnits(multiplier);
  if (tokens === undefined || !ratio) return undefined;
  return roundedDecimal((tokens * ratio) / WAD, fractionDigits, "floor");
}

/** Indicative per-token USD price: the raw underlying bid/ask midpoint scaled by the token multiplier. */
export function stockTokenPrice(bid: string, ask: string, multiplier: string): string | undefined {
  const [low, high, ratio] = [bid, ask, multiplier].map(decimalUnits);
  if (!low || !high || !ratio || high < low) return undefined;
  return roundedDecimal(((low + high) / 2n) * ratio / WAD, 2, "nearest");
}

/** Indicative USD value of a token amount at a per-token price, rounded to cents. */
export function stockTokenValue(amount: string, price: string): string | undefined {
  const tokens = decimalUnits(amount);
  const unitPrice = decimalUnits(price);
  if (tokens === undefined || unitPrice === undefined) return undefined;
  return roundedDecimal((tokens * unitPrice) / WAD, 2, "nearest");
}

/** Everyday names of listed Stock Tokens whose registry name reads differently. */
const COMPANY_ALIASES: Record<string, string> = {
  google: "GOOGL", alphabet: "GOOGL", facebook: "META", meta: "META", palantir: "PLTR", spacex: "SPCX", ford: "F",
  cisco: "CSCO", crowdstrike: "CRWD", tsmc: "TSM", micron: "MU", marvell: "MRVL", rivian: "RIVN", lilly: "LLY",
  exxon: "XOM", exxonmobil: "XOM", "trump media": "DJT", "palo alto": "PANW", supermicro: "SMCI", "super micro": "SMCI",
  hynix: "SKHY", microstrategy: "MSTR", lockheed: "LMT", "lockheed martin": "LMT", "s&p 500": "SPY", sp500: "SPY",
  nasdaq: "QQQ", "nasdaq 100": "QQQ", gold: "GLD", silver: "SLV", oil: "USO", "j&j": "JNJ", "take two": "TTWO",
};
/** Words that only say what kind of company a registry name is: "Inc.", "Class A common stock". */
const CORPORATE_WORDS = /\b(?:inc|corp|corporation|company|co|holdings?|nv|plc|ltd|limited|group|class\s+[a-c]|common\s+stock|american\s+depositary\s+shares|the)\b\.?/gi;

function companyKey(name: string) {
  return name.toLowerCase().replace(/,/g, " ").replace(CORPORATE_WORDS, " ").replace(/\s+/g, " ").trim();
}

const companyPatternCache = new WeakMap<readonly StockTokenListing[], Array<{ pattern: RegExp; token: StockTokenListing }>>();

/** One pattern per company name and everyday name on a token list, longest first, built once per list. */
function companyPatterns(tokens: readonly StockTokenListing[]) {
  const cached = companyPatternCache.get(tokens);
  if (cached) return cached;
  const listed = new Map(tokens.filter(isStockToken).map((token) => [token.symbol, token]));
  const patterns = [
    ...Array.from(listed.values(), (token) => [companyKey(token.name), token] as const),
    ...Object.entries(COMPANY_ALIASES).flatMap(([alias, symbol]) => listed.has(symbol) ? [[alias, listed.get(symbol)!] as const] : []),
  ]
    .filter(([key]) => key.length >= 3)
    .sort((left, right) => right[0].length - left[0].length)
    .map(([key, token]) => ({
      pattern: new RegExp(`(?<![\\w&$@.-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?![\\w&])`, "gi"),
      token,
    }));
  companyPatternCache.set(tokens, patterns);
  return patterns;
}

/**
 * A listed Stock Token that a request names by its company instead of its ticker, as an amount of it ("3 apple", "2
 * nvidia tokens", "2 shares of tesla", "3 apple hissesi"): its name or an everyday name for it, right after the amount
 * or before a word for shares. Only a single name counts, and it is only ever offered back as a suggestion to confirm.
 */
export function companyMention(input: string, tokens: readonly StockTokenListing[]) {
  for (const { pattern, token } of companyPatterns(tokens)) {
    for (const match of input.matchAll(pattern)) {
      const before = input.slice(0, match.index);
      const after = input.slice(match.index + match[0].length);
      // The amount may sit before "shares of", "tokens of" or the Turkish counters "tane" and "adet".
      const lead = before.replace(/\s+(?:(?:shares?|tokens?)\s+of|tane|adet)\s+$/i, " ");
      const digits = /(?<![\w.,])(\d+(?:[.,]\d+)*)\s+$/.exec(lead)?.[1];
      const words = digits ? undefined : numberWordsBefore(lead, lead.length);
      const readings = digits ? numberReadings(digits) : words !== undefined ? [String(words)] : [];
      const shares = /^(?:['’]\S*)?\s+(?:hisse\S*|shares?|stocks?|tokens?)\b/i.test(after) || /(?:shares?|tokens?)\s+of\s+$/i.test(before);
      if (readings.length || shares) return { token, amount: readings.length === 1 ? readings[0] : undefined };
    }
  }
  return undefined;
}

/**
 * Deterministically reads "Send 2 NVDA to @bob on X" style requests for the selected network's allowlisted
 * tokens: Stock Tokens, and on mainnet USDG. `knownSymbols` holds tickers from every Robinhood network,
 * so a ticker that exists elsewhere is explained instead of falling through. These requests never reach the USDC
 * parser, its AI prompt, or the USDC escrow. An amount reads as written in digits or in words; one that reads two
 * ways ("1,000") is asked about, and a company named instead of a ticker is offered back with its ticker.
 */
export function parseStockTransferRequest(
  input: string,
  catalog: { network: StockNetworkId; tokens: readonly StockTokenListing[] },
  knownSymbols: ReadonlySet<string> = new Set(),
): StockTransferParse {
  const asset = readStockAsset(input, catalog, knownSymbols);
  if (asset.status !== "found") return asset;
  const { token, symbol, amount, decimals } = asset;
  const example = (listed: string) => `Send 2 ${listed} to @toly on X`;
  const chain = STOCK_CHAINS[catalog.network];
  const { username, recipientPlatform, sourcePlatform } = parseSocialRecipient(input, [symbol]);
  if (!username) return { status: "invalid", message: `Add who receives it and where, for example: ${example(symbol)}.` };
  if (!recipientPlatform) {
    return { status: "invalid", message: `Add which platform @${username} is on, for example: Send ${amount} ${symbol} to @${username} on X.` };
  }

  return {
    status: "parsed",
    intent: {
      kind: "send",
      asset: {
        type: "stock-token",
        kind: token.kind,
        symbol,
        name: token.name,
        address: token.address,
        chainId: chain.id,
        decimals,
      },
      amount,
      recipient: { platform: recipientPlatform, username: username.toLowerCase() },
      sourcePlatform,
      status: "draft",
    },
  };
}

/** The listed token and amount a request names, or why it names none this desk can send. It reads no recipient. */
export type StockAssetReading =
  | { status: "none" }
  | { status: "invalid"; message: string; suggestions?: string[]; ticker?: StockTickerHint }
  | { status: "found"; token: StockTokenListing; symbol: string; amount: string; decimals: number };

/**
 * The asset half of `parseStockTransferRequest`: one listed token with one amount in token units, read as that
 * function reads it, for requests that pay one person or several.
 */
export function readStockAsset(
  input: string,
  catalog: { network: StockNetworkId; tokens: readonly StockTokenListing[] },
  knownSymbols: ReadonlySet<string> = new Set(),
): StockAssetReading {
  const chain = STOCK_CHAINS[catalog.network];
  const bySymbol = new Map(catalog.tokens.map((token) => [token.symbol, token]));
  const isListed = (symbol: string) => bySymbol.has(symbol) || knownSymbols.has(symbol);
  const mentions = new Map<string, { text: string; readings: string[]; symbol: string }>();
  const unknown = new Set<string>();
  let usdcMentioned = false;

  for (const match of input.matchAll(new RegExp(`(?<![\\w.,])(\\d+(?:[.,]\\d+)*)${DISTRIBUTIVE_ENDING}?\\s*(\\$?)([A-Za-z]{1,6})(?!\\w)`, "g"))) {
    const [, text, cashtag, word] = match;
    const symbol = word.toUpperCase();
    if (symbol === "USDC") {
      usdcMentioned = true;
      continue;
    }
    const explicit = cashtag === "$" || word === symbol;
    if (isListed(symbol) && (explicit || (symbol.length >= 3 && !lowercaseWords.has(word.toLowerCase()) && !EVERYDAY_TICKER_WORDS.has(word.toLowerCase())))) {
      mentions.set(`${symbol}:${text}`, { text, readings: numberReadings(text), symbol });
    } else if (!isListed(symbol) && word === symbol && symbol.length >= 2) {
      unknown.add(symbol);
    }
  }
  // An amount in words before a ticker written as one: "five NVDA", "two $TSLA", "ten usdg".
  if (!mentions.size) {
    for (const match of input.matchAll(/(?<![\w.@-])(\$?)([A-Za-z]{2,6})(?!\w)/g)) {
      const [, cashtag, word] = match;
      const symbol = word.toUpperCase();
      if (symbol === "USDC" || !isListed(symbol) || !(cashtag || word === symbol || symbol === "USDG")) continue;
      const value = numberWordsBefore(input, match.index);
      if (value !== undefined) mentions.set(`${symbol}:${value}`, { text: String(value), readings: [String(value)], symbol });
    }
  }
  const cashtags = Array.from(input.matchAll(/\$([A-Za-z]{1,6})(?!\w)/g), (match) => match[1].toUpperCase()).filter(isListed);
  const example = (symbol: string) => `Send 2 ${symbol} to @toly on X`;
  const available = catalog.tokens.length <= 12 ? ` Available here: ${catalog.tokens.map((token) => token.symbol).join(", ")}.` : "";
  /** The request this one could be, with the recipient it names; offered only when it names who and where. */
  const rewrite = (amount: string | undefined, symbol: string) => {
    const { username, recipientPlatform } = parseSocialRecipient(input, [symbol]);
    const text = `Send ${amount ?? "2"} ${symbol} to @${username ?? "toly"} on ${recipientPlatform ? platformName(recipientPlatform) : "X"}`;
    return { text, complete: Boolean(amount && username && recipientPlatform), amount, username, platform: recipientPlatform };
  };
  const hint = (symbol: string, name: string, shares: boolean, request: ReturnType<typeof rewrite>): StockTickerHint => ({
    symbol, name, shares,
    ...(request.amount ? { amount: request.amount } : {}),
    ...(request.username ? { username: request.username } : {}),
    ...(request.platform ? { platform: request.platform } : {}),
  });
  const company = mentions.size === 0 && cashtags.length === 0 ? companyMention(input, catalog.tokens) : undefined;
  if (/\bshares?\b|\bhisse/i.test(input)) {
    const [first] = mentions.values();
    const named = first?.symbol ?? cashtags[0]
      ?? Array.from(input.matchAll(/(?<![\w@$])([A-Z]{2,6})(?!\w)/g), (match) => match[1]).find(isListed)
      ?? company?.token.symbol;
    const listed = named ? bySymbol.get(named) : undefined;
    if (named && (!listed || isStockToken(listed))) {
      const request = rewrite(first?.readings.length === 1 ? first.readings[0] : company?.amount, named);
      return {
        status: "invalid",
        message: `Stock Tokens move in token units, not shares. Write it as “${request.text}” and the review shows the share equivalent.`,
        ...(request.complete ? { suggestions: [request.text] } : {}),
        ticker: hint(named, listed?.name ?? company?.token.name ?? named, true, request),
      };
    }
  }

  if (mentions.size === 0 && cashtags.length === 0) {
    if (company && !usdcMentioned) {
      const request = rewrite(company.amount, company.token.symbol);
      return {
        status: "invalid",
        message: `Stock Tokens go by their ticker: ${company.token.name} is ${company.token.symbol}. Write it as “${request.text}”.`,
        ...(request.complete ? { suggestions: [request.text] } : {}),
        ticker: hint(company.token.symbol, company.token.name, false, request),
      };
    }
    if (unknown.size === 0 || usdcMentioned) return { status: "none" };
    const [symbol] = unknown;
    return { status: "invalid", message: `${symbol} isn't on the verified token list. HaPaPay sends USDC, USDG, xStocks and Robinhood Chain Stock Tokens.${available}` };
  }
  if (usdcMentioned) return { status: "invalid", message: "Send one asset at a time: either USDC or a single listed token." };
  if (mentions.size > 1) return { status: "invalid", message: "Send one token at a time." };

  const [mention] = mentions.values();
  const symbol = mention?.symbol ?? cashtags[0]!;
  const token = bySymbol.get(symbol);
  if (!token) {
    return {
      status: "invalid",
      message: chain.testAssets
        ? `${symbol} has no test token on ${chain.name}.${available}`
        : `${symbol} isn't available on ${chain.name}.`,
    };
  }
  if (!mention) return { status: "invalid", message: `Add an amount, for example: ${example(symbol)}.` };
  if (mention.readings.length > 1) {
    // "1,000" is a thousand in English and one in Turkish: the sender says which.
    const [decimal, thousands] = mention.readings;
    const options = [rewrite(thousands, symbol), rewrite(decimal, symbol)];
    return {
      status: "invalid",
      message: `“${mention.text}” can mean ${thousands} or ${decimal}. Write the amount without a thousands separator, for example: ${options[0].text}.`,
      ...(options[0].complete ? { suggestions: options.map((option) => option.text) } : {}),
    };
  }

  const decimals = tokenDecimals(token);
  const amount = mention.readings.length === 1 ? normalizeStockAmount(mention.readings[0], decimals) : undefined;
  if (!amount) return { status: "invalid", message: `Enter an amount greater than zero with at most ${decimals} decimals.` };
  return { status: "found", token, symbol, amount, decimals };
}

type StockWalletTransaction = { from: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value: string };

/**
 * What `/api/stocks/transfers/prepare` returns for one reviewed transfer: a single `transaction` while no fee
 * router runs on the network, or, with one, the `fee` and two `transactions`: an approval of the amount plus the fee
 * to the router, then the router's `pay`.
 */
export type PreparedStockTransfer = {
  networkId: StockNetworkId;
  chainId: number;
  chainIdHex: `0x${string}`;
  chainName: string;
  token: { symbol: string; name: string; address: `0x${string}`; decimals: number };
  amount: string;
  units: string;
  balance: string;
  transaction?: StockWalletTransaction;
  fee?: PreparedPlatformFee;
  paymentRef?: `0x${string}`;
  transactions?: Array<StockWalletTransaction & { purpose: "approve" | "pay" }>;
  recipient?: { platform: Platform; username: string; address: `0x${string}` };
};

/**
 * The browser opens a wallet only for the exact transfer the sender reviewed: the same chain, the allowlisted
 * token contract, the session wallet as sender, the resolved recipient, and the same base units. Through the fee
 * router that is an approval of exactly the amount plus a fee of at most 1% to the router (left out when an earlier
 * approval already covers it), then `pay` of that token and amount to that recipient with the reviewed note after its
 * arguments and nothing else. Without a fee router it is one `transfer`, and no note.
 */
export function matchesStockReview(
  prepared: PreparedStockTransfer,
  review: {
    network: StockNetworkId; token: string; sender: string; recipient: string; units: string; note?: string;
    /**
     * The fee router the review showed the fee for, or null when it showed no fee: a fee the review never showed is
     * never signed (audit, 2026-10-06: the board could miss the fee while preparation added it).
     */
    router?: string | null;
  },
) {
  const chain = STOCK_CHAINS[review.network];
  try {
    if (prepared.networkId !== review.network || prepared.chainId !== chain.id || prepared.chainIdHex !== `0x${chain.id.toString(16)}`) return false;
    if (prepared.units !== review.units) return false;
    if (review.router !== undefined) {
      if (Boolean(prepared.fee) !== Boolean(review.router)) return false;
      if (prepared.fee && review.router && getAddress(prepared.fee.router) !== getAddress(review.router)) return false;
    }
    const units = BigInt(review.units);
    if (!prepared.fee) {
      const { transaction } = prepared;
      if (review.note || !transaction || prepared.transactions) return false;
      if (getAddress(transaction.to) !== getAddress(review.token) || getAddress(transaction.from) !== getAddress(review.sender) || BigInt(transaction.value) !== 0n) return false;
      const call = decodeFunctionData({ abi: erc20TransferAbi, data: transaction.data });
      return call.functionName === "transfer" && getAddress(call.args[0]) === getAddress(review.recipient) && call.args[1] === units;
    }
    const { fee } = prepared;
    const calls = prepared.transactions ?? [];
    if (prepared.transaction || !isPreparedFeeWithinSchedule(fee, units) || (calls.length !== 1 && calls.length !== 2) || !prepared.paymentRef) return false;
    // The approval is left out when an earlier one already covers the payment.
    const approve = calls.length === 2 ? calls[0] : undefined;
    if (approve && !matchesRoutedCall(approve, routedApproveCall({ token: review.token, router: fee.router, units: BigInt(fee.totalUnits) }), review.sender)) return false;
    return matchesRoutedCall(calls.at(-1), routedPayCall({ token: review.token, router: fee.router, recipient: review.recipient, units, paymentRef: prepared.paymentRef, note: review.note }), review.sender);
  } catch {
    return false;
  }
}

/** What `/api/stocks/transfers/prepare-batch` returns: the network and token, then the batch itself. */
export type PreparedStockBatch = PreparedBatch & {
  networkId: StockNetworkId;
  chainIdHex: `0x${string}`;
  chainName: string;
  token: { symbol: string; name: string; address: `0x${string}`; decimals: number };
  balance: string;
};

/**
 * A token batch opens the wallet only when it is exactly the reviewed one: the same chain and allowlisted token, and
 * through the router of the network's fee schedule everything `matchesRoutedBatch` checks.
 */
export function matchesStockBatch(
  prepared: PreparedStockBatch,
  review: { network: StockNetworkId; token: string; router: string; sender: string; note?: string; payments: Array<{ recipient: string; units: string }> },
) {
  const chain = STOCK_CHAINS[review.network];
  try {
    if (prepared.networkId !== review.network || prepared.chainId !== chain.id || prepared.chainIdHex !== `0x${chain.id.toString(16)}`) return false;
    if (getAddress(prepared.token.address) !== getAddress(review.token)) return false;
    return matchesRoutedBatch(prepared, { token: review.token, router: review.router, wallet: review.sender, note: review.note, payments: review.payments });
  } catch {
    return false;
  }
}
