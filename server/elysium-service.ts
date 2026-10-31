import { createPublicClient, decodeEventLog, encodeFunctionData, fallback, getAddress, http, isAddress, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { ELYSA_PASS_ARTIFACT, ELYSA_PAY_ROUTER_ARTIFACT, ELYSA_TOKEN_ARTIFACT } from "../src/domain/elysium-artifacts.js";
import {
  ELYSIUM_BATCH_MAX, ELYSIUM_CHAINS, ELYSIUM_MAINNET, ELYSIUM_MAINNET_LAUNCH, ELYSIUM_NETWORK_IDS, elysiumFee, elysiumNoteBytes, formatHype, parseHype,
  type ElysiumBlock, type ElysiumContractKind, type ElysiumContracts, type ElysiumLiveStats, type ElysiumMarket, type ElysiumNetworkId, type ElysiumNetworkView, type ElysiumPaymentRecord,
} from "../src/domain/elysium.js";
import type { Platform } from "../src/domain/payment-intent.js";
import type { AdminSettingsRepository } from "./admin-service.js";

/** A refusal the desk or the admin panel can show as it is. */
export class ElysiumRequestError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503 = 400) { super(message); }
}

type NetworkSetting = { enabled: boolean; rpcUrl?: string; explorerUrl?: string };
type Environment = Partial<Record<"ELYSIUM_TESTNET_RPC_URL" | "ELYSIUM_MAINNET_RPC_URL", string | undefined>>;

const ARTIFACTS = { router: ELYSA_PAY_ROUTER_ARTIFACT, token: ELYSA_TOKEN_ARTIFACT, pass: ELYSA_PASS_ARTIFACT } as const;
const PAID_EVENT = parseAbiItem("event Paid(address indexed payer, address indexed recipient, address indexed token, uint256 amount, uint256 fee, bytes note)");
const OWNER_ABI = [parseAbiItem("function owner() view returns (address)")];
const TREASURY_ABI = [parseAbiItem("function treasury() view returns (address)")];
/** About what a router payment costs in gas on Elysium (call, two transfers, the event, the parent-chain posting). */
const PAYMENT_GAS = 60_000n;
/** How many recent blocks the block river keeps. */
const BLOCK_WINDOW = 36;
const cachedBlocks = (cached: { blocks: ElysiumBlock[] } | undefined) => cached?.blocks ?? [];
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
/** The perps the desk's market strip shows, HYPE first. */
const MARKET_COINS = ["HYPE", "BTC", "ETH", "SOL", "PURR", "FARTCOIN"] as const;

/**
 * Whether deployed runtime code is exactly the artifact's, outside the immutable ranges (the treasury, a cap), which
 * the constructor fills in. Anything else (a proxy, a different build, a lookalike) is refused.
 */
export function matchesRuntime(code: Hex | undefined, artifact: { runtime: string; immutables: ReadonlyArray<readonly [number, number]> }) {
  if (!code || code.length !== artifact.runtime.length) return false;
  const live = Buffer.from(code.slice(2), "hex");
  const expected = Buffer.from(artifact.runtime.slice(2), "hex");
  for (const [start, length] of artifact.immutables) {
    live.fill(0, start, start + length);
    expected.fill(0, start, start + length);
  }
  return live.equals(expected);
}

/** An https URL with no credentials, query or fragment; otherwise undefined. */
export function cleanHttpsUrl(input: string | undefined) {
  if (!input?.trim()) return undefined;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export type ElysiumServiceOptions = {
  settings: AdminSettingsRepository;
  resolve(platform: Platform, username: string): Promise<Address | undefined> | Address | undefined;
  environment?: Environment;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Tests hand in their own clients (an Anvil fork, a stub). */
  client?: (network: ElysiumNetworkId, rpcUrls: string[]) => Pick<PublicClient, "getChainId" | "getBlockNumber" | "getBlock" | "getGasPrice" | "getCode" | "readContract" | "getTransactionReceipt" | "getTransaction" | "estimateGas" | "getBalance">;
};

/**
 * ElysaPay on Elysium: which networks are open, the contracts an admin registered, live chain stats, Hyperliquid's
 * market data, and HYPE payments to verified handles through `ElysaPayRouter`. The server prepares the exact call,
 * the sender's wallet signs it, and a payment is recorded only from its `Paid` event read back from chain.
 */
export class ElysiumService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly clients = new Map<string, ReturnType<NonNullable<ElysiumServiceOptions["client"]>>>();
  private readonly statsCache = new Map<ElysiumNetworkId, { at: number; value: ElysiumLiveStats }>();
  private marketsCache?: { at: number; value: ElysiumMarket[] };
  private readonly blockCache = new Map<ElysiumNetworkId, { at: number; blocks: ElysiumBlock[]; pending?: Promise<ElysiumBlock[]> }>();

  constructor(private readonly options: ElysiumServiceOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  // ---- Networks ----

  private async setting(network: ElysiumNetworkId): Promise<NetworkSetting> {
    const stored = await this.options.settings.get<NetworkSetting>(`elysium.network.${network}`);
    // Testnet is open by default; mainnet waits for an admin.
    return stored?.value ?? { enabled: network === "elysium-testnet" };
  }

  async contracts(network: ElysiumNetworkId): Promise<ElysiumContracts> {
    return (await this.options.settings.get<ElysiumContracts>(`elysium.contracts.${network}`))?.value ?? {};
  }

  /** The public RPCs for a network: the admin's (mainnet) or the bundled ones, then fallbacks. */
  private async publicRpcUrls(network: ElysiumNetworkId) {
    const chain = ELYSIUM_CHAINS[network];
    const setting = await this.setting(network);
    const primary = network === "elysium-mainnet" ? cleanHttpsUrl(setting.rpcUrl) : chain.rpcUrl;
    return [primary, ...chain.fallbackRpcUrls].filter((url): url is string => Boolean(url));
  }

  /** What the server reads through: a provider's endpoint from the environment first (it may carry a key), then the public ones. */
  private async serverRpcUrls(network: ElysiumNetworkId) {
    const environment = this.options.environment ?? {};
    const provider = cleanHttpsUrl(network === "elysium-mainnet" ? environment.ELYSIUM_MAINNET_RPC_URL : environment.ELYSIUM_TESTNET_RPC_URL);
    return [...new Set([provider, ...await this.publicRpcUrls(network)].filter((url): url is string => Boolean(url)))];
  }

  private async client(network: ElysiumNetworkId) {
    const urls = await this.serverRpcUrls(network);
    if (!urls.length) throw new ElysiumRequestError(`${ELYSIUM_CHAINS[network].chainName} has no RPC set yet. An admin adds it in the admin panel once Kinetiq publishes it.`, 503);
    const key = `${network}|${urls.join(",")}`;
    let client = this.clients.get(key);
    if (!client) {
      client = this.options.client
        ? this.options.client(network, urls)
        : createPublicClient({ transport: fallback(urls.map((url) => http(url, { timeout: 8_000, retryCount: 1, batch: { batchSize: 40, wait: 8 } }))) });
      this.clients.set(key, client);
    }
    return client;
  }

  async view(network: ElysiumNetworkId): Promise<ElysiumNetworkView> {
    const chain = ELYSIUM_CHAINS[network];
    const setting = await this.setting(network);
    const rpcUrl = (await this.publicRpcUrls(network))[0];
    const explorerUrl = network === "elysium-mainnet" ? cleanHttpsUrl(setting.explorerUrl) : chain.explorerUrl;
    const contracts = await this.contracts(network);
    const reason = !setting.enabled
      ? network === "elysium-mainnet" ? "Elysium mainnet is not switched on yet. It opens after the public launch, once an admin adds the official RPC." : "Elysium Testnet is paused by an admin."
      : !rpcUrl ? "No RPC is set for this network yet."
        : !contracts.router ? "The ElysaPay router is not deployed on this network yet." : undefined;
    return {
      id: network,
      chainName: chain.chainName,
      environment: chain.environment,
      chainId: chain.chainId,
      chainIdHex: `0x${chain.chainId.toString(16)}`,
      rpcUrl: rpcUrl ?? null,
      explorerUrl: explorerUrl ?? null,
      explorerTxPath: chain.explorerTxPath,
      explorerAddressPath: chain.explorerAddressPath,
      faucetUrl: chain.faucetUrl ?? null,
      bridgeUrl: chain.bridgeUrl ?? null,
      parentChain: chain.parentChain,
      enabled: setting.enabled && Boolean(rpcUrl),
      ...(reason ? { reason } : {}),
      contracts,
      ...(network === "elysium-mainnet" ? { launch: ELYSIUM_MAINNET_LAUNCH } : {}),
    };
  }

  async views() {
    return Promise.all(ELYSIUM_NETWORK_IDS.map((network) => this.view(network)));
  }

  /** Block height, block time, gas price and what a payment costs now; cached for three seconds. */
  async stats(network: ElysiumNetworkId): Promise<ElysiumLiveStats> {
    const cached = this.statsCache.get(network);
    if (cached && Date.now() - cached.at < 3_000) return cached.value;
    const client = await this.client(network);
    const chainId = await client.getChainId();
    if (chainId !== ELYSIUM_CHAINS[network].chainId) throw new ElysiumRequestError(`The RPC answered chain ${chainId}, not ${ELYSIUM_CHAINS[network].chainId}.`, 503);
    const [latest, gasPrice] = await Promise.all([client.getBlock(), client.getGasPrice()]);
    const span = 200n;
    let blockTimeMs: number | null = null;
    if (latest.number !== null && latest.number > span) {
      const earlier = await client.getBlock({ blockNumber: latest.number - span }).catch(() => undefined);
      if (earlier) blockTimeMs = Math.max(1, Math.round(Number(latest.timestamp - earlier.timestamp) * 1000 / Number(span)));
    }
    const value: ElysiumLiveStats = {
      network,
      blockNumber: String(latest.number ?? 0n),
      blockTimeMs,
      gasPriceWei: gasPrice.toString(),
      paymentCostHype: formatHype(gasPrice * PAYMENT_GAS, 8),
      readAt: this.now().toISOString(),
    };
    this.statsCache.set(network, { at: Date.now(), value });
    return value;
  }

  /**
   * The newest blocks, newest first: what the desk's block river draws. Elysium makes a block about every 100 ms, so
   * the server keeps the last ones and reads only the blocks it has not seen, at most once a second and in one batched
   * request, however many people watch.
   */
  async blocks(network: ElysiumNetworkId, count = BLOCK_WINDOW): Promise<ElysiumBlock[]> {
    const cached = this.blockCache.get(network);
    if (cached && Date.now() - cached.at < 1_000) return cached.blocks.slice(0, count);
    if (cached?.pending) return (await cached.pending).slice(0, count);
    const read = (async () => {
      const client = await this.client(network);
      const latest = await client.getBlockNumber();
      const known = cached?.blocks ?? [];
      const newest = known[0] ? BigInt(known[0].number) : -1n;
      const from = latest - BigInt(BLOCK_WINDOW - 1) > newest ? latest - BigInt(BLOCK_WINDOW - 1) : newest + 1n;
      const numbers: bigint[] = [];
      for (let number = latest; number >= from && number >= 0n; number--) numbers.push(number);
      const fresh = await Promise.all(numbers.map((blockNumber) => client.getBlock({ blockNumber }).catch(() => undefined)));
      const blocks = [
        ...fresh.filter((block): block is NonNullable<typeof block> => Boolean(block)).map((block): ElysiumBlock => ({
          number: String(block.number),
          timestamp: Number(block.timestamp),
          txCount: block.transactions.length,
          gasUsed: block.gasUsed.toString(),
          baseFeeGwei: block.baseFeePerGas === null || block.baseFeePerGas === undefined ? null : Number(block.baseFeePerGas) / 1e9,
        })),
        ...known,
      ].slice(0, BLOCK_WINDOW);
      this.blockCache.set(network, { at: Date.now(), blocks });
      return blocks;
    })();
    this.blockCache.set(network, { at: cached?.at ?? 0, blocks: cachedBlocks(cached), pending: read });
    try {
      return (await read).slice(0, count);
    } catch (error) {
      this.blockCache.set(network, { at: 0, blocks: cachedBlocks(cached) });
      throw error;
    }
  }

  /** Hyperliquid perps (HYPE first): mid, 24h change, volume, open interest and funding; cached for fifteen seconds. */
  async markets(): Promise<ElysiumMarket[]> {
    if (this.marketsCache && Date.now() - this.marketsCache.at < 15_000) return this.marketsCache.value;
    const response = await this.fetcher(HYPERLIQUID_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new ElysiumRequestError("Hyperliquid's market data could not be read right now.", 503);
    const [meta, contexts] = await response.json() as [{ universe: Array<{ name: string }> }, Array<Record<string, string | null>>];
    const number = (value: unknown) => {
      const parsed = Number(value);
      return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null;
    };
    const markets: ElysiumMarket[] = [];
    for (const coin of MARKET_COINS) {
      const index = meta.universe.findIndex((asset) => asset.name === coin);
      const context = contexts[index];
      if (index < 0 || !context) continue;
      const mid = number(context.midPx) ?? number(context.markPx);
      if (mid === null) continue;
      const prevDay = number(context.prevDayPx);
      const openInterest = number(context.openInterest);
      markets.push({
        coin, mid, prevDay,
        change24h: prevDay ? (mid - prevDay) / prevDay : null,
        dayVolumeUsd: number(context.dayNtlVlm),
        openInterest: openInterest === null ? null : openInterest * mid,
        funding: number(context.funding),
      });
    }
    this.marketsCache = { at: Date.now(), value: markets };
    return markets;
  }

  // ---- Contracts ----

  /**
   * Checks a contract before it is registered: it is on the right chain, its code is exactly the ElysaPay build, and
   * an admin wallet controls it (the token and the pass) or receives its fees (the router's treasury is shown).
   */
  async inspectContract(network: ElysiumNetworkId, kind: ElysiumContractKind, input: string, admins: (address: Address) => boolean) {
    if (!isAddress(input, { strict: false })) throw new ElysiumRequestError("Enter the contract's address.");
    const address = getAddress(input);
    const client = await this.client(network);
    const chainId = await client.getChainId();
    if (chainId !== ELYSIUM_CHAINS[network].chainId) throw new ElysiumRequestError(`The RPC answered chain ${chainId}, not ${ELYSIUM_CHAINS[network].chainName}.`, 503);
    const code = await client.getCode({ address });
    if (!code || code === "0x") throw new ElysiumRequestError(`No contract is deployed at ${address} on ${ELYSIUM_CHAINS[network].chainName}.`);
    if (!matchesRuntime(code, ARTIFACTS[kind])) throw new ElysiumRequestError(`The code at ${address} is not the ${ARTIFACTS[kind].contractName} build ElysaPay ships, so it was not registered.`);
    if (kind === "router") {
      const treasury = await client.readContract({ address, abi: TREASURY_ABI, functionName: "treasury" });
      return { address, treasury: getAddress(treasury) };
    }
    const owner = getAddress(await client.readContract({ address, abi: OWNER_ABI, functionName: "owner" }));
    if (!admins(owner)) throw new ElysiumRequestError(`The ${ARTIFACTS[kind].contractName} at ${address} is owned by ${owner}, which is not an admin wallet.`);
    return { address, owner };
  }

  async setContract(network: ElysiumNetworkId, kind: ElysiumContractKind, address: Address | undefined, actor: string) {
    const current = await this.contracts(network);
    const next: ElysiumContracts = { ...current };
    if (address) next[kind] = getAddress(address);
    else delete next[kind];
    await this.options.settings.set(`elysium.contracts.${network}`, next, actor);
    return next;
  }

  /**
   * Switches a network on or off. Mainnet also takes its official RPC and explorer; switching it on needs an RPC that
   * answers chain 99901 now, so a wrong or testnet endpoint can never carry mainnet payments.
   */
  async setNetwork(network: ElysiumNetworkId, input: { enabled: boolean; rpcUrl?: string; explorerUrl?: string }, actor: string) {
    const current = await this.setting(network);
    const next: NetworkSetting = { ...current, enabled: input.enabled };
    if (network === "elysium-mainnet") {
      if (input.rpcUrl !== undefined) next.rpcUrl = cleanHttpsUrl(input.rpcUrl);
      if (input.explorerUrl !== undefined) next.explorerUrl = cleanHttpsUrl(input.explorerUrl);
      if (input.rpcUrl?.trim() && !next.rpcUrl) throw new ElysiumRequestError("The RPC must be an https URL without credentials or a fragment.");
      if (input.explorerUrl?.trim() && !next.explorerUrl) throw new ElysiumRequestError("The explorer must be an https URL.");
      if (next.rpcUrl && /testnet/i.test(next.rpcUrl)) throw new ElysiumRequestError("A testnet RPC cannot be used for Elysium mainnet.");
      if (next.enabled) {
        if (!next.rpcUrl) throw new ElysiumRequestError("Add Elysium mainnet's official RPC before switching it on.");
        const probe = this.options.client
          ? this.options.client(network, [next.rpcUrl])
          : createPublicClient({ transport: http(next.rpcUrl, { timeout: 8_000, retryCount: 1 }) });
        const chainId = await probe.getChainId().catch(() => undefined);
        if (chainId !== ELYSIUM_MAINNET.chainId) throw new ElysiumRequestError(chainId === undefined ? "The mainnet RPC did not answer, so mainnet stays off." : `The RPC answered chain ${chainId}, not Elysium mainnet (${ELYSIUM_MAINNET.chainId}). Mainnet stays off.`);
      }
    }
    await this.options.settings.set(`elysium.network.${network}`, next, actor);
    this.statsCache.delete(network);
    return this.view(network);
  }

  // ---- Payments ----

  private async openNetwork(network: ElysiumNetworkId) {
    const view = await this.view(network);
    if (!view.enabled || !view.contracts.router) throw new ElysiumRequestError(view.reason ?? `${view.chainName} is not open for payments.`, 503);
    return { view, router: getAddress(view.contracts.router) };
  }

  /**
   * One HYPE payment to a verified handle: the exact router call, its value (amount plus the 1% fee) and the gas the
   * chain estimates for it from the sender. A handle without a verified wallet is refused; nothing is guessed.
   */
  async preparePayment(input: { network: ElysiumNetworkId; sender: Address; platform: Platform; username: string; amount: string; note?: string }) {
    const { view, router } = await this.openNetwork(input.network);
    const amount = parseHype(input.amount);
    if (!amount) throw new ElysiumRequestError("Write the amount in HYPE, for example 0.5.");
    const note = elysiumNoteBytes(input.note ?? "");
    if (!note) throw new ElysiumRequestError("The note can be at most 160 bytes.");
    const username = input.username.trim().replace(/^@/, "").toLowerCase();
    const recipient = await this.options.resolve(input.platform, username);
    if (!recipient) throw new ElysiumRequestError(`@${username} has not verified a wallet on ElysaPay yet, so nothing was prepared.`, 404);
    if (getAddress(recipient) === getAddress(input.sender)) throw new ElysiumRequestError("That handle is linked to your own wallet.");
    const fee = elysiumFee(amount);
    const value = amount + fee;
    const data = encodeFunctionData({ abi: ELYSA_PAY_ROUTER_ARTIFACT.abi, functionName: "payNative", args: [getAddress(recipient), amount, note] });
    const client = await this.client(input.network);
    const balance = await client.getBalance({ address: input.sender });
    if (balance < value) throw new ElysiumRequestError(`Your wallet holds ${formatHype(balance)} HYPE on ${view.chainName}; this payment needs ${formatHype(value)} HYPE plus gas.${view.faucetUrl ? " Testnet HYPE comes from Kinetiq's faucet." : ""}`, 409);
    const gas = await client.estimateGas({ account: input.sender, to: router, value, data }).catch(() => undefined);
    if (gas === undefined) throw new ElysiumRequestError("The chain refused this payment in a simulation, so the wallet was not opened.", 409);
    return {
      network: input.network,
      chainId: view.chainIdHex,
      to: router,
      value: value.toString(),
      data,
      // Room above the estimate: Orbit adds the parent-chain posting cost, which moves with HyperEVM's gas price.
      gas: ((gas * 125n) / 100n).toString(),
      recipient: getAddress(recipient),
      platform: input.platform,
      username,
      amount: amount.toString(),
      fee: fee.toString(),
      display: { amount: formatHype(amount), fee: formatHype(fee), total: formatHype(value) },
      note: input.note?.trim() ?? "",
    };
  }

  /**
   * Several HYPE payments in one transaction (`payNativeBatch`), up to ten verified handles, each with its own amount
   * and its own 1% fee, one note for all. Every handle is resolved now; one that has no verified wallet stops the
   * whole batch before anything is signed.
   */
  async prepareBatch(input: { network: ElysiumNetworkId; sender: Address; recipients: Array<{ platform: Platform; username: string; amount: string }>; note?: string }) {
    const { view, router } = await this.openNetwork(input.network);
    if (!input.recipients.length || input.recipients.length > ELYSIUM_BATCH_MAX) throw new ElysiumRequestError(`A split pays 1 to ${ELYSIUM_BATCH_MAX} people.`);
    const note = elysiumNoteBytes(input.note ?? "");
    if (!note) throw new ElysiumRequestError("The note can be at most 160 bytes.");
    const rows = [];
    const seen = new Set<string>();
    for (const entry of input.recipients) {
      const username = entry.username.trim().replace(/^@/, "").toLowerCase();
      const amount = parseHype(entry.amount);
      if (!amount) throw new ElysiumRequestError(`Write the amount for @${username} in HYPE, for example 0.5.`);
      const recipient = await this.options.resolve(entry.platform, username);
      if (!recipient) throw new ElysiumRequestError(`@${username} has not verified a wallet on ElysaPay yet, so nothing was prepared.`, 404);
      const address = getAddress(recipient);
      if (address === getAddress(input.sender)) throw new ElysiumRequestError(`@${username} is linked to your own wallet.`);
      if (seen.has(address)) throw new ElysiumRequestError(`@${username} appears twice in the split.`);
      seen.add(address);
      rows.push({ platform: entry.platform, username, recipient: address, amount, fee: elysiumFee(amount) });
    }
    const total = rows.reduce((sum, row) => sum + row.amount, 0n);
    const fees = rows.reduce((sum, row) => sum + row.fee, 0n);
    const value = total + fees;
    const data = encodeFunctionData({ abi: ELYSA_PAY_ROUTER_ARTIFACT.abi, functionName: "payNativeBatch", args: [rows.map((row) => row.recipient), rows.map((row) => row.amount), note] });
    const client = await this.client(input.network);
    const balance = await client.getBalance({ address: input.sender });
    if (balance < value) throw new ElysiumRequestError(`Your wallet holds ${formatHype(balance)} HYPE on ${view.chainName}; this split needs ${formatHype(value)} HYPE plus gas.`, 409);
    const gas = await client.estimateGas({ account: input.sender, to: router, value, data }).catch(() => undefined);
    if (gas === undefined) throw new ElysiumRequestError("The chain refused this split in a simulation, so the wallet was not opened.", 409);
    return {
      network: input.network,
      chainId: view.chainIdHex,
      to: router,
      value: value.toString(),
      data,
      gas: ((gas * 125n) / 100n).toString(),
      recipients: rows.map((row) => ({ platform: row.platform, username: row.username, recipient: row.recipient, amount: formatHype(row.amount), fee: formatHype(row.fee) })),
      display: { amount: formatHype(total), fee: formatHype(fees), total: formatHype(value) },
      note: input.note?.trim() ?? "",
    };
  }

  /**
   * Records a split from its receipt: one record for each `Paid` event to a wallet one of the named handles resolves
   * to now. Every named handle must have been paid, or nothing is recorded.
   */
  async confirmBatch(input: { network: ElysiumNetworkId; sender: Address; hash: string; recipients: Array<{ platform: Platform; username: string }> }): Promise<{ status: "pending" } | { status: "confirmed"; payments: ElysiumPaymentRecord[] }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.hash)) throw new ElysiumRequestError("That is not a transaction hash.");
    const hash = input.hash.toLowerCase() as Hex;
    const known = await this.receipt(input.network, hash);
    if (known.length) return { status: "confirmed", payments: known };
    const read = await this.paidEvents(input.network, input.sender, hash);
    if (read === "pending") return { status: "pending" };
    const payments: ElysiumPaymentRecord[] = [];
    const used = new Set<number>();
    for (const entry of input.recipients) {
      const username = entry.username.trim().replace(/^@/, "").toLowerCase();
      const expected = await this.options.resolve(entry.platform, username);
      const index = read.events.findIndex((event, at) => !used.has(at) && expected && getAddress(event.args.recipient) === getAddress(expected));
      if (index < 0) throw new ElysiumRequestError(`This transaction did not pay the wallet @${username} has verified.`);
      used.add(index);
      payments.push(this.record(input.network, hash, read.blockNumber, read.events[index], entry.platform, username));
    }
    for (const [index, payment] of payments.entries()) await this.options.settings.set(`elysium.payment.${input.network}.${hash}.${index}`, payment, payment.payer);
    return { status: "confirmed", payments };
  }

  /** A payment's public receipt: every recorded payment of one transaction (one, or each person of a split). */
  async receipt(network: ElysiumNetworkId, hash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ElysiumRequestError("That is not a transaction hash.");
    const rows = await this.options.settings.list<ElysiumPaymentRecord>(`elysium.payment.${network}.${hash.toLowerCase()}`);
    return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).map(([, entry]) => entry.value);
  }

  /** The `Paid` events of a mined, successful transaction this wallet sent to the registered router. */
  private async paidEvents(network: ElysiumNetworkId, sender: Address, hash: Hex) {
    const { router } = await this.openNetwork(network);
    const client = await this.client(network);
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (!receipt) return "pending" as const;
    if (receipt.status !== "success") throw new ElysiumRequestError("This transaction failed on chain. Nothing was paid.");
    if (getAddress(receipt.from) !== getAddress(sender)) throw new ElysiumRequestError("This transaction was not sent by your wallet.", 403);
    if (!receipt.to || getAddress(receipt.to) !== router) throw new ElysiumRequestError("This transaction did not go to the ElysaPay router.");
    const events = receipt.logs.filter((log) => getAddress(log.address) === router).flatMap((log) => {
      try {
        return [decodeEventLog({ abi: [PAID_EVENT], data: log.data, topics: log.topics })];
      } catch {
        return [];
      }
    }).filter((event) => getAddress(event.args.payer) === getAddress(sender));
    return { events, blockNumber: receipt.blockNumber };
  }

  private record(network: ElysiumNetworkId, hash: Hex, blockNumber: bigint, event: { args: { payer: Address; recipient: Address; amount: bigint; fee: bigint; note: Hex } }, platform: Platform, username: string): ElysiumPaymentRecord {
    return {
      network,
      hash,
      payer: getAddress(event.args.payer),
      recipient: getAddress(event.args.recipient),
      platform,
      username,
      token: "HYPE",
      amount: formatHype(event.args.amount, 18),
      fee: formatHype(event.args.fee, 18),
      note: Buffer.from(event.args.note.slice(2), "hex").toString("utf8"),
      blockNumber: blockNumber.toString(),
      confirmedAt: this.now().toISOString(),
    };
  }

  /**
   * Records a payment from its receipt: mined, sent by this wallet to the registered router, with a `Paid` event to
   * the wallet the handle resolves to now. A hash already recorded answers with the record.
   */
  async confirmPayment(input: { network: ElysiumNetworkId; sender: Address; hash: string; platform: Platform; username: string }): Promise<{ status: "pending" } | { status: "confirmed"; payment: ElysiumPaymentRecord }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.hash)) throw new ElysiumRequestError("That is not a transaction hash.");
    const hash = input.hash.toLowerCase() as Hex;
    const key = `elysium.payment.${input.network}.${hash}`;
    const known = await this.options.settings.get<ElysiumPaymentRecord>(key);
    if (known) return { status: "confirmed", payment: known.value };
    const { router } = await this.openNetwork(input.network);
    const client = await this.client(input.network);
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (!receipt) return { status: "pending" };
    if (receipt.status !== "success") throw new ElysiumRequestError("This transaction failed on chain. Nothing was paid.");
    if (getAddress(receipt.from) !== getAddress(input.sender)) throw new ElysiumRequestError("This transaction was not sent by your wallet.", 403);
    if (!receipt.to || getAddress(receipt.to) !== router) throw new ElysiumRequestError("This transaction did not go to the ElysaPay router.");
    const username = input.username.trim().replace(/^@/, "").toLowerCase();
    const expected = await this.options.resolve(input.platform, username);
    const paid = receipt.logs.filter((log) => getAddress(log.address) === router).flatMap((log) => {
      try {
        return [decodeEventLog({ abi: [PAID_EVENT], data: log.data, topics: log.topics })];
      } catch {
        return [];
      }
    });
    const event = paid.find((entry) => expected && getAddress(entry.args.recipient) === getAddress(expected) && getAddress(entry.args.payer) === getAddress(input.sender));
    if (!event) throw new ElysiumRequestError(`This transaction did not pay the wallet @${username} has verified.`);
    const note = Buffer.from((event.args.note as Hex).slice(2), "hex").toString("utf8");
    const payment: ElysiumPaymentRecord = {
      network: input.network,
      hash,
      payer: getAddress(event.args.payer),
      recipient: getAddress(event.args.recipient),
      platform: input.platform,
      username,
      token: "HYPE",
      amount: formatHype(event.args.amount, 18),
      fee: formatHype(event.args.fee, 18),
      note,
      blockNumber: receipt.blockNumber.toString(),
      confirmedAt: this.now().toISOString(),
    };
    await this.options.settings.set(key, payment, payment.payer);
    return { status: "confirmed", payment };
  }

  /** The payments a wallet sent or received on Elysium, newest first. */
  async history(wallet?: Address, limit = 50) {
    const rows = [...(await this.options.settings.list<ElysiumPaymentRecord>("elysium.payment.")).values()].map((entry) => entry.value);
    const own = wallet ? rows.filter((row) => row.payer === wallet || row.recipient === wallet) : rows;
    return own.sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)).slice(0, limit);
  }

  /**
   * An admin transaction (a deployment, a mint, a pause) read back from chain for the audit log: mined, sent by this
   * admin, and either creating a contract or calling one registered on this network.
   */
  async readAdminTransaction(network: ElysiumNetworkId, hash: string, admin: Address) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ElysiumRequestError("That is not a transaction hash.");
    const client = await this.client(network);
    const receipt = await client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
    if (!receipt) return { status: "pending" as const };
    if (getAddress(receipt.from) !== getAddress(admin)) throw new ElysiumRequestError("This transaction was not sent by your wallet.", 403);
    // The router has no admin functions: a call to it is a payment, never an admin change.
    const { router: _router, ...managed } = await this.contracts(network);
    const contracts = Object.values(managed).map((address) => getAddress(address));
    const created = receipt.contractAddress ? getAddress(receipt.contractAddress) : undefined;
    if (!created && !(receipt.to && contracts.includes(getAddress(receipt.to)))) throw new ElysiumRequestError("This transaction neither deployed a contract nor called the token or pass registered on this network.");
    return {
      status: receipt.status === "success" ? "confirmed" as const : "failed" as const,
      hash: hash.toLowerCase(),
      blockNumber: receipt.blockNumber.toString(),
      contractAddress: created ?? null,
      to: receipt.to ? getAddress(receipt.to) : null,
      gasUsed: receipt.gasUsed.toString(),
    };
  }
}
