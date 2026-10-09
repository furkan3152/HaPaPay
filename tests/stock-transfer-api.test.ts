import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { decodeFunctionData, encodeFunctionResult, padHex, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import type { AccountAddressService } from "../server/account-address-service";
import { readSolanaConfig } from "../server/solana-network";
import { MemoryStockTransferRepository, StockTransferService, stockTokenTransferAbi, type StockChainClient } from "../server/stock-transfer-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { STOCK_TOKEN_ALLOWLISTS } from "../src/domain/robinhood-stock-tokens";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
const TSLA = STOCK_TOKEN_ALLOWLISTS["robinhood-testnet"].tokens.find((token) => token.symbol === "TSLA")!;
const NVDA = STOCK_TOKEN_ALLOWLISTS["robinhood-mainnet"].tokens.find((token) => token.symbol === "NVDA")!;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const HASH = `0x${"ab".repeat(32)}` as const;

function chain(chainId: number, symbol: string, token: Address, sender: Address): StockChainClient {
  return {
    getChainId: async () => chainId,
    getBytecode: async () => "0x6080",
    readContract: async ({ functionName }) => functionName === "decimals" ? 18 : functionName === "symbol" ? symbol : 7_000_000_000_000_000_000n,
    call: async () => ({ data: encodeFunctionResult({ abi: stockTokenTransferAbi, functionName: "transfer", result: true }) }),
    getTransactionReceipt: async () => ({
      status: "success",
      from: sender,
      blockNumber: 9_001n,
      logs: [{ address: token, topics: [TRANSFER_TOPIC, padHex(sender, { size: 32 }), padHex(RECIPIENT, { size: 32 })], data: toHex(2_500_000_000_000_000_000n, { size: 32 }) }],
    }),
  };
}

describe("wallet-signed stock-token transfer HTTP API", () => {
  let server: Server;
  let origin: string;
  let cookie: string;
  let failList = false;
  const sender = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  const identities = new VerifiedIdentityService();

  const post = (path: string, body: unknown, withSession = true) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(withSession ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const testnetRequest = {
    network: "robinhood-testnet",
    token: { symbol: "TSLA", address: TSLA.address },
    amount: "2.50",
    recipient: { platform: "x", username: "@Nora" },
    expectedRecipientAddress: RECIPIENT,
    sourcePlatform: "github",
  };

  before(async () => {
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "stock-transfer-api-secret-with-32-chars" });
    identities.link(RECIPIENT, { platform: "x", providerUserId: "x-22", username: "nora", verifiedAt: "2026-09-28T10:00:00.000Z" });
    identities.link(sender.address, { platform: "github", providerUserId: "gh-sender", username: "ada", verifiedAt: "2026-09-28T10:00:00.000Z" });
    const transfers = new StockTransferService({
      networks: {
        "robinhood-testnet": { enabled: true, client: chain(46630, "TSLA", TSLA.address, sender.address) },
        "robinhood-mainnet": { enabled: true, client: chain(4663, "NVDA", NVDA.address, sender.address) },
      },
      repository: new MemoryStockTransferRepository(),
      now: () => Date.parse("2026-09-28T12:00:00.000Z"),
    });
    const app = createApp({
      auth,
      identities,
      stockTransfers: {
        availability: (network) => transfers.availability(network),
        prepare: (input) => transfers.prepare(input),
        confirm: (input) => transfers.confirm(input),
        list: async (wallet) => {
          if (failList) throw new Error("connection to postgres://admin:hunter2@db.internal failed");
          return transfers.list(wallet);
        },
      },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test port");
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    const challenge = await post("/api/auth/challenge", { address: sender.address }, false).then((response) => response.json()) as { id: string; message: string };
    const signature = await sender.signMessage({ message: challenge.message });
    const login = await post("/api/auth/verify", { address: sender.address, challengeId: challenge.id, signature }, false);
    cookie = login.headers.get("set-cookie") ?? "";
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  it("publishes per-network transfer availability with the stock board", async () => {
    const testnet = await fetch(`${origin}/api/stocks?network=robinhood-testnet`).then((response) => response.json()) as { transfers: unknown; tokens: unknown[] };
    assert.deepEqual(testnet.transfers, { enabled: true, tokens: { enabled: true } });
    assert.equal(testnet.tokens.length, 5);
    const health = await fetch(`${origin}/api/health`).then((response) => response.json()) as { stockTransfers: unknown };
    assert.deepEqual(health.stockTransfers, { "robinhood-testnet": "receipt_verified", "robinhood-mainnet": "receipt_verified" });
  });

  it("prepares exact transfer calldata for the session wallet after re-resolving the recipient", async () => {
    assert.equal((await post("/api/stocks/transfers/prepare", testnetRequest, false)).status, 401);

    const response = await post("/api/stocks/transfers/prepare", testnetRequest);
    assert.equal(response.status, 200);
    const prepared = await response.json() as Record<string, any>;
    assert.equal(prepared.networkId, "robinhood-testnet");
    assert.equal(prepared.chainIdHex, "0xb626");
    assert.equal(prepared.rpcUrl, "https://rpc.testnet.chain.robinhood.com");
    assert.deepEqual(prepared.nativeCurrency, { name: "Ether", symbol: "ETH", decimals: 18 });
    assert.equal(prepared.amount, "2.5");
    assert.equal(prepared.units, "2500000000000000000");
    assert.equal(prepared.balance, "7");
    assert.deepEqual(prepared.recipient, { platform: "x", username: "nora", address: RECIPIENT });
    assert.deepEqual(prepared.senderIdentity, { platform: "github", username: "ada" });
    assert.equal(prepared.transaction.from, sender.address);
    assert.equal(prepared.transaction.to, TSLA.address);
    assert.equal(prepared.transaction.value, "0x0");
    assert.deepEqual(decodeFunctionData({ abi: stockTokenTransferAbi, data: prepared.transaction.data as Hex }).args, [RECIPIENT, 2_500_000_000_000_000_000n]);
  });

  it("refuses requests the review did not cover", async () => {
    const cases: Array<[string, unknown, number, RegExp]> = [
      ["malformed", { ...testnetRequest, amount: undefined }, 400, /Invalid stock-token transfer request/],
      ["zero amount", { ...testnetRequest, amount: "0" }, 400, /greater than zero/],
      ["mainnet token on testnet", { ...testnetRequest, token: { symbol: "NVDA", address: NVDA.address } }, 400, /NVDA is not on the verified Robinhood Chain Testnet token list/],
      ["ticker at another address", { ...testnetRequest, token: { symbol: "TSLA", address: "0x1111111111111111111111111111111111111111" } }, 400, /not on the verified/],
      ["unknown recipient", { ...testnetRequest, recipient: { platform: "x", username: "nobody" } }, 404, /verified social identity/],
      ["recipient changed", { ...testnetRequest, expectedRecipientAddress: "0x3333333333333333333333333333333333333333" }, 409, /changed after review/],
      ["unlinked source", { ...testnetRequest, sourcePlatform: "discord" }, 400, /Link and verify your Discord account/],
      ["mainnet without eligibility", { ...testnetRequest, network: "robinhood-mainnet", token: { symbol: "NVDA", address: NVDA.address } }, 400, /Confirm that you may hold and transfer Robinhood Stock Tokens/],
    ];
    for (const [label, body, status, message] of cases) {
      const response = await post("/api/stocks/transfers/prepare", body);
      assert.equal(response.status, status, label);
      assert.match(((await response.json()) as { error: string }).error, message, label);
    }
    const mainnet = await post("/api/stocks/transfers/prepare", { ...testnetRequest, network: "robinhood-mainnet", token: { symbol: "NVDA", address: NVDA.address }, eligibilityConfirmed: true });
    assert.equal(mainnet.status, 200);
    assert.equal(((await mainnet.json()) as { chainId: number }).chainId, 4663);
  });

  it("records a confirmed transfer once and lists it with its asset and chain", async () => {
    const confirmation = { ...testnetRequest, expectedRecipientAddress: undefined, transactionHash: HASH };
    const confirmed = await post("/api/stocks/transfers/confirm", confirmation);
    assert.equal(confirmed.status, 201);
    const entry = {
      transactionHash: HASH,
      direction: "sent",
      counterparty: RECIPIENT,
      platform: "x",
      username: "nora",
      amount: "2.5",
      blockNumber: "9001",
      confirmedAt: "2026-09-28T12:00:00.000Z",
      asset: { type: "stock-token", symbol: "TSLA", address: TSLA.address, chainId: 46630, network: "robinhood-testnet" },
      sourceIdentity: { platform: "github", username: "ada" },
    };
    assert.deepEqual(await confirmed.json(), entry);

    const replay = await post("/api/stocks/transfers/confirm", confirmation);
    assert.equal(replay.status, 409);
    assert.match(((await replay.json()) as { error: string }).error, /already confirmed/);

    const history = await fetch(`${origin}/api/stocks/transfers`, { headers: { Cookie: cookie } });
    assert.equal(history.status, 200);
    assert.deepEqual(await history.json(), { transfers: [entry] });
    assert.equal((await fetch(`${origin}/api/stocks/transfers`)).status, 401);

    failList = true;
    const failed = await fetch(`${origin}/api/stocks/transfers`, { headers: { Cookie: cookie } });
    failList = false;
    assert.equal(failed.status, 500);
    const body = await failed.text();
    assert.doesNotMatch(body, /hunter2|postgres/, "internal errors never reach the browser");
  });
});

describe("stock-token transfers on a server without them", () => {
  it("keeps drafts available and reports why transfers are off", async () => {
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "stock-transfer-off-secret-with-32-chars" }),
      stockTransfers: new StockTransferService({
        networks: { "robinhood-mainnet": { enabled: false, reason: "Mainnet stock transfers are turned off on this server. The operator enables them after reviewing eligibility." } },
        repository: new MemoryStockTransferRepository(),
      }),
    });
    const server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const origin = `http://127.0.0.1:${address.port}`;
      const mainnet = await fetch(`${origin}/api/stocks?network=robinhood-mainnet`).then((response) => response.json()) as { transfers: { enabled: boolean; reason?: string } };
      assert.equal(mainnet.transfers.enabled, false);
      assert.match(mainnet.transfers.reason ?? "", /operator enables them after reviewing eligibility/);
      const testnet = await fetch(`${origin}/api/stocks?network=robinhood-testnet`).then((response) => response.json()) as { transfers: { enabled: boolean; reason?: string } };
      assert.deepEqual(testnet.transfers, {
        enabled: false,
        reason: "Robinhood Chain Testnet stock transfers are not configured on this server.",
        tokens: { enabled: false, reason: "Robinhood Chain Testnet stock transfers are not configured on this server." },
      });
      const draft = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Send 2 NVDA to @selin on X", networkPreference: "robinhood-mainnet" }),
      }).then((response) => response.json()) as { status: string };
      assert.equal(draft.status, "needs_clarification", "an unverified recipient still gets a clarification, never a USDC draft");
      const health = await fetch(`${origin}/api/health`).then((response) => response.json()) as { stockTransfers: unknown };
      assert.deepEqual(health.stockTransfers, { "robinhood-testnet": "disabled", "robinhood-mainnet": "disabled" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("the chat reads the signed-in sender's own holdings to choose a network", () => {
  it("sends NVDA on Robinhood Chain, the main network, reading only the sender's own balances, and nothing for a visitor", async () => {
    // The sender's wallets choose the network, and Robinhood Chain is the main one.
    const sender = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const identities = new VerifiedIdentityService();
    identities.link(RECIPIENT, { platform: "x", providerUserId: "x-22", username: "nora", verifiedAt: "2026-09-28T10:00:00.000Z" });
    const solanaAddresses: Record<string, string> = {
      [sender.address]: "Vote111111111111111111111111111111111111111",
      [RECIPIENT]: "Stake11111111111111111111111111111111111111",
    };
    const reads: string[] = [];
    let onSolana = "0";
    const transfers = new StockTransferService({
      networks: { "robinhood-mainnet": { enabled: true, client: chain(4663, "NVDA", NVDA.address, sender.address) } },
      repository: new MemoryStockTransferRepository(),
    });
    const unused = async (): Promise<never> => { throw new Error("not part of this test"); };
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "sender-holdings-secret-with-32-chars!!" }),
      identities,
      stockTransfers: {
        availability: (network) => transfers.availability(network),
        prepare: unused,
        confirm: unused,
        list: async () => [],
        holding: async (network, token, owner) => {
          reads.push(`${network}:${token.symbol}:${owner}`);
          return transfers.holding(network, token, owner);
        },
      },
      solana: {
        config: readSolanaConfig({ SOLANA_TREASURY_ADDRESS: "So11111111111111111111111111111111111111112", SOLANA_STOCK_TRANSFERS: "enabled" }),
        transfers: {
          availability: () => ({ enabled: true }),
          prepare: unused,
          confirm: unused,
          list: async () => [],
          status: unused,
          treasury: "So11111111111111111111111111111111111111112",
          holding: async (owner, asset) => {
            reads.push(`solana:${asset.symbol}:${owner}`);
            return onSolana;
          },
        },
        addresses: { solana: async (wallet: string) => solanaAddresses[wallet] } as unknown as AccountAddressService,
      },
    });
    const server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const origin = `http://127.0.0.1:${address.port}`;
      const post = (path: string, body: unknown, cookie?: string) => fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
      });
      const challenge = await post("/api/auth/challenge", { address: sender.address }).then((response) => response.json()) as { id: string; message: string };
      const login = await post("/api/auth/verify", { address: sender.address, challengeId: challenge.id, signature: await sender.signMessage({ message: challenge.message }) });
      const cookie = login.headers.get("set-cookie") ?? "";
      const chat = (cookieValue?: string) => post("/api/chat", { message: "Send 2 NVDA to @nora on X" }, cookieValue).then((response) => response.json()) as Promise<{ status: string; message: string; stockIntent?: { asset: { symbol: string } } }>;

      const moved = await chat(cookie);
      assert.equal(moved.status, "stock_review");
      assert.equal(moved.stockIntent?.asset.symbol, "NVDA");
      assert.doesNotMatch(moved.message, /your wallet holds/i, "nothing to say when the main network holds enough");
      assert.deepEqual(reads.sort(), [`robinhood-mainnet:NVDA:${sender.address}`, "solana:NVDAx:Vote111111111111111111111111111111111111111"], "only the sender's own addresses are read");

      onSolana = "50";
      const kept = await chat(cookie);
      assert.equal(kept.status, "stock_review", "Robinhood Chain stays first while it holds enough");

      reads.length = 0;
      const visitor = await chat();
      assert.equal(visitor.status, "stock_review");
      assert.deepEqual(reads, [], "a visitor's request reads no balance");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
