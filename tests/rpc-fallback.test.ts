import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createPublicClient } from "viem";
import { ARC_MAINNET_FALLBACK_RPC_URLS, arcReadTransport, arcServerTransport } from "../server/arc-network";
import { robinhoodChainClient } from "../server/robinhood-network";

type Rpc = { url: string; calls: number; server: Server };

/** A JSON-RPC endpoint that answers eth_chainId, or fails the way a public endpoint does when its backends disagree. */
async function endpoint(answer: "chain" | "http-500" | "rpc-32014" | "revert"): Promise<Rpc> {
  const rpc = { url: "", calls: 0, server: undefined as unknown as Server };
  rpc.server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      rpc.calls++;
      const { id } = JSON.parse(body) as { id: number };
      if (answer === "http-500") return void response.writeHead(500).end("upstream down");
      response.writeHead(200, { "content-type": "application/json" });
      if (answer === "rpc-32014") return void response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32014, message: "block height mismatch" } }));
      if (answer === "revert") return void response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: "0x" } }));
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x13b2" }));
    });
  });
  await new Promise<void>((resolve) => rpc.server.listen(0, "127.0.0.1", resolve));
  const address = rpc.server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  rpc.url = `http://127.0.0.1:${address.port}`;
  return rpc;
}

describe("RPC fallbacks", () => {
  const rpcs: Rpc[] = [];
  let healthy: Rpc;
  let down: Rpc;
  let disagreeing: Rpc;
  let reverting: Rpc;

  before(async () => {
    [healthy, down, disagreeing, reverting] = await Promise.all([endpoint("chain"), endpoint("http-500"), endpoint("rpc-32014"), endpoint("revert")]);
    rpcs.push(healthy, down, disagreeing, reverting);
  });
  after(async () => { await Promise.all(rpcs.map((rpc) => new Promise((resolve) => rpc.server.close(resolve)))); });

  it("reads Arc Mainnet through the documented keyless endpoints when Circle's fails", async () => {
    assert.deepEqual(ARC_MAINNET_FALLBACK_RPC_URLS, ["https://rpc.quicknode.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io"]);
    for (const failing of [down, disagreeing]) {
      const before = healthy.calls;
      const client = createPublicClient({ transport: arcReadTransport(failing.url, "mainnet", [healthy.url]) });
      assert.equal(await client.getChainId(), 5042);
      assert.ok(healthy.calls > before, "the fallback answered");
    }
  });

  it("keeps a contract revert as the answer instead of asking another endpoint", async () => {
    const before = healthy.calls;
    const client = createPublicClient({ transport: arcReadTransport(reverting.url, "mainnet", [healthy.url]) });
    await assert.rejects(client.call({ to: "0x0000000000000000000000000000000000000001", data: "0x" }), /revert/i);
    assert.equal(healthy.calls, before);
  });

  it("reads Arc Mainnet through a provider first, then the official endpoint, then the keyless ones", async () => {
    const [provider, official] = await Promise.all([endpoint("chain"), endpoint("chain")]);
    rpcs.push(provider, official);
    const client = createPublicClient({ transport: arcServerTransport({ rpcUrl: official.url, serverRpcUrl: provider.url, environment: "mainnet" }) });
    assert.equal(await client.getChainId(), 5042);
    assert.equal(provider.calls, 1);
    assert.equal(official.calls, 0, "the official endpoint is not asked while the provider answers");
    const failing = createPublicClient({ transport: arcServerTransport({ rpcUrl: official.url, serverRpcUrl: down.url, environment: "mainnet" }) });
    assert.equal(await failing.getChainId(), 5042);
    assert.equal(official.calls, 1, "the official endpoint answers when the provider fails");
    const without = createPublicClient({ transport: arcServerTransport({ rpcUrl: official.url, environment: "mainnet" }) });
    assert.equal(await without.getChainId(), 5042);
    assert.equal(official.calls, 2);
  });

  it("does not fall back on Arc Testnet", async () => {
    const before = healthy.calls;
    const client = createPublicClient({ transport: arcReadTransport(down.url, "testnet", [healthy.url]) });
    await assert.rejects(client.getChainId());
    assert.equal(healthy.calls, before);
  });

  it("falls back from a provider RPC to Robinhood Chain's public one", async () => {
    assert.equal(await robinhoodChainClient(down.url, healthy.url).getChainId(), 5042);
    const before = down.calls;
    await assert.rejects(robinhoodChainClient(down.url, down.url).getChainId(), "the same URL twice is one endpoint");
    assert.ok(down.calls - before <= 2, "one endpoint with one retry");
    assert.equal(await robinhoodChainClient(healthy.url).getChainId(), 5042);
  });
});
