import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { IdentityRegistryLinkService } from "./fixtures/identity-registry-calls";
import { resolveFoundryBinary } from "../scripts/foundry-binary";
import { ARC_IDENTITY_REGISTRY_ARTIFACT } from "../src/domain/arc-identity-registry-artifact";
import { arcIdentityRegistryAbi } from "../src/domain/arc-identity-registry";

const mnemonic = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 5_042_002,
  name: "Arc Testnet contract security simulation",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
const registryAbi = parseAbi([
  "function securityRevision() pure returns (uint256)",
  "function setVerifier(address newVerifier)",
  "function transferOwnership(address newOwner)",
  "function verifier() view returns (address)",
  "function owner() view returns (address)",
  "function nonces(address wallet) view returns (uint256)",
]);
const registryArtifact = { abi: arcIdentityRegistryAbi, bytecode: ARC_IDENTITY_REGISTRY_ARTIFACT.bytecode };

// Arc vault links use the reviewed StockClaimEscrow, whose adversarial-token, signature-binding, window and solvency
// cases run in foundry-test/StockClaimEscrow.t.sol; this suite covers the Arc identity registry the operator deploys.
describe("ArcIdentityRegistry binding and rotation on a real EVM", () => {
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

  it("reports security revision 2 from the committed registry build", async () => {
    const owner = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const wallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
    const registry = await deploy(publicClient, wallet, registryArtifact, [owner.address]);
    assert.equal(await publicClient.readContract({ address: registry, abi: registryAbi, functionName: "securityRevision" }), 2n);
  });

  it("binds registry attestations to one contract and enforces verifier and owner rotation", async () => {
    const owner = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const identityWallet = mnemonicToAccount(mnemonic, { addressIndex: 2 });
    const nextVerifier = mnemonicToAccount(mnemonic, { addressIndex: 3 });
    const stranger = mnemonicToAccount(mnemonic, { addressIndex: 4 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
    const identityWalletClient = createWalletClient({ account: identityWallet, chain, transport: http(rpcUrl) });
    const nextVerifierWallet = createWalletClient({ account: nextVerifier, chain, transport: http(rpcUrl) });
    const strangerWallet = createWalletClient({ account: stranger, chain, transport: http(rpcUrl) });
    const firstRegistry = await deploy(publicClient, ownerWallet, registryArtifact, [owner.address]);
    const secondRegistry = await deploy(publicClient, ownerWallet, registryArtifact, [owner.address]);
    const account = { platform: "github" as const, providerUserId: "registry-42", username: "registry-user", verifiedAt: new Date().toISOString() };
    const now = (await publicClient.getBlock()).timestamp;
    const service = (registry: Address, attestor: ReturnType<typeof mnemonicToAccount>) => new IdentityRegistryLinkService({
      chainId: chain.id,
      registry,
      attestor,
      now: () => new Date(Number(now) * 1000),
      readNonce: (wallet) => publicClient.readContract({ address: registry, abi: registryAbi, functionName: "nonces", args: [wallet] }),
    });

    const oldAttestation = await service(firstRegistry, owner).prepare(identityWallet.address, account);
    await assert.rejects(() => identityWalletClient.sendTransaction({ to: secondRegistry, data: oldAttestation.transaction.data, value: 0n }));
    await assert.rejects(() => strangerWallet.writeContract({ address: firstRegistry, abi: registryAbi, functionName: "setVerifier", args: [nextVerifier.address] }));
    await confirmed(publicClient, ownerWallet.writeContract({ address: firstRegistry, abi: registryAbi, functionName: "setVerifier", args: [nextVerifier.address] }));
    await assert.rejects(() => identityWalletClient.sendTransaction({ to: firstRegistry, data: oldAttestation.transaction.data, value: 0n }));

    const rotatedAttestation = await service(firstRegistry, nextVerifier).prepare(identityWallet.address, account);
    await confirmed(publicClient, identityWalletClient.sendTransaction({ to: firstRegistry, data: rotatedAttestation.transaction.data, value: 0n }));
    await assert.rejects(() => identityWalletClient.sendTransaction({ to: firstRegistry, data: rotatedAttestation.transaction.data, value: 0n }));

    await confirmed(publicClient, ownerWallet.writeContract({ address: firstRegistry, abi: registryAbi, functionName: "transferOwnership", args: [nextVerifier.address] }));
    await assert.rejects(() => ownerWallet.writeContract({ address: firstRegistry, abi: registryAbi, functionName: "setVerifier", args: [owner.address] }));
    await confirmed(publicClient, nextVerifierWallet.writeContract({ address: firstRegistry, abi: registryAbi, functionName: "setVerifier", args: [owner.address] }));
    assert.equal(await publicClient.readContract({ address: firstRegistry, abi: registryAbi, functionName: "owner" }), nextVerifier.address);
    assert.equal(await publicClient.readContract({ address: firstRegistry, abi: registryAbi, functionName: "verifier" }), owner.address);
  });
});


async function deploy(
  publicClient: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  artifact: { abi: readonly unknown[]; bytecode: Hex },
  args: readonly unknown[] = [],
) {
  const hash = await wallet.deployContract({ account: wallet.account!, chain, abi: artifact.abi, bytecode: artifact.bytecode, args });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
}

async function confirmed(client: ReturnType<typeof createPublicClient>, hashPromise: Promise<Hex>) {
  const receipt = await client.waitForTransactionReceipt({ hash: await hashPromise });
  assert.equal(receipt.status, "success");
}

async function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing security test port."));
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
