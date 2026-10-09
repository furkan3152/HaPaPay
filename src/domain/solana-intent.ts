import { DISTRIBUTIVE_ENDING, EVERYDAY_TICKER_WORDS, numberReadings, numberWordsBefore } from "./payment-intent.js";
import { solanaAssetByName } from "./solana-stocks.js";
import { NO_SOL_SENDING, SOLANA_SOL, type SolanaAssetListing } from "./solana-assets.js";

/** A network a request can name: Robinhood Chain (the main network), Solana, or Arc. */
export type NetworkWord = "solana" | "arc" | "robinhood";

const TURKISH_CASE = "(?:['’]?(?:da|de|ta|te|dan|den|tan|ten|daki|deki|taki|teki|ya|ye|ın|in|nın|nin))?";
const NETWORK_TAIL = "(?:\\s+(?:network|chain|mainnet|blockchain|a[gğ][ıi](?:nda|ndan|na)?|zinciri(?:nde|nden)?|[üu]zerinden|[üu]st[üu]nden))?";
const NETWORK_NAMES: Record<NetworkWord, string> = {
  solana: "solana",
  arc: "arc(?:\\s+mainnet)?",
  robinhood: "robinhood(?:\\s+chain)?",
};
const LEAD = "(?:\\b(?:on|via|over|using|through|in|with)\\s+(?:the\\s+)?)?";

/**
 * The networks a request names ("on Solana", "via Arc", "Robinhood Chain", "Solana'da", "solana ağında", "Arc
 * üzerinden"), and the request with those words taken out, so a network is never read as a handle or a platform.
 * "SOL" is an asset, not a network word; a handle such as @solana is left alone.
 */
export function readNetworkWords(text: string): { networks: NetworkWord[]; text: string } {
  const networks: NetworkWord[] = [];
  let rest = text;
  for (const network of Object.keys(NETWORK_NAMES) as NetworkWord[]) {
    // "1 solana" is an amount of SOL, not the network (audit, 2026-10-06).
    const afterAmount = network === "solana" ? "(?<!\\d[\\d.,]*\\s*)" : "";
    const pattern = new RegExp(`${LEAD}(?<![@\\w.$-])${afterAmount}${NETWORK_NAMES[network]}${TURKISH_CASE}${NETWORK_TAIL}(?![\\wçğıöşü'’-])`, "gi");
    if (pattern.test(rest)) {
      networks.push(network);
      rest = rest.replace(pattern, " ");
    }
  }
  return { networks, text: rest.replace(/\s{2,}/g, " ").trim() };
}

/** Letters beyond ASCII ("ş", "ü"): a word that runs on into one is a Turkish word, never a ticker ("bahşiş" is not BAH). */
const LETTER = "\\u00C0-\\u024F";
/** Words that mean US dollars, read as USDC: "dollars", "dolar", "usd", "bucks". */
const DOLLAR_WORDS = /^(?:dollars?|dolar(?:[ıi]|l[ıi]k)?|usd|bucks)$/i;
/** Lowercase words that only read as an asset when written in capitals or as a cashtag. */
const PLAIN_WORDS = new Set(["a", "an", "at", "be", "go", "hi", "i", "in", "is", "it", "me", "my", "no", "of", "ok", "on", "or", "so", "to", "up", "us", "we", "x", "tl", "ve", "ile", "bir", "her"]);
export type SolanaAmountReading =
  | { status: "none" }
  /** `final`: the request itself is wrong on any network, so no other network's reader is asked. */
  | { status: "invalid"; message: string; amounts?: string[]; asset?: SolanaAssetListing; final?: boolean }
  | { status: "found"; asset: SolanaAssetListing; amount: string; written: string };

/**
 * The Solana asset a written word names, or undefined: USDC, USDG, an xStock (TSLAx) or its ticker (TSLA), or SOL, which
 * is read only so that a request for it is told HaPaPay does not send it.
 */
export function solanaAssetWord(word: string, cashtag = false) {
  return assetOf(word, cashtag);
}

function assetOf(word: string, cashtag: boolean) {
  if (DOLLAR_WORDS.test(word)) return solanaAssetByName("USDC");
  // "1 solana" is one SOL; the network word only names Solana elsewhere (audit, 2026-10-06).
  if (/^(?:solana|sol)$/i.test(word)) return SOLANA_SOL;
  const asset = solanaAssetByName(word);
  if (!asset) return undefined;
  const lower = word.toLowerCase();
  const written = cashtag || word === asset.symbol || word === asset.ticker || word === word.toUpperCase()
    || ["sol", "usdc", "usdg"].includes(lower) || (lower.length >= 3 && !PLAIN_WORDS.has(lower) && !EVERYDAY_TICKER_WORDS.has(lower));
  return written ? asset : undefined;
}

/** "-5 USDC" or "−5": a sign right before the digits, which no payment can carry. */
const NEGATIVE = /(?:^|[\s(:])[-−–]\d/;
/** A dollar value of another asset: "$100 of TSLA", "$5 worth of SOL", "5 dollars worth of NVDA", "10 usd in sol". */
const DOLLARS_OF = /(?:\$\s*\d[\d.,]*|\d[\d.,]*\s*(?:\$|dollars?|usd|bucks|dolar(?!l[ıi]k)))\s+(?:worth\s+(?:of\s+)?|of\s+|in\s+)\$?([A-Za-z][A-Za-z0-9]{0,7})(?![\w])|\d[\d.,]*\s*(?:dolarl[ıi]k|\$['’]?l[ıi]k)\s+\$?([A-Za-z][A-Za-z0-9]{0,7})(?![\w])/i;
/** One asset joined to another: "5 usdc and usdg", "0.5 SOL and NVDA", "2 TSLA ve USDC". */
const AND_ANOTHER = /(?<![\w@.$-])\$?([A-Za-z][A-Za-z0-9]{0,7})\s+(?:and|&|plus|ve|ile|with)\s+(?:some\s+)?\$?([A-Za-z][A-Za-z0-9]{0,7})(?![\w@])/gi;

/**
 * The amount and the listed Solana asset a request states: "0.5 SOL", "25 USDC", "$25", "2 TSLAx", "2 TSLA", "five
 * sol". One asset and one amount; anything else says what to write instead. An amount with more decimals than the
 * asset has, or none above zero, is refused here.
 */
export function readSolanaAmount(text: string): SolanaAmountReading {
  // A dollar value of another asset is not an amount of it: the request writes the amount in that asset (audit,
  // 2026-10-06: "$100 of TSLA" became a 100 USDC payment).
  const dollarsOf = DOLLARS_OF.exec(text);
  const valuedWord = dollarsOf ? dollarsOf[1] ?? dollarsOf[2] : undefined;
  const valued = valuedWord ? assetOf(valuedWord, false) : undefined;
  if (valued?.symbol === "SOL") return { status: "invalid", message: NO_SOL_SENDING, final: true };
  if (valued && valued.kind !== "cash") {
    // Named as the request wrote it: "TSLA" stays TSLA, "TSLAx" TSLAx.
    const name = valuedWord!.toUpperCase() === valued.ticker.toUpperCase() ? valued.ticker : valued.symbol;
    return { status: "invalid", message: `Write the amount in ${name}, not dollars, for example: Send 2 ${name} to @toly on X.`, asset: valued, final: true };
  }
  if (NEGATIVE.test(text)) return { status: "invalid", message: "Enter an amount greater than zero.", final: true };
  const found = new Map<string, { asset: SolanaAssetListing; text: string; readings: string[]; written: string }>();
  const add = (asset: SolanaAssetListing, amountText: string, readings: string[], written: string) => {
    found.set(`${asset.symbol}:${amountText}`, { asset, text: amountText, readings, written });
  };
  for (const match of text.matchAll(new RegExp(`(?<![\\w.,])(\\d+(?:[.,]\\d+)*)${DISTRIBUTIVE_ENDING}?\\s*(\\$?)([A-Za-z][A-Za-z0-9]{0,7})(?![\\w${LETTER}])`, "g"))) {
    const [, amountText, cashtag, word] = match;
    const asset = assetOf(word, cashtag === "$");
    if (asset) add(asset, amountText, numberReadings(amountText), word);
  }
  // "$25" and "25$" are both dollars, read as USDC (audit, 2026-10-06: "25$" went to Arc).
  for (const match of text.matchAll(/(?<![\w.,])\$\s*(\d+(?:[.,]\d+)*)|(?<![\w.,$])(\d+(?:[.,]\d+)*)\s*\$(?![\w$])/g)) {
    const amountText = match[1] ?? match[2];
    add(solanaAssetByName("USDC")!, amountText, numberReadings(amountText), "$");
  }
  if (!found.size) {
    for (const match of text.matchAll(new RegExp(`(?<![\\w.@${LETTER}-])(\\$?)([A-Za-z][A-Za-z0-9]{1,7})(?![\\w${LETTER}])`, "g"))) {
      const asset = assetOf(match[2], match[1] === "$");
      if (!asset) continue;
      const value = numberWordsBefore(text, match.index);
      if (value !== undefined) add(asset, String(value), [String(value)], match[2]);
    }
  }
  if (!found.size) return { status: "none" };
  // HaPaPay does not send SOL; a request that writes an amount of it is told so.
  if ([...found.values()].some(({ asset }) => asset.symbol === "SOL")) return { status: "invalid", message: NO_SOL_SENDING, final: true };
  const assets = new Set([...found.values()].map(({ asset }) => asset.symbol));
  if (assets.size > 1) {
    // SOL and an xStock written with its "x" are read on no other network, so this answer is the last (audit,
    // 2026-10-06: "1 SOL and $20" was answered that SOL is not on the token list).
    const final = [...found.values()].some(({ asset, written }) => namesSolanaOnly(asset, written));
    return { status: "invalid", message: "Send one asset at a time.", ...(final ? { final } : {}) };
  }
  // Another asset joined to this one without an amount of its own is a second asset, never dropped (audit,
  // 2026-10-06: "0.5 SOL and NVDA" drafted the SOL alone).
  for (const match of text.matchAll(AND_ANOTHER)) {
    const [left, right] = [assetOf(match[1], false), assetOf(match[2], false)];
    if (left && right && left.symbol !== right.symbol && (assets.has(left.symbol) || assets.has(right.symbol))) return { status: "invalid", message: "Send one asset at a time.", final: true };
  }
  const entries = [...found.values()];
  const [first] = entries;
  if (entries.length > 1) return { status: "invalid", message: `Write one amount of ${first.asset.symbol}.`, asset: first.asset };
  if (first.readings.length > 1) {
    const [decimal, thousands] = first.readings;
    return { status: "invalid", message: `“${first.text}” can mean ${thousands} or ${decimal} ${first.asset.symbol}. Write the amount without a thousands separator.`, amounts: [thousands, decimal], asset: first.asset };
  }
  const amount = first.readings[0];
  if (!amount) return { status: "invalid", message: `Write the amount as digits with one decimal point, for example: 5 ${first.asset.symbol}.`, asset: first.asset };
  if (!/[1-9]/.test(amount)) return { status: "invalid", message: "Enter an amount greater than zero.", asset: first.asset };
  if ((amount.split(".")[1]?.length ?? 0) > first.asset.decimals) {
    return { status: "invalid", message: `${first.asset.symbol} has ${first.asset.decimals} decimal places. Write at most ${first.asset.decimals} digits after the point.`, asset: first.asset };
  }
  return { status: "found", asset: first.asset, amount, written: first.written };
}

/** Whether a word names an xStock the way only Solana lists it (with its "x"), so the request is plainly on Solana. */
export function namesSolanaOnly(asset: SolanaAssetListing, written: string) {
  return asset.symbol === "SOL" || (asset.symbol !== asset.ticker && written.toUpperCase() === asset.symbol.toUpperCase());
}
