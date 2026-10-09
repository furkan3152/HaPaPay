import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { getContractAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp, type ArcMainnetSetup } from "../server/app";
import { readArcContractConfig, readArcNetworkConfig } from "../server/arc-network";
import type { ArcMainnetReader } from "../server/arc-mainnet-deployment";
import { WalletAuthService } from "../server/wallet-auth";
import { compileOperatorContract } from "../scripts/generate-stock-claim-escrow-artifact";

const operator = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const minedHash = `0x${"a1".repeat(32)}` as Hex;
const pendingHash = `0x${"b2".repeat(32)}` as Hex;
const foreignHash = `0x${"c3".repeat(32)}` as Hex;
const brokenHash = `0x${"d4".repeat(32)}` as Hex;

describe("Arc Mainnet operator reads over HTTP", () => {
  let server: Server;
  let origin: string;
  const forwarder = getContractAddress({ from: operator.address, nonce: 4n });

  before(async () => {
    const forwarderCode = (await compileOperatorContract("HaPaPayFeeForwarder")).deployedBytecode as Hex;
    const reader: ArcMainnetReader = {
      getTransactionCount: async () => 5,
      getBytecode: async ({ address }) => address === forwarder ? forwarderCode : undefined,
      readContract: async ({ address, functionName }) => {
        if (address === forwarder && functionName === "treasury") return operator.address;
        throw new Error("execution reverted");
      },
      getTransactionReceipt: async ({ hash }) => {
        if (hash === minedHash) return { status: "success", blockNumber: 42n, from: operator.address, contractAddress: forwarder.toLowerCase() as Address };
        if (hash === foreignHash) return { status: "success", blockNumber: 43n, from: stranger.address, contractAddress: null };
        if (hash === brokenHash) throw new Error("RPC unavailable");
        return null;
      },
    };
    const contracts = readArcContractConfig({ ARC_MAINNET_OPERATOR_ADDRESS: operator.address, ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY: generatePrivateKey(), ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: generatePrivateKey() }, "mainnet");
    const arcMainnetSetup: ArcMainnetSetup = { contracts, live: false, problems: {}, reader: () => reader };
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "arc-mainnet-setup-api-secret-32-chars" }),
      network: readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }),
      arcMainnetSetup,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no port");
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function session(account: typeof operator) {
    const challenge = await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: account.address }) }).then((response) => response.json()) as { id: string; message: string };
    const login = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) }) });
    return (login.headers.get("set-cookie") ?? "").split(";")[0];
  }

  it("lets only the operator's session read its deployment, and finds what is already on chain", async () => {
    assert.equal((await fetch(`${origin}/api/arc/mainnet-setup/deployment`)).status, 401);
    assert.equal((await fetch(`${origin}/api/arc/mainnet-setup/deployment`, { headers: { Cookie: await session(stranger) } })).status, 403);
    const response = await fetch(`${origin}/api/arc/mainnet-setup/deployment`, { headers: { Cookie: await session(operator) } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { deployment: { forwarder } });
  });

  it("reads a deployment receipt from Arc Mainnet for the operator, never one from another sender", async () => {
    const cookie = await session(operator);
    const read = async (hash: string) => fetch(`${origin}/api/arc/mainnet-setup/receipt/${hash}`, { headers: { Cookie: cookie } });
    const mined = await read(minedHash);
    assert.equal(mined.status, 200);
    assert.deepEqual(await mined.json(), { receipt: { status: "0x1", blockNumber: "0x2a", contractAddress: forwarder } });
    assert.deepEqual(await (await read(pendingHash)).json(), { receipt: null });
    assert.equal((await read(foreignHash)).status, 403);
    assert.equal((await read(brokenHash)).status, 503);
    assert.equal((await read("0x1234")).status, 400);
    assert.equal((await fetch(`${origin}/api/arc/mainnet-setup/receipt/${minedHash}`, { headers: { Cookie: await session(stranger) } })).status, 403);
  });
});
