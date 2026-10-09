import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { createPublicClient, createTestClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, parseAbi, parseEther, parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { readStockClaimConfig, robinhoodChainClient } from "../server/robinhood-network";
import { MemoryStockClaimRepository, StockClaimService } from "../server/stock-claim-service";
import { MemoryStockTransferRepository, StockTransferService } from "../server/stock-transfer-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { STOCK_TOKEN_ALLOWLISTS } from "../src/domain/robinhood-stock-tokens";
import { matchesStockReview, type PreparedStockTransfer } from "../src/domain/stock-tokens";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact";
import { BURN_VAULT_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../src/domain/fee-artifacts";
import { burnVaultAbi, payRouterAbi } from "../src/domain/fees";
import { matchesStockClaimAction, matchesStockClaimFunding, stockClaimEscrowAbi, type PreparedStockClaimAction, type PreparedStockClaimFunding, type StockEscrowDeployment } from "../src/domain/stock-claims";
import { resolveFoundryBinary } from "../scripts/foundry-binary";

// Opt-in: forks the live Robinhood Chain Testnet so the real faucet TSLA Stock contract (beacon proxy, issuer
// pause and compliance checks) runs every call. Run with `npm run test:robinhood-fork`.
const forkUrl = process.env.ROBINHOOD_TESTNET_FORK_URL;
const holder = getAddress(process.env.ROBINHOOD_TESTNET_TSLA_HOLDER ?? "0xFfEf1147c3724a19AB7328F4e361C049ba452dA9");
const chain = defineChain({
  id: 46_630,
  name: "Robinhood Chain Testnet fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
const TSLA = STOCK_TOKEN_ALLOWLISTS["robinhood-testnet"].tokens.find((token) => token.symbol === "TSLA")!;
const erc20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address recipient, uint256 amount) returns (bool)",
]);

describe("stock-token transfers against a fork of the live Robinhood Chain Testnet", { skip: !forkUrl }, () => {
  let anvil: ChildProcess;
  let rpcUrl: string;

  before(async () => {
    const port = await unusedPort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(resolveFoundryBinary("anvil"), ["--silent", "--port", String(port), "--fork-url", forkUrl!], { stdio: "ignore" });
    await waitForRpc(rpcUrl);
  });

  after(async () => {
    if (!anvil.killed) anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => anvil.once("exit", () => resolve()));
  });

  it("sends real faucet TSLA through the HTTP journey and decodes the real contract's rejection", async () => {
    // Fresh keys: Anvil's well-known dev accounts already hold faucet tokens on the public testnet.
    const sender = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey());
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });
    assert.equal(await publicClient.getChainId(), 46630);
    const balance = (owner: Address) => publicClient.readContract({ address: TSLA.address, abi: erc20, functionName: "balanceOf", args: [owner] });
    assert.ok(await balance(holder) >= parseUnits("3", 18), "the faucet holder still has TSLA on the live testnet");

    // Fund the test wallet from the faucet holder; everything after this is signed by the test wallet itself.
    await testClient.impersonateAccount({ address: holder });
    await testClient.setBalance({ address: holder, value: parseEther("1") });
    await testClient.setBalance({ address: sender.address, value: parseEther("1") });
    const holderWallet = createWalletClient({ account: holder, chain, transport: http(rpcUrl) });
    const funding = await holderWallet.sendTransaction({ to: TSLA.address, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sender.address, parseUnits("3", 18)] }) });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: funding })).status, "success");
    await testClient.stopImpersonatingAccount({ address: holder });
    assert.equal(await balance(sender.address), parseUnits("3", 18));

    const identities = new VerifiedIdentityService();
    identities.link(sender.address, { platform: "github", providerUserId: "gh-fork-7", username: "ayse-dev", verifiedAt: new Date().toISOString() });
    identities.link(recipient.address, { platform: "x", providerUserId: "x-fork-8", username: "nora", verifiedAt: new Date().toISOString() });
    const stockTransfers = new StockTransferService({
      networks: { "robinhood-testnet": { enabled: true, client: robinhoodChainClient(rpcUrl) } },
      repository: new MemoryStockTransferRepository(),
    });
    const server = await listen(createApp({ auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "robinhood-fork-secret-with-32-chars" }), identities, stockTransfers }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const challenge = await (await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address }) })).json() as { id: string; message: string };
      const login = await fetch(`${origin}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: sender.address, challengeId: challenge.id, signature: await sender.signMessage({ message: challenge.message }) }),
      });
      const cookie = login.headers.get("set-cookie") ?? "";
      const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

      const stocks = await (await fetch(`${origin}/api/stocks?network=robinhood-testnet`)).json() as { transfers: { enabled: boolean } };
      assert.deepEqual(stocks.transfers, { enabled: true });
      const draft = await (await post("/api/chat", { message: "Send 2.5 TSLA to @nora on X", networkPreference: "robinhood-testnet" })).json() as {
        status: string; resolvedAddress: Address; units: string;
        stockIntent: { asset: { symbol: string; address: Address }; amount: string; recipient: { platform: "x"; username: string } };
      };
      assert.equal(draft.status, "stock_review");
      const request = { network: "robinhood-testnet", token: { symbol: draft.stockIntent.asset.symbol, address: draft.stockIntent.asset.address }, amount: draft.stockIntent.amount, recipient: draft.stockIntent.recipient };

      const tooMuch = await post("/api/stocks/transfers/prepare", { ...request, amount: "1000", expectedRecipientAddress: draft.resolvedAddress });
      assert.equal(tooMuch.status, 400);
      assert.equal((await tooMuch.json() as { error: string }).error, "Your wallet holds 3 TSLA; this transfer needs 1000 TSLA.");

      const response = await post("/api/stocks/transfers/prepare", { ...request, expectedRecipientAddress: draft.resolvedAddress });
      assert.equal(response.status, 200);
      const prepared = await response.json() as PreparedStockTransfer;
      assert.equal(prepared.balance, "3");
      assert.equal(matchesStockReview(prepared, { network: "robinhood-testnet", token: TSLA.address, sender: sender.address, recipient: recipient.address, units: draft.units }), true);

      const senderWallet = createWalletClient({ account: sender, chain, transport: http(rpcUrl) });
      assert.ok(prepared.transaction, "no fee router is registered yet, so the payment is one transfer");
      const transactionHash = await senderWallet.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data, value: 0n });
      assert.equal((await publicClient.waitForTransactionReceipt({ hash: transactionHash })).status, "success");
      const confirmation = await post("/api/stocks/transfers/confirm", { ...request, transactionHash });
      assert.equal(confirmation.status, 201);
      assert.equal((await confirmation.json() as { amount: string }).amount, "2.5");
      assert.equal(await balance(sender.address), parseUnits("0.5", 18));
      assert.equal(await balance(recipient.address), parseUnits("2.5", 18));
      assert.equal((await post("/api/stocks/transfers/confirm", { ...request, transactionHash })).status, 409);
      const history = await (await fetch(`${origin}/api/stocks/transfers`, { headers: { Cookie: cookie } })).json() as { transfers: Array<{ asset: { symbol: string; chainId: number } }> };
      assert.deepEqual(history.transfers.map((entry) => [entry.asset.symbol, entry.asset.chainId]), [["TSLA", 46630]]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("deploys the claim escrow, holds real faucet TSLA in it, and releases it to the OAuth-matched wallet", async () => {
    const operator = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey());
    const attestorKey = generatePrivateKey();
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });
    const balance = (owner: Address) => publicClient.readContract({ address: TSLA.address, abi: erc20, functionName: "balanceOf", args: [owner] });
    await testClient.impersonateAccount({ address: holder });
    await testClient.setBalance({ address: holder, value: parseEther("1") });
    await testClient.setBalance({ address: operator.address, value: parseEther("1") });
    await testClient.setBalance({ address: recipient.address, value: parseEther("1") });
    const holderWallet = createWalletClient({ account: holder, chain, transport: http(rpcUrl) });
    const funding = await holderWallet.sendTransaction({ to: TSLA.address, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [operator.address, parseUnits("3", 18)] }) });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: funding })).status, "success");
    await testClient.stopImpersonatingAccount({ address: holder });

    const identities = new VerifiedIdentityService();
    const stockTransfers = new StockTransferService({
      networks: { "robinhood-testnet": { enabled: true, client: robinhoodChainClient(rpcUrl) } },
      repository: new MemoryStockTransferRepository(),
    });
    const stockClaims = new StockClaimService({
      transfers: stockTransfers,
      repository: new MemoryStockClaimRepository(),
      directory: { lookup: async () => ({ platform: "github", providerUserId: "fork-583231", username: "octo-fork" }) },
      config: readStockClaimConfig({ CLAIM_ATTESTOR_PRIVATE_KEY: attestorKey, CONTRACT_OWNER_ADDRESS: operator.address }),
    });
    const server = await listen(createApp({ auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "robinhood-fork-claim-secret-32-chars" }), identities, stockTransfers, stockClaims }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const signIn = async (account: typeof operator) => {
      const challenge = await (await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: account.address }) })).json() as { id: string; message: string };
      const login = await fetch(`${origin}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) }),
      });
      return login.headers.get("set-cookie")?.split(";")[0] ?? "";
    };
    const post = (cookie: string, path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

    try {
      const operatorCookie = await signIn(operator);
      const status = await (await fetch(`${origin}/api/stocks/escrow`)).json() as { networks: StockEscrowDeployment[] };
      const testnet = status.networks.find((entry) => entry.network === "robinhood-testnet")!;
      const operatorWallet = createWalletClient({ account: operator, chain, transport: http(rpcUrl) });
      const vaultHash = await operatorWallet.deployContract({ abi: burnVaultAbi, bytecode: BURN_VAULT_ARTIFACT.bytecode });
      const burnVault = getAddress((await publicClient.waitForTransactionReceipt({ hash: vaultHash })).contractAddress!);
      const routerHash = await operatorWallet.deployContract({ abi: payRouterAbi, bytecode: PAY_ROUTER_ARTIFACT.bytecode, args: [burnVault, operator.address] });
      const router = getAddress((await publicClient.waitForTransactionReceipt({ hash: routerHash })).contractAddress!);
      const deployment = await operatorWallet.deployContract({ abi: stockClaimEscrowAbi, bytecode: STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, args: [testnet.verifier!, router] });
      assert.equal((await publicClient.waitForTransactionReceipt({ hash: deployment })).status, "success");
      const registered = await post(operatorCookie, "/api/stocks/escrow/register", { network: "robinhood-testnet", transactionHash: deployment });
      assert.equal(registered.status, 201);
      const escrow = (await registered.json() as StockEscrowDeployment).escrow!.address;

      const draft = await (await post(operatorCookie, "/api/chat", { message: "Send 2 TSLA to @octo-fork on GitHub", networkPreference: "robinhood-testnet" })).json() as {
        status: string; units: string; escrow: Address;
        stockIntent: { asset: { symbol: string; address: Address }; amount: string; recipient: { platform: "github"; username: string } };
      };
      assert.equal(draft.status, "stock_claim_review");
      const request = { network: "robinhood-testnet", token: { symbol: "TSLA", address: TSLA.address }, amount: draft.stockIntent.amount, recipient: draft.stockIntent.recipient };
      const prepared = await (await post(operatorCookie, "/api/stocks/claims/prepare", { ...request, expiryHours: 72 })).json() as PreparedStockClaimFunding;
      assert.equal(matchesStockClaimFunding(prepared, {
        network: "robinhood-testnet", token: TSLA.address, payer: operator.address, units: draft.units, escrow, platform: "github", nowSeconds: Math.floor(Date.now() / 1000),
      }), true);
      const hashes = [];
      for (const transaction of prepared.transactions) {
        const hash = await operatorWallet.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n });
        assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, "success");
        hashes.push(hash);
      }
      assert.equal(await balance(escrow), parseUnits("2.02", 18), "the real Stock contract delivered the exact amount and the 1% fee to the escrow");
      const confirmed = await post(operatorCookie, "/api/stocks/claims/confirm-funding", { ...request, escrow, paymentId: prepared.paymentId, transactionHash: hashes[1] });
      assert.equal(confirmed.status, 201);

      identities.link(recipient.address, { platform: "github", providerUserId: "fork-583231", username: "octo-fork", verifiedAt: new Date().toISOString() });
      const recipientCookie = await signIn(recipient);
      const claim = await (await post(recipientCookie, `/api/stocks/claims/robinhood-testnet/${prepared.paymentId}/prepare-claim`, {})).json() as PreparedStockClaimAction;
      assert.equal(matchesStockClaimAction(claim, { network: "robinhood-testnet", escrow, wallet: recipient.address, paymentId: prepared.paymentId, action: "claim" }), true);
      const recipientWallet = createWalletClient({ account: recipient, chain, transport: http(rpcUrl) });
      const claimHash = await recipientWallet.sendTransaction({ to: claim.transaction.to, data: claim.transaction.data, value: 0n });
      assert.equal((await publicClient.waitForTransactionReceipt({ hash: claimHash })).status, "success");
      assert.equal(await balance(recipient.address), parseUnits("2", 18));
      assert.equal(await balance(escrow), 0n);
      // The operator funded 2 TSLA plus the 0.02 fee, and as treasury got half of that fee back on the claim.
      assert.equal(await balance(operator.address), parseUnits("0.99", 18));
      assert.equal(await balance(burnVault), parseUnits("0.01", 18));
      const details = await (await fetch(`${origin}/api/stocks/claims/robinhood-testnet/${prepared.paymentId}`)).json() as { status: string };
      assert.equal(details.status, "settled");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

async function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing fork test port."));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function listen(app: ReturnType<typeof createApp>) {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function waitForRpc(rpcUrl: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Anvil fork did not start.");
}
