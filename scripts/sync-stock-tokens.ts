import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { STOCK_CHAINS, STOCK_TOKEN_DECIMALS, type StockNetworkId, type StockTokenKind, type StockTokenListing } from "../src/domain/stock-tokens";
import { readStockTokenRegistry, STOCK_TOKEN_REGISTRY_URL, stockTokenDisplayName, stockTokenKind } from "../server/stock-token-registry";

/**
 * Robinhood Chain Testnet faucet Stock Tokens. The official registry lists mainnet deployments only. These five
 * were created together at testnet blocks 275–280 by one factory behind a single Stock beacon, are the tokens the
 * Robinhood Chain faucet hands out, and the Arbitrum Foundation's Robinhood Chain guide builds on TSLA, AMZN and
 * NFLX from this set. Every sync re-reads them from chain 46630; nothing here is trusted without that read.
 */
export const ROBINHOOD_TESTNET_FAUCET_TOKENS: ReadonlyArray<{ symbol: string; address: Address }> = [
  { symbol: "TSLA", address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" },
  { symbol: "AMZN", address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02" },
  { symbol: "PLTR", address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0" },
  { symbol: "NFLX", address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93" },
  { symbol: "AMD", address: "0x71178BAc73cBeb415514eB542a8995b82669778d" },
];
/** The UpgradeableBeacon every faucet Stock Token proxies through (EIP-1967 beacon slot). */
export const ROBINHOOD_TESTNET_STOCK_BEACON: Address = "0x1dF3cA0fD30ED5eeb09eB01938f4E9c5196E6Ca5";
const BEACON_SLOT: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

export const stockTokenAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "uid", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;
type StockTokenRead = (typeof stockTokenAbi)[number]["name"];

export type StockTokenChainReader = {
  getChainId(): Promise<number>;
  getBytecode(input: { address: Address }): Promise<Hex | undefined>;
  getStorageAt(input: { address: Address; slot: Hex }): Promise<Hex | undefined>;
  readContract(input: { address: Address; abi: typeof stockTokenAbi; functionName: StockTokenRead }): Promise<unknown>;
};

export type StockTokenCandidate = { symbol: string; address: Address; name?: string; kind?: StockTokenKind; uid?: Hex };

/**
 * Keeps only candidates whose live contract has bytecode, 18 decimals, the expected ticker, and the Stock Token
 * interface (a non-zero `uid()` and a positive ERC-8056 `uiMultiplier()`). A registry uid must match on chain;
 * a pinned beacon must match the proxy's EIP-1967 beacon slot.
 */
export async function verifyStockTokensOnChain(
  candidates: readonly StockTokenCandidate[],
  reader: StockTokenChainReader,
  options: { chainId: number; beacon?: Address; concurrency?: number; attempts?: number; retryDelayMs?: number },
) {
  const { chainId, beacon, concurrency = 6, attempts = 3, retryDelayMs = 750 } = options;
  const reported = await reader.getChainId();
  if (reported !== chainId) throw new Error(`Expected chain ${chainId}, RPC reported ${reported}.`);
  const verified: StockTokenListing[] = [];
  const rejected: Array<{ symbol: string; reason: string }> = [];
  for (let index = 0; index < candidates.length; index += concurrency) {
    await Promise.all(candidates.slice(index, index + concurrency).map(async (candidate) => {
      const read = (functionName: StockTokenRead) => reader.readContract({ address: candidate.address, abi: stockTokenAbi, functionName });
      let reads: [Hex | undefined, unknown, unknown, unknown, unknown, unknown, Hex | undefined] | undefined;
      let failure = "unverified";
      for (let attempt = 1; attempt <= attempts && !reads; attempt++) {
        try {
          // Transport failures are retried; a successful read that disagrees is never retried away.
          reads = [
            await reader.getBytecode({ address: candidate.address }),
            await read("decimals"),
            await read("symbol"),
            await read("name"),
            await read("uid"),
            await read("uiMultiplier"),
            beacon ? await reader.getStorageAt({ address: candidate.address, slot: BEACON_SLOT }) : undefined,
          ];
        } catch (error) {
          failure = `RPC read failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`;
          if (attempt < attempts) await new Promise((done) => setTimeout(done, retryDelayMs * attempt));
        }
      }
      const [code, decimals, symbol, name, uid, multiplier, beaconSlot] = reads ?? [];
      const liveBeacon = beaconSlot && BigInt(beaconSlot) ? getAddress(`0x${beaconSlot.slice(-40)}`) : undefined;
      const reason = !reads ? failure
        : !code || code === "0x" ? "no bytecode"
          : Number(decimals) !== STOCK_TOKEN_DECIMALS ? `decimals() returned ${String(decimals)}`
            : symbol !== candidate.symbol ? `symbol() returned ${String(symbol)}`
              : typeof uid !== "string" || !BigInt(uid) ? "uid() is missing"
                : candidate.uid && uid.toLowerCase() !== candidate.uid.toLowerCase() ? `uid() ${uid} does not match the registry`
                  : typeof multiplier !== "bigint" || multiplier <= 0n ? "uiMultiplier() is missing"
                    : beacon && liveBeacon !== getAddress(beacon) ? `beacon ${liveBeacon ?? "missing"} is not the pinned Stock beacon`
                      : undefined;
      if (reason) {
        rejected.push({ symbol: candidate.symbol, reason });
        return;
      }
      const displayName = candidate.name ?? stockTokenDisplayName(String(name));
      verified.push({ symbol: candidate.symbol, name: displayName, kind: candidate.kind ?? stockTokenKind(displayName), address: getAddress(candidate.address) });
    }));
  }
  verified.sort((left, right) => left.symbol.localeCompare(right.symbol));
  return { verified, rejected };
}

function rows(tokens: readonly StockTokenListing[]) {
  return tokens.map((token) => `  { symbol: ${JSON.stringify(token.symbol)}, name: ${JSON.stringify(token.name)}, kind: ${JSON.stringify(token.kind)}, address: ${JSON.stringify(token.address)} },`).join("\n");
}

export function renderStockTokenModule(
  mainnet: { tokens: readonly StockTokenListing[]; verifiedOn: string },
  testnet: { tokens: readonly StockTokenListing[]; verifiedOn: string },
) {
  const main = STOCK_CHAINS["robinhood-mainnet"];
  const test = STOCK_CHAINS["robinhood-testnet"];
  return `// Generated by \`npm run sync:stock-tokens\`. Do not edit by hand.
import type { StockNetworkId, StockTokenListing } from "./stock-tokens.js";

// ${main.name} (chain ID ${main.id}): the official registry (${STOCK_TOKEN_REGISTRY_URL}), read back on ${mainnet.verifiedOn}:
// bytecode, decimals() == ${STOCK_TOKEN_DECIMALS}, symbol() == ticker, uid() == registry id, and a positive uiMultiplier().
export const ROBINHOOD_STOCK_TOKENS_VERIFIED_ON = ${JSON.stringify(mainnet.verifiedOn)};

export const ROBINHOOD_STOCK_TOKENS: readonly StockTokenListing[] = [
${rows(mainnet.tokens)}
];

// ${test.name} (chain ID ${test.id}): the faucet test tokens pinned in scripts/sync-stock-tokens.ts, read back on
// ${testnet.verifiedOn}: bytecode, decimals() == ${STOCK_TOKEN_DECIMALS}, symbol(), uid(), uiMultiplier(), and the pinned Stock beacon.
// Test tokens have no monetary value.
export const ROBINHOOD_TESTNET_STOCK_TOKENS_VERIFIED_ON = ${JSON.stringify(testnet.verifiedOn)};

export const ROBINHOOD_TESTNET_STOCK_TOKENS: readonly StockTokenListing[] = [
${rows(testnet.tokens)}
];

export const STOCK_TOKEN_ALLOWLISTS: Record<StockNetworkId, { tokens: readonly StockTokenListing[]; verifiedOn: string }> = {
  "robinhood-mainnet": { tokens: ROBINHOOD_STOCK_TOKENS, verifiedOn: ROBINHOOD_STOCK_TOKENS_VERIFIED_ON },
  "robinhood-testnet": { tokens: ROBINHOOD_TESTNET_STOCK_TOKENS, verifiedOn: ROBINHOOD_TESTNET_STOCK_TOKENS_VERIFIED_ON },
};
`;
}

function chainReader(network: StockNetworkId): StockTokenChainReader {
  const client = createPublicClient({ transport: http(STOCK_CHAINS[network].rpcUrl, { retryCount: 2 }) });
  return {
    getChainId: () => client.getChainId(),
    getBytecode: (input) => client.getBytecode(input),
    getStorageAt: (input) => client.getStorageAt(input),
    readContract: (input) => client.readContract(input as never),
  };
}

async function main() {
  const response = await fetch(STOCK_TOKEN_REGISTRY_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Registry request failed (${response.status}).`);
  const registry = readStockTokenRegistry(await response.json());
  const today = new Date().toISOString().slice(0, 10);
  const mainnet = await verifyStockTokensOnChain(registry, chainReader("robinhood-mainnet"), { chainId: STOCK_CHAINS["robinhood-mainnet"].id });
  const testnet = await verifyStockTokensOnChain(ROBINHOOD_TESTNET_FAUCET_TOKENS, chainReader("robinhood-testnet"), {
    chainId: STOCK_CHAINS["robinhood-testnet"].id,
    beacon: ROBINHOOD_TESTNET_STOCK_BEACON,
  });
  if (mainnet.verified.length === 0 || testnet.verified.length === 0) {
    throw new Error("A network had no verified stock token; the allowlist was not changed.");
  }
  const target = fileURLToPath(new URL("../src/domain/robinhood-stock-tokens.ts", import.meta.url));
  await writeFile(target, renderStockTokenModule({ tokens: mainnet.verified, verifiedOn: today }, { tokens: testnet.verified, verifiedOn: today }));
  console.log(`Verified ${mainnet.verified.length} of ${registry.length} registry stock tokens on ${STOCK_CHAINS["robinhood-mainnet"].name}.`);
  console.log(`Verified ${testnet.verified.length} of ${ROBINHOOD_TESTNET_FAUCET_TOKENS.length} faucet test tokens on ${STOCK_CHAINS["robinhood-testnet"].name}.`);
  for (const { symbol, reason } of [...mainnet.rejected, ...testnet.rejected]) console.log(`Rejected ${symbol}: ${reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
