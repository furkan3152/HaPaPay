import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import solc from "solc";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { robinhoodChainClient } from "../server/robinhood-network";
import { MemoryStockTransferRepository, StockTransferService } from "../server/stock-transfer-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { STOCK_TOKEN_ALLOWLISTS } from "../src/domain/robinhood-stock-tokens";
import { matchesStockReview, type PreparedStockTransfer } from "../src/domain/stock-tokens";
import { resolveFoundryBinary } from "../scripts/foundry-binary";

const mnemonic = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 46_630,
  name: "Robinhood Chain Testnet simulation",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
const TSLA = STOCK_TOKEN_ALLOWLISTS["robinhood-testnet"].tokens.find((token) => token.symbol === "TSLA")!;
const NVDA = STOCK_TOKEN_ALLOWLISTS["robinhood-mainnet"].tokens.find((token) => token.symbol === "NVDA")!;
const stockAbi = parseAbi([
  "function mint(address recipient, uint256 amount)",
  "function setPaused(bool value)",
  "function setBlocked(address account, bool value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address recipient, uint256 amount) returns (bool)",
]);

describe("Robinhood stock-token transfer lifecycle on a real EVM", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;

  before(async () => {
    const port = await unusedPort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(resolveFoundryBinary("anvil"), [
      "--silent", "--port", String(port), "--chain-id", String(chain.id), "--mnemonic", mnemonic,
    ], { stdio: "ignore" });
    await waitForRpc(rpcUrl);
  });

  after(async () => {
    if (!anvil.killed) anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => anvil.once("exit", () => resolve()));
  });

  it("runs chat → prepare → wallet → receipt → history against the allowlisted TSLA address and rejects what the token would", async () => {
    const deployer = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const sender = mnemonicToAccount(mnemonic, { addressIndex: 1 });
    const recipient = mnemonicToAccount(mnemonic, { addressIndex: 2 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
    const senderWallet = createWalletClient({ account: sender, chain, transport: http(rpcUrl) });
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });

    // Deploy the fixture, then place its runtime code at the real allowlisted testnet TSLA address.
    const fixture = await compileMockStockToken();
    const deployment = await deployerWallet.deployContract({ abi: fixture.abi, bytecode: fixture.bytecode });
    const deployed = (await publicClient.waitForTransactionReceipt({ hash: deployment })).contractAddress!;
    await testClient.setCode({ address: TSLA.address, bytecode: (await publicClient.getCode({ address: deployed }))! });
    const admin = async (functionName: "mint" | "setPaused" | "setBlocked", args: readonly unknown[]) => {
      const hash = await deployerWallet.writeContract({ address: TSLA.address, abi: stockAbi, functionName, args } as never);
      await publicClient.waitForTransactionReceipt({ hash });
    };
    await admin("mint", [sender.address, parseUnits("10", 18)]);

    const identities = new VerifiedIdentityService();
    identities.link(sender.address, { platform: "github", providerUserId: "gh-sender-1", username: "ayse-dev", verifiedAt: new Date().toISOString() });
    identities.link(recipient.address, { platform: "x", providerUserId: "x-recipient-2", username: "nora", verifiedAt: new Date().toISOString() });
    const stockTransfers = new StockTransferService({
      networks: {
        "robinhood-testnet": { enabled: true, client: robinhoodChainClient(rpcUrl) },
        // The same RPC offered as mainnet must fail the chain check instead of preparing anything.
        "robinhood-mainnet": { enabled: true, client: robinhoodChainClient(rpcUrl) },
      },
      repository: new MemoryStockTransferRepository(),
      receiptRetry: { attempts: 2, delayMs: 50 },
    });
    const app = createApp({ auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "stock-lifecycle-secret-with-32-chars" }), identities, stockTransfers });
    const server = await listen(app);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const challenge = await postJson(origin, "/api/auth/challenge", { address: sender.address }) as { id: string; message: string };
      const signature = await sender.signMessage({ message: challenge.message });
      const login = await fetch(`${origin}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: sender.address, challengeId: challenge.id, signature }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie") ?? "";
      const post = (path: string, body: unknown) => fetch(`${origin}${path}`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const draft = await (await post("/api/chat", { message: "GitHub hesabımdan X'teki @nora'ya 2,5 TSLA gönder", networkPreference: "robinhood-testnet" })).json() as {
        status: string;
        transferEnabled: boolean;
        resolvedAddress: Address;
        units: string;
        stockIntent: { asset: { symbol: string; address: Address }; amount: string; recipient: { platform: "x"; username: string }; sourcePlatform?: "github" };
      };
      assert.equal(draft.status, "stock_review");
      assert.equal(draft.transferEnabled, true);
      assert.equal(draft.resolvedAddress, recipient.address);
      assert.equal(draft.stockIntent.sourcePlatform, "github");
      const request = {
        network: "robinhood-testnet",
        token: { symbol: draft.stockIntent.asset.symbol, address: draft.stockIntent.asset.address },
        amount: draft.stockIntent.amount,
        recipient: draft.stockIntent.recipient,
        sourcePlatform: draft.stockIntent.sourcePlatform,
      };

      const prepareResponse = await post("/api/stocks/transfers/prepare", { ...request, expectedRecipientAddress: draft.resolvedAddress });
      assert.equal(prepareResponse.status, 200);
      const prepared = await prepareResponse.json() as PreparedStockTransfer;
      assert.equal(prepared.balance, "10");
      assert.ok(prepared.transaction, "without a registered fee router the payment is one transfer");
      assert.equal(prepared.transaction.to, TSLA.address);
      assert.equal(matchesStockReview(prepared, { network: "robinhood-testnet", token: TSLA.address, sender: sender.address, recipient: draft.resolvedAddress, units: draft.units }), true);

      const transactionHash = await senderWallet.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data, value: BigInt(prepared.transaction.value) });
      assert.equal((await publicClient.waitForTransactionReceipt({ hash: transactionHash })).status, "success");
      const confirmation = await post("/api/stocks/transfers/confirm", { ...request, transactionHash });
      assert.equal(confirmation.status, 201);
      const confirmed = await confirmation.json() as { direction: string; amount: string; asset: { symbol: string; chainId: number; network: string }; sourceIdentity: unknown };
      assert.equal(confirmed.direction, "sent");
      assert.equal(confirmed.amount, "2.5");
      assert.deepEqual(confirmed.asset, { type: "stock-token", symbol: "TSLA", address: TSLA.address, chainId: 46630, network: "robinhood-testnet" });
      assert.deepEqual(confirmed.sourceIdentity, { platform: "github", username: "ayse-dev" });
      assert.equal(await publicClient.readContract({ address: TSLA.address, abi: stockAbi, functionName: "balanceOf", args: [sender.address] }), parseUnits("7.5", 18));
      assert.equal(await publicClient.readContract({ address: TSLA.address, abi: stockAbi, functionName: "balanceOf", args: [recipient.address] }), parseUnits("2.5", 18));

      const history = await (await fetch(`${origin}/api/stocks/transfers`, { headers: { Cookie: cookie } })).json() as { transfers: unknown[] };
      assert.equal(history.transfers.length, 1);
      assert.equal((await stockTransfers.list(recipient.address))[0]?.direction, "received");
      const replay = await post("/api/stocks/transfers/confirm", { ...request, transactionHash });
      assert.equal(replay.status, 409);

      // Pre-flight rejections come from the token contract itself through eth_call.
      const rejected = async (body: Record<string, unknown>, message: RegExp) => {
        const response = await post("/api/stocks/transfers/prepare", { ...request, expectedRecipientAddress: draft.resolvedAddress, ...body });
        assert.equal(response.status, 400);
        assert.match((await response.json() as { error: string }).error, message);
      };
      await rejected({ amount: "100" }, /^Your wallet holds 7\.5 TSLA; this transfer needs 100 TSLA\.$/);
      await admin("setPaused", [true]);
      await rejected({}, /TSLA transfers are paused by the issuer/);
      await admin("setPaused", [false]);
      await admin("setBlocked", [recipient.address, true]);
      await rejected({}, /blocks TSLA transfers to this recipient/);
      await admin("setBlocked", [recipient.address, false]);
      await admin("setBlocked", [sender.address, true]);
      await rejected({}, /blocks TSLA transfers from this wallet/);
      await admin("setBlocked", [sender.address, false]);

      // A receipt is recorded only for the exact reviewed transfer, and a reverted one never.
      const oneToken = await senderWallet.sendTransaction({
        to: TSLA.address,
        data: encodeFunctionData({ abi: stockAbi, functionName: "transfer", args: [recipient.address, parseUnits("1", 18)] }),
      });
      await publicClient.waitForTransactionReceipt({ hash: oneToken });
      const wrongAmount = await post("/api/stocks/transfers/confirm", { ...request, amount: "2", transactionHash: oneToken });
      assert.equal(wrongAmount.status, 400);
      assert.match((await wrongAmount.json() as { error: string }).error, /does not contain the reviewed TSLA transfer/);
      assert.equal((await post("/api/stocks/transfers/confirm", { ...request, amount: "1", transactionHash: oneToken })).status, 201);

      const failing = await senderWallet.sendTransaction({
        to: TSLA.address,
        data: encodeFunctionData({ abi: stockAbi, functionName: "transfer", args: [recipient.address, parseUnits("1000", 18)] }),
        gas: 120_000n,
      });
      assert.equal((await publicClient.waitForTransactionReceipt({ hash: failing })).status, "reverted");
      const revertedConfirmation = await post("/api/stocks/transfers/confirm", { ...request, amount: "1000", transactionHash: failing });
      assert.equal(revertedConfirmation.status, 400);
      assert.match((await revertedConfirmation.json() as { error: string }).error, /transaction reverted; nothing was transferred/);

      const unknownHash = await post("/api/stocks/transfers/confirm", { ...request, transactionHash: `0x${"42".repeat(32)}` as Hex });
      assert.equal(unknownHash.status, 503);
      assert.equal(unknownHash.headers.get("retry-after"), "5");

      const mainnet = await post("/api/stocks/transfers/prepare", {
        ...request, network: "robinhood-mainnet", token: { symbol: "NVDA", address: NVDA.address }, expectedRecipientAddress: draft.resolvedAddress, eligibilityConfirmed: true,
      });
      assert.equal(mainnet.status, 503);
      assert.match((await mainnet.json() as { error: string }).error, /reports chain 46630, not 4663/);
      assert.equal((await (await fetch(`${origin}/api/stocks/transfers`, { headers: { Cookie: cookie } })).json() as { transfers: unknown[] }).transfers.length, 2);
    } finally {
      await close(server);
    }
  });
});

async function compileMockStockToken() {
  const source = await readFile(new URL("./fixtures/MockStockToken.sol", import.meta.url), "utf8");
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "MockStockToken.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  }))) as { errors?: Array<{ severity: string; formattedMessage: string }>; contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>> };
  const errors = output.errors?.filter((error) => error.severity === "error") ?? [];
  assert.deepEqual(errors, []);
  const artifact = output.contracts["MockStockToken.sol"].MockStockToken;
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` as Hex };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
}

async function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing stock lifecycle test port."));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function listen(app: ReturnType<typeof createApp>) {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForRpc(rpcUrl: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Anvil RPC did not start.");
}
