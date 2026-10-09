import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../server/app";
import { ARC_MAINNET, readArcNetworkConfig } from "../server/arc-network";
import { WalletAuthService } from "../server/wallet-auth";

describe("selected Arc network HTTP API", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "network-api-secret-with-32-characters" }),
      network: readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }),
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

  it("publishes testnet wallet and funding metadata", async () => {
    const response = await fetch(`${origin}/api/network`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.environment, "testnet");
    assert.equal(body.chainId, 5_042_002);
    assert.equal(body.chainIdHex, "0x4cef52");
    assert.equal(body.faucetUrl, "https://faucet.circle.com/");
    assert.deepEqual((body.paymentNetworks as Array<{ id: string; available: boolean }>).map(({ id, available }) => [id, available]), [
      ["arc-testnet", true], ["arc-mainnet", false], ["robinhood-testnet", false], ["robinhood-mainnet", false],
    ]);
  });

  it("reports selected-network readiness without claiming mainnet is configured", async () => {
    const response = await fetch(`${origin}/api/health`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.network, "testnet");
    assert.equal(body.networkStatus, "configured");
    assert.equal("mainnet" in body, false);
    assert.equal(body.paymentHistory, "pending_service_configuration");
  });
});

describe("selected Arc Mainnet HTTP API", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "network-mainnet-api-secret-32-characters" }),
      network: readArcNetworkConfig({
        ARC_NETWORK_MODE: "mainnet",
        ARC_MAINNET_RPC_URL: ARC_MAINNET.rpcUrl,
        ARC_MAINNET_CHAIN_ID: String(ARC_MAINNET.chainId),
        ARC_MAINNET_EXPLORER_URL: ARC_MAINNET.explorerUrl,
        ARC_MAINNET_USDC_ADDRESS: ARC_MAINNET.usdcAddress,
      }),
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

  it("publishes Arc Mainnet with its bundled chain and keeps testnet unavailable, never falling back to it", async () => {
    const response = await fetch(`${origin}/api/network`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.environment, "mainnet");
    assert.equal(body.ready, true);
    assert.equal(body.chainId, ARC_MAINNET.chainId);
    assert.equal(body.explorerUrl, ARC_MAINNET.explorerUrl);
    assert.equal(body.fees, null, "no fee contracts are verified in this server, so no fee schedule is published");
    assert.deepEqual((body.paymentNetworks as Array<{ id: string; available: boolean }>).map(({ id, available }) => [id, available]), [
      ["arc-testnet", false], ["arc-mainnet", true], ["robinhood-testnet", false], ["robinhood-mainnet", false],
    ]);
  });
});
