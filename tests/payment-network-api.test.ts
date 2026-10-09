import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { readArcNetworkConfig } from "../server/arc-network";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";

describe("payment network preference before preparation side effects", () => {
  let server: Server;
  let origin: string;
  let cookie: string;
  let identityCalls = 0;
  let claimCalls = 0;

  before(async () => {
    const sender = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "network-preference-secret-with-32-characters" });
    const identities = new class extends VerifiedIdentityService {
      override resolve(platform: Parameters<VerifiedIdentityService["resolve"]>[0], username: string) {
        identityCalls++;
        return super.resolve(platform, username);
      }
      override account(wallet: string, platform: Parameters<VerifiedIdentityService["account"]>[1]) {
        identityCalls++;
        return super.account(wallet, platform);
      }
    }();
    const app = createApp({
      auth,
      identities,
      network: readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }),
      claims: { async prepare() { claimCalls++; throw new Error("Claim service must not be called."); } },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test port");
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    const challenge = await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address }) }).then((response) => response.json()) as { id: string; message: string };
    const signature = await sender.signMessage({ message: challenge.message });
    const login = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address, challengeId: challenge.id, signature }) });
    cookie = login.headers.get("set-cookie") ?? "";
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  for (const path of ["/api/payment/prepare", "/api/claims/prepare"] as const) {
    it(`${path} rejects malformed and unavailable choices before identity/claim calls`, async () => {
      identityCalls = 0;
      claimCalls = 0;
      const body = path.includes("payment")
        ? { kind: "send", amount: "1", token: "USDC", recipient: { platform: "x", username: "nora" }, status: "draft", expectedRecipientAddress: "0x2222222222222222222222222222222222222222" }
        : { platform: "github", username: "outside-user", amount: "1", expiryHours: 72 };
      for (const [networkPreference, status] of [[null, 400], ["arc-mainnet", 503], ["robinhood-testnet", 503], ["robinhood-mainnet", 503]] as const) {
        const response = await fetch(`${origin}${path}`, {
          method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ ...body, networkPreference }),
        });
        assert.equal(response.status, status, `${path}: ${String(networkPreference)}`);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(identityCalls, 0);
        assert.equal(claimCalls, 0);
      }
    });
  }
});
