import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SOLANA_MAINNET } from "../src/domain/solana-chains";
import { SOLANA_TOKEN_PROGRAM_ADDRESSES, XSTOCK_DECIMALS } from "../src/domain/solana-assets";

/**
 * xStocks (Backed Assets) publishes every token and its deployments at this endpoint, a page of 100 at a time.
 * https://docs.xstocks.fi/apis/openapi documents it as public and unauthenticated.
 */
export const XSTOCKS_ASSETS_URL = "https://api.xstocks.fi/api/v2/public/assets";

export type XStockCandidate = { symbol: string; ticker: string; name: string; kind: "stock" | "etf"; mint: string };

const pageSchema = z.object({
  nodes: z.array(z.object({
    name: z.string(),
    symbol: z.string(),
    underlyingSymbol: z.string(),
    underlying: z.object({ exchange: z.object({ country: z.string().nullable().optional() }).nullable().optional() }).nullable().optional(),
    deployments: z.array(z.object({ network: z.string(), address: z.string() })),
  }).passthrough()),
  page: z.object({ hasNextPage: z.boolean() }).passthrough(),
});

/**
 * The US listings on one page that have a Solana deployment. The display name drops the issuer's " xStock" suffix; a
 * name that says ETF, Fund or Trust is an ETF, everything else a stock (the API carries no type).
 */
export function readXStocksPage(input: unknown) {
  const page = pageSchema.parse(input);
  const candidates: XStockCandidate[] = [];
  for (const node of page.nodes) {
    if (node.underlying?.exchange?.country !== "US") continue;
    if (!/^[A-Za-z0-9.]{1,16}$/.test(node.symbol) || !/^[A-Z0-9.]{1,12}$/.test(node.underlyingSymbol)) continue;
    const solana = node.deployments.find(({ network }) => network === "Solana");
    if (!solana || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solana.address)) continue;
    const name = node.name.replace(/\s+xStock$/i, "").trim();
    candidates.push({ symbol: node.symbol, ticker: node.underlyingSymbol, name, kind: /\b(ETF|Fund|Trust)\b/.test(name) ? "etf" : "stock", mint: solana.address });
  }
  return { candidates, hasNextPage: page.page.hasNextPage };
}

/** A mint account as `getMultipleAccounts` returns it with `jsonParsed`: its owner, decimals and extensions. */
export type ParsedMint = { owner: string; decimals: number; extensions: Record<string, Record<string, unknown> | undefined> };
export type MintReader = (mints: readonly string[]) => Promise<Array<ParsedMint | null>>;

/**
 * Keeps a candidate only when its live mint is a Token-2022 mint with 8 decimals whose on-chain metadata names the
 * same symbol and mint, with no transfer hook program, accounts that start initialized, no transfer fee and the
 * scaled UI amount extension. Anything else would move differently from what the review shows, so it is left out.
 */
export async function verifyXStocksOnChain(candidates: readonly XStockCandidate[], readMints: MintReader, batch = 100) {
  const verified: XStockCandidate[] = [];
  const rejected: Array<{ symbol: string; reason: string }> = [];
  for (let index = 0; index < candidates.length; index += batch) {
    const slice = candidates.slice(index, index + batch);
    const mints = await readMints(slice.map(({ mint }) => mint));
    slice.forEach((candidate, position) => {
      const reason = mintProblem(candidate, mints[position]);
      if (reason) rejected.push({ symbol: candidate.symbol, reason });
      else verified.push(candidate);
    });
  }
  verified.sort((left, right) => left.ticker.localeCompare(right.ticker));
  return { verified, rejected };
}

function mintProblem(candidate: XStockCandidate, mint: ParsedMint | null) {
  if (!mint) return "no mint account";
  if (mint.owner !== SOLANA_TOKEN_PROGRAM_ADDRESSES["token-2022"]) return "not a Token-2022 mint";
  if (mint.decimals !== XSTOCK_DECIMALS) return `decimals ${mint.decimals}`;
  const metadata = mint.extensions.tokenMetadata;
  if (metadata?.symbol !== candidate.symbol || metadata?.mint !== candidate.mint) return "metadata does not name this symbol and mint";
  if (mint.extensions.transferHook?.programId) return "a transfer hook program is set";
  const state = mint.extensions.defaultAccountState?.accountState;
  if (state && state !== "initialized") return `new accounts start ${String(state)}`;
  const fee = mint.extensions.transferFeeConfig as { olderTransferFee?: { transferFeeBasisPoints?: number }; newerTransferFee?: { transferFeeBasisPoints?: number } } | undefined;
  if (fee && (fee.olderTransferFee?.transferFeeBasisPoints || fee.newerTransferFee?.transferFeeBasisPoints)) return "a transfer fee is set";
  if (mint.extensions.nonTransferable) return "not transferable";
  if (!mint.extensions.scaledUiAmountConfig) return "no scaled UI amount";
  return undefined;
}

export function renderSolanaStockModule(tokens: readonly XStockCandidate[], verifiedOn: string) {
  const rows = tokens.map((token) => `  [${JSON.stringify(token.symbol)}, ${JSON.stringify(token.ticker)}, ${JSON.stringify(token.name)}, ${JSON.stringify(token.mint)}, ${JSON.stringify(token.kind === "etf" ? "e" : "s")}],`).join("\n");
  return `// Generated by \`npm run sync:solana-stocks\`. Do not edit by hand.

// xStocks (Backed Assets) on ${SOLANA_MAINNET.name}: the official asset API (${XSTOCKS_ASSETS_URL}), US listings with a Solana
// deployment, read back from mainnet on ${verifiedOn}: a Token-2022 mint with ${XSTOCK_DECIMALS} decimals whose metadata names the same
// symbol and mint, no transfer hook program, accounts that start initialized, no transfer fee, and a scaled UI amount.
export const SOLANA_XSTOCKS_VERIFIED_ON = ${JSON.stringify(verifiedOn)};

/** [symbol, ticker, name, mint, kind]: kind "s" is a stock, "e" an ETF. */
export const SOLANA_XSTOCK_ROWS: ReadonlyArray<readonly [string, string, string, string, "s" | "e"]> = [
${rows}
];
`;
}

/** How many xStocks the list holds, in a module small enough for the home page to import. */
export function renderSolanaStockCount(count: number) {
  return `/** How many xStocks HaPaPay lists on Solana, written by scripts/sync-solana-stocks.ts with the list itself. */\nexport const SOLANA_XSTOCK_COUNT = ${count};\n`;
}

/** Reads mints through a JSON-RPC endpoint with `getMultipleAccounts` (jsonParsed), retrying a busy endpoint. */
export function rpcMintReader(url: string): MintReader {
  return async (mints) => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [mints, { encoding: "jsonParsed" }] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const body = await response.json() as { result?: { value: Array<{ owner: string; data: { parsed?: { info?: { decimals: number; extensions?: Array<{ extension: string; state?: Record<string, unknown> }> } } } } | null> } };
        if (body.result) {
          return body.result.value.map((account) => {
            const info = account?.data.parsed?.info;
            if (!account || !info) return null;
            return { owner: account.owner, decimals: info.decimals, extensions: Object.fromEntries((info.extensions ?? []).map(({ extension, state }) => [extension, state ?? {}])) };
          });
        }
      }
      if (attempt >= 5) throw new Error(`The Solana RPC did not return the mints (${response.status}).`);
      await new Promise((done) => setTimeout(done, 1_500 * attempt));
    }
  };
}

async function main() {
  const candidates: XStockCandidate[] = [];
  for (let page = 0; page < 100; page++) {
    const response = await fetch(`${XSTOCKS_ASSETS_URL}?page=${page}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`The xStocks asset list failed on page ${page} (${response.status}).`);
    const read = readXStocksPage(await response.json());
    candidates.push(...read.candidates);
    if (!read.hasNextPage) break;
  }
  const { verified, rejected } = await verifyXStocksOnChain(candidates, rpcMintReader(process.env.SOLANA_RPC_URL ?? SOLANA_MAINNET.rpcUrl));
  if (verified.length === 0) throw new Error("No xStock verified; the allowlist was not changed.");
  const target = fileURLToPath(new URL("../src/domain/solana-stock-tokens.ts", import.meta.url));
  await writeFile(target, renderSolanaStockModule(verified, new Date().toISOString().slice(0, 10)));
  await writeFile(fileURLToPath(new URL("../src/domain/solana-stock-count.ts", import.meta.url)), renderSolanaStockCount(verified.length));
  console.log(`Verified ${verified.length} of ${candidates.length} US xStocks on Solana.`);
  for (const { symbol, reason } of rejected) console.log(`Rejected ${symbol}: ${reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
