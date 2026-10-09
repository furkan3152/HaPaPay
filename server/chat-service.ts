import { formatUnits, getAddress, parseUnits } from "viem";
import { z } from "zod";
import {
  canonicalAmount,
  isBareHandle,
  numberReadings,
  numberWords,
  parsePaymentIntent,
  parseSocialRecipient,
  parseSocialRecipients,
  platformMentions,
  recipientPlatformMentions,
  platformName,
  profileLinksAsHandles,
  statedUsdcAmounts,
  type NamedRecipient,
  type PaymentIntent,
  type Platform,
} from "../src/domain/payment-intent.js";
import { checkPaymentNote } from "../src/domain/payment-note.js";
import { KNOWN_ROBINHOOD_SYMBOLS, ROBINHOOD_ASSET_ALLOWLISTS } from "../src/domain/robinhood-assets.js";
import { PAYMENT_BATCH_MAX_RECIPIENTS, splitUnits, type AmountMode } from "../src/domain/routed-payments.js";
import {
  isStockToken,
  parseStockTransferRequest,
  readStockAsset,
  STOCK_CHAINS,
  stockTokenUnits,
  tokenDecimals,
  transferAvailabilityFor,
  type StockNetworkId,
  type StockTokenListing,
  type StockTickerHint,
  type StockTransferAvailability,
} from "../src/domain/stock-tokens.js";
import { isStockClaimPlatform, STOCK_CLAIM_WINDOW_HOURS, type StockClaimAvailability } from "../src/domain/stock-claims.js";
import { isLockableName, locksOnlyToName, type VaultLock } from "../src/domain/vault-lock.js";
import { NO_SOL_SENDING, isSolanaStock, vaultHoldsAsset, type SolanaAssetListing } from "../src/domain/solana-assets.js";
import { namesSolanaOnly, readNetworkWords, readSolanaAmount, solanaAssetWord, type NetworkWord, type SolanaAmountReading } from "../src/domain/solana-intent.js";
import { solanaAssetByName } from "../src/domain/solana-stocks.js";

const PLATFORMS = ["github", "telegram", "x", "discord", "farcaster"] as const;

export const paymentIntentSchema = z.object({
  kind: z.literal("send"),
  amount: z.string().regex(/^\d+(?:\.\d{1,6})?$/).refine((amount) => /[1-9]/.test(amount), "Enter an amount greater than zero."),
  token: z.literal("USDC"),
  recipient: z.object({
    platform: z.enum(PLATFORMS),
    // A Turkish case ending copied with the handle ("octocat'a") is not part of it.
    username: z.preprocess(
      (value) => typeof value === "string" ? value.trim().replace(/['’].*$/, "") : value,
      z.string().regex(/^@?[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_])?$/).transform((value) => value.replace(/^@/, "").toLowerCase()),
    ),
  }),
  sourcePlatform: z.enum(PLATFORMS).optional(),
  status: z.literal("draft"),
  /** The note the sender reviewed; the prepare routes check it with `checkPaymentNote`. */
  note: z.string().max(1_000).optional(),
});

/**
 * A batch the sender reviewed, as the browser sends it to be prepared: who, how much each (validated by the route
 * for its asset), the wallet the review resolved for each, the sender's own account when named, and the note.
 */
export const paymentBatchSchema = z.object({
  recipients: z.array(z.object({
    platform: z.enum(PLATFORMS),
    username: paymentIntentSchema.shape.recipient.shape.username,
    amount: z.string().min(1).max(80),
    expectedRecipientAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })).min(1).max(PAYMENT_BATCH_MAX_RECIPIENTS),
  sourcePlatform: z.enum(PLATFORMS).optional(),
  note: z.string().max(1_000).optional(),
});

const AI_PLATFORMS = [...PLATFORMS, "unstated"] as const;

/**
 * What the AI reader returns for one request (`parseWithOpenRouter`): an untrusted reading that the desk keeps only
 * where the message states it. It never decides each or split, never names a platform the message does not, and
 * copies a note only as written.
 */
export const paymentReadingSchema = z.object({
  kind: z.enum(["send", "none"]),
  amount: z.string().max(64),
  asset: z.string().max(16),
  recipients: z.array(z.object({ username: z.string().max(80), platform: z.enum(AI_PLATFORMS) })).max(PAYMENT_BATCH_MAX_RECIPIENTS * 2),
  sourcePlatform: z.enum(AI_PLATFORMS),
  note: z.string().max(400),
});
export type PaymentReading = z.infer<typeof paymentReadingSchema>;

type IntentParser = (message: string) => Promise<unknown>;
type IdentityResolver = (platform: Platform, username: string) =>
  | `0x${string}`
  | undefined
  | Promise<`0x${string}` | undefined>;
type Parser = "local" | "openrouter" | "local_fallback";
/**
 * A question a reply asks about one request, so a short typed answer ("each", "X", "evet") finishes that request:
 * the browser sends the answer back with `request`, and the server reads `request` again to know the question. The
 * answers it understands are `choices` (by keyword) and `offered` (by position: "1", "the second").
 */
export type ChatQuestion = { kind: "amount_mode" | "platform" | "recipients"; request: string; choices: Array<string | undefined>; offered: string[] };
/** What a reply asks for, and up to three complete requests the sender can pick instead of typing one again. */
type Clarification = { message: string; suggestions?: string[]; question?: ChatQuestion };
/** Whether this server holds USDC in the Arc vault for someone who has not joined, and on which platforms. */
export type UsdcClaimAvailability = { enabled: boolean; platforms?: readonly Platform[]; reason?: string };

function clarify(reply: Clarification, parser: Parser): {
  status: "needs_clarification"; message: string; suggestions?: string[]; question?: ChatQuestion; parser: Parser; intent?: undefined; stockIntent?: undefined; batch?: undefined;
} {
  return {
    status: "needs_clarification",
    message: reply.message,
    ...(reply.suggestions?.length ? { suggestions: reply.suggestions.slice(0, 3) } : {}),
    ...(reply.question ? { question: reply.question } : {}),
    parser,
  };
}

function requestText(amount: string, asset: string, username: string, platform: Platform) {
  return `Send ${amount} ${asset} to @${username} on ${platformName(platform)}`;
}

/** A request with its note, written so it reads back the same way. */
function withNote(request: string, note?: string) {
  return note ? `${request}, note: ${note}` : request;
}

/** Everything the desk reads a request against: the AI reader, the identity directory and each network's state. */
type Desk = {
  parseWithAi?: IntentParser;
  resolveIdentity?: IdentityResolver;
  networkName: string;
  stockNetwork: StockNetworkId;
  stockTransfers: StockTransferAvailability | boolean;
  stockClaims: StockClaimAvailability;
  usdcClaims: UsdcClaimAvailability;
  /** The session wallet, when the sender has verified one: nobody is asked to pay themselves in a batch. */
  sender?: string;
  /** Solana, beside Robinhood Chain, when this server runs it. */
  solana?: SolanaChatDesk;
  /**
   * Whether the platform's official directory knows the handle: `false` only when it says the account does not exist,
   * undefined when it cannot be asked. Asked before a vault link is offered to someone who has not joined.
   */
  recipientExists?: RecipientExists;
  /** What the signed-in sender's own wallets hold, to choose the network of a request that names none. */
  holdings?: SenderHoldings;
};

/**
 * The official directory's answer for a handle: exists, does not exist (`false`), the platform refuses this server's
 * lookups for now (`"unavailable"`), or could not be asked (undefined).
 */
export type RecipientExists = (platform: Platform, username: string) => Promise<boolean | "unavailable" | undefined>;

/**
 * What the signed-in sender's own wallets hold, read on chain, to choose the network of a request that names none. Each
 * read answers the amount
 * as a wallet shows it, or undefined when it cannot be read. Never a permission: preparation reads the balance again,
 * and the wallet signs.
 */
export type SenderHoldings = {
  /** On Solana, at the Solana address the account added. */
  solana(asset: SolanaAssetListing): Promise<string | undefined>;
  /** On Arc (USDC) or Robinhood Chain (its listed tokens), at the session wallet. */
  evm(network: Exclude<NetworkWord, "solana">, symbol: string): Promise<string | undefined>;
  /** How long the chat waits for them before it chooses without them. */
  waitMs?: number;
};

export async function createChatDraft(
  message: string,
  parseWithAi?: IntentParser,
  resolveIdentity?: IdentityResolver,
  networkName = "Arc — configuration pending",
  stockNetwork: StockNetworkId = "robinhood-mainnet",
  stockTransfers: StockTransferAvailability | boolean = false,
  stockClaims: StockClaimAvailability = { enabled: false },
  usdcClaims: UsdcClaimAvailability = { enabled: false },
  context: { answering?: { request: string }; sender?: string; solana?: SolanaChatDesk; recipientExists?: RecipientExists; holdings?: SenderHoldings } = {},
) {
  const desk: Desk = {
    parseWithAi, resolveIdentity, networkName, stockNetwork, stockTransfers, stockClaims, usdcClaims,
    sender: context.sender, solana: context.solana, recipientExists: context.recipientExists, holdings: context.holdings,
  };
  return (context.answering ? await answerQuestion(message, context.answering.request, desk) : undefined) ?? await readRequest(message, desk);
}

/**
 * "x'ten @jack'e", "githubdan @octocat'a", "from X": the one platform a request writes as where the payment comes from
 * names where the recipient is (`recipientPlatformMentions`), unless someone it pays is verified on another platform
 * and not on that one. Then the sender most likely named their own account, so the request is read with it written as
 * theirs ("X hesabımdan", "from my X") and the desk asks, offering where that person is ("@jack'e x'ten 10 dolar
 * yolla" is read as X; "telegramdan @torvalds'a" still offers GitHub, where @torvalds is).
 */
function ownPlatformWritten(text: string, desk: Desk): string | Promise<string> {
  const mentions = platformMentions(text);
  // Nothing to ask is answered at once, so a request that needs no lookup reaches the parser without waiting.
  if (!mentions.length || !desk.resolveIdentity || mentions.some(({ source, mine }) => !source || mine)) return text;
  const platforms = new Set(mentions.map(({ platform }) => platform));
  if (platforms.size !== 1) return text;
  const [platform] = platforms;
  return ownedWhereVerifiedElsewhere(text, mentions, platform, desk.resolveIdentity);
}

async function ownedWhereVerifiedElsewhere(text: string, mentions: ReturnType<typeof platformMentions>, platform: Platform, lookup: NonNullable<Desk["resolveIdentity"]>) {
  const { recipients } = parseSocialRecipients(text, TICKER_WORDS);
  const resolve = async (on: Platform, username: string) => {
    try {
      return await lookup(on, username);
    } catch {
      return undefined;
    }
  };
  const elsewhere = await Promise.all(recipients.map(async ({ username }) => {
    if (await resolve(platform, username)) return false;
    const others = await Promise.all(PLATFORMS.filter((other) => other !== platform).map((other) => resolve(other, username)));
    return others.some(Boolean);
  }));
  if (!elsewhere.some(Boolean)) return text;
  // Written from the end, so earlier positions stay where they are.
  let owned = text;
  for (const { index, end } of [...mentions].sort((left, right) => right.index - left.index)) {
    const suffix = /^['’]?(?:dan|den|tan|ten)(?![a-zçğıöşü])/i.exec(owned.slice(end));
    owned = suffix
      ? `${owned.slice(0, end)} hesabımdan${owned.slice(end + suffix[0].length)}`
      : `${owned.slice(0, index)}my ${owned.slice(index)}`;
  }
  return owned;
}

/** Reads one request: its note, what it must never become, then one person's payment or several people's. */
async function readRequest(message: string, desk: Desk) {
  const first = await readPayment(message, desk);
  const result = first.status === "rewrite" ? await readRewrite(first.rewrite, desk) : first;
  // Every complete request a reply offers keeps the note the sender wrote.
  const { note } = readNote(message);
  if (note && "suggestions" in result && result.suggestions && result.question?.kind !== "recipients") {
    result.suggestions = result.suggestions.map((suggestion) => readNote(suggestion).note ? suggestion : withNote(suggestion, note));
  }
  return result;
}

/** A request the AI reader found and the desk wrote back in its own words, read by the rules alone and shown as read. */
async function readRewrite(request: string, desk: Desk) {
  const result = await readPayment(request, { ...desk, parseWithAi: undefined });
  if (result.status === "rewrite") return clarify({ message: "Write an amount, an asset and who receives it, for example: Send 2 NVDA to @toly on X." }, "openrouter");
  return { ...result, message: `Reading that as “${request}”. ${result.message}`, parser: "openrouter" as const };
}

async function readPayment(message: string, desk: Desk) {
  const { stockNetwork } = desk;
  // A note rides with the payment; the request around it is read without it.
  const noted = readNote(message);
  if (noted.error) return clarify({ message: noted.error }, "local");
  const { note } = noted;
  // The product's own name is never an asset or a payee: "how does HaPaPay work" names neither an asset nor @work.
  const namedProduct = new RegExp(PRODUCT_NAME.source, "i").test(noted.text);
  const owned = ownPlatformWritten(writtenAmounts(profileLinksAsHandles(noted.text.replace(PRODUCT_NAME, " ").replace(/\s{2,}/g, " ").trim())), desk);
  let text = typeof owned === "string" ? owned : await owned;
  // A request that names Arc or Robinhood Chain keeps it in every request the desk writes back (audit, 2026-10-06:
  // a question's answer went to Solana and drafted another asset there).
  const named = readNetworkWords(text).networks;
  const keep = <T extends object>(result: T) => keepNetwork(result, named.length === 1 ? named[0] : undefined);
  // A network HaPaPay does not run is said, never ignored (audit, 2026-10-06: "on Ethereum" drafted on Solana).
  const elsewhere = UNSUPPORTED_NETWORK.exec(wordsOf(text));
  if (elsewhere) {
    return clarify({ message: `HaPaPay sends on Solana, Arc and Robinhood Chain; ${networkLabel(elsewhere[1])} is not one of them. Write the request without it, or with one of those.` }, "local");
  }
  // Asking for money, saying not to send, repeated payments or a payment for later: never a draft.
  const outside = outOfScope(text);
  if (outside) {
    const now = outside.now ? immediateRequest(text, stockNetwork) : undefined;
    return keep(clarify({ message: outside.message, suggestions: now ? [now] : undefined }, "local"));
  }
  // A part of an amount is never worked out, and the fee is never taken out of one (audit, 2026-10-06: "half of 10
  // USDC" drafted 10 USDC).
  if (PART_OF_AMOUNT.test(text) || multipliedAmount(text)) return keep(clarify({ message: "Write the amount to send as one number, for example: Send 5 USDC to @toly on X." }, "local"));
  if (FEE_INSIDE.test(text)) {
    return keep(clarify({ message: "The 1% fee is added on top, so the recipient gets exactly the amount you write. Write that amount, for example: Send 5 USDC to @toly on X." }, "local"));
  }
  // A wallet address is not a handle (audit, 2026-10-06: a Solana address was lowercased and asked for its platform).
  if (walletAddressRecipient(text)) {
    return keep(clarify({ message: "HaPaPay pays people by their verified handle, not by wallet address. Write who receives it and where, for example: Send 5 USDC to @toly on X." }, "local"));
  }
  // A number written for each person or for everyone beside another amount: which one is meant is asked.
  const twoAmounts = conflictingShare(text);
  if (twoAmounts) return clarify({ message: twoAmounts }, "local");
  // A question about the desk is answered with what it does.
  if (asksAboutTheDesk(text, namedProduct)) return clarify({ message: HELP_REPLY }, "local");
  // Named before the Solana reader takes the network words out, so a Robinhood Chain request keeps its own tickers.
  const namesRobinhood = readNetworkWords(text).networks.includes("robinhood");
  // The Solana reader looks at every request first: it keeps what goes on Solana (`readSolanaRequest`) and hands the
  // rest back without its network words, for Robinhood Chain, the main network, and Arc below.
  let routed: string | undefined;
  if (desk.solana) {
    const solana = await readSolanaRequest(message, text, note, desk, desk.solana);
    if (!forEvm(solana)) return solana;
    text = solana.evmText;
    routed = (solana as { because?: string }).because;
  } else {
    // xStocks move only on Solana, which a server without it says plainly; SOL is not sent anywhere.
    const onlySolana = readSolanaAmount(text);
    if (onlySolana.status === "invalid" && onlySolana.message === NO_SOL_SENDING) return clarify({ message: NO_SOL_SENDING }, "local");
    if (onlySolana.status === "found" && namesSolanaOnly(onlySolana.asset, onlySolana.written)) {
      return clarify({ message: `${onlySolana.asset.symbol} moves only on Solana, which this server does not run. It sends USDC on Arc and Stock Tokens and USDG on Robinhood Chain.` }, "local");
    }
  }
  const result = keep(await readEvmPayment(message, text, note, namesRobinhood, desk));
  // A request that went to its other network because of what the wallet holds says so in its review.
  return routed && EVM_REVIEWS.has(result.status) ? { ...result, message: `${result.message} ${routed}` } : result;
}

/**
 * Amounts written the short way, read the long way before anything else reads the request: ".5" and ",5" are 0.5,
 * "half a SOL" and "yarım SOL" 0.5 SOL, "10k USDC" and "$2m" 10000 USDC and 2000000 dollars, and a dollar value in
 * brackets after an amount of another asset ("0.1 SOL ($20)") is what it is worth, not a second amount (audit,
 * 2026-10-06: ".5 USDC" and "10k USDC" were offered back as 5 and 10 USDC, and "0.1 SOL ($20)" was answered that SOL
 * is not sent).
 */
function writtenAmounts(text: string) {
  return text
    .replace(/(?<=^|[\s(:$-])(?=[.,]\d)/g, "0")
    .replace(HALF_OF_ASSET, (whole, word: string) => namesAnyAsset(word) ? "0.5 " : whole)
    .replace(/(?<![\w.,])(\$\s*)?(\d+(?:[.,]\d+)?)(k|mn|m)(?!\w)/gi, (whole: string, dollar: string | undefined, digits: string, scale: string, at: number, all: string) => {
      const after = all.slice(at + whole.length);
      const next = /^\s*(\$?[A-Za-z][A-Za-z0-9]{0,7})(?![\w@.])/.exec(after)?.[1];
      if (!dollar && !/^\s*\$(?![\w$])/.test(after) && !(next && namesAnyAsset(next))) return whole;
      const readings = numberReadings(digits);
      const places = scale.toLowerCase() === "k" ? 3 : 6;
      const [units, fraction = ""] = readings[0]?.split(".") ?? [];
      if (readings.length !== 1 || fraction.length > places) return whole;
      return `${dollar ?? ""}${BigInt(units + fraction.padEnd(places, "0"))}`;
    })
    .replace(VALUE_IN_BRACKETS, (whole, amount: string, asset: string) => namesAnyAsset(asset) && !DOLLAR_ASSET.test(asset) ? amount : whole);
}

/** "half a SOL", "a half USDC", "yarım SOL": never the half in "one and a half SOL", which is asked. */
const HALF_OF_ASSET = /(?<!\band\s+(?:a\s+)?)(?<![\w@.-])(?:a\s+)?(?:half|yar[ıi]m)\s+(?:an?\s+)?(?=(\$?[A-Za-z][A-Za-z0-9]{0,7})(?![\w@.]))/gi;
/** A value in brackets after an amount: "0.1 SOL ($20)", "2 TSLA (~$500)", "1 SOL (about 150 USDC)". */
const VALUE_IN_BRACKETS = /(\d[\d.,]*\s*(\$?[A-Za-z][A-Za-z0-9]{0,7}))\s*\(\s*(?:~|≈|about|around|approx(?:\.|imately)?|roughly|yaklaşık|yaklasik)?\s*(?:\$\s*\d[\d.,]*|\d[\d.,]*\s*(?:\$|usdc|usdg|usd|dollars?|bucks|dolar\w*))\s*(?:worth)?\s*\)/gi;
/** The dollar assets, whose value in dollars is their amount: a different one in brackets is a second amount. */
const DOLLAR_ASSET = /^\$?(?:usdc|usdg|usd|dollars?|bucks|dolar\w*)$/i;
/**
 * A part of an amount: "half of 10 USDC", "50% of 10 USDC", "a third of 30 USDC", "half now", "10 usdc'nin yarısı",
 * "%50'si".
 */
const PART_OF_AMOUNT = /\b(?:half|(?:a|one|two)\s+thirds?|(?:a|one|three)\s+quarters?|quarter|third)\s+of\s+(?:the\s+|my\s+|your\s+|that\s+|this\s+)?(?=\$?\s*\d)|\d\s*(?:%|percent)\s+of\b|%\s*\d+(?:[.,]\d+)?['’]s?[ıiuü](?:n[ıiuü])?(?![\wçğıöşü])|\by[üu]zde\s*\d|\bhalf\s+(?:now|today|later|tomorrow|up\s*front)\b|\d[\d.,]*\s*\$?[A-Za-z]{2,8}['’]?n[ıi]n\s+(?:yar[ıi]s|[çc]eyre[ğg]|[üu][çc]te)/i;
/**
 * An amount written as a product of numbers next to an asset: "5x2 USDC", "$5 x 2", "2 x 5 SOL", "5 USDC x 2". An EVM
 * address ("0x…") and a product of other things ("for 2 x 50 tickets") are not one.
 */
function multipliedAmount(text: string) {
  const product = /(?<![\w@.])(\$\s*)?(?:[1-9]\d*|0[.,]\d+)(?:[.,]\d+)?\s*[x×*]\s*\d[\d.,]*(?:\s*(\$|[A-Za-z][A-Za-z0-9]{0,7})(?![\w]))?/g;
  for (const [, dollar, after] of text.matchAll(product)) if (dollar || after === "$" || (after && namesAnyAsset(after))) return true;
  const times = /(?<![\w@.])\d[\d.,]*\s*(\$?[A-Za-z][A-Za-z0-9]{0,7})\s*[x×*]\s*\d/g;
  return [...text.matchAll(times)].some(([, asset]) => namesAnyAsset(asset));
}

/** The fee taken out of the amount, where HaPaPay adds it on top: "10 USDC minus fees", "fees included". */
const FEE_INSIDE = /\b(?:minus|less|net\s+of|excluding|exclusive\s+of)\s+(?:the\s+)?(?:fees?|commission)\b|\bafter\s+(?:the\s+)?(?:fees?|commission)(?=\s*(?:$|[,.;!?)]))|\b(?:including|incl\.?|inclusive\s+of)\s+(?:the\s+)?(?:fees?|commission)\b|\b(?:fees?|commission)\s+(?:included|inclusive|deducted)\b|\bkomisyon(?:u)?\s+(?:dahil|d[üu][şs][üu]l)/i;

/** An EVM address or a Solana address (base58, 32 to 44 characters) written where a handle goes; "@0x…" is a handle. */
const WALLET_ADDRESS = /(?<![\w@./-])(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(?![\w.-])/g;

/** The wallet address a request names as the person to pay, if it does. */
function walletAddressRecipient(text: string) {
  const people = new Set(parseSocialRecipients(text, TICKER_WORDS).recipients.map(({ username }) => username.toLowerCase()));
  for (const [, address] of text.matchAll(WALLET_ADDRESS)) {
    // A Solana address mixes digits, capitals and small letters; a long handle seldom does.
    const solana = !/^0x/.test(address) && /\d/.test(address) && /[A-Z]/.test(address) && /[a-z]/.test(address);
    if ((/^0x/.test(address) || solana) && people.has(address.toLowerCase())) return address;
  }
  return undefined;
}

/** Networks people name that HaPaPay does not run. */
const UNSUPPORTED_NETWORK = /\b(?:on|via|over|using|through)\s+(?:the\s+)?(ethereum|eth\s+mainnet|base|polygon|matic|bsc|bnb\s+(?:smart\s+)?chain|binance(?:\s+smart\s+chain)?|arbitrum|optimism|avalanche|avax|tron|bitcoin|lightning|ton|aptos|near|cosmos|linea|scroll|zksync|blast|celo|gnosis|fantom|cardano|ripple|xrpl?)(?:\s+(?:network|chain|mainnet|blockchain))?\b/i;

function networkLabel(word: string) {
  const lower = word.toLowerCase().replace(/\s+/g, " ");
  const names: Record<string, string> = { "eth mainnet": "Ethereum", bsc: "BNB Chain", "bnb chain": "BNB Chain", "bnb smart chain": "BNB Chain", binance: "BNB Chain", "binance smart chain": "BNB Chain", matic: "Polygon", avax: "Avalanche", zksync: "zkSync", xrp: "the XRP Ledger", xrpl: "the XRP Ledger", ripple: "the XRP Ledger", ton: "TON" };
  return names[lower] ?? lower.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Every request a reply writes back (its suggestions, its question's choices, and a request the AI reader found, which
 * the rules read again) keeps the network the request named, Arc or Robinhood Chain, before any note it carries.
 * Solana's own replies already say "on Solana" where needed.
 */
function keepNetwork<T extends object>(result: T, network: NetworkWord | undefined): T {
  const words = network === "arc" ? "on Arc" : network === "robinhood" ? "on Robinhood Chain" : undefined;
  if (!words) return result;
  const add = (request: string) => {
    const { text, note } = readNote(request);
    // Only the request's own words count: a note may name a network ("note: Solana meetup") without choosing it.
    if (readNetworkWords(text).networks.length) return request;
    return withNote(`${text.trim()} ${words}`, note);
  };
  const reply = result as T & { suggestions?: string[]; question?: ChatQuestion; rewrite?: string };
  return {
    ...result,
    ...(reply.rewrite ? { rewrite: add(reply.rewrite) } : {}),
    ...(reply.suggestions ? { suggestions: reply.suggestions.map(add) } : {}),
    ...(reply.question ? { question: { ...reply.question, choices: reply.question.choices.map((choice) => choice && add(choice)), offered: reply.question.offered.map(add) } } : {}),
  };
}

/** A bare number beside "each" or "in total" ("5 each", "(1 each)", "10 in total"), and the number it stands beside. */
const SHARE_NUMBER = /(?<![\w.,$])(\d+(?:[.,]\d+)?)\s*(?:each|apiece|per\s+person|in\s+total|total|toplam|her\s+birine)(?![\wçğıöşü])|(?:each|in\s+total|total|toplam)\s+(?:of\s+)?(\d+(?:[.,]\d+)?)(?![\w.,])/i;
/** A number with its asset or currency: "10 USDC", "2 TSLA", "$5", "5$". */
const UNIT_NUMBER = /(?<![\w.,])\$\s*(\d+(?:[.,]\d+)?)|(?<![\w.,$])(\d+(?:[.,]\d+)?)\s*(?:\$|[A-Za-z]{2,8}\b)/g;

/**
 * A request to several people that writes its amount with an asset and another one beside "each" or "in total"
 * ("send 10 USDC to @a and @b, 5 each"): which is meant is asked, never guessed (audit, 2026-10-06: it paid 10 each).
 */
function conflictingShare(text: string): string | undefined {
  const masked = wordsOf(text);
  const share = SHARE_NUMBER.exec(masked);
  if (!share || readListed(text)) return undefined;
  const value = share[1] ?? share[2];
  const other = [...masked.matchAll(UNIT_NUMBER)]
    .filter((match) => !/^\d+(?:[.,]\d+)?\s*(?:each|apiece|per|in|total|toplam|her)\b/i.test(match[0]))
    .find((match) => (match[1] ?? match[2]) !== value);
  if (!other) return undefined;
  return `This request names two amounts, ${other[0].trim()} and ${share[0].trim()}. Write it again with one: the amount each person gets with “each”, or the total to split.`;
}

/** Whether the Solana reader handed the request on to Arc and Robinhood Chain, and why when the wallet decided it. */
function forEvm(reading: object): reading is { evmText: string } {
  return typeof (reading as { evmText?: unknown }).evmText === "string";
}

/** The reviews of Arc and Robinhood Chain, which a request moved there by the sender's holdings explains. */
const EVM_REVIEWS = new Set<string>(["ready_for_review", "stock_review", "batch_review", "claim_review", "stock_claim_review"]);

/** A request for Arc or Robinhood Chain: one person's payment, several people's, a vault link, or what is missing. */
async function readEvmPayment(message: string, text: string, note: string | undefined, namesRobinhood: boolean, desk: Desk) {
  const { parseWithAi, resolveIdentity, networkName, stockNetwork, stockTransfers, stockClaims, usdcClaims } = desk;
  const stockChain = STOCK_CHAINS[stockNetwork];
  const tokens = ROBINHOOD_ASSET_ALLOWLISTS[stockNetwork].tokens;
  // Several people in one request are read together; one person keeps the reading below.
  const people = parseSocialRecipients(text, TICKER_WORDS);
  if (people.recipients.length > 1) return readBatch(message, text, note, people, desk);
  const mode = amountModeOf(text);
  if (!people.recipients.length && mode) {
    return clarify({ message: "Name everyone who receives it, for example: Send 5 USDC each to @toly and @carol on X." }, "local");
  }
  if (people.recipients.length === 1 && SPLIT_VERBS.test(wordsOf(text))) {
    return clarify({ message: `Name everyone who shares it, for example: Split 10 USDC between @${people.recipients[0].username} and @carol on X.` }, "local");
  }
  // Robinhood token requests are recognized deterministically first, so a ticker can never be reinterpreted as USDC.
  const stockRequest = parseStockTransferRequest(text, { network: stockNetwork, tokens }, KNOWN_ROBINHOOD_SYMBOLS);
  if (stockRequest.status === "invalid" && parseWithAi && /^Add who receives it and where/.test(stockRequest.message)) {
    const asset = readStockAsset(text, { network: stockNetwork, tokens }, KNOWN_ROBINHOOD_SYMBOLS);
    try {
      const reading = asset.status === "found" ? paymentReadingSchema.parse(await parseWithAi(text)) : undefined;
      const rewrite = reading && asset.status === "found" ? groundedRewrite(text, reading, note ?? groundedNote(text, reading), asset) : undefined;
      if (rewrite && rewrite !== message) return { status: "rewrite" as const, rewrite };
    } catch {
      // Without the AI reader the rules' question stands.
    }
  }
  if (stockRequest.status === "invalid") {
    const xstock = namesRobinhood ? undefined : xstockInstead(stockRequest.ticker, desk);
    if (xstock) return clarify(xstock, "local");
    const missingPlatform = /^Add which platform @([^ ]+) is on, for example: Send (\S+) (\S+) to /.exec(stockRequest.message);
    const suggestions = stockRequest.suggestions
      ?? (missingPlatform ? await platformChoices(text, missingPlatform[1], missingPlatform[2], missingPlatform[3], resolveIdentity) : undefined);
    const question = missingPlatform ? platformQuestion(message, missingPlatform[1], missingPlatform[2], missingPlatform[3], note, suggestions) : undefined;
    return clarify({ message: missingPlatform ? askPlatform(stockRequest.message, suggestions) : stockRequest.message, suggestions, question }, "local");
  }
  if (stockRequest.status === "parsed") {
    const stockIntent = stockRequest.intent;
    const { platform, username } = stockIntent.recipient;
    const decimals = stockIntent.asset.decimals;
    const units = stockTokenUnits(stockIntent.amount, decimals).toString();
    const assetTransfers = typeof stockTransfers === "boolean"
      ? { enabled: stockTransfers }
      : transferAvailabilityFor(stockTransfers, stockIntent.asset);
    const stockToken = isStockToken(stockIntent.asset);
    const resolvedAddress = await resolveIdentity?.(platform, username);
    if (!resolvedAddress) {
      // GitHub, X and Farcaster resolve a handle to an immutable account ID, so the tokens can wait in the vault.
      const linksHoldThisAsset = stockToken ? stockClaims.stockTokens !== false : stockClaims.tokens !== false;
      if (stockClaims.enabled && stockClaims.escrow && linksHoldThisAsset && isStockClaimPlatform(platform) && (stockClaims.platforms?.includes(platform) ?? true)) {
        const offer = await vaultOffer(desk, platform, username);
        if ("refusal" in offer) return clarify({ message: offer.refusal }, "local");
        return {
          status: "stock_claim_review" as const,
          message: `${vaultReviewText(username, platform, stockIntent.asset.symbol, `${stockChain.name} vault`, offer.lock)}${note ? VAULT_NOTE : ""}`,
          vaultLock: offer.lock,
          stockIntent,
          stockNetwork,
          units,
          network: stockChain.name,
          chainId: stockChain.id,
          escrow: stockClaims.escrow,
          expiryHours: STOCK_CLAIM_WINDOW_HOURS.default,
          parser: "local" as const,
        };
      }
      return {
        status: "needs_clarification" as const,
        message: notJoinedYet(platform, username, vaultClosed(stockChain.name, stockClaims, platform, username)),
        stockIntent,
        parser: "local" as const,
      };
    }
    return {
      status: "stock_review" as const,
      message: assetTransfers.enabled
        ? `Found @${username}'s verified wallet. Check the transfer below, then sign it in your wallet.`
        : `Found @${username}'s verified wallet. ${stockChain.name} ${stockToken ? "stock" : stockIntent.asset.symbol} transfers are off on this server, so this stays a draft.`,
      stockIntent,
      stockNetwork,
      resolvedAddress,
      units,
      network: stockChain.name,
      chainId: stockChain.id,
      transferEnabled: assetTransfers.enabled,
      ...(note ? { note } : {}),
      parser: "local" as const,
    };
  }

  const read = await readUsdcRequest(text, parseWithAi);
  const { intent, parser } = read;
  if (read.rewrite && read.rewrite !== message) return { status: "rewrite" as const, rewrite: read.rewrite };
  const usdcNote = note ?? read.note;
  if (!intent) {
    const reply = clarification(text, tokens, stockTransfers);
    const missingPlatform = /^Add which platform @([^ ]+) is on, for example: Send (\S+) (\S+) to /.exec(reply.message);
    if (missingPlatform && !reply.suggestions) reply.suggestions = await platformChoices(text, missingPlatform[1], missingPlatform[2], missingPlatform[3], resolveIdentity);
    if (missingPlatform) {
      reply.question = platformQuestion(message, missingPlatform[1], missingPlatform[2], missingPlatform[3], note, reply.suggestions);
      reply.message = askPlatform(reply.message, reply.suggestions);
    }
    return clarify(reply, parser);
  }

  const { platform, username } = intent.recipient;
  const resolvedAddress = await resolveIdentity?.(platform, username);
  if (!resolvedAddress) {
    // As with tokens, someone who has not joined can claim USDC from the Arc vault once they connect that account.
    if (usdcClaims.enabled && isStockClaimPlatform(platform) && (usdcClaims.platforms?.includes(platform) ?? true)) {
      const offer = await vaultOffer(desk, platform, username);
      if ("refusal" in offer) return clarify({ message: offer.refusal }, parser);
      return {
        status: "claim_review" as const,
        message: `${vaultReviewText(username, platform, "USDC", `${networkName} vault`, offer.lock)}${usdcNote ? VAULT_NOTE : ""}`,
        vaultLock: offer.lock,
        intent,
        network: networkName,
        expiryHours: STOCK_CLAIM_WINDOW_HOURS.default,
        parser,
      };
    }
    return {
      status: "needs_clarification" as const,
      message: notJoinedYet(platform, username, vaultClosed(networkName, usdcClaims, platform, username)),
      intent,
      parser,
    };
  }

  return {
    status: "ready_for_review" as const,
    message: "Recipient matched to one verified wallet. Review the details before signing.",
    intent,
    resolvedAddress,
    network: networkName,
    ...(usdcNote ? { note: usdcNote } : {}),
    parser,
  };
}

/**
 * Whether the vault can hold the money for this handle, and what the link would wait for (`vault-lock.ts`). A
 * mistyped handle must not be offered the vault, so the directory is asked first and a handle it does not know gets no link. Discord and Telegram
 * links wait for the name, which is checked against the names the platform allows; so do X links while X cannot be
 * asked.
 */
async function vaultOffer(desk: Desk, platform: Platform, username: string): Promise<{ refusal: string } | { lock: VaultLock }> {
  if (locksOnlyToName(platform)) {
    return isLockableName(platform, username) ? { lock: "name" } : { refusal: `No ${platformLabel(platform)} account can be named @${username}. Check how the handle is spelled.` };
  }
  const exists = await desk.recipientExists?.(platform, username).catch(() => undefined);
  if (exists === false) return { refusal: `There is no ${platformLabel(platform)} account named @${username}. Check how the handle is spelled.` };
  if (exists === "unavailable") {
    if (platform === "x") return { lock: "name" };
    return { refusal: `${platformLabel(platform)} is not answering account lookups for HaPaPay right now, so the money cannot wait in the vault for @${username}. Try again later, or ask @${username} to join HaPaPay and link ${platformLabel(platform)} so you can pay them directly.` };
  }
  return { lock: "account" };
}

/**
 * What a vault review says about who claims: the account (its immutable ID), or the name, which whoever connects that
 * platform with it claims, so the sender checks the spelling. X says why it waits for the name.
 */
function vaultReviewText(username: string, platform: Platform, symbol: string, vault: string, lock: VaultLock) {
  const name = platformLabel(platform);
  const window = `within the window you pick, ${STOCK_CLAIM_WINDOW_HOURS.default} hours to 30 days, or you take it back after that`;
  if (lock === "account") return `@${username} is not on HaPaPay yet. You can keep the ${symbol} in the ${vault}; they claim it with their official ${name} account ${window}.`;
  const why = platform === "x" ? " X is not answering account lookups right now, so it waits for the name instead of the account." : "";
  return `@${username} is not on HaPaPay yet. You can keep the ${symbol} in the ${vault} for the ${name} name @${username}: whoever connects ${name} to HaPaPay with that name claims it ${window}.${why} Check how the name is spelled.`;
}

/** Why the vault cannot hold the money for this person on this network, or undefined for a platform it never serves. */
function vaultClosed(networkName: string, vault: { enabled: boolean; reason?: string; platforms?: readonly Platform[] }, platform: Platform, username: string) {
  if (!isStockClaimPlatform(platform)) return undefined;
  if (!vault.enabled) return ` The ${networkName} vault is not open${vault.reason ? `: ${vault.reason.replace(/\.$/, "")}` : ""}.`;
  if (vault.platforms && !vault.platforms.includes(platform)) return ` This server cannot look ${platformLabel(platform)} accounts up, so the money cannot wait in the vault for @${username} yet.`;
  return "";
}

/**
 * Someone who has not linked the platform yet, why the money cannot wait for them here, and what to do: send them the
 * invite link from the SP tab, then pay them once they link it. A bare "invite them" reads as broken.
 */
function notJoinedYet(platform: Platform, username: string, closed: string | undefined) {
  const name = platformLabel(platform);
  return `@${username} has not linked ${name} to HaPaPay yet.${closed ?? ""} Send @${username} your invite link from the SP tab; once they sign in and link ${name}, send it again and it goes straight to them.`;
}

/** What a vault-link reply adds when the request has a note: a note rides only on a direct payment's `pay`. */
const VAULT_NOTE = " A note rides only on a direct payment, so this vault link carries none.";
/** Tickers and asset words, which a list of handles written without the @ never contains. */
const TICKER_WORDS = [...KNOWN_ROBINHOOD_SYMBOLS].map((symbol) => symbol.toLowerCase()).concat("usdc");

/**
 * The question behind "Add which platform @bob is on": a platform the answer names picks the request for that
 * platform, and a position picks one of the requests offered.
 */
function platformQuestion(request: string, username: string, amount: string, asset: string, note: string | undefined, offered: string[] = []): ChatQuestion {
  return {
    kind: "platform",
    request,
    choices: PLATFORMS.map((platform) => withNote(requestText(amount, asset, username, platform), note)),
    offered: offered.map((suggestion) => readNote(suggestion).note || !note ? suggestion : withNote(suggestion, note)),
  };
}

/**
 * The platforms where this handle has a verified HaPaPay account, as complete requests to pick from; when it has
 * none, the platform the message names as the sender's own, since most people pay someone where they talk to them;
 * else every platform, so the choice is a press away. With only "for example … on X" written, the desk would seem to
 * know X alone.
 */
async function platformChoices(message: string, username: string, amount: string, asset: string, resolveIdentity?: IdentityResolver) {
  const verified = (await Promise.all(PLATFORMS.map(async (platform) => await resolveIdentity?.(platform, username) ? platform : undefined)))
    .filter((platform): platform is Platform => Boolean(platform));
  const named = platformMentions(message).map(({ platform }) => platform);
  const choices = verified.length ? verified : named.length ? [...new Set(named)].slice(0, 1) : PLATFORM_OFFER_ORDER;
  return choices.map((platform) => requestText(amount, asset, username, platform));
}

/**
 * "Add which platform …, for example: …" with the first request offered as its example, not always X, and with every
 * platform named when nothing narrows the choice.
 */
function askPlatform(message: string, offered: readonly string[] | undefined) {
  if (!offered?.length) return message;
  const example = message.replace(/for example: .+\.$/, `for example: ${offered[0]}.`);
  if (offered.length < PLATFORM_OFFER_ORDER.length) return example;
  const names = PLATFORM_OFFER_ORDER.map(platformLabel);
  return example.replace(/ (is|are) on, for example: /, ` $1 on (${names.slice(0, -1).join(", ")} or ${names.at(-1)}), for example: `);
}

/** Every platform, in the order the desk offers them when nothing narrows the choice. */
const PLATFORM_OFFER_ORDER: readonly Platform[] = ["x", "github", "farcaster", "discord", "telegram"];

/** The request without the part that made it a later or repeated payment, for a reply that offers to send it now. */
function immediateRequest(message: string, stockNetwork: StockNetworkId) {
  const tokens = ROBINHOOD_ASSET_ALLOWLISTS[stockNetwork].tokens;
  const stock = parseStockTransferRequest(message, { network: stockNetwork, tokens }, KNOWN_ROBINHOOD_SYMBOLS);
  if (stock.status === "parsed") return requestText(stock.intent.amount, stock.intent.asset.symbol, stock.intent.recipient.username, stock.intent.recipient.platform);
  if (stock.status === "invalid" || namesOtherAsset(message)) return undefined;
  try {
    const intent = paymentIntentSchema.parse(parsePaymentIntent(message));
    return requestText(intent.amount, "USDC", intent.recipient.username, intent.recipient.platform);
  } catch {
    return undefined;
  }
}

/** The request with every @handle masked, so a handle such as @request never reads as a word. */
function wordsOf(message: string) {
  return message.replace(/(?<![\w.])@[\w.-]+/g, " ");
}

const TURKISH_END = "(?![\\wçğıöşü])";
/** The first verb that sends, so words after it ("…, he will receive it") never turn a payment into a request. */
const SEND_VERB = /\b(?:send|pay|tip|give|transfer)\b|(?:^|[^\wçğıöşü])(?:gönder|gonder|yolla|öde|ode)/i;
/** Asking someone for money, when it comes before any verb that sends: "request 5 USDC from @bob", "get paid". */
const ASKS_FIRST = /\b(?:request(?:ing)?|invoice|charge|collect|receive|get\s+paid)\b|\b(?:get|take)\b[^.?!]{0,40}?\bfrom\s+(?!my\b|own\b|the\s+vault\b)[a-z0-9_]/i;
/**
 * Asking to be paid in the request itself: "pay me", "send me", "to me", "to myself", "owes me", "bana gönder",
 * "bob'dan iste", "kendime", "borcu var". In a later clause they tell the story around a payment ("…, he'll pay me
 * back", "…, he'll send it back to me"), so only the request's own clause counts (audit, 2026-10-06: such a payment
 * was refused).
 */
const ASKS_IN_REQUEST = [
  /\b(?:owes?|owed)\s+me\b|\b(?:pay|send|give|transfer|tip)\s+me\b|\bto\s+me\b|\bmyself\b/i,
  new RegExp(`(?:^|[^\\wçğıöşü])(?:iste|isteyin|istesene|talep\\s+et|tahsil\\s+et|kendime)${TURKISH_END}`, "i"),
  /\bbana\s+(?:\S+\s+){0,4}?(?:gönder|gonder|yolla|öde|ode|at|ver)/i,
  new RegExp(`\\bborcu\\s+var\\b|(?:^|\\s)borçlu${TURKISH_END}`, "i"),
];
/** Saying not to send: "don't send", "never pay", "gönderme". */
const SAYS_NOT_TO = [
  /\b(?:don'?t|do\s+not|dont|never)\s+(?:\w+\s+){0,2}?(?:send|pay|transfer|tip|give)\b/i,
  new RegExp(`(?:^|[^\\wçğıöşü])(?:gönderme|gonderme|yollama|atma)(?:yin|yın|yiniz|yınız)?(?:\\s+(?:lütfen|lutfen|please|pls))?\\s*[.!]*\\s*$`, "i"),
];
const CANCELS = new RegExp(`\\b(?:cancel|undo|reverse|revert|iptal)\\b|(?:^|\\s)vazge[çc]`, "i");
/** The same payment more than once: "twice", "3 times", "iki kez", a closing "2x" or "x3". */
const REPEATED = new RegExp(`\\b(?:twice|thrice|(?:two|three|four|five|\\d+)\\s+times)\\b|(?:^|\\s)(?:iki|üç|uc|\\d+)\\s+(?:kez|kere|defa)${TURKISH_END}|(?:^|\\s)(?:(?:[2-9]|[1-9]\\d+)x|x(?:[2-9]|[1-9]\\d+))\\s*[.!]*\\s*$`, "i");
/** A payment for later or on a schedule. */
const LATER = [
  /\b(?:tomorrow|tonight|later|next\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:every|each)\s+(?:day|week|month|year|hour|morning|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+)|recurring|schedul(?:e|ed|ing))\b|\b(?:daily|weekly|monthly|yearly|annually)\b(?!\s+(?!(?:payments?|transfers?|basis|plan|schedule|subscription|to|for|please|from)\b)[a-z]{3,})/i,
  /\bin\s+\d+\s+(?:minutes?|hours?|days?|weeks?)\b|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\bat\s+\d{1,2}:\d{2}\b/i,
  new RegExp(`(?:^|\\s)(?:yar[ıi]n|haftaya|gelecek\\s+(?:hafta|ay)|her\\s+(?:g[üu]n|hafta|ay|y[ıi]l|sabah|ak[şs]am|pazartesi|sal[ıi]|[çc]ar[şs]amba|per[şs]embe|cuma|cumartesi|pazar)|ayda\\s+bir|haftada\\s+bir|daha\\s+sonra)${TURKISH_END}|(?:^|\\s)(?:g[üu]nl[üu]k|haftal[ıi]k|ayl[ıi]k|y[ıi]ll[ıi]k)${TURKISH_END}(?!\\s+(?!(?:[öo]deme|g[öo]nderim|transfer|olarak)${TURKISH_END})[a-zçğıöşü]{3,})`, "i"),
];
/**
 * What the desk reads but never drafts, with the reason: asking someone for money, saying not to send, cancelling,
 * the same payment more than once, or a payment for later (`now` marks a request whose payment can be offered to send
 * now instead). Every check reads the words with @handles masked.
 */
function outOfScope(message: string): (Clarification & { now?: boolean }) | undefined {
  const text = wordsOf(message);
  const firstSend = SEND_VERB.exec(text)?.index ?? Infinity;
  const before = (pattern: RegExp) => {
    const match = pattern.exec(text);
    return Boolean(match && match.index < firstSend);
  };
  // The request's own clause: up to the first comma, full stop or "because" after its first sending verb.
  const clauseEnd = firstSend === Infinity ? Infinity : firstSend + (/[,;.!?]|\s(?:but|because|since|so|and\s+then)\s/i.exec(text.slice(firstSend))?.index ?? Infinity);
  const inRequest = (pattern: RegExp) => {
    const match = pattern.exec(text);
    return Boolean(match && match.index < clauseEnd);
  };
  // "Don't send" stops a request, unless a later clause only leaves someone out ("…, don't send to alice").
  const notTo = SAYS_NOT_TO[0].exec(text);
  const stops = (notTo && (notTo.index < clauseEnd || !/^\s+(?:it\s+)?to\b/i.test(text.slice(notTo.index + notTo[0].length))))
    || SAYS_NOT_TO.slice(1).some((pattern) => pattern.test(text));
  if (stops) return { message: "Okay, nothing will be sent. Write a new request whenever you want to pay someone." };
  if (before(CANCELS)) {
    return { message: "A sent payment is final on chain and cannot be cancelled. Nothing is sent before you sign it in your wallet, and a vault link that nobody claims comes back to you when its window closes." };
  }
  if (before(ASKS_FIRST) || ASKS_IN_REQUEST.some(inRequest)) {
    return { message: "HaPaPay sends from your own wallet; it cannot ask anyone for money. To get paid, verify an account under Identities and share its payment link." };
  }
  if (REPEATED.test(text)) return { message: "HaPaPay sends each payment once. Send it, then write the request again for the next one." };
  if (LATER.some((pattern) => pattern.test(text))) {
    return { message: "HaPaPay sends right away; it cannot schedule or repeat a payment. Send it when you want it to arrive.", now: true };
  }
  return undefined;
}

/** The product's own name, never an asset or a payee: "HaPaPay", "hapapay", "Ha Pa Pay". */
const PRODUCT_NAME = /(?<![\w@.$-])ha\s*pa\s*pay(?!\w)/gi;
/** A question or a request for help, in English or Turkish: what the desk answers with what it does. */
const ASKS = new RegExp(`\\?|^\\s*(?:what|how|why|who|where|when|which|can|could|does|do|is|are|will|should|tell\\s+me|explain|help)\\b|\\b(?:learn\\s+more|help\\s+me|how\\s+to)\\b|(?:^|[^\\wçğıöşü])(?:nedir|nas[ıi]l|neden|ni[çc]in|kimdir|nerede|hangi|yard[ıi]m|anlat)${TURKISH_END}`, "i");
/** What a question about the desk gets: what it does and how to write a request, never a draft. */
export const HELP_REPLY = "HaPaPay sends stablecoins (USDC and USDG) and stocks (xStocks and Stock Tokens) from your own wallet to a verified handle on GitHub, X, Telegram, Discord or Farcaster, with a 1% fee; someone who has not joined yet claims theirs from the vault once they connect that account. Write an amount, an asset and who receives it, for example: Send 5 USDC to @toly on X.";

/**
 * A question about the desk itself: it asks something (or names the product) and states no amount, handle or asset,
 * so it can only be answered, never drafted.
 */
function asksAboutTheDesk(text: string, namedProduct: boolean) {
  if (/(?<![\w.])@\w/.test(text) || /\b(?:shares?|stocks?|xstocks?)\b|\bhisse/i.test(text)) return false;
  if (/\d/.test(text) || namedToken(text) || NAMES_USDC.test(text) || OTHER_CURRENCY.test(text)) {
    // A question that carries an amount or an asset but names nobody to pay is still a question (audit,
    // 2026-10-06: "why did my 5 USDC payment fail" asked which platform @payment was on).
    return QUESTION.test(text) && !parseSocialRecipients(text, TICKER_WORDS).recipients.length;
  }
  return namedProduct || ASKS.test(text);
}

/** Shaped as a question: it starts with a question word or ends with a question mark. */
const QUESTION = new RegExp(`\\?\\s*$|^\\s*(?:what|how|why|who|where|when|which|can|could|does|do|did|is|are|will|should|was|were)\\b|(?:^|[^\\wçğıöşü])(?:nedir|nas[ıi]l|neden|ni[çc]in|ka[çc]|ne\\s+kadar)${TURKISH_END}`, "i");

/**
 * A Robinhood Chain ticker's reply (shares, or a company name) turned to the xStock with the same ticker, when
 * Robinhood Chain, the main network, does not list that stock and Solana carries it.
 */
function xstockInstead(ticker: StockTickerHint | undefined, desk: Desk): Clarification | undefined {
  if (!ticker || !desk.solana?.stocks.enabled) return undefined;
  if (ROBINHOOD_ASSET_ALLOWLISTS[desk.stockNetwork].tokens.some((token) => token.symbol === ticker.symbol.toUpperCase())) return undefined;
  const asset = solanaAssetByName(ticker.symbol);
  if (!asset || !isSolanaStock(asset)) return undefined;
  const request = `Send ${ticker.amount ?? "2"} ${asset.symbol} to @${ticker.username ?? "toly"} on ${ticker.platform ? platformName(ticker.platform) : "X"}`;
  return {
    message: ticker.shares
      ? `xStocks go by their ticker, in the amounts wallets show rather than shares. Write it as “${request}”.`
      : `xStocks go by their ticker: ${ticker.name} is ${asset.symbol}. Write it as “${request}”.`,
    ...(ticker.amount && ticker.username && ticker.platform ? { suggestions: [request] } : {}),
  };
}

function platformLabel(platform: Platform) {
  return platformName(platform);
}

/** A USDC or dollar amount: "5 USDC", "$5", "5 dollars", "50 dolar". */
const NAMES_USDC = /\busdc\b|\$\s*\d|\d\s*\$|\bdollars?\b|\bdolar|\busd\b|\bbucks\b/i;
/** Currencies HaPaPay does not send. A ".eth" name is a handle, not ether. */
const OTHER_CURRENCY = /(?<![\w.@-])(?:usdt|tether|eth|ether|btc|bitcoin|sol|solana|bnb|xrp|doge|dogecoin|eurc|eur|euros?|gbp|pounds?|lira|tl)(?!\w)|[€£₺]/i;

/**
 * Reads a USDC request. The AI parser is asked only when the message states an amount and USDC or dollars and names no
 * other asset, and its draft is kept only when the message states every part of it; otherwise the deterministic
 * parser reads the message. Two USDC amounts, or one that reads two ways ("1,000"), are left to the clarification.
 */
async function readUsdcRequest(message: string, parseWithAi?: IntentParser): Promise<{ intent?: PaymentIntent; rewrite?: string; note?: string; parser: Parser }> {
  // A USDC draft never stands in for another asset the message names.
  if (namesOtherAsset(message)) return { intent: undefined, parser: "local" as const };
  const stated = statedUsdcAmounts(message);
  if (stated.length > 1 || (stated[0]?.readings.length ?? 1) !== 1) return { intent: undefined, parser: "local" as const };
  const answerable = statedAmounts(message).size > 0 && NAMES_USDC.test(message);
  if (parseWithAi && answerable) {
    try {
      const reading = paymentReadingSchema.parse(await parseWithAi(message));
      const note = groundedNote(message, reading);
      if (reading.kind === "send" && reading.recipients.length === 1 && reading.asset.toUpperCase() === "USDC") {
        const [recipient] = reading.recipients;
        if (recipient.platform !== "unstated") {
          const intent = groundedIntent(message, paymentIntentSchema.parse({
            kind: "send", amount: reading.amount, token: "USDC", recipient: { platform: recipient.platform, username: recipient.username }, status: "draft",
          }));
          if (intent) return { intent, ...(note ? { note } : {}), parser: "openrouter" as const };
        }
      }
      const rewrite = groundedRewrite(message, reading, note);
      if (rewrite) return { rewrite, parser: "openrouter" as const };
    } catch {
      // An unavailable model or a malformed draft falls back to the deterministic parser below.
    }
  }
  const parser = parseWithAi && answerable ? "local_fallback" as const : "local" as const;
  try {
    return { intent: paymentIntentSchema.parse(parsePaymentIntent(message)) as PaymentIntent, parser };
  } catch {
    return { intent: undefined, parser };
  }
}

/**
 * A note the AI reader found, kept only when the message writes it: the same words in the same order, at most one
 * note's length, and none of the request's own parts (a handle, a platform, an amount of an asset).
 */
function groundedNote(message: string, reading: PaymentReading) {
  const check = checkPaymentNote(reading.note);
  if (!check.ok || !check.note) return undefined;
  const flat = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").toLowerCase();
  if (!flat(message).includes(flat(check.note)) || /@/.test(check.note) || platformMentions(check.note).length) return undefined;
  if (statedUsdcAmounts(check.note).length || reading.recipients.some(({ username }) => new RegExp(`(?<![\\w.])${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(check.note!))) return undefined;
  return check.note;
}

/**
 * People the AI reader found where the rules could not, written back as the desk's own request ("Send 5 USDC to @a
 * and @b on X") when every part is grounded: each handle as the message writes it, each platform named in the
 * message, and the asset and amount the message states (for a token, exactly what the rules read). That request is
 * then read by the rules like any other. One USDC recipient keeps `groundedIntent` instead.
 */
function groundedRewrite(message: string, reading: PaymentReading, note?: string, token?: { symbol: string; amount: string }) {
  if (reading.kind !== "send" || !reading.recipients.length) return undefined;
  let amount: string;
  if (token) {
    if (reading.asset.toUpperCase() !== token.symbol || canonicalAmount(reading.amount) !== token.amount) return undefined;
    amount = token.amount;
  } else {
    if (reading.recipients.length < 2 || reading.asset.toUpperCase() !== "USDC" || !NAMES_USDC.test(message) || namesOtherAsset(message)) return undefined;
    amount = canonicalAmount(reading.amount);
    const [usdc] = statedUsdcAmounts(message);
    if (!/^\d+(?:\.\d{1,6})?$/.test(amount) || !/[1-9]/.test(amount) || (usdc ? usdc.readings[0] !== amount : !statedAmounts(message).has(amount))) return undefined;
  }
  const named = new Set(recipientPlatformMentions(platformMentions(message)).map(({ platform }) => platform));
  const people: BatchPerson[] = [];
  for (const { username: written, platform } of reading.recipients) {
    const username = written.trim().replace(/^@/, "").replace(/['’].*$/, "").toLowerCase();
    if (!/^[a-z0-9_](?:[a-z0-9_.-]{0,62}[a-z0-9_])?$/.test(username) || !handleIn(message, username)) return undefined;
    if (platform !== "unstated" && !named.has(platform)) return undefined;
    if (!people.some((person) => person.username === username && person.platform === (platform === "unstated" ? undefined : platform))) {
      people.push({ username, ...(platform === "unstated" ? {} : { platform }) });
    }
  }
  const symbol = token?.symbol ?? "USDC";
  if (people.length === 1) return people[0].platform ? withNote(requestText(amount, symbol, people[0].username, people[0].platform), note) : undefined;
  const mode = amountModeOf(message);
  return batchText({ amount, symbol, people, mode: mode === "each" || mode === "split" ? mode : undefined, note });
}

/**
 * OpenRouter output is untrusted, so its draft stands only when the message states all of it: the handle as written,
 * a platform named for that handle rather than for the sender's own account, the amount in digits or number words
 * (the one written next to USDC or dollars when there is one), and USDC or dollars with no other asset. The sender's
 * own account is read from the message, not from the model.
 */
function groundedIntent(message: string, intent: PaymentIntent): PaymentIntent | undefined {
  const handle = handleIn(message, intent.recipient.username);
  if (!handle) return undefined;
  const mentions = platformMentions(message, handle);
  const named = recipientPlatformMentions(mentions);
  if (!named.some(({ platform }) => platform === intent.recipient.platform)) return undefined;
  const amount = canonicalAmount(intent.amount);
  const [usdcAmount] = statedUsdcAmounts(message);
  if (usdcAmount ? usdcAmount.readings[0] !== amount : !statedAmounts(message).has(amount)) return undefined;
  if (!NAMES_USDC.test(message) || namesOtherAsset(message)) return undefined;
  const sourcePlatform = mentions.find((mention) => mention.source && !named.includes(mention) && mention.platform !== intent.recipient.platform)?.platform;
  return { ...intent, amount, sourcePlatform };
}

/** Where the message writes this handle, with or without the @; a bare word must read as a handle there. */
function handleIn(message: string, username: string) {
  const name = username.replace(/\./g, "\\.");
  const tagged = new RegExp(`(?<![\\w.])@${name}(?![\\w-]|\\.\\w)`, "i").exec(message);
  if (tagged) return { index: tagged.index, end: tagged.index + tagged[0].length };
  for (const match of message.matchAll(new RegExp(`(?<![\\w@$.-])${name}(?![\\w-]|\\.\\w)`, "gi"))) {
    if (isBareHandle(message, match.index, match[0])) return { index: match.index, end: match.index + match[0].length };
  }
  return undefined;
}

/**
 * A listed Robinhood Chain token the message names without an amount before it, which the token parser would have
 * read: USDG in any case, or a ticker of three or more capitals.
 */
function namedToken(message: string) {
  const word = message.match(/(?<![\w.@$-])usdg(?!\w)/i)?.[0]
    ?? Array.from(message.matchAll(/(?<![\w.@-])\$?([A-Z]{3,6})(?!\w)/g), (match) => match[1])
      .find((symbol) => symbol !== "USDC" && KNOWN_ROBINHOOD_SYMBOLS.has(symbol));
  return word?.toUpperCase();
}

function namesOtherAsset(message: string) {
  return Boolean(namedToken(message)) || OTHER_CURRENCY.test(message);
}

/**
 * Every amount a message states, canonical: digits in each way they read ("8,75", "1,000", "1.234,5") and whole
 * numbers in English or Turkish words ("fifty", "yirmi bes").
 */
function statedAmounts(message: string) {
  const amounts = new Set<string>();
  for (const [token] of message.matchAll(/\d+(?:[.,]\d+)*/g)) for (const reading of numberReadings(token)) amounts.add(reading);
  for (const value of numberWords(message)) amounts.add(String(value));
  return amounts;
}

/**
 * What a request that is not a complete payment still needs, read from what the message does state, and the complete
 * requests it could be when the message names who and where. A message with no digits, asset or @handle (a greeting
 * or a question) gets the example request.
 */
function clarification(message: string, tokens: readonly StockTokenListing[], stockTransfers: StockTransferAvailability | boolean): Clarification {
  const amounts = [...statedAmounts(message)];
  const token = namedToken(message);
  const digits = /\d/.test(message);
  const shares = /\bshares?\b|\bstocks?\b|\bhisse/i.test(message);
  if (!digits && !token && !shares && !NAMES_USDC.test(message) && !OTHER_CURRENCY.test(message) && !/(?<![\w.])@\w/.test(message)) {
    return { message: "Write an amount, an asset and who receives it, for example: Send 2 NVDA to @toly on X." };
  }
  const { username, recipientPlatform } = parseSocialRecipient(message, token ? [token] : []);
  const stated = statedUsdcAmounts(message);
  // The amount written next to USDC or dollars, else the first one the message states; never a zero.
  const written = [stated.length === 1 && stated[0].readings.length === 1 ? stated[0].readings[0] : undefined, ...amounts]
    .find((amount): amount is string => amount !== undefined && /[1-9]/.test(amount));
  const example = (asset: string, fallback: string, amount = written) =>
    `Send ${amount ?? fallback} ${asset} to @${username ?? "toly"} on ${recipientPlatform ? platformLabel(recipientPlatform) : "X"}`;
  /** A complete request for these amounts of one asset, when the message names who receives it and where. */
  const choices = (asset: string, ...options: string[]) =>
    username && recipientPlatform ? options.map((amount) => requestText(amount, asset, username, recipientPlatform)) : undefined;
  // "on usdc": the Turkish ten, which is also an English word, so it is offered back in digits.
  const ten = !digits && /(?:^|\s)on\s+(?:[Uu][Ss][Dd][CcGg]|[Dd]olar\S*|[Dd]ollars?|\$?[A-Z]{2,6})(?!\w)/.test(message);
  if (amounts.length === 1 && amounts[0] === "0") return { message: `Enter an amount greater than zero, for example: ${example(token ?? "USDC", "5")}.` };
  if (token) {
    if (/\busdc\b/i.test(message)) return { message: "Send one asset at a time: either USDC or a single listed token." };
    if (NAMES_USDC.test(message)) return { message: `Write the amount in ${token}, not dollars, for example: ${example(token, "2", "2")}.` };
    if (ten) return { message: `Write the amount in digits, for example: ${example(token, "10", "10")}.`, suggestions: choices(token, "10") };
    if (!amounts.length) return { message: `Add an amount, for example: ${example(token, "2")}.` };
    if (!digits) return { message: `Write the amount in digits, for example: ${example(token, "2")}.` };
    return { message: `Write the amount before ${token}, for example: ${example(token, "2")}.` };
  }
  if (OTHER_CURRENCY.test(message)) return { message: `HaPaPay sends USDC, USDG, xStocks and Robinhood Chain Stock Tokens, for example: ${example("USDC", "5")}.` };
  if (shares) return { message: "Name the Stock Token by its ticker, in token units, for example: Send 2 NVDA to @toly on X." };
  if (ten) return { message: `Write the amount in digits, for example: ${example("USDC", "10", "10")}.`, suggestions: choices("USDC", "10") };
  if (stated.length > 1) return { message: "Write one amount per request. Several people share one request when each gets the same amount, for example: Send 5 USDC each to @toly and @carol on X." };
  const [usdc] = stated;
  if (usdc && usdc.readings.length > 1) {
    // "1,000" is a thousand in English and one in Turkish: the sender says which.
    const [decimal, thousands] = usdc.readings;
    return {
      message: `“${usdc.text}” can mean ${thousands} or ${decimal} USDC. Write the amount without a thousands separator, for example: ${example("USDC", thousands, thousands)}.`,
      suggestions: choices("USDC", thousands, decimal),
    };
  }
  if (usdc && !usdc.readings.length) return { message: `Write the amount as digits with one decimal point, for example: ${example("USDC", "5", "5")}.` };
  if (usdc && /\.\d{7,}$/.test(usdc.readings[0])) return { message: `USDC has six decimal places. Write at most six digits after the point, for example: ${example("USDC", "5", "5")}.` };
  if (!amounts.length) return { message: `Add an amount, for example: ${example("USDC", "5")}.` };
  if (!digits && !usdc) return { message: `Write the amount in digits, for example: ${example("USDC", "5")}.` };
  if (!NAMES_USDC.test(message)) {
    const amount = amounts.find((stated) => stated !== "0") ?? "5";
    const usdg = tokens.find((listing) => listing.symbol === "USDG");
    const usdgLive = Boolean(usdg) && (typeof stockTransfers === "boolean" ? stockTransfers : transferAvailabilityFor(stockTransfers, usdg!).enabled);
    return {
      message: `Name the asset after the amount, for example: ${example("USDC", "5")}.`,
      suggestions: [...choices("USDC", amount) ?? [], ...(usdgLive ? choices("USDG", amount) ?? [] : [])],
    };
  }
  if (!username) {
    // Handles on every supported platform are Latin letters, digits, "_", "." and "-": "bülent'e" is a name, not one.
    if (/(?<![\w.])@\S*[^\x00-\x7F]|[^\s'’@]*[^\x00-\x7F][^\s'’]*['’]y?[ae](?![a-zçğıöşü])/i.test(message)) {
      return { message: `Write the recipient's handle as their profile shows it, in Latin letters, digits, "_", "." or "-", for example: ${example("USDC", "5")}.` };
    }
    return { message: `Add who receives it and where, for example: ${example("USDC", "5")}.` };
  }
  if (!recipientPlatform) return { message: `Add which platform @${username} is on, for example: ${example("USDC", "5")}.` };
  return { message: `Write it like this: ${example("USDC", "5")}.` };
}

/** A note written after a marker, to the end of the request: "note: …", "memo: …", "not: …", "açıklama: …". */
const NOTE_MARKER = /(?:^|[\s,;(—–-])(?:(?:with\s+(?:the\s+|a\s+)?)?(?:note|memo|message|msg)|not|notu|notum|açıklama|aciklama|mesaj|mesajı|mesaji)\s*[:：]\s*|(?:^|[\s,;(—–-])with\s+(?:the\s+|a\s+)?(?:note|memo)\s+(?=["“«„])/i;
const QUOTED_NOTE = /["“«„]([^"“”«»„]{1,400})["”»“]/;
/** English: a "for …" phrase that ends a request after its amount and recipient: "… on X for dinner". */
const FOR_TAIL = /\s(for\s+(?!(?:me|myself|you|him|her|them|us|it)\b)(?!(?:now|later|today|tomorrow|tonight)\s*[.!]*$)[^@\d]+?)\s*[.!]*$/i;
/** Turkish: an "… için" phrase that ends or starts a request: "… gönder, yemek için", "yemek için @bob'a …". */
const ICIN_TAIL = /(?:[,;]\s*|\s)((?:[^\s@\d,;.!?]+\s+){0,5}[^\s@\d,;.!?]+\s+i[çc]in)\s*[.!]*$/i;
const ICIN_HEAD = /^\s*((?:[^\s@\d,;.!?]+\s+){0,5}?[^\s@\d,;.!?]+\s+i[çc]in)\s*,?\s+(?=\S)/i;

/**
 * The note a request carries and the request without it. A note is what follows a marker ("note: thanks"), the
 * first quoted text, or a closing "for …" (English) or "… için" (Turkish) phrase after the request's own words; the
 * review shows it and the sender can change or clear it before signing, because it is written on chain for good.
 */
export function readNote(message: string): { text: string; note?: string; error?: string } {
  const finish = (text: string, raw: string) => {
    const check = checkPaymentNote(raw.replace(/^["“«„]|["”»“]$/g, ""));
    return check.ok ? { text, ...(check.note ? { note: check.note } : {}) } : { text, error: check.error };
  };
  const marker = NOTE_MARKER.exec(message);
  if (marker) return finish(message.slice(0, marker.index), message.slice(marker.index + marker[0].length));
  const quoted = QUOTED_NOTE.exec(message);
  if (quoted) return finish(`${message.slice(0, quoted.index)} ${message.slice(quoted.index + quoted[0].length)}`.trim(), quoted[1]);
  // A closing phrase is a note only after a request that already names an amount and someone to pay.
  const paying = (before: string) => /\d/.test(before) && /@\w|\bto\s+\w|(?:gönder|gonder|yolla|öde|ode)/i.test(before);
  for (const pattern of [FOR_TAIL, ICIN_TAIL]) {
    const tail = pattern.exec(message);
    if (tail && paying(message.slice(0, tail.index)) && !platformMentions(tail[1]).length) return finish(message.slice(0, tail.index), tail[1]);
  }
  const head = ICIN_HEAD.exec(message);
  if (head && paying(message.slice(head[0].length)) && !platformMentions(head[1]).length) return finish(message.slice(head[0].length), head[1]);
  return { text: message };
}

/** That amount to each person: "each", "apiece", "per person", "her birine", "kişi başı", "1'er", "beşer". */
const EACH_WORDS = [
  /\b(?:each|apiece|per\s+(?:person|head|recipient|account|wallet))\b/i,
  new RegExp(`(?:^|[^\\wçğıöşü])(?:her\\s+biri(?:si)?(?:ne|ye)?|her\\s+ki[şs]iye|ki[şs]i\\s+ba[şs][ıi](?:na)?|adam\\s+ba[şs][ıi]|ayr[ıi]\\s+ayr[ıi]|tanesine)${TURKISH_END}`, "i"),
  /\d['’](?:er|ar|şer|şar|ser|sar)(?![\wçğıöşü])/i,
  new RegExp(`(?:^|[^\\wçğıöşü])(?:birer|iki[şs]er|[üu][çc]er|d[öo]rder|be[şs]er|alt[ıi][şs]ar|yedi[şs]er|sekizer|dokuzar|onar|yirmi[şs]er|otuzar|k[ıi]rkar|elli[şs]er|altm[ıi][şs]ar|yetmi[şs]er|seksener|doksanar|y[üu]zer|biner)${TURKISH_END}`, "i"),
];
/** "To everyone": that amount to each, unless the request also says to split it. */
const EVERYONE_WORDS = new RegExp(`\\b(?:everyone|everybody|all\\s+of\\s+them|to\\s+all)\\b|(?:^|[^\\wçğıöşü])(?:herkese|hepsine|[üu][çc][üu]ne(?:\\s+de)?|ikisine(?:\\s+de)?)${TURKISH_END}`, "i");
/** Split the amount: "split", "divide", "share between", "bölüştür", "paylaştır", "dağıt", "aralarında". */
const SPLIT_VERBS = new RegExp(`\\b(?:split|divide[sd]?|dividing|between|among(?:st)?)\\b|\\bshare\\s+(?:[\\w$.,]+\\s+){0,4}?(?:between|among|with)\\b|(?:^|[^\\wçğıöşü])(?:payla[şs]t[ıi]r[\\wçğıöşü]*|payla[şs]|b[öo]l[üu][şs]t[üu]r[\\wçğıöşü]*|böl|bölün|aralar[ıi]nda|da[ğg][ıi]t[\\wçğıöşü]*)${TURKISH_END}`, "i");
/** The amount is everyone's together: "in total", "altogether", "equally", "toplam", "eşit". */
const SPLIT_TOTAL = new RegExp(`\\b(?:in\\s+total|total(?:\\s+of)?|altogether|combined|evenly|equally)\\b|(?:^|[^\\wçğıöşü])(?:toplam(?:da|[ıi])?|e[şs]it(?:\\s+olarak|\\s+[şs]ekilde)?)${TURKISH_END}`, "i");

/**
 * How one stated amount reaches several people, when the request says so: `each` gives everyone that amount, `split`
 * divides it between them. Words for both are a `conflict`; neither is no answer, and the desk asks.
 */
function amountModeOf(message: string): AmountMode | "conflict" | undefined {
  const text = wordsOf(message);
  const each = EACH_WORDS.some((pattern) => pattern.test(text));
  const split = SPLIT_VERBS.test(text) || SPLIT_TOTAL.test(text);
  if (each && split) return "conflict";
  if (split) return "split";
  return each || EVERYONE_WORDS.test(text) ? "each" : undefined;
}

/** "@a", "@a and @b", "@a, @b and @c". */
function joinList(items: string[]) {
  return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

type BatchPerson = { username: string; platform?: Platform };

/** Everyone's handles, with their platforms when one handle is named on two of them. */
function whoText(people: BatchPerson[]) {
  const twice = new Set(people.map(({ username }) => username)).size < people.length;
  return joinList(people.map(({ username, platform }) => twice && platform ? `@${username} on ${platformName(platform)}` : `@${username}`));
}

/** Everyone's handles with their platforms, written so they read back the same way: one platform once, at the end. */
function peopleText(people: BatchPerson[]) {
  const platforms = new Set(people.map(({ platform }) => platform));
  const [shared] = platforms;
  if (platforms.size === 1 && shared) return `${joinList(people.map(({ username }) => `@${username}`))} on ${platformName(shared)}`;
  if (!platforms.has(undefined)) return joinList(people.map(({ username, platform }) => `@${username} on ${platformName(platform!)}`));
  return joinList(people.map(({ username }) => `@${username}`));
}

/** A complete request for several people, as the desk writes it back; it reads the same way again. */
function batchText(input: { amount: string; symbol: string; people: BatchPerson[]; mode?: AmountMode; note?: string; amounts?: readonly string[] }) {
  if (input.mode === "listed" && input.amounts?.length === input.people.length) {
    // Each person with their own amount: "Send 10 USDC to @a and 5 USDC to @b on X".
    const platforms = new Set(input.people.map(({ platform }) => platform));
    const [shared] = platforms;
    const one = platforms.size === 1 ? shared : undefined;
    const parts = input.people.map(({ username, platform }, index) => `${input.amounts![index]} ${input.symbol} to @${username}${!one && platform ? ` on ${platformName(platform)}` : ""}`);
    return withNote(`Send ${joinList(parts)}${one ? ` on ${platformName(one)}` : ""}`, input.note);
  }
  const people = peopleText(input.people);
  const request = input.mode === "split"
    ? `Split ${input.amount} ${input.symbol} between ${people}`
    : `Send ${input.amount} ${input.symbol}${input.mode === "each" ? " each" : ""} to ${people}`;
  return withNote(request, input.note);
}

/** Every @handle in a request, in order, without a Turkish ending ("@bob'a" is bob). */
const HANDLE_AT = /(?<![\w.])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/g;
/** An amount in digits with the word written after it: "10 USDC", "$5", "0.5 sol", "2 NVDA", "10". */
const AMOUNT_AT = /(?<![\w.,@$'’])(\$\s*)?(\d+(?:[.,]\d+)*)(?![\w'’])(?:\s*(\$?[A-Za-z][A-Za-z0-9]{0,7})(?!\w))?/g;
/** Words that name US dollars, read as USDC. */
const DOLLAR_WORD = /^(?:usdc|usd|dollars?|dolar\w*|bucks)$/i;

/** One amount of a listed request: as written, its readings, the word after it and whether a "$" came first. */
type ListedAmount = { text: string; readings: string[]; word?: string; dollar: boolean };
type Listed = { handles: string[]; amounts: ListedAmount[] };

/**
 * Different amounts for different people, each written next to its person: every @handle has exactly one amount, and amounts and handles
 * alternate in one order ("10 USDC to @a, 5 USDC to @b", "@a 10, @b 5 USDC", "@a'ya 10 USDC, @b'ye 5 USDC").
 * Anything else is read as before: one amount, to each or split.
 */
function readListed(text: string): Listed | undefined {
  const handles = [...text.matchAll(HANDLE_AT)].map((match) => ({ at: match.index!, name: match[1].toLowerCase() }));
  if (handles.length < 2) return undefined;
  const amounts = [...text.matchAll(AMOUNT_AT)].map((match) => ({ at: match.index!, text: match[2], readings: numberReadings(match[2]), word: match[3], dollar: Boolean(match[1]) }));
  if (amounts.length !== handles.length) return undefined;
  const order = [...handles.map(({ at }) => ({ at, kind: "p" })), ...amounts.map(({ at }) => ({ at, kind: "a" }))]
    .sort((left, right) => left.at - right.at).map(({ kind }) => kind).join("");
  if (order !== "ap".repeat(handles.length) && order !== "pa".repeat(handles.length)) return undefined;
  return { handles: handles.map(({ name }) => name), amounts: amounts.map(({ text: written, readings, word, dollar }) => ({ text: written, readings, word, dollar })) };
}

/** Whether the people a request names are the listed handles, in the same order. */
function listedFor(listed: Listed | undefined, people: BatchPerson[]) {
  return listed && listed.handles.length === people.length && listed.handles.every((handle, index) => handle === people[index].username.toLowerCase()) ? listed : undefined;
}

/**
 * The one asset and the checked amounts of a listed request, or what to write instead: one asset for everyone, each
 * amount with one reading, no more decimals than the asset has, and none of them zero.
 */
function listedAmounts(listed: Listed, asset: { symbol: string; decimals: number }, people: BatchPerson[], example: (amounts: string[]) => string): string[] | Clarification {
  const amounts: string[] = [];
  for (const [index, amount] of listed.amounts.entries()) {
    if (amount.readings.length !== 1) {
      const [decimal, thousands] = amount.readings;
      return { message: amount.readings.length ? `“${amount.text}” for @${people[index].username} can mean ${thousands} or ${decimal} ${asset.symbol}. Write it without a thousands separator.` : `Write each amount as digits with one decimal point, for example: ${example(listed.amounts.map(() => "5"))}.` };
    }
    const [reading] = amount.readings;
    if (!/[1-9]/.test(reading)) return { message: `Enter an amount greater than zero for @${people[index].username}.` };
    if ((reading.split(".")[1]?.length ?? 0) > asset.decimals) return { message: `${asset.symbol} has ${asset.decimals} decimal places. Write at most ${asset.decimals} digits after the point for @${people[index].username}.` };
    amounts.push(reading);
  }
  return amounts;
}

/** A word that names an asset on any network or a currency HaPaPay does not send: SOL, TSLAx, NVDA, ETH, euros. */
function namesAnyAsset(word: string) {
  const plain = word.replace(/^\$/, "");
  return DOLLAR_WORD.test(plain) || OTHER_CURRENCY.test(plain) || Boolean(solanaAssetWord(plain, word.startsWith("$")))
    || (plain === plain.toUpperCase() && KNOWN_ROBINHOOD_SYMBOLS.has(plain.toUpperCase()));
}

/**
 * The asset words a listed request writes, read by `name`. More than one asset is refused, and so is an asset `name`
 * does not carry: "10 USDC to @a and 2 SOL to @b" never becomes 2 USDC for @b on a network without SOL.
 */
function listedSymbol<T>(listed: Listed, name: (word: string, dollar: boolean) => T | undefined, key: (asset: T) => string): T | Clarification | undefined {
  const found = new Map<string, T>();
  const elsewhere = new Set<string>();
  for (const amount of listed.amounts) {
    const asset = amount.dollar ? name("$", true) : amount.word ? name(amount.word, false) : undefined;
    if (asset) found.set(key(asset), asset);
    else if (amount.word && namesAnyAsset(amount.word)) elsewhere.add(amount.word.replace(/^\$/, "").toUpperCase());
  }
  if (found.size + elsewhere.size > 1) return { message: "Send one asset at a time." };
  if (elsewhere.size) return { message: `${[...elsewhere][0]} isn't sent here. Send one listed asset to everyone, for example USDC.` };
  return [...found.values()][0];
}

/** The listed token or USDC that a request for several people sends, with its one amount, or what it still needs. */
type BatchAsset = { symbol: string; decimals: number; amount: string; token?: StockTokenListing };

function batchAsset(text: string, people: BatchPerson[], desk: Desk): BatchAsset | Clarification {
  const tokens = ROBINHOOD_ASSET_ALLOWLISTS[desk.stockNetwork].tokens;
  const example = (amount: string, symbol = "USDC") => batchText({ amount, symbol, people, mode: "each" });
  const stock = readStockAsset(text, { network: desk.stockNetwork, tokens }, KNOWN_ROBINHOOD_SYMBOLS);
  if (stock.status === "invalid") return { message: stock.message };
  if (stock.status === "found") return { symbol: stock.symbol, decimals: stock.decimals, amount: stock.amount, token: stock.token };
  if (namesOtherAsset(text)) return { message: clarification(text, tokens, desk.stockTransfers).message };
  const stated = statedUsdcAmounts(text);
  if (stated.length > 1) return { message: `Write one amount for everyone, for example: ${example(stated[0].readings[0] ?? "5")}.` };
  const [usdc] = stated;
  if (!usdc) {
    const amount = [...statedAmounts(text)].find((value) => /[1-9]/.test(value));
    return { message: amount ? `Name the asset after the amount, for example: ${example(amount)}.` : `Add an amount, for example: ${example("5")}.` };
  }
  if (usdc.readings.length > 1) {
    const [decimal, thousands] = usdc.readings;
    return {
      message: `“${usdc.text}” can mean ${thousands} or ${decimal} USDC. Write the amount without a thousands separator, for example: ${example(thousands)}.`,
      suggestions: people.every(({ platform }) => platform) && amountModeOf(text) !== undefined && amountModeOf(text) !== "conflict"
        ? [thousands, decimal].map((amount) => batchText({ amount, symbol: "USDC", people, mode: amountModeOf(text) as AmountMode }))
        : undefined,
    };
  }
  if (!usdc.readings.length) return { message: `Write the amount as digits with one decimal point, for example: ${example("5")}.` };
  if (/\.\d{7,}$/.test(usdc.readings[0])) return { message: `USDC has six decimal places. Write at most six digits after the point, for example: ${example("5")}.` };
  if (!/[1-9]/.test(usdc.readings[0])) return { message: `Enter an amount greater than zero, for example: ${example("5")}.` };
  return { symbol: "USDC", decimals: 6, amount: usdc.readings[0] };
}

/** A listed request's asset on Arc or Robinhood Chain: USDC, or one listed Robinhood token, with each amount checked. */
/** The asset a word beside a listed amount names for the batch reader: USDC for dollars, or a Robinhood Chain symbol. */
function listedWordAsset(word: string, dollar: boolean, tokens: readonly StockTokenListing[]) {
  const plain = word.replace(/^\$/, "");
  if (dollar || DOLLAR_WORD.test(plain)) return "USDC";
  const upper = plain.toUpperCase();
  return tokens.some((token) => token.symbol === upper) || (KNOWN_ROBINHOOD_SYMBOLS.has(upper) && plain === upper) ? upper : undefined;
}

function listedBatchAsset(listed: Listed, people: BatchPerson[], desk: Desk): (BatchAsset & { amounts: string[] }) | Clarification {
  const tokens = ROBINHOOD_ASSET_ALLOWLISTS[desk.stockNetwork].tokens;
  const symbol = listedSymbol(listed, (word, dollar) => listedWordAsset(word, dollar, tokens), (found) => found);
  const example = (amounts: string[], name = typeof symbol === "string" ? symbol : "USDC") => batchText({ amount: amounts[0], symbol: name, people, mode: "listed", amounts });
  if (typeof symbol === "object") return symbol;
  if (!symbol) return { message: `Name the asset after each amount, for example: ${example(listed.amounts.map(({ readings }) => readings[0] ?? "5"))}.` };
  let asset: BatchAsset;
  if (symbol === "USDC") asset = { symbol: "USDC", decimals: 6, amount: "1" };
  else {
    const read = readStockAsset(`1 ${symbol}`, { network: desk.stockNetwork, tokens }, KNOWN_ROBINHOOD_SYMBOLS);
    if (read.status === "invalid") return { message: read.message };
    if (read.status !== "found") return { message: `${symbol} isn't on the verified token list.` };
    asset = { symbol: read.symbol, decimals: read.decimals, amount: "1", token: read.token };
  }
  const amounts = listedAmounts(listed, asset, people, (written) => example(written, asset.symbol));
  if (!Array.isArray(amounts)) return amounts;
  return { ...asset, amount: amounts[0], amounts };
}

/**
 * Several people in one request: one asset and one amount, every person's platform, whether the amount goes to each
 * or is split, and a verified wallet for everyone. Whatever the request does not say is asked, one thing at a time:
 * the platform first, then each or split. Nothing it does say is asked again.
 */
async function readBatch(message: string, text: string, note: string | undefined, found: { recipients: NamedRecipient[]; sourcePlatform?: Platform }, desk: Desk) {
  const people: BatchPerson[] = found.recipients.map(({ username, platform }) => ({ username, platform }));
  if (people.length > PAYMENT_BATCH_MAX_RECIPIENTS) {
    return clarify({ message: `One request pays at most ${PAYMENT_BATCH_MAX_RECIPIENTS} people. Split the list into smaller requests.` }, "local");
  }
  const listed = listedFor(readListed(text), people);
  const asset: BatchAsset & { amounts?: string[] } | Clarification = listed ? listedBatchAsset(listed, people, desk) : batchAsset(text, people, desk);
  if ("message" in asset) return clarify(asset, "local");
  const mode = listed ? "listed" as const : amountModeOf(text);
  const known = mode === "each" || mode === "split" || mode === "listed" ? mode : undefined;

  const missing = people.filter(({ platform }) => !platform);
  if (missing.length) {
    const verifiedOn = await Promise.all(missing.map(async ({ username }) =>
      (await Promise.all(PLATFORMS.map(async (platform) => await desk.resolveIdentity?.(platform, username) ? platform : undefined)))
        .filter((platform): platform is Platform => Boolean(platform))));
    const assign = (choose: (index: number) => Platform | undefined) => people.map((person) => person.platform
      ? person
      : { ...person, platform: choose(missing.indexOf(person)) });
    const shared = PLATFORMS.filter((platform) => verifiedOn.every((platforms) => platforms.includes(platform)));
    const options = shared.length
      ? shared.map((platform) => assign(() => platform))
      : verifiedOn.every((platforms) => platforms.length)
        ? [assign((index) => verifiedOn[index][0])]
        : found.sourcePlatform ? [assign(() => found.sourcePlatform)] : PLATFORM_OFFER_ORDER.map((platform) => assign(() => platform));
    const write = (group: BatchPerson[]) => batchText({ amount: asset.amount, symbol: asset.symbol, people: group, mode: known, note, amounts: asset.amounts });
    const offered = options.map(write);
    const who = joinList(missing.map(({ username }) => `@${username}`));
    return clarify({
      message: askPlatform(`Add which platform ${who} ${missing.length > 1 ? "are" : "is"} on, for example: ${offered[0] ?? write(assign(() => "x"))}.`, offered),
      suggestions: offered,
      question: { kind: "platform", request: message, choices: PLATFORMS.map((platform) => write(assign(() => platform))), offered },
    }, "local");
  }

  const symbol = asset.symbol;
  if (!known) {
    const each = batchText({ amount: asset.amount, symbol, people, mode: "each", note });
    const split = batchText({ amount: asset.amount, symbol, people, mode: "split", note });
    const total = formatUnits(parseUnits(asset.amount, asset.decimals) * BigInt(people.length), asset.decimals);
    const who = whoText(people);
    return clarify({
      message: `Should ${who} each get ${asset.amount} ${symbol} (${total} ${symbol} in total), or should ${asset.amount} ${symbol} be split between them?`,
      suggestions: [each, split],
      question: { kind: "amount_mode", request: message, choices: [each, split], offered: [each, split] },
    }, "local");
  }

  const units = parseUnits(asset.amount, asset.decimals);
  const shares = known === "listed" ? asset.amounts!.map((amount) => parseUnits(amount, asset.decimals))
    : known === "each" ? people.map(() => units) : splitUnits(units, people.length);
  if (shares.some((share) => share === 0n)) {
    return clarify({ message: `${asset.amount} ${symbol} is too small to split between ${people.length} people. Send a larger amount, or the same amount to each.` }, "local");
  }
  const sender = desk.sender ? getAddress(desk.sender) : undefined;
  const wallets = await Promise.all(people.map(({ platform, username }) => desk.resolveIdentity?.(platform!, username)));
  const own = people.filter((_, index) => wallets[index] && sender && getAddress(wallets[index]!) === sender);
  const unverified = people.filter((_, index) => !wallets[index]);
  if (own.length || unverified.length) return unpaidPeople({ message, people, wallets, shares, asset, own, unverified, note, desk, mode: known });

  const chain = STOCK_CHAINS[desk.stockNetwork];
  const total = shares.reduce((sum, share) => sum + share, 0n);
  const token = asset.token;
  const transferEnabled = token
    ? typeof desk.stockTransfers === "boolean" ? desk.stockTransfers : transferAvailabilityFor(desk.stockTransfers, token).enabled
    : undefined;
  const who = whoText(people);
  // Two handles of one person: their wallet is paid once for each, and the reply says so.
  const shared = [...new Set(wallets.map((wallet) => getAddress(wallet!)))]
    .map((wallet) => people.filter((_, index) => getAddress(wallets[index]!) === wallet))
    .filter((group) => group.length > 1);
  const same = shared.map((group) => ` ${whoText(group)} are the same wallet, so it is paid ${group.length === 2 ? "twice" : `${group.length} times`}.`).join("");
  const how = known === "listed"
    ? `Each gets the amount written for them, ${formatUnits(total, asset.decimals)} ${symbol} in total.`
    : known === "each"
      ? `Each gets ${asset.amount} ${symbol}, ${formatUnits(total, asset.decimals)} ${symbol} in total.`
      : `${asset.amount} ${symbol} is split between them.`;
  return {
    status: "batch_review" as const,
    message: transferEnabled === false
      ? `Found verified wallets for ${who}.${same} ${how} ${chain.name} ${token && isStockToken(token) ? "stock" : symbol} transfers are off on this server, so this stays a draft.`
      : `Found verified wallets for ${who}.${same} ${how} Check each payment below, then sign them in your wallet.`,
    batch: {
      asset: token
        ? { type: "stock-token" as const, kind: token.kind, symbol, name: token.name, address: token.address, chainId: chain.id, decimals: asset.decimals }
        : { type: "usdc" as const, symbol: "USDC" as const, decimals: 6 },
      mode: known,
      amount: known === "listed" ? formatUnits(total, asset.decimals) : asset.amount,
      payments: people.map(({ platform, username }, index) => ({
        recipient: { platform: platform!, username },
        resolvedAddress: wallets[index]!,
        amount: formatUnits(shares[index], asset.decimals),
        units: shares[index].toString(),
      })),
      totalAmount: formatUnits(total, asset.decimals),
      totalUnits: total.toString(),
      ...(found.sourcePlatform ? { sourcePlatform: found.sourcePlatform } : {}),
      ...(note ? { note } : {}),
    },
    network: token ? chain.name : desk.networkName,
    ...(token ? { stockNetwork: desk.stockNetwork, chainId: chain.id, transferEnabled } : {}),
    parser: "local" as const,
    // A batch has no single draft; these say so to every reader of the union.
    ...({} as { intent?: undefined; stockIntent?: undefined }),
  };
}

/**
 * Some people in the request cannot be paid directly: they have no verified account on that platform, or the handle
 * is the sender's own wallet. The reply names them and offers what can be sent: the batch without them, each with the
 * amount they would have had, and for someone without an account their own request, which can become a vault link.
 */
function unpaidPeople(input: {
  message: string;
  people: BatchPerson[];
  wallets: Array<`0x${string}` | undefined>;
  shares: bigint[];
  asset: BatchAsset;
  own: BatchPerson[];
  unverified: BatchPerson[];
  note?: string;
  desk: Desk;
  mode: AmountMode;
}) {
  const { people, shares, asset } = input;
  const payable = people.filter((person) => !input.own.includes(person) && !input.unverified.includes(person));
  const share = (person: BatchPerson) => formatUnits(shares[people.indexOf(person)], asset.decimals);
  const names = (group: BatchPerson[]) => joinList(group.map(({ username }) => `@${username}`));
  const byPlatform = PLATFORMS.map((platform) => input.unverified.filter((person) => person.platform === platform)).filter((group) => group.length);
  const lines = [
    ...byPlatform.map((group) => `${names(group)} ${group.length > 1 ? "have" : "has"} no verified ${platformLabel(group[0].platform!)} account${group.length > 1 ? "s" : ""} on HaPaPay.`),
    ...(input.own.length ? [`${names(input.own)} ${input.own.length > 1 ? "are" : "is"} your own wallet.`] : []),
  ];
  const rest = payable.length > 1
    ? input.mode === "listed"
      ? batchText({ amount: share(payable[0]), symbol: asset.symbol, people: payable, mode: "listed", amounts: payable.map(share), note: input.note })
      : input.mode === "each"
      ? batchText({ amount: asset.amount, symbol: asset.symbol, people: payable, mode: "each", note: input.note })
      : batchText({ amount: formatUnits(payable.reduce((sum, person) => sum + shares[people.indexOf(person)], 0n), asset.decimals), symbol: asset.symbol, people: payable, mode: "split", note: input.note })
    : payable.length === 1 ? withNote(requestText(share(payable[0]), asset.symbol, payable[0].username, payable[0].platform!), input.note) : undefined;
  // Someone without an account can still get their part in the vault, where this network and platform keep one.
  const vaulted = input.unverified.filter(({ platform }) => vaultHolds(input.desk, asset.token, platform!));
  const singles = vaulted.map((person) => requestText(share(person), asset.symbol, person.username, person.platform!));
  const offered = [...(rest ? [rest] : []), ...singles].slice(0, 3);
  const others = input.unverified.filter((person) => !vaulted.includes(person));
  const next = [
    rest ? `Pay ${names(payable)} now?` : "",
    vaulted.length ? `${names(vaulted)} can ${vaulted.length > 1 ? "each " : ""}get their part in the vault until they join, with a request of their own.` : "",
    others.length ? `Ask ${names(others)} to link ${others.length > 1 ? "their accounts" : "the account"} first.` : "",
  ].filter(Boolean);
  lines.push(...next);
  return clarify({
    message: lines.join(" "),
    suggestions: offered,
    question: { kind: "recipients", request: input.message, choices: offered, offered },
  }, "local");
}

/** Whether a vault link can hold this asset for an account on this platform that has not joined yet. */
function vaultHolds(desk: Desk, token: StockTokenListing | undefined, platform: Platform) {
  if (!isStockClaimPlatform(platform)) return false;
  if (!token) return desk.usdcClaims.enabled && (desk.usdcClaims.platforms?.includes(platform) ?? true);
  const claims = desk.stockClaims;
  const holds = isStockToken(token) ? claims.stockTokens !== false : claims.tokens !== false;
  return Boolean(claims.enabled && claims.escrow && holds && (claims.platforms?.includes(platform) ?? true));
}

const YES = /^(?:y(?:es|ep|eah)?|ok(?:ay)?|sure|evet|tamam|olur|ok\s+go|go\s+ahead)\b/i;
const ORDINALS = [
  /^(?:1|#1|one|first|the\s+first|ilk(?:i)?|birinci(?:si)?)(?![\w'’])/i,
  /^(?:2|#2|two|second|the\s+second|ikinci(?:si)?)(?![\w'’])/i,
  /^(?:3|#3|three|third|the\s+third|[üu][çc][üu]nc[üu](?:s[üu])?)(?![\w'’])/i,
];

/**
 * A short typed answer to the question asked about `request`: the server reads `request` again to know that question
 * and maps the answer onto one of its complete requests, which it then reads in full. An answer that writes its own
 * request (it tags someone) or that maps onto nothing is read as a new request instead.
 */
async function answerQuestion(answer: string, request: string, desk: Desk) {
  if (/(?<![\w.])@\w/.test(answer) || request.length > 500) return undefined;
  const asked = await readRequest(request, desk);
  const question = "question" in asked ? asked.question : undefined;
  if (!question) return undefined;
  const text = answer.trim();
  const position = ORDINALS.findIndex((pattern) => pattern.test(text));
  let choice: string | undefined;
  if (question.kind === "amount_mode") {
    const mode = amountModeOf(text);
    choice = mode === "each" ? question.choices[0] : mode === "split" ? question.choices[1] : undefined;
  } else if (question.kind === "platform") {
    const named = [...new Set(platformMentions(text).map(({ platform }) => platform))];
    if (named.length === 1) choice = question.choices[PLATFORMS.indexOf(named[0] as (typeof PLATFORMS)[number])];
  } else if (YES.test(text) && question.offered.length) {
    choice = question.offered[0];
  }
  choice ??= position >= 0 ? question.offered[position] : undefined;
  // A short reply that answers nothing asks the same question again; anything longer is a new request.
  if (!choice) return /\d/.test(text) || text.split(/\s+/).length > 4 ? undefined : { ...asked, message: `I could not tell which one you meant. ${asked.message}` };
  const result = await readRequest(choice, desk);
  return { ...result, message: `Reading that as “${choice}”. ${result.message}` };
}

/**
 * What the desk knows about Solana for one request: the switches for USDC and USDG and for xStocks, whether the
 * Solana vault takes links, each recipient's Solana address, and the sender's own.
 */
export type SolanaChatDesk = {
  transfers: { enabled: boolean; reason?: string };
  stocks: { enabled: boolean; reason?: string };
  vault: { enabled: boolean; platforms?: readonly Platform[]; reason?: string };
  /** The Solana address the verified account behind a handle has added, if any. */
  addressOf(platform: Platform, username: string): Promise<string | undefined> | string | undefined;
  /** The session account's own Solana address, when it has added one. */
  senderAddress?: string;
};

type SolanaPerson = BatchPerson & { wallet?: `0x${string}`; address?: string };

/** The asset as a Solana review carries it, from the bundled list only. */
function solanaAssetView(asset: SolanaAssetListing) {
  return {
    symbol: asset.symbol,
    name: asset.name,
    kind: asset.kind,
    decimals: asset.decimals,
    ...(asset.mint ? { mint: asset.mint } : {}),
    ...(asset.program ? { program: asset.program } : {}),
    ...(asset.scaled ? { scaled: true } : {}),
  };
}

/** Where else the asset moves when a request does not say Solana: USDC on Arc, USDG and Stock Tokens on Robinhood Chain. */
function evmHome(asset: SolanaAssetListing): { network: Exclude<NetworkWord, "solana">; words: string } | undefined {
  if (asset.symbol === "USDC") return { network: "arc", words: "on Arc" };
  if (asset.symbol === "USDG" || (isSolanaStock(asset) && KNOWN_ROBINHOOD_SYMBOLS.has(asset.ticker.toUpperCase()))) return { network: "robinhood", words: "on Robinhood Chain" };
  return undefined;
}

type EvmHome = NonNullable<ReturnType<typeof evmHome>>;

/** How long the chat waits for the wallet's balances before it chooses without them. */
const HOLDINGS_WAIT_MS = 2_500;

/** A read that answers in time, or undefined: a slow or failing RPC never holds a reply up. */
async function inTime<T>(read: Promise<T>, ms: number): Promise<T | undefined> {
  let stop = () => undefined as void;
  const late = new Promise<undefined>((resolve) => {
    const timer = setTimeout(resolve, ms);
    stop = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([read.catch(() => undefined), late]);
  } finally {
    stop();
  }
}

/** A balance as a wallet shows it, in an asset's base units (digits beyond its decimals dropped), or undefined. */
function heldUnits(value: string | undefined, decimals: number) {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  return parseUnits(fraction ? `${whole}.${fraction.slice(0, decimals)}` : whole, decimals);
}

/** A balance for a reply: at most six decimals, cut rather than rounded up. */
function heldText(value: string) {
  const [whole, fraction = ""] = value.split(".");
  const cut = fraction.slice(0, 6).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

/** An amount and HaPaPay's 1% on top, the most a network's fee can add to it. */
const withFee = (units: bigint) => units + units / 100n;

/** The asset's symbol on its EVM home: USDC and USDG keep theirs, an xStock is its Robinhood Chain ticker. */
function homeSymbol(asset: SolanaAssetListing) {
  return asset.symbol === "USDC" || asset.symbol === "USDG" ? asset.symbol : asset.ticker.toUpperCase();
}

/**
 * What the signed-in sender's wallets hold of an asset on Solana and on its EVM home, read at once and each within
 * the wait, against what a payment of `total` (in the asset's Solana decimals) needs there with HaPaPay's 1% fee.
 * Undefined when either cannot be read, or the home does not list the asset.
 */
async function readHeld(desk: Desk, asset: SolanaAssetListing, home: EvmHome, total: bigint) {
  const holdings = desk.holdings;
  if (!holdings || !desk.sender) return undefined;
  const symbol = homeSymbol(asset);
  const token = home.network === "robinhood" ? ROBINHOOD_ASSET_ALLOWLISTS[desk.stockNetwork].tokens.find((entry) => entry.symbol === symbol) : undefined;
  if (home.network === "robinhood" && !token) return undefined;
  const wait = holdings.waitMs ?? HOLDINGS_WAIT_MS;
  const [onSolana, atHome] = await Promise.all([inTime(holdings.solana(asset), wait), inTime(holdings.evm(home.network, symbol), wait)]);
  const homeDecimals = token ? tokenDecimals(token) : 6;
  const solanaUnits = heldUnits(onSolana, asset.decimals);
  const homeUnits = heldUnits(atHome, homeDecimals);
  if (solanaUnits === undefined || homeUnits === undefined) return undefined;
  const homeName = home.network === "arc" ? desk.networkName : STOCK_CHAINS[desk.stockNetwork].name;
  return {
    homeName,
    here: `${heldText(onSolana!)} ${asset.symbol} on Solana`,
    there: `${heldText(atHome!)} ${symbol} on ${homeName}`,
    enoughOnSolana: solanaUnits >= withFee(total),
    enoughAtHome: homeUnits >= withFee(parseUnits(formatUnits(total, asset.decimals), homeDecimals)),
  };
}

/**
 * The sender's wallets choose the network. An asset that moves on Solana and on an EVM network, written without a
 * network, goes where the sender can pay it. Robinhood Chain is the main network: USDG and the Stock Tokens it lists go there (`moved`, with the reply's explanation when
 * there is one) whenever it can pay these people now, and stay on Solana only when the sender's Solana wallet holds
 * enough for the payment and its 1% fee and the Robinhood Chain wallet does not (`note` says so). USDC, which Robinhood
 * Chain does not carry, stays on Solana unless Solana holds less and Arc holds enough. When neither holds enough, the
 * reply says what each holds. Only the sender's own addresses are read, and only to choose: preparation checks the
 * balance again.
 */
async function heldAtHome(desk: Desk, asset: SolanaAssetListing, home: EvmHome | undefined, total: bigint, people: readonly SolanaPerson[]): Promise<{ moved?: string; note?: string } | undefined> {
  if (!home) return undefined;
  const symbol = homeSymbol(asset);
  const token = home.network === "robinhood" ? ROBINHOOD_ASSET_ALLOWLISTS[desk.stockNetwork].tokens.find((entry) => entry.symbol === symbol) : undefined;
  if (home.network === "robinhood" && !token) return undefined;
  // Only a network that can pay everyone now: a joined person by a transfer, anyone else by its vault.
  const transfers = !token ? true : typeof desk.stockTransfers === "boolean" ? desk.stockTransfers : transferAvailabilityFor(desk.stockTransfers, token).enabled;
  if (!people.every((person) => person.wallet ? transfers : vaultHolds(desk, token, person.platform!))) return undefined;
  const held = desk.holdings && desk.sender ? await readHeld(desk, asset, home, total) : undefined;
  if (home.network === "robinhood") {
    if (held?.enoughOnSolana && !held.enoughAtHome) return { note: `It goes on Solana: your wallet holds ${held.here} and ${held.there}. Write “on Robinhood Chain” to send ${symbol} there instead.` };
    if (held && !held.enoughOnSolana && !held.enoughAtHome) return { moved: `Your wallet holds ${held.there} and ${held.here}, less than this payment and its 1% fee on either.` };
    return { moved: "" };
  }
  if (!held || held.enoughOnSolana) return undefined;
  if (held.enoughAtHome) return { moved: `It goes on ${held.homeName}: your wallet holds ${held.there} and ${held.here}. Write “on Solana” to send ${asset.symbol} there instead.` };
  return { note: `Your wallet holds ${held.here} and ${held.there}, less than this payment and its 1% fee on either.` };
}

/**
 * A request that goes on its EVM home because someone it pays has no Solana address, while the wallet holds enough
 * only on Solana: the review says so, since preparing it there will find the balance short.
 */
async function heldOnlyOnSolana(desk: Desk, asset: SolanaAssetListing, home: EvmHome | undefined, total: bigint, without: readonly BatchPerson[]) {
  if (!home || !desk.holdings || !desk.sender || !without.length) return undefined;
  const held = await readHeld(desk, asset, home, total);
  if (!held || held.enoughAtHome || !held.enoughOnSolana) return undefined;
  const who = joinList(without.map(({ username }) => `@${username}`));
  return `Your wallet holds ${held.here} but ${held.there}; ${who} ${without.length > 1 ? "have" : "has"} not added a Solana address yet, so this goes on ${held.homeName}.`;
}

/** A request for Arc or Robinhood Chain, checked against what that network carries, without its network words. */
function evmRequest(network: Exclude<NetworkWord, "solana">, text: string, stockNetwork: StockNetworkId) {
  const solana = readSolanaAmount(text);
  if (solana.status === "invalid" && solana.message === NO_SOL_SENDING) return clarify({ message: NO_SOL_SENDING }, "local");
  if (solana.status === "found" && namesSolanaOnly(solana.asset, solana.written)) {
    return clarify({ message: `${solana.asset.symbol} moves only on Solana. Write the request without “${network === "arc" ? "on Arc" : "on Robinhood Chain"}”.` }, "local");
  }
  const usdc = NAMES_USDC.test(text) && !namesOtherAsset(text);
  // Any token Robinhood Chain lists counts, two-letter tickers ("2 BB") and cashtags ("2 $NU") included. An amount
  // written for each person is judged as the batch reader reads it: USDC ("$10 to @bob and 5 to @dave, apt 3F") goes
  // ahead, and a Robinhood Chain token ("2 nvda to @bob and 3 nvda to @dave") does not.
  const tokens = ROBINHOOD_ASSET_ALLOWLISTS[stockNetwork].tokens;
  const people = parseSocialRecipients(text, TICKER_WORDS).recipients.map(({ username, platform }) => ({ username, platform }));
  const perPerson = people.length > 1 ? listedFor(readListed(text), people) : undefined;
  const perPersonAsset = perPerson && listedSymbol(perPerson, (word, dollar) => listedWordAsset(word, dollar, tokens), (found) => found);
  const listed = () => typeof perPersonAsset === "string"
    ? perPersonAsset !== "USDC"
    : readStockAsset(text, { network: stockNetwork, tokens }, KNOWN_ROBINHOOD_SYMBOLS).status === "found";
  if (network === "arc" && ((!usdc && (namedToken(text) || (solana.status === "found" && solana.asset.symbol !== "USDC"))) || listed())) {
    return clarify({ message: "Arc carries USDC here. Send Stock Tokens and USDG on Robinhood Chain, or USDC, USDG and xStocks on Solana." }, "local");
  }
  if (network === "robinhood" && usdc) return clarify({ message: "Robinhood Chain carries Stock Tokens and USDG here. USDC goes on Solana or Arc." }, "local");
  return { evmText: text };
}

/** Whether the Solana vault can hold this asset for an account on this platform that has not joined yet. */
/** Every listed token (USDC, USDG, xStocks) can wait in the Solana vault for an account or a name (`vault-lock.ts`). */
function solanaVaultHolds(solana: SolanaChatDesk, asset: SolanaAssetListing, platform: Platform) {
  return vaultHoldsAsset(asset) && isStockClaimPlatform(platform) && solana.vault.enabled && (solana.vault.platforms?.includes(platform) ?? true);
}

/**
 * Reads a request for Solana: xStocks written with their "x" (TSLAx) move only there, and a request that says "on
 * Solana" goes there. USDC without a network goes there when the sender and everyone it pays have Solana addresses;
 * USDG and a ticker Robinhood Chain lists go on Robinhood Chain, the main network, unless the sender's wallet holds
 * them only on Solana (`heldAtHome`). Anything else comes back as `evmText`, without its network words, for Robinhood
 * Chain and Arc. Nothing that is missing is guessed; one thing is asked at a time.
 */
async function readSolanaRequest(message: string, text: string, note: string | undefined, desk: Desk, solana: SolanaChatDesk) {
  const words = readNetworkWords(text);
  if (words.networks.length > 1) return clarify({ message: "Name one network for a request: Solana, Arc or Robinhood Chain." }, "local");
  const [named] = words.networks;
  const body = words.text;
  if (named === "arc" || named === "robinhood") return evmRequest(named, body, desk.stockNetwork);
  // An amount of SOL anywhere in the request, even beside another asset, is answered first: it is not sent.
  const sol = readSolanaAmount(body);
  if (sol.status === "invalid" && sol.message === NO_SOL_SENDING) return clarify({ message: NO_SOL_SENDING }, "local");
  const explicit = named === "solana";
  // An amount written for each person is read before the one-amount reader, which refuses two amounts.
  const listedHere = readListed(body);
  const listedAsset = listedHere
    ? listedSymbol(listedHere, (word, dollar) => dollar ? solanaAssetWord("USDC") : solanaAssetWord(word.replace(/^\$/, ""), word.startsWith("$")), (asset) => asset.symbol)
    : undefined;
  if (listedAsset && "message" in listedAsset) {
    if (!explicit) return { evmText: body };
    return clarify(listedAsset, "local");
  }
  const listedWritten = listedHere && listedAsset
    ? listedHere.amounts.find((entry) => entry.dollar || (entry.word && solanaAssetWord(entry.word.replace(/^\$/, ""), entry.word.startsWith("$"))?.symbol === listedAsset.symbol))
    : undefined;
  const reading: SolanaAmountReading = listedHere && listedAsset
    ? { status: "found", asset: listedAsset, amount: listedHere.amounts[0].readings[0] ?? "1", written: listedWritten?.dollar ? "$" : listedWritten?.word?.replace(/^\$/, "") ?? listedAsset.symbol }
    : readSolanaAmount(body);
  if (reading.status === "none") {
    // SOL named without an amount is answered here: HaPaPay does not send it.
    if (/(?<![\w@.$-])(?:sol|solana)(?![\w])/i.test(body)) return clarify({ message: NO_SOL_SENDING }, "local");
    // An xStock written with its "x" moves only on Solana, so its missing or unreadable amount is asked here, in it
    // (audit, 2026-10-06: the other networks' reader answered with a USDC example).
    const onlyHere = [...body.matchAll(/(?<![\w@.$-])\$?([A-Za-z][A-Za-z0-9]{1,7})(?![\w])/g)]
      .map(([, word]) => ({ word, asset: solanaAssetWord(word) }))
      .find(({ word, asset }) => asset && namesSolanaOnly(asset, word))?.asset;
    if (onlyHere) return clarify({ message: `Write the amount of ${onlyHere.symbol} to send, for example: Send 1 ${onlyHere.symbol} to @toly on X.` }, "local");
    if (!explicit) return { evmText: body };
    // A Stock Token Solana does not list moves only on Robinhood Chain, as an xStock moves only on Solana.
    const robinhoodOnly = readStockAsset(body, { network: desk.stockNetwork, tokens: ROBINHOOD_ASSET_ALLOWLISTS[desk.stockNetwork].tokens }, KNOWN_ROBINHOOD_SYMBOLS);
    if (robinhoodOnly.status === "found" && !solanaAssetWord(robinhoodOnly.symbol)) {
      return clarify({ message: `${robinhoodOnly.symbol} moves only on Robinhood Chain. Write the request without “on Solana”.` }, "local");
    }
    return clarify({ message: "Add the amount and the asset to send, for example: Send 25 USDC to @toly on X." }, "local");
  }
  if (reading.status === "invalid") {
    const solanaOnly = reading.asset ? namesSolanaOnly(reading.asset, reading.asset.symbol) && reading.asset.symbol === "SOL" : false;
    if (!explicit && !solanaOnly && !reading.final) return { evmText: body };
    return clarify({ message: reading.message }, "local");
  }
  const { asset, amount, written } = reading;
  const only = namesSolanaOnly(asset, written);
  const plain = explicit || only;
  const home = evmHome(asset);
  const live = isSolanaStock(asset) ? solana.stocks : solana.transfers;
  if (!live.enabled) {
    if (!plain && home) return { evmText: body };
    return clarify({ message: live.reason ?? "Solana transfers are not available on this server right now." }, "local");
  }
  // A signed-in sender without a Solana address is paid out on the asset's other network unless they asked for Solana.
  if (!plain && home && desk.sender && !solana.senderAddress) return { evmText: body };
  const symbol = asset.symbol;
  /** "on Solana" is kept in every request written back when only the words, not the asset, put it there. */
  const suffix = explicit && !only ? " on Solana" : "";
  const single = (username: string, platform: Platform, value = amount) => withNote(`${requestText(value, symbol, username, platform)}${suffix}`, note);
  const group = (people: BatchPerson[], mode: AmountMode | undefined, value = amount, amounts?: readonly string[]) => withNote(`${batchText({ amount: value, symbol, people, mode, amounts })}${suffix}`, note);

  const found = parseSocialRecipients(body, [...TICKER_WORDS, symbol.toLowerCase(), asset.ticker.toLowerCase(), "sol"]);
  const people: BatchPerson[] = found.recipients.map(({ username, platform }) => ({ username, platform }));
  if (!people.length) {
    if (desk.parseWithAi) {
      try {
        const reading = paymentReadingSchema.parse(await desk.parseWithAi(body));
        const rewrite = groundedRewrite(body, reading, undefined, { symbol: symbol.toUpperCase() === symbol ? symbol : symbol.toUpperCase(), amount });
        if (rewrite) return { status: "rewrite" as const, rewrite: withNote(`${rewrite}${suffix}`, note ?? groundedNote(body, reading)) };
      } catch {
        // Without the AI reader the rules' question stands.
      }
    }
    if (!plain) return { evmText: body };
    return clarify({ message: `Add who receives it and where, for example: Send ${amount} ${symbol} to @toly on X${suffix}.` }, "local");
  }
  if (people.length > PAYMENT_BATCH_MAX_RECIPIENTS) {
    return clarify({ message: `One request pays at most ${PAYMENT_BATCH_MAX_RECIPIENTS} people. Split the list into smaller requests.` }, "local");
  }
  if (people.length === 1 && SPLIT_VERBS.test(wordsOf(body))) {
    return clarify({ message: `Name everyone who shares it, for example: Split ${amount} ${symbol} between @${people[0].username} and @carol on X${suffix}.` }, "local");
  }

  // A listed request names each of its people next to an amount; one that names others too is asked to.
  const listed = listedHere && listedAsset ? listedFor(listedHere, people) : undefined;
  if (listedHere && listedAsset && !listed) {
    return clarify({ message: `Write an amount next to each person, for example: Send ${listedHere.amounts[0].readings[0] ?? "10"} ${symbol} to @${people[0].username} and ${listedHere.amounts[1]?.readings[0] ?? "5"} ${symbol} to @${people[1]?.username ?? "carol"} on X${suffix}.` }, "local");
  }
  const listedWrittenAmounts = listed?.amounts.map((entry) => entry.readings[0] ?? entry.text);

  const missing = people.filter(({ platform }) => !platform);
  if (missing.length) {
    // Without "on Solana" the question is asked the usual way; the answer is read again from the top.
    if (!plain) return { evmText: body };
    const mode = listed ? "listed" as const : amountModeOf(body);
    const known = mode === "each" || mode === "split" || mode === "listed" ? mode : undefined;
    const assign = (platform: Platform) => people.map((person) => person.platform ? person : { ...person, platform });
    const write = (platform: Platform) => people.length === 1 ? single(people[0].username, platform) : group(assign(platform), known, amount, listedWrittenAmounts);
    const verified = (await Promise.all(PLATFORMS.map(async (platform) => (await Promise.all(missing.map(({ username }) => desk.resolveIdentity?.(platform, username)))).every(Boolean) ? platform : undefined)))
      .filter((platform): platform is Platform => Boolean(platform));
    const offered = (verified.length ? verified : found.sourcePlatform ? [found.sourcePlatform] : PLATFORM_OFFER_ORDER).map(write);
    const who = joinList(missing.map(({ username }) => `@${username}`));
    return clarify({
      message: askPlatform(`Add which platform ${who} ${missing.length > 1 ? "are" : "is"} on, for example: ${offered[0] ?? write("x")}.`, offered),
      suggestions: offered,
      question: { kind: "platform", request: message, choices: PLATFORMS.map(write), offered },
    }, "local");
  }

  const mode = listed ? "listed" as const : people.length > 1 ? amountModeOf(body) : "each";
  const known = mode === "each" || mode === "split" || mode === "listed" ? mode : undefined;
  if (!known) {
    const each = group(people, "each");
    const split = group(people, "split");
    const total = formatUnits(parseUnits(amount, asset.decimals) * BigInt(people.length), asset.decimals);
    return clarify({
      message: `Should ${whoText(people)} each get ${amount} ${symbol} (${total} ${symbol} in total), or should ${amount} ${symbol} be split between them?`,
      suggestions: [each, split],
      question: { kind: "amount_mode", request: message, choices: [each, split], offered: [each, split] },
    }, "local");
  }
  const listedValues = listed ? listedAmounts(listed, asset, people, (written) => group(people, "listed", written[0], written)) : undefined;
  if (listedValues && !Array.isArray(listedValues)) return clarify(listedValues, "local");
  const units = parseUnits(amount, asset.decimals);
  const shares = listedValues ? listedValues.map((value) => parseUnits(value, asset.decimals))
    : known === "each" ? people.map(() => units) : splitUnits(units, people.length);
  if (shares.some((share) => share === 0n)) {
    return clarify({ message: `${amount} ${symbol} is too small to split between ${people.length} people. Send a larger amount, or the same amount to each.` }, "local");
  }
  const total = shares.reduce((sum, value) => sum + value, 0n);

  const sender = desk.sender ? getAddress(desk.sender) : undefined;
  const resolved: SolanaPerson[] = await Promise.all(people.map(async (person) => {
    const wallet = await desk.resolveIdentity?.(person.platform!, person.username);
    const address = wallet ? await solana.addressOf(person.platform!, person.username) : undefined;
    return { ...person, wallet, address };
  }));
  const own = resolved.filter(({ wallet }) => wallet && sender && getAddress(wallet) === sender);
  const unverified = resolved.filter(({ wallet }) => !wallet);
  const withoutAddress = resolved.filter((person) => person.wallet && !person.address && !own.includes(person));
  // A person here is either one of `people` or its resolved copy (audit, 2026-10-06: a copy's index was -1, and a
  // request to several people that someone could not take answered with a server error).
  const share = (person: BatchPerson) => {
    const at = resolved.indexOf(person as SolanaPerson);
    return formatUnits(shares[at >= 0 ? at : people.indexOf(person)], asset.decimals);
  };
  const other = home ? ` or ${home.words}` : "";

  if (people.length === 1) {
    const [person] = resolved;
    const { username, platform } = person as { username: string; platform: Platform };
    if (own.length) return clarify({ message: `@${username} on ${platformLabel(platform)} is your own wallet. Write who receives it.` }, "local");
    if (person.address) {
      const held = plain ? undefined : await heldAtHome(desk, asset, home, total, resolved);
      if (held?.moved !== undefined) return { evmText: body, because: held.moved || undefined };
      return {
        status: "solana_review" as const,
        message: `Found @${username}'s Solana address. Check the payment below, then sign it in your wallet.${!plain && home && !(home.network === "robinhood" && held?.note) ? ` It goes on Solana; write “${home.words}” to send it there instead.` : ""}${held?.note ? ` ${held.note}` : ""}`,
        solana: {
          asset: solanaAssetView(asset),
          mode: "single" as const,
          amount,
          payments: [{ recipient: { platform, username }, address: person.address, amount }],
          totalAmount: amount,
          ...(found.sourcePlatform ? { sourcePlatform: found.sourcePlatform } : {}),
          ...(note ? { note } : {}),
        },
        network: "Solana",
        parser: "local" as const,
        ...({} as { intent?: undefined; stockIntent?: undefined; batch?: undefined }),
      };
    }
    if (person.wallet) {
      if (!plain && home) return { evmText: body, because: await heldOnlyOnSolana(desk, asset, home, total, [person]) };
      return clarify({
        message: `@${username} has not added a Solana address to HaPaPay yet, so nothing can reach them on Solana. Ask them to sign in to HaPaPay again, which adds one${home ? `, or send it ${home.words}` : ""}.`,
        ...(home ? { suggestions: [withNote(`${requestText(amount, symbol === "USDC" || symbol === "USDG" ? symbol : asset.ticker, username, platform)} ${home.words}`, note)] } : {}),
      }, "local");
    }
    if (solanaVaultHolds(solana, asset, platform)) {
      const offer = await vaultOffer(desk, platform, username);
      if ("refusal" in offer) return clarify({ message: offer.refusal }, "local");
      const held = plain ? undefined : await heldAtHome(desk, asset, home, total, resolved);
      if (held?.moved !== undefined) return { evmText: body, because: held.moved || undefined };
      return {
        status: "solana_claim_review" as const,
        message: `${vaultReviewText(username, platform, symbol, "Solana vault", offer.lock)}${note ? VAULT_NOTE : ""}${held?.note ? ` ${held.note}` : ""}`,
        vaultLock: offer.lock,
        solana: {
          asset: solanaAssetView(asset),
          recipient: { platform, username },
          amount,
          expiryHours: STOCK_CLAIM_WINDOW_HOURS.default,
          ...(found.sourcePlatform ? { sourcePlatform: found.sourcePlatform } : {}),
        },
        network: "Solana",
        parser: "local" as const,
        ...({} as { intent?: undefined; stockIntent?: undefined; batch?: undefined }),
      };
    }
    if (!plain && home) return { evmText: body };
    return clarify({ message: notJoinedYet(platform, username, vaultClosed("Solana", solana.vault, platform, username)) }, "local");
  }

  if (own.length || unverified.length || withoutAddress.length) {
    if (!plain && home) return { evmText: body, because: own.length || unverified.length ? undefined : await heldOnlyOnSolana(desk, asset, home, total, withoutAddress) };
    const names = (people: BatchPerson[]) => joinList(people.map(({ username }) => `@${username}`));
    const payable = resolved.filter((person) => person.address && !own.includes(person));
    const rest = payable.length > 1
      ? known === "listed" ? group(payable, "listed", share(payable[0]), payable.map(share))
        : known === "each" ? group(payable, "each") : group(payable, "split", formatUnits(payable.reduce((sum, person) => sum + shares[resolved.indexOf(person)], 0n), asset.decimals))
      : payable.length === 1 ? single(payable[0].username, payable[0].platform!, share(payable[0])) : undefined;
    const vaulted = unverified.filter(({ platform }) => solanaVaultHolds(solana, asset, platform!));
    const offered = [...(rest ? [rest] : []), ...vaulted.map((person) => single(person.username, person.platform!, share(person)))].slice(0, 3);
    const lines = [
      ...(unverified.length ? [`${names(unverified)} ${unverified.length > 1 ? "have" : "has"} no verified account on HaPaPay.`] : []),
      ...(withoutAddress.length ? [`${names(withoutAddress)} ${withoutAddress.length > 1 ? "have" : "has"} not added a Solana address yet${home ? `; you can pay them ${home.words} instead` : ""}.`] : []),
      ...(own.length ? [`${names(own)} ${own.length > 1 ? "are" : "is"} your own wallet.`] : []),
      ...(rest ? [`Pay ${names(payable)} now?`] : []),
      ...(vaulted.length ? [`${names(vaulted)} can ${vaulted.length > 1 ? "each " : ""}get their part in the Solana vault until they join, with a request of their own.`] : []),
    ];
    return clarify({ message: lines.join(" "), suggestions: offered, question: { kind: "recipients", request: message, choices: offered, offered } }, "local");
  }

  const held = plain ? undefined : await heldAtHome(desk, asset, home, total, resolved);
  if (held?.moved !== undefined) return { evmText: body, because: held.moved || undefined };
  const how = known === "listed"
    ? `Each gets the amount written for them, ${formatUnits(total, asset.decimals)} ${symbol} in total.`
    : known === "each"
      ? `Each gets ${amount} ${symbol}, ${formatUnits(total, asset.decimals)} ${symbol} in total.`
      : `${amount} ${symbol} is split between them.`;
  return {
    status: "solana_review" as const,
    message: `Found Solana addresses for ${whoText(people)}. ${how} It goes in one Solana transaction; check it below, then sign it in your wallet.${held?.note ? ` ${held.note}` : ""}`,
    solana: {
      asset: solanaAssetView(asset),
      mode: known,
      amount: known === "listed" ? formatUnits(total, asset.decimals) : amount,
      payments: resolved.map((person, index) => ({ recipient: { platform: person.platform!, username: person.username }, address: person.address!, amount: formatUnits(shares[index], asset.decimals) })),
      totalAmount: formatUnits(total, asset.decimals),
      ...(found.sourcePlatform ? { sourcePlatform: found.sourcePlatform } : {}),
      ...(note ? { note } : {}),
    },
    network: "Solana",
    parser: "local" as const,
    ...({} as { intent?: undefined; stockIntent?: undefined; batch?: undefined }),
  };
}
