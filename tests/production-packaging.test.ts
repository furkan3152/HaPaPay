import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("production container build context", () => {
  it("excludes environment files, package-manager credentials, private keys, and local Foundry output", async () => {
    const dockerignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
    const patterns = new Set(
      dockerignore
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    );

    for (const requiredPattern of [
      ".env*",
      "**/.env*",
      "**/*.env",
      ".secrets",
      ".npmrc",
      "*.pem",
      "*.key",
      "*.secret",
      "foundry-out",
      "foundry-cache",
      "deployments",
      ".vercel",
    ]) {
      assert.ok(patterns.has(requiredPattern), `${requiredPattern} must be excluded from the Docker build context`);
    }
  });
});
