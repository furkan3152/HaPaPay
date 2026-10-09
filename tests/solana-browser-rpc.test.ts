import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../server/app";
import { ARC_MAINNET, readArcNetworkConfig } from "../server/arc-network";
import { readSolanaConfig } from "../server/solana-network";
import type { SolanaDesk } from "../server/solana-routes";
import { WalletAuthService } from "../server/wallet-auth";
import { SOLANA_MAINNET, parseSolanaBrowserRpcUrl } from "../src/domain/solana-chains";

const PAGE_RPC = "https://example-name.solana-mainnet.quiknode.pro/0123456789abcdef/";
const ARC_PROVIDER = "https://example-name.arc-mainnet.quiknode.pro/fedcba9876543210/";

/**
 * Solana's public endpoint answers 403 to any request that carries a browser's Origin, so pages read and send through
 * a QuickNode Solana endpoint the server names. Its token is public by design; the server's own provider URLs never leave it.
 */
describe("the pages' Solana RPC", () => {
  it("accepts only an https QuickNode Solana mainnet endpoint", () => {
    assert.equal(parseSolanaBrowserRpcUrl(PAGE_RPC), PAGE_RPC);
    assert.equal(parseSolanaBrowserRpcUrl(` ${PAGE_RPC} `), PAGE_RPC);
    for (const value of [
      "http://example-name.solana-mainnet.quiknode.pro/token/",
      "https://user:secret@example-name.solana-mainnet.quiknode.pro/token/",
      "https://example-name.solana-mainnet.quiknode.pro:8443/token/",
      "https://example-name.solana-mainnet.quiknode.pro/token/#part",
      "https://example-name.solana-devnet.quiknode.pro/token/",
      "https://solana-mainnet.quiknode.pro/token/",
      "https://a.b.solana-mainnet.quiknode.pro/token/",
      "https://example-name.solana-mainnet.quiknode.pro.attacker.example/token/",
      SOLANA_MAINNET.rpcUrl,
      "not a url",
      undefined,
      42,
    ]) assert.equal(parseSolanaBrowserRpcUrl(value), undefined, String(value));
  });

  it("is read from SOLANA_BROWSER_RPC_URL, and anything else is reported by name without its value", () => {
    assert.equal(readSolanaConfig({ SOLANA_BROWSER_RPC_URL: PAGE_RPC }).browserRpcUrl, PAGE_RPC);
    assert.equal(readSolanaConfig({}).browserRpcUrl, undefined);
    const wrong = readSolanaConfig({ SOLANA_BROWSER_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=secret-value" });
    assert.equal(wrong.browserRpcUrl, undefined);
    assert.ok(wrong.problems.some((problem) => problem.startsWith("SOLANA_BROWSER_RPC_URL")));
    assert.equal(wrong.problems.join(" ").includes("secret-value"), false);
  });

  it("never comes from Solana's public endpoint in browser code: every page reads through the page's RPC", async () => {
    const files: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(new URL(directory, import.meta.url), { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(`${directory}${entry.name}/`);
        else if (/\.tsx?$/.test(entry.name)) files.push(`${directory}${entry.name}`);
      }
    };
    await walk("../src/");
    for (const file of files) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      assert.equal(/createSolanaRpc(Subscriptions)?\(SOLANA_MAINNET\.rpcUrl/.test(source), false, `${file} reads Solana's public endpoint`);
    }
    const privy = await readFile(new URL("../src/wallet/PrivyBridge.tsx", import.meta.url), "utf8");
    assert.match(privy, /solanaRpcs\(solanaRpcUrl\)/, "Privy's embedded Solana wallets use the page's RPC");
  });
});

describe("the server's RPC settings over HTTP", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "solana-browser-rpc-secret-32-characters" }),
      network: readArcNetworkConfig({ ARC_NETWORK_MODE: "mainnet", ARC_MAINNET_RPC_URL: ARC_PROVIDER }),
      solana: { config: readSolanaConfig({ SOLANA_BROWSER_RPC_URL: PAGE_RPC, SOLANA_RPC_URL: "https://server-name.solana-mainnet.quiknode.pro/server-token/" }) } as unknown as SolanaDesk,
      rpcProviders: { solana: true, solanaBrowser: true, arc: true, robinhood: false },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test port");
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  it("names the pages' Solana RPC and nothing of the server's own", async () => {
    const text = await (await fetch(`${origin}/api/providers`)).text();
    assert.equal((JSON.parse(text) as { solanaRpcUrl: unknown }).solanaRpcUrl, PAGE_RPC);
    assert.equal(text.includes("server-token"), false);
  });

  it("gives wallets Arc's official RPC and keeps the Arc provider on the server", async () => {
    const text = await (await fetch(`${origin}/api/network`)).text();
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.rpcUrl, ARC_MAINNET.rpcUrl);
    assert.equal("serverRpcUrl" in body, false);
    assert.equal(text.includes("fedcba9876543210"), false);
  });

  it("reports which networks read through a provider, as states only", async () => {
    const response = await fetch(`${origin}/api/health`);
    const text = await response.text();
    assert.deepEqual((JSON.parse(text) as { rpc: unknown }).rpc, { solana: "provider", solanaBrowser: "provider", arc: "provider", robinhood: "public" });
    assert.equal(/quiknode|server-token|fedcba9876543210|0123456789abcdef/.test(text), false, "no endpoint or token in the health report");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /connect-src[^;]* https:\/\/\*\.solana-mainnet\.quiknode\.pro wss:\/\/\*\.solana-mainnet\.quiknode\.pro/);
  });
});
