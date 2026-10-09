import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app";
import { WalletAuthService } from "../server/wallet-auth";

describe("production web delivery seam", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const app = createApp({
      auth: new WalletAuthService({
        domain: "127.0.0.1",
        sessionSecret: "production-static-test-secret-32-characters",
      }),
      webRoot: fileURLToPath(new URL("./fixtures", import.meta.url)),
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

  it("serves the SPA shell with browser security headers", async () => {
    const response = await fetch(`${origin}/pay/x/nora`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /HaPaPay production shell/);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  });

  it("never allows shared caching of API responses", async () => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
