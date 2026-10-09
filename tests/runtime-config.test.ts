import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPublishedSessionSecret, readAppOrigin, readDatabaseUrl, readFarcasterRpcUrl, readSessionSecret, readTrustProxy } from "../server/runtime-config";

describe("production runtime configuration seam", () => {
  it("refuses to start production with the shared development session secret", () => {
    assert.throws(
      () => readSessionSecret({ NODE_ENV: "production", SESSION_SECRET: undefined }),
      /SESSION_SECRET is required in production/,
    );
  });

  it("refuses the published example secrets in production, and falls back to the development one only outside it", () => {
    for (const published of ["replace-with-at-least-32-random-characters", "development-only-session-secret-change-me", " replace-with-a-value-someone-copied-over "]) {
      assert.equal(isPublishedSessionSecret(published), true, published);
      assert.throws(() => readSessionSecret({ NODE_ENV: "production", SESSION_SECRET: published }), /published example value/);
    }
    assert.equal(readSessionSecret({ NODE_ENV: "development", SESSION_SECRET: "" }), "development-only-session-secret-change-me");
    assert.throws(() => readSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "" }), /SESSION_SECRET is required in production/);
    assert.equal(isPublishedSessionSecret("a-production-secret-with-more-than-32-chars"), false);
  });

  it("accepts an explicitly configured production secret", () => {
    assert.equal(
      readSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "a-production-secret-with-more-than-32-chars" }),
      "a-production-secret-with-more-than-32-chars",
    );
  });

  it("reads TRUST_PROXY as a hop count or proxy addresses, and never trusts every client", () => {
    assert.equal(readTrustProxy({}), undefined);
    assert.equal(readTrustProxy({ TRUST_PROXY: " " }), undefined);
    assert.equal(readTrustProxy({ TRUST_PROXY: "1" }), 1);
    assert.equal(readTrustProxy({ TRUST_PROXY: "loopback" }), "loopback");
    assert.equal(readTrustProxy({ TRUST_PROXY: "10.0.0.0/8, 192.168.1.10, ::1/128" }), "10.0.0.0/8,192.168.1.10,::1/128");
    assert.equal(readTrustProxy({ TRUST_PROXY: "::ffff:10.0.0.0/104" }), "::ffff:10.0.0.0/104");
    for (const refused of ["true", "0", "11", "10.0.0.0/33", "0.0.0.0/0", "::/0", "0.0.0.0/1,128.0.0.0/1", "::ffff:0:0/96",
      "0:0:0:0:0:ffff:0:0/96", "::0:ffff:0:0/96", "0:0:0:0:0:ffff:0.0.0.0/96", "2000::/3", "proxy.example", "10.0.0.1/8/2",
      "10.0.0.0/", "10.0.0.0/8x"]) {
      assert.throws(() => readTrustProxy({ TRUST_PROXY: refused }), /TRUST_PROXY/, refused);
    }
  });

  it("requires a dedicated Farcaster verification RPC in production", () => {
    assert.throws(
      () => readFarcasterRpcUrl({ NODE_ENV: "production", FARCASTER_OPTIMISM_RPC_URL: undefined }),
      /FARCASTER_OPTIMISM_RPC_URL is required in production/,
    );
    assert.equal(
      readFarcasterRpcUrl({ NODE_ENV: "production", FARCASTER_OPTIMISM_RPC_URL: "https://optimism.example/rpc" }),
      "https://optimism.example/rpc",
    );
  });

  it("requires persistent identity storage in production", () => {
    assert.throws(
      () => readDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: undefined }),
      /DATABASE_URL is required in production/,
    );
    assert.equal(readDatabaseUrl({ NODE_ENV: "development", DATABASE_URL: undefined }), undefined);
  });

  it("requires one explicit HTTPS origin and matching domain in production", () => {
    assert.throws(() => readAppOrigin({ NODE_ENV: "production", APP_URL: undefined, APP_DOMAIN: "hapapay.example" }), /APP_URL/);
    assert.throws(() => readAppOrigin({ NODE_ENV: "production", APP_URL: "http://hapapay.example", APP_DOMAIN: "hapapay.example" }), /HTTPS/);
    assert.throws(() => readAppOrigin({ NODE_ENV: "production", APP_URL: "https://hapapay.example", APP_DOMAIN: "other.example" }), /APP_DOMAIN/);
    assert.deepEqual(readAppOrigin({ NODE_ENV: "production", APP_URL: "https://hapapay.example", APP_DOMAIN: "hapapay.example" }), {
      url: "https://hapapay.example",
      domain: "hapapay.example",
    });
  });
});
