import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { readArcNetworkConfig } from "../server/arc-network";
import type { ChainReceipt } from "../server/receipts";
import { WalletAuthService } from "../server/wallet-auth";
import { receiptSource } from "../src/domain/transaction-receipt";

const payer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const hash = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const [mined, pending, foreign, broken] = [hash("a1"), hash("b2"), hash("c3"), hash("d4")];

/** One chain's receipts: mined from the payer, not yet mined, sent by someone else, or an RPC that fails. */
function chain(blockNumber: bigint) {
  return async ({ hash: wanted }: { hash: Hex }): Promise<ChainReceipt | null> => {
    if (wanted === mined) return { status: "success", blockNumber, from: payer.address.toLowerCase() as Address, contractAddress: null };
    if (wanted === foreign) return { status: "success", blockNumber, from: stranger.address };
    if (wanted === broken) throw new Error("RPC unavailable");
    return null;
  };
}

describe("receipts read through the server for every wallet flow", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const robinhood = chain(77n);
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "receipt-api-secret-with-32-characters" }),
      network: readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }),
      arcReceipts: chain(42n),
      stockTransfers: {
        availability: () => ({ enabled: true }),
        prepare: async () => { throw new Error("unused"); },
        confirm: async () => { throw new Error("unused"); },
        list: async () => [],
        readReceipt: async (_network, wanted) => await robinhood({ hash: wanted }) as never,
      },
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

  async function session(account: typeof payer) {
    const challenge = await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: account.address }) }).then((response) => response.json()) as { id: string; message: string };
    const login = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) }) });
    return (login.headers.get("set-cookie") ?? "").split(";")[0];
  }

  it("answers only the session wallet's own transactions, on Arc and on Robinhood Chain", async () => {
    assert.equal((await fetch(`${origin}/api/receipts/arc/${mined}`)).status, 401);
    const cookie = await session(payer);
    const read = (path: string) => fetch(`${origin}/api/receipts/${path}`, { headers: { Cookie: cookie } });
    const arc = await read(`arc/${mined}`);
    assert.equal(arc.status, 200);
    assert.equal(arc.headers.get("cache-control"), "no-store");
    assert.deepEqual(await arc.json(), { receipt: { status: "0x1", blockNumber: "0x2a", contractAddress: null } });
    assert.deepEqual(await (await read(`robinhood-mainnet/${mined}`)).json(), { receipt: { status: "0x1", blockNumber: "0x4d", contractAddress: null } });
    assert.deepEqual(await (await read(`arc/${pending}`)).json(), { receipt: null });
    assert.equal((await read(`arc/${foreign}`)).status, 403);
    assert.equal((await read(`robinhood-mainnet/${foreign}`)).status, 403);
    assert.equal((await read(`arc/${broken}`)).status, 503);
    assert.equal((await read("arc/0x1234")).status, 400);
    assert.equal((await read(`ethereum/${mined}`)).status, 400);
  });

  it("lets the browser fall back to the wallet when the server has no receipt, and treats failures as not mined yet", async () => {
    const wallet = (receipt: unknown) => ({ request: async () => receipt });
    const serverSays = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    assert.deepEqual(await receiptSource("arc", mined, wallet(null), serverSays(200, { receipt: { status: "0x1", blockNumber: "0x2a" } }))(), { status: "0x1", blockNumber: "0x2a" });
    assert.deepEqual(await receiptSource("arc", mined, wallet({ status: "0x1", blockNumber: "0x2b" }), serverSays(200, { receipt: null }))(), { status: "0x1", blockNumber: "0x2b" }, "the wallet's RPC may be ahead");
    assert.deepEqual(await receiptSource("arc", mined, wallet({ status: "0x1", blockNumber: "0x2c" }), serverSays(503, { error: "down" }))(), { status: "0x1", blockNumber: "0x2c" });
    const failing = { request: async () => { throw new Error("wallet lost the request"); } };
    assert.equal(await receiptSource("arc", mined, failing, async () => { throw new TypeError("offline"); })(), null);
  });
});
