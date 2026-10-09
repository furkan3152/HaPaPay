import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../server/app";
import { WalletAuthService } from "../server/wallet-auth";

describe("chat HTTP abuse-control seam", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const app = createApp({
      auth: new WalletAuthService({
        domain: "127.0.0.1",
        sessionSecret: "chat-rate-limit-secret-with-32-characters",
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

  it("stops excessive draft requests before they can consume AI quota", async () => {
    let response: Response | undefined;
    for (let index = 0; index < 31; index += 1) {
      response = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "X'teki @nora'ya 1 USDC gönder" }),
      });
    }
    assert.equal(response?.status, 429);
    assert.ok(response?.headers.get("ratelimit"));
  });
});

describe("rate limits behind a trusted reverse proxy", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "trusted-proxy-limit-secret-with-32-chars" }),
      trustProxy: 1,
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

  it("counts each client the proxy names, so one client's limit never stops another", async () => {
    const challenge = (client: string) => fetch(`${origin}/api/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": client },
      body: JSON.stringify({ address: "0x1111111111111111111111111111111111111111" }),
    });
    let last: Response | undefined;
    for (let attempt = 0; attempt < 11; attempt += 1) last = await challenge("203.0.113.7");
    assert.equal(last?.status, 429, "the busy client reaches its own limit");
    assert.equal((await challenge("203.0.113.8")).status, 200, "another client behind the same proxy is not limited");
  });
});
