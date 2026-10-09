import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newDb } from "pg-mem";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, padHex, toHex, type Address, type Hex } from "viem";
import {
  DuplicateStockTransferError,
  MemoryStockTransferRepository,
  PostgresStockTransferRepository,
  StockReceiptPendingError,
  StockTransferRejectedError,
  StockTransferService,
  StockTransferUnavailableError,
  stockTokenTransferAbi,
  type StockChainClient,
  type StockTransferRecord,
} from "../server/stock-transfer-service";
import { readRobinhoodTransferConfig } from "../server/robinhood-network";
import { STOCK_TOKEN_ALLOWLISTS } from "../src/domain/robinhood-stock-tokens";
import { payRouterAbi } from "../src/domain/fees";
import { matchesStockReview, type PreparedStockTransfer } from "../src/domain/stock-tokens";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
const TSLA = STOCK_TOKEN_ALLOWLISTS["robinhood-testnet"].tokens.find((token) => token.symbol === "TSLA")!;
const NVDA = STOCK_TOKEN_ALLOWLISTS["robinhood-mainnet"].tokens.find((token) => token.symbol === "NVDA")!;
const SENDER = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A" as const;
const RECIPIENT = "0x8a7e4E1B6f1cA842a9b84E5CB18A46EDF2Ceb789" as const;
const HASH = `0x${"ab".repeat(32)}` as const;
const ROUTER = "0x3333333333333333333333333333333333333333" as const;
const BURN_VAULT = "0x4444444444444444444444444444444444444444" as const;
const TREASURY = "0x5555555555555555555555555555555555555555" as const;
const REF = `0x${"cd".repeat(32)}` as const;

function record(overrides: Partial<StockTransferRecord> = {}): StockTransferRecord {
  return {
    chainId: 46630,
    transactionHash: HASH,
    tokenAddress: TSLA.address,
    tokenSymbol: "TSLA",
    sender: SENDER,
    recipient: RECIPIENT,
    platform: "x",
    username: "selin",
    amount: "0.5",
    units: 500_000_000_000_000_000n,
    blockNumber: 812n,
    confirmedAt: "2026-09-28T12:00:00.000Z",
    ...overrides,
  };
}

/** Mirrors viem: eth_call reverts surface as nested errors whose innermost cause carries the revert data. */
function reverted(data: Hex) {
  return Object.assign(new Error("Execution reverted."), { cause: Object.assign(new Error("RPC error"), { code: 3, data }) });
}

function transferLog(token: Address, from: Address, to: Address, units: bigint) {
  return { address: token, topics: [TRANSFER_TOPIC, padHex(from, { size: 32 }), padHex(to, { size: 32 })] as const, data: toHex(units, { size: 32 }) };
}

type FakeChain = StockChainClient & { calls: Array<{ account: Address; to: Address; data: Hex }>; chainIdReads: number };

function fakeChain(options: {
  chainId?: number | (() => Promise<number>);
  symbol?: string;
  decimals?: number;
  code?: Hex;
  balance?: bigint;
  allowance?: bigint;
  feeBps?: bigint;
  call?: (input: { account: Address; to: Address; data: Hex }) => Promise<{ data?: Hex }>;
  receipt?: Awaited<ReturnType<StockChainClient["getTransactionReceipt"]>>;
} = {}): FakeChain {
  const chain: FakeChain = {
    calls: [],
    chainIdReads: 0,
    async getChainId() {
      chain.chainIdReads += 1;
      return typeof options.chainId === "function" ? options.chainId() : options.chainId ?? 46630;
    },
    async getBytecode() { return options.code ?? "0x6080"; },
    async readContract({ functionName }) {
      if (functionName === "decimals") return options.decimals ?? 18;
      if (functionName === "symbol") return options.symbol ?? "TSLA";
      if (functionName === "feeBpsFor") return options.feeBps ?? 100n;
      if (functionName === "allowance") return options.allowance ?? 0n;
      return options.balance ?? 2_000_000_000_000_000_000n;
    },
    async call(input) {
      chain.calls.push(input);
      return options.call ? options.call(input) : { data: encodeFunctionResult({ abi: stockTokenTransferAbi, functionName: "transfer", result: true }) };
    },
    async getTransactionReceipt() {
      return options.receipt ?? { status: "success", from: SENDER, blockNumber: 812n, logs: [transferLog(TSLA.address, SENDER, RECIPIENT, 500_000_000_000_000_000n)] };
    },
  };
  return chain;
}

function service(chain: StockChainClient, now = () => Date.parse("2026-09-28T12:00:00.000Z")) {
  return new StockTransferService({
    networks: {
      "robinhood-testnet": { enabled: true, client: chain },
      "robinhood-mainnet": { enabled: false, reason: "Mainnet stock transfers are turned off on this server." },
    },
    repository: new MemoryStockTransferRepository(),
    now,
    receiptRetry: { attempts: 3, delayMs: 0 },
  });
}

function receiptNotFound() {
  return Object.assign(new Error("Transaction receipt could not be found."), { name: "TransactionReceiptNotFoundError" });
}

describe("stock-transfer history repositories", () => {
  it("keeps chain-scoped records across process recreation and rejects replays per chain", async () => {
    const database = newDb();
    const pool = new (database.adapters.createPg().Pool)();
    const first = new PostgresStockTransferRepository(pool);
    await first.migrate();
    const testnet = record({ sourcePlatform: "github", sourceUsername: "ayse-dev" });
    assert.deepEqual(await first.save(testnet), testnet);
    await assert.rejects(() => first.save(testnet), DuplicateStockTransferError);

    // The same hash on another chain is a different transaction.
    const mainnet = record({ chainId: 4663, tokenAddress: NVDA.address, tokenSymbol: "NVDA", confirmedAt: "2026-09-28T12:05:00.000Z" });
    await first.save(mainnet);

    const restarted = new PostgresStockTransferRepository(pool);
    assert.deepEqual(await restarted.list(SENDER), [mainnet, testnet]);
    assert.deepEqual(await restarted.list(RECIPIENT), [mainnet, testnet]);
    assert.deepEqual(await restarted.list("0x2222222222222222222222222222222222222222"), []);
    await pool.end();
  });

  it("applies the same replay and ordering rules in memory", async () => {
    const memory = new MemoryStockTransferRepository();
    const early = record();
    const late = record({ transactionHash: `0x${"cd".repeat(32)}`, confirmedAt: "2026-09-28T13:00:00.000Z" });
    await memory.save(early);
    await memory.save(late);
    await assert.rejects(() => memory.save(record({ transactionHash: HASH.toUpperCase().replace("0X", "0x") as Hex })), DuplicateStockTransferError);
    await memory.save(record({ chainId: 4663 }));
    assert.deepEqual((await memory.list(SENDER)).map((entry) => `${entry.chainId}:${entry.transactionHash.slice(0, 6)}`), ["46630:0xcdcd", "46630:0xabab", "4663:0xabab"]);
  });
});

describe("Robinhood transfer runtime configuration", () => {
  it("runs testnet by default and mainnet only on an explicit operator switch", () => {
    const defaults = readRobinhoodTransferConfig({});
    assert.deepEqual(defaults["robinhood-testnet"], { network: "robinhood-testnet", enabled: true, tokens: { enabled: true }, rpcUrl: "https://rpc.testnet.chain.robinhood.com" });
    assert.equal(defaults["robinhood-mainnet"].enabled, false);
    assert.match(defaults["robinhood-mainnet"].reason ?? "", /turned off on this server/);
    assert.deepEqual(defaults["robinhood-mainnet"].tokens, { enabled: true }, "USDG is not a Stock Token and runs by default");
    assert.equal(defaults["robinhood-mainnet"].rpcUrl, "https://rpc.mainnet.chain.robinhood.com", "mainnet keeps a read client for tokens and claims");

    const enabled = readRobinhoodTransferConfig({ ROBINHOOD_MAINNET_STOCK_TRANSFERS: " Enabled ", ROBINHOOD_MAINNET_RPC_URL: "https://robinhood.example/rpc/key" });
    assert.deepEqual(enabled["robinhood-mainnet"], { network: "robinhood-mainnet", enabled: true, tokens: { enabled: true }, rpcUrl: "https://robinhood.example/rpc/key" });

    const tokensOff = readRobinhoodTransferConfig({ ROBINHOOD_MAINNET_TOKEN_TRANSFERS: "disabled" })["robinhood-mainnet"].tokens;
    assert.deepEqual(tokensOff, { enabled: false, reason: "USDG transfers are turned off on Robinhood Chain on this server." });
    assert.match(readRobinhoodTransferConfig({ ROBINHOOD_MAINNET_TOKEN_TRANSFERS: "yes" })["robinhood-mainnet"].tokens.reason ?? "", /misconfigured/);

    assert.equal(readRobinhoodTransferConfig({ ROBINHOOD_TESTNET_STOCK_TRANSFERS: "disabled" })["robinhood-testnet"].enabled, false);
    for (const flag of ["true", "1", "on", "yes"]) {
      const config = readRobinhoodTransferConfig({ ROBINHOOD_MAINNET_STOCK_TRANSFERS: flag })["robinhood-mainnet"];
      assert.equal(config.enabled, false, `${flag} is not the documented switch`);
      assert.match(config.reason ?? "", /misconfigured/);
    }
    for (const rpc of ["http://rpc.example", "https://user:secret@rpc.example", "https://rpc.example/#fragment", "not a url"]) {
      const config = readRobinhoodTransferConfig({ ROBINHOOD_TESTNET_RPC_URL: rpc })["robinhood-testnet"];
      assert.equal(config.enabled, false);
      assert.equal(config.tokens.enabled, false);
      assert.equal(config.rpcUrl, undefined, "a rejected RPC value is never kept, and no client falls back to another RPC");
      assert.match(config.reason ?? "", /must be an HTTPS URL/);
    }
  });
});

describe("wallet-signed stock-token transfers", () => {
  it("builds exact transfer calldata after verifying the chain, the token, and an eth_call pre-flight", async () => {
    const chain = fakeChain({ balance: 3_250_000_000_000_000_000n });
    const transfers = service(chain);
    const prepared = await transfers.prepare({ network: "robinhood-testnet", sender: SENDER.toLowerCase(), recipient: RECIPIENT, token: TSLA, amount: "0.50" });
    assert.ok("transaction" in prepared, "without a fee router the payment is one transfer");
    assert.deepEqual({ ...prepared, transaction: { ...prepared.transaction, data: undefined } }, {
      networkId: "robinhood-testnet",
      chainId: 46630,
      chainIdHex: "0xb626",
      chainName: "Robinhood Chain Testnet",
      rpcUrl: "https://rpc.testnet.chain.robinhood.com",
      explorerUrl: "https://explorer.testnet.chain.robinhood.com",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      token: { symbol: "TSLA", name: "Tesla", address: TSLA.address, decimals: 18 },
      amount: "0.5",
      units: "500000000000000000",
      balance: "3.25",
      transaction: { from: SENDER, to: TSLA.address, data: undefined, value: "0x0" },
    });
    const decoded = decodeFunctionData({ abi: stockTokenTransferAbi, data: prepared.transaction.data });
    assert.equal(decoded.functionName, "transfer");
    assert.deepEqual(decoded.args, [RECIPIENT, 500_000_000_000_000_000n]);
    assert.deepEqual(chain.calls, [{ account: SENDER, to: TSLA.address, data: prepared.transaction.data }]);

    await transfers.prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "1" });
    assert.equal(chain.chainIdReads, 1, "the chain is verified once per process");
  });

  it("routes a payment through the fee router: approve the amount plus 1%, then pay, after pre-flighting every leg", async () => {
    const fees = { router: ROUTER, burnVault: BURN_VAULT, treasury: TREASURY, feeBps: 100, burnShareBps: 5000 };
    const chain = fakeChain({ balance: 3_000_000_000_000_000_000n });
    const prepared = await service(chain).prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "2", fees, paymentRef: REF });
    assert.ok("transactions" in prepared);
    assert.deepEqual(prepared.fee, {
      router: ROUTER, feeBps: 100, units: "20000000000000000", amount: "0.02",
      burnShare: "10000000000000000", treasuryShare: "10000000000000000", totalUnits: "2020000000000000000", totalAmount: "2.02",
    });
    assert.equal(prepared.paymentRef, REF);
    const [approve, pay] = prepared.transactions;
    assert.deepEqual([approve.purpose, approve.to, pay.purpose, pay.to], ["approve", TSLA.address, "pay", ROUTER]);
    assert.deepEqual(decodeFunctionData({ abi: stockTokenTransferAbi, data: approve.data }).args, [ROUTER, 2_020_000_000_000_000_000n]);
    assert.deepEqual(decodeFunctionData({ abi: payRouterAbi, data: pay.data }).args, [TSLA.address, RECIPIENT, 2_000_000_000_000_000_000n, REF]);
    // The token sees the same three movements the router makes: to the recipient, the burn vault and the treasury.
    assert.deepEqual(chain.calls.map((call) => decodeFunctionData({ abi: stockTokenTransferAbi, data: call.data }).args), [
      [RECIPIENT, 2_000_000_000_000_000_000n], [BURN_VAULT, 10_000_000_000_000_000n], [TREASURY, 10_000_000_000_000_000n],
    ]);
    const review = { network: "robinhood-testnet" as const, token: TSLA.address, sender: SENDER, recipient: RECIPIENT, units: "2000000000000000000" };
    assert.equal(matchesStockReview(prepared as PreparedStockTransfer, review), true);
    assert.equal(matchesStockReview(prepared as PreparedStockTransfer, { ...review, units: "1000000000000000000" }), false);
    // A retry after an approval whose second signature never came needs only the payment.
    const retried = await service(fakeChain({ balance: 3_000_000_000_000_000_000n, allowance: 2_020_000_000_000_000_000n })).prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "2", fees, paymentRef: REF });
    assert.ok("transactions" in retried);
    assert.deepEqual(retried.transactions.map((transaction) => transaction.purpose), ["pay"]);
    assert.equal(matchesStockReview(retried as PreparedStockTransfer, review), true);
    const short = await service(fakeChain({ balance: 3_000_000_000_000_000_000n, allowance: 2_019_999_999_999_999_999n })).prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "2", fees, paymentRef: REF });
    assert.ok("transactions" in short);
    assert.deepEqual(short.transactions.map((transaction) => transaction.purpose), ["approve", "pay"]);
    assert.equal(matchesStockReview({ ...(prepared as PreparedStockTransfer), transactions: [(prepared as PreparedStockTransfer).transactions![0]] }, review), false, "an approval alone never passes");

    await assert.rejects(
      () => service(fakeChain({ balance: 2_010_000_000_000_000_000n })).prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "2", fees }),
      (error) => error instanceof StockTransferRejectedError && error.message === "Your wallet holds 2.01 TSLA; this payment needs 2.02 TSLA, the amount plus the 1% fee.",
    );
    await assert.rejects(
      () => service(fakeChain()).prepare({ network: "robinhood-testnet", sender: SENDER, recipient: SENDER, token: TSLA, amount: "1", fees }),
      /points to your own wallet/,
    );
    const frozenVault = fakeChain({
      balance: 3_000_000_000_000_000_000n,
      call: async ({ data }) => {
        if (decodeFunctionData({ abi: stockTokenTransferAbi, data }).args[0] === BURN_VAULT) throw reverted(encodeErrorResult({ abi: stockTokenTransferAbi, errorName: "AddressFrozen" }));
        return { data: encodeFunctionResult({ abi: stockTokenTransferAbi, functionName: "transfer", result: true }) };
      },
    });
    await assert.rejects(
      () => service(frozenVault).prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "2", fees }),
      /would not accept the fee/,
    );
    const passHolder = await service(fakeChain({ balance: 3_000_000_000_000_000_000n, feeBps: 50n })).prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "2", fees });
    assert.ok("fee" in passHolder);
    assert.equal(passHolder.fee.amount, "0.01", "a holder rate read from the router lowers the fee");
    await assert.rejects(
      () => service(fakeChain({ feeBps: 150n })).prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "1", fees }),
      /quoted an unexpected fee/,
      "a router asking more than 1% is refused",
    );
  });

  it("explains the issuer and balance rules a real Stock Token enforces before a wallet opens", async () => {
    const cases: Array<[Hex, RegExp]> = [
      [encodeErrorResult({ abi: stockTokenTransferAbi, errorName: "ERC20InsufficientBalance", args: [SENDER, 250_000_000_000_000_000n, 500_000_000_000_000_000n] }), /^Your wallet holds 0\.25 TSLA; this transfer needs 0\.5 TSLA\.$/],
      [encodeErrorResult({ abi: stockTokenTransferAbi, errorName: "IsPaused" }), /TSLA transfers are paused by the issuer/],
      [encodeErrorResult({ abi: stockTokenTransferAbi, errorName: "Blocked", args: [SENDER] }), /blocks TSLA transfers from this wallet/],
      [encodeErrorResult({ abi: stockTokenTransferAbi, errorName: "Blocked", args: [RECIPIENT] }), /blocks TSLA transfers to this recipient/],
      [encodeErrorResult({ abi: stockTokenTransferAbi, errorName: "ERC20InvalidReceiver", args: [RECIPIENT] }), /cannot be sent to this recipient address/],
      ["0xdeadbeef", /would reject this transfer, so your wallet was not opened/],
    ];
    for (const [data, message] of cases) {
      const transfers = service(fakeChain({ call: async () => { throw reverted(data); } }));
      await assert.rejects(
        () => transfers.prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "0.5" }),
        (error: Error) => error instanceof StockTransferRejectedError && message.test(error.message),
      );
    }
    const offline = service(fakeChain({ call: async () => { throw new Error("HTTP request failed. URL: https://secret-rpc.example/key"); } }));
    await assert.rejects(
      () => offline.prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "0.5" }),
      (error: Error) => error instanceof StockTransferUnavailableError && error.message === "Robinhood Chain Testnet is not reachable right now. Try again shortly.",
      "an unreachable RPC is never reported as a contract rejection or echoed to the browser",
    );
    const falseResult = service(fakeChain({ call: async () => ({ data: encodeFunctionResult({ abi: stockTokenTransferAbi, functionName: "transfer", result: false }) }) }));
    await assert.rejects(
      () => falseResult.prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "0.5" }),
      /The TSLA contract did not accept this transfer\./,
    );
  });

  it("stays closed when a network is off, the RPC is on another chain, or the token drifted", async () => {
    const off = service(fakeChain());
    assert.deepEqual(off.availability("robinhood-mainnet"), {
      enabled: false,
      reason: "Mainnet stock transfers are turned off on this server.",
      tokens: { enabled: false, reason: "Mainnet stock transfers are turned off on this server." },
    }, "the token switch follows the Stock Token switch when a caller does not set it");
    assert.deepEqual(off.availability("robinhood-testnet"), { enabled: true, tokens: { enabled: true } });
    await assert.rejects(
      () => off.prepare({ network: "robinhood-mainnet", sender: SENDER, recipient: RECIPIENT, token: NVDA, amount: "1" }),
      (error: Error) => error instanceof StockTransferUnavailableError && /turned off/.test(error.message),
    );

    let clock = Date.parse("2026-09-28T12:00:00.000Z");
    const wrongChain = fakeChain({ chainId: 1 });
    const mismatched = service(wrongChain, () => clock);
    const attempt = () => mismatched.prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "1" });
    await assert.rejects(attempt, /reports chain 1, not 46630/);
    await assert.rejects(attempt, /reports chain 1, not 46630/);
    assert.equal(wrongChain.chainIdReads, 1, "a failed check is cached instead of hammering the RPC");
    clock += 31_000;
    await assert.rejects(attempt, StockTransferUnavailableError);
    assert.equal(wrongChain.chainIdReads, 2);

    const offline = service(fakeChain({ chainId: async () => { throw new Error("fetch failed https://secret-rpc.example/key"); } }));
    await assert.rejects(
      () => offline.prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "1" }),
      (error: Error) => error instanceof StockTransferUnavailableError && error.message === "Robinhood Chain Testnet is not reachable right now. Try again shortly.",
    );

    for (const drift of [{ symbol: "TSLAx" }, { decimals: 6 }, { code: "0x" as Hex }]) {
      const transfers = service(fakeChain(drift));
      await assert.rejects(
        () => transfers.prepare({ network: "robinhood-testnet", sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "1" }),
        (error: Error) => error instanceof StockTransferUnavailableError && /TSLA/.test(error.message),
      );
    }
  });

  it("reads what a wallet holds of a listed token for the chat's choice of network, and nothing from a chain it cannot verify", async () => {
    // A request written without a network goes where the sender's wallet holds the asset.
    const chain = fakeChain({ balance: 3_250_000_000_000_000_000n });
    const transfers = service(chain);
    assert.equal(await transfers.holding("robinhood-testnet", TSLA, SENDER), "3.25");
    assert.equal(await transfers.holding("robinhood-testnet", TSLA, SENDER.toLowerCase()), "3.25");
    assert.equal(await service(fakeChain({ balance: 0n })).holding("robinhood-testnet", TSLA, SENDER), "0");
    // A balance is read even while transfers are off: it only chooses a network, and preparation stays closed.
    assert.equal(await service(fakeChain()).holding("robinhood-mainnet", NVDA, SENDER), undefined, "a network without a client answers nothing");
    assert.equal(await service(fakeChain({ chainId: 1 })).holding("robinhood-testnet", TSLA, SENDER), undefined, "nor does an RPC on another chain");
    assert.equal(await service(fakeChain({ symbol: "TSLAx" })).holding("robinhood-testnet", TSLA, SENDER), undefined, "nor a token that drifted from the allowlist");
  });

  it("records a transfer only when the receipt carries the exact reviewed Transfer log", async () => {
    const confirmInput = { network: "robinhood-testnet" as const, transactionHash: HASH.toUpperCase().replace("0X", "0x"), sender: SENDER, recipient: RECIPIENT, token: TSLA, amount: "0.50", platform: "x" as const, username: "@Selin", sourcePlatform: "github" as const, sourceUsername: "Ayse-Dev" };
    const transfers = service(fakeChain());
    const entry = await transfers.confirm(confirmInput);
    assert.deepEqual(entry, {
      transactionHash: HASH,
      direction: "sent",
      counterparty: RECIPIENT,
      platform: "x",
      username: "selin",
      amount: "0.5",
      blockNumber: "812",
      confirmedAt: "2026-09-28T12:00:00.000Z",
      asset: { type: "stock-token", symbol: "TSLA", address: TSLA.address, chainId: 46630, network: "robinhood-testnet" },
      sourceIdentity: { platform: "github", username: "ayse-dev" },
    });
    await assert.rejects(() => transfers.confirm(confirmInput), DuplicateStockTransferError);
    assert.deepEqual(await transfers.list(RECIPIENT.toLowerCase()), [{ ...entry, direction: "received", counterparty: SENDER }]);

    const receipts: Array<[string, Awaited<ReturnType<StockChainClient["getTransactionReceipt"]>>, RegExp]> = [
      ["reverted", { status: "reverted", from: SENDER, blockNumber: 1n, logs: [] }, /transaction reverted; nothing was transferred/],
      ["other sender", { status: "success", from: RECIPIENT, blockNumber: 1n, logs: [transferLog(TSLA.address, SENDER, RECIPIENT, 500_000_000_000_000_000n)] }, /sender does not match the wallet session/],
      ["other amount", { status: "success", from: SENDER, blockNumber: 1n, logs: [transferLog(TSLA.address, SENDER, RECIPIENT, 5n)] }, /does not contain the reviewed TSLA transfer/],
      ["other recipient", { status: "success", from: SENDER, blockNumber: 1n, logs: [transferLog(TSLA.address, SENDER, SENDER, 500_000_000_000_000_000n)] }, /does not contain the reviewed TSLA transfer/],
      ["other token", { status: "success", from: SENDER, blockNumber: 1n, logs: [transferLog(STOCK_TOKEN_ALLOWLISTS["robinhood-testnet"].tokens[0]!.address, SENDER, RECIPIENT, 500_000_000_000_000_000n)] }, /does not contain the reviewed TSLA transfer/],
    ];
    for (const [label, receipt, message] of receipts) {
      await assert.rejects(() => service(fakeChain({ receipt })).confirm(confirmInput), message, label);
    }
    await assert.rejects(() => transfers.confirm({ ...confirmInput, transactionHash: "0x1234" }), /Invalid transaction hash/);

    // A receipt the server's RPC has not indexed yet is re-read, then reported as pending rather than failed.
    let reads = 0;
    const lagging = fakeChain();
    const found = lagging.getTransactionReceipt.bind(lagging);
    lagging.getTransactionReceipt = async (input) => (++reads < 3 ? Promise.reject(receiptNotFound()) : found(input));
    assert.equal((await service(lagging).confirm(confirmInput)).blockNumber, "812");
    assert.equal(reads, 3);
    const missing = fakeChain();
    missing.getTransactionReceipt = async () => { throw receiptNotFound(); };
    await assert.rejects(() => service(missing).confirm(confirmInput), StockReceiptPendingError);
    const broken = fakeChain();
    broken.getTransactionReceipt = async () => { throw new Error("socket hang up https://secret-rpc.example/key"); };
    await assert.rejects(() => service(broken).confirm(confirmInput), (error: Error) => error instanceof StockTransferUnavailableError && !/secret/.test(error.message));
    await assert.rejects(() => transfers.confirm({ ...confirmInput, transactionHash: `0x${"ef".repeat(32)}`, amount: "0" }), /Invalid token amount/);
  });
});
