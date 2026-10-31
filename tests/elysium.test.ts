import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseEther, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { resolveFoundryBinary } from "../scripts/foundry-binary";
import { MemoryAdminSettingsRepository } from "../server/admin-service";
import { cleanHttpsUrl, ElysiumRequestError, ElysiumService, matchesRuntime } from "../server/elysium-service";
import { ELYSA_PASS_ARTIFACT, ELYSA_PAY_ROUTER_ARTIFACT, ELYSA_TOKEN_ARTIFACT } from "../src/domain/elysium-artifacts";
import { countdown, elysiumFee, elysiumNoteBytes, elysiumTxUrl, elysiumWalletChain, ELYSIUM_TESTNET, formatHype, parseHype } from "../src/domain/elysium";

const mnemonic = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: ELYSIUM_TESTNET.chainId,
  name: "Elysium Testnet simulation",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});

describe("Elysium domain rules", () => {
  it("adds the 1% fee on top and rounds it up, like the router", () => {
    assert.equal(elysiumFee(parseEther("1")), parseEther("0.01"));
    assert.equal(elysiumFee(1n), 1n);
    assert.equal(elysiumFee(100n), 1n);
    assert.equal(elysiumFee(101n), 2n);
  });

  it("reads HYPE amounts people write and refuses anything else", () => {
    assert.equal(parseHype("0.5"), parseEther("0.5"));
    assert.equal(parseHype("2,25"), parseEther("2.25"));
    assert.equal(parseHype("0"), undefined);
    assert.equal(parseHype("-1"), undefined);
    assert.equal(parseHype("1e3"), undefined);
    assert.equal(parseHype("0.1234567890123456789"), undefined);
    assert.equal(formatHype(parseEther("1.5")), "1.5");
    assert.equal(formatHype(parseEther("2")), "2");
  });

  it("limits notes to 160 bytes and builds wallet and explorer entries", () => {
    assert.ok(elysiumNoteBytes("kira için"));
    assert.equal(elysiumNoteBytes("x".repeat(161)), undefined);
    const wallet = elysiumWalletChain({ chainIdHex: "0x185d9", chainName: "Elysium Testnet", rpcUrl: ELYSIUM_TESTNET.rpcUrl!, explorerUrl: ELYSIUM_TESTNET.explorerUrl! });
    assert.equal(wallet.nativeCurrency.symbol, "HYPE");
    assert.equal(wallet.chainId, `0x${(99_801).toString(16)}`);
    assert.equal(elysiumTxUrl({ explorerUrl: "https://explorer-elysium-testnet.t.conduit.xyz/", explorerTxPath: "/tx/" }, "0xabc"), "https://explorer-elysium-testnet.t.conduit.xyz/tx/0xabc");
  });

  it("counts down to the mainnet launch and stops at zero", () => {
    const left = countdown("2026-11-09T00:00:00Z", Date.parse("2026-11-07T22:30:15Z"));
    assert.deepEqual(left, { done: false, days: 1, hours: 1, minutes: 29, seconds: 45 });
    assert.equal(countdown("2026-11-09T00:00:00Z", Date.parse("2026-11-10T00:00:00Z")).done, true);
  });

  it("accepts only clean https URLs", () => {
    assert.equal(cleanHttpsUrl("https://rpc.example.xyz/"), "https://rpc.example.xyz");
    assert.equal(cleanHttpsUrl("http://rpc.example.xyz"), undefined);
    assert.equal(cleanHttpsUrl("https://user:pass@rpc.example.xyz"), undefined);
    assert.equal(cleanHttpsUrl("https://rpc.example.xyz#x"), undefined);
  });

  it("matches runtime code only outside immutable ranges", () => {
    const artifact = { runtime: "0x6001aaaa6002", immutables: [[2, 2]] as const };
    assert.equal(matchesRuntime("0x6001bbbb6002", artifact), true);
    assert.equal(matchesRuntime("0x6001bbbb6003", artifact), false);
    assert.equal(matchesRuntime("0x6001bbbb", artifact), false);
    assert.equal(matchesRuntime(undefined, artifact), false);
  });
});

describe("Elysium payments on a real EVM", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;

  before(async () => {
    const port = await unusedPort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(resolveFoundryBinary("anvil"), ["--silent", "--port", String(port), "--chain-id", String(chain.id), "--mnemonic", mnemonic], { stdio: "ignore" });
    await waitForRpc(rpcUrl);
  });

  after(async () => {
    if (!anvil.killed) anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => anvil.once("exit", () => resolve()));
  });

  it("deploys from the admin's wallet, registers, pays a verified handle and records it from the receipt", async () => {
    const admin = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const sender = mnemonicToAccount(mnemonic, { addressIndex: 1 });
    const recipient = mnemonicToAccount(mnemonic, { addressIndex: 2 });
    const treasury = mnemonicToAccount(mnemonic, { addressIndex: 3 }).address;
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const adminWallet = createWalletClient({ account: admin, chain, transport: http(rpcUrl) });
    const senderWallet = createWalletClient({ account: sender, chain, transport: http(rpcUrl) });

    const deploy = async (hash: Hex) => (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    const router = await deploy(await adminWallet.deployContract({ abi: ELYSA_PAY_ROUTER_ARTIFACT.abi, bytecode: ELYSA_PAY_ROUTER_ARTIFACT.bytecode as Hex, args: [treasury] }));
    const token = await deploy(await adminWallet.deployContract({ abi: ELYSA_TOKEN_ARTIFACT.abi, bytecode: ELYSA_TOKEN_ARTIFACT.bytecode as Hex, args: ["Elysa", "ELYSA", parseEther("1000000"), admin.address] }));
    const pass = await deploy(await adminWallet.deployContract({ abi: ELYSA_PASS_ARTIFACT.abi, bytecode: ELYSA_PASS_ARTIFACT.bytecode as Hex, args: ["Elysian Pass", "EPASS", 1000n, true, "https://elysapay.xyz/pass/", admin.address] }));
    const stranger = mnemonicToAccount(mnemonic, { addressIndex: 4 });
    const foreignToken = await deploy(await adminWallet.deployContract({ abi: ELYSA_TOKEN_ARTIFACT.abi, bytecode: ELYSA_TOKEN_ARTIFACT.bytecode as Hex, args: ["Other", "OTH", 1n, stranger.address] }));

    const settings = new MemoryAdminSettingsRepository();
    const handles = new Map<string, Address>([["x:alice", recipient.address], ["x:me", sender.address]]);
    const service = new ElysiumService({
      settings,
      resolve: (platform, username) => handles.get(`${platform}:${username}`),
      client: () => createPublicClient({ chain, transport: http(rpcUrl) }),
    });
    const isAdmin = (address: Address) => getAddress(address) === admin.address;

    // Testnet is open by default, mainnet is off until an admin adds its RPC; nothing pays before a router exists.
    const before = await service.views();
    assert.equal(before[0].enabled, true);
    assert.equal(before[1].enabled, false);
    assert.match(before[1].reason ?? "", /not switched on/);
    await assert.rejects(service.preparePayment({ network: "elysium-testnet", sender: sender.address, platform: "x", username: "alice", amount: "1" }), /router is not deployed/);

    // Only ElysaPay's own builds are registered, and only when an admin controls them.
    assert.equal((await service.inspectContract("elysium-testnet", "router", router, isAdmin)).treasury, treasury);
    assert.equal((await service.inspectContract("elysium-testnet", "token", token, isAdmin)).owner, admin.address);
    await service.inspectContract("elysium-testnet", "pass", pass, isAdmin);
    await assert.rejects(service.inspectContract("elysium-testnet", "token", foreignToken, isAdmin), /not an admin wallet/);
    await assert.rejects(service.inspectContract("elysium-testnet", "router", token, isAdmin), /not the ElysaPayRouter build/);
    await assert.rejects(service.inspectContract("elysium-testnet", "router", treasury, isAdmin), /No contract/);
    await service.setContract("elysium-testnet", "router", router, admin.address);

    // Live stats read the chain and refuse a wrong chain ID.
    const stats = await service.stats("elysium-testnet");
    assert.ok(BigInt(stats.blockNumber) > 0n);

    // A handle without a verified wallet, the sender's own handle and a bad amount are refused.
    await assert.rejects(service.preparePayment({ network: "elysium-testnet", sender: sender.address, platform: "x", username: "nobody", amount: "1" }), (error: unknown) => error instanceof ElysiumRequestError && error.status === 404);
    await assert.rejects(service.preparePayment({ network: "elysium-testnet", sender: sender.address, platform: "x", username: "me", amount: "1" }), /your own wallet/);
    await assert.rejects(service.preparePayment({ network: "elysium-testnet", sender: sender.address, platform: "x", username: "alice", amount: "abc" }), /amount in HYPE/);

    const prepared = await service.preparePayment({ network: "elysium-testnet", sender: sender.address, platform: "x", username: "@Alice", amount: "1.5", note: "kira" });
    assert.equal(prepared.to, getAddress(router));
    assert.equal(prepared.value, (parseEther("1.5") + parseEther("0.015")).toString());
    assert.equal(prepared.display.fee, "0.015");
    assert.equal(prepared.recipient, recipient.address);

    const before0 = await publicClient.getBalance({ address: recipient.address });
    const hash = await senderWallet.sendTransaction({ to: prepared.to, data: prepared.data, value: BigInt(prepared.value), gas: BigInt(prepared.gas) });
    await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(await publicClient.getBalance({ address: recipient.address }) - before0, parseEther("1.5"));
    assert.equal(await publicClient.getBalance({ address: treasury }) - parseEther("10000"), parseEther("0.015"));

    // Someone else cannot claim the payment, and a confirmation for another handle is refused.
    await assert.rejects(service.confirmPayment({ network: "elysium-testnet", sender: recipient.address, hash, platform: "x", username: "alice" }), /not sent by your wallet/);
    handles.set("x:bob", stranger.address);
    await assert.rejects(service.confirmPayment({ network: "elysium-testnet", sender: sender.address, hash, platform: "x", username: "bob" }), /did not pay the wallet @bob/);
    const confirmed = await service.confirmPayment({ network: "elysium-testnet", sender: sender.address, hash, platform: "x", username: "alice" });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.status === "confirmed" && confirmed.payment.amount, "1.5");
    assert.equal(confirmed.status === "confirmed" && confirmed.payment.note, "kira");
    // A repeat answers with the same record; history shows it to both sides.
    assert.deepEqual(await service.confirmPayment({ network: "elysium-testnet", sender: sender.address, hash, platform: "x", username: "alice" }), confirmed);
    assert.equal((await service.history(sender.address)).length, 1);
    assert.equal((await service.history(recipient.address)).length, 1);
    assert.equal((await service.history(treasury)).length, 0);

    // An admin mint is recorded only for the admin's own transaction to a registered contract.
    await service.setContract("elysium-testnet", "token", token, admin.address);
    const mint = await adminWallet.writeContract({ address: token, abi: ELYSA_TOKEN_ARTIFACT.abi, functionName: "mint", args: [recipient.address, parseEther("5"), `0x${"0".repeat(64)}`] });
    await publicClient.waitForTransactionReceipt({ hash: mint });
    const recorded = await service.readAdminTransaction("elysium-testnet", mint, admin.address);
    assert.equal(recorded.status, "confirmed");
    await assert.rejects(service.readAdminTransaction("elysium-testnet", mint, sender.address), /not sent by your wallet/);
    await assert.rejects(service.readAdminTransaction("elysium-testnet", hash, sender.address), /neither deployed/);

    // Mainnet cannot be switched on with an RPC on another chain (here, the testnet simulation).
    await assert.rejects(service.setNetwork("elysium-mainnet", { enabled: true, rpcUrl: "https://rpc.elysium.example" }, admin.address), /not Elysium mainnet/);
    await assert.rejects(service.setNetwork("elysium-mainnet", { enabled: true, rpcUrl: "https://testnet-rpc.elysium.example" }, admin.address), /testnet RPC/);
    const off = await service.setNetwork("elysium-mainnet", { enabled: false, rpcUrl: "https://rpc.elysium.example", explorerUrl: "https://explorer.elysium.example" }, admin.address);
    assert.equal(off.enabled, false);
    assert.equal(off.rpcUrl, "https://rpc.elysium.example");
  });
});

async function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No port."));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForRpc(url: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Anvil RPC did not start.");
}
