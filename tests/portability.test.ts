import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("repository hygiene", () => {
  it("keeps credentials and local agent state outside Git", async () => {
    const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
    for (const pattern of [
      ".env",
      "*.env",
      ".secrets/",
      ".npmrc",
      "*.pem",
      "*.key",
      "*.secret",
      ".playwright-cli/",
      ".codex/auth.json",
      ".codex/*.sqlite*",
    ]) {
      assert.match(ignore, new RegExp(`^${escapeRegExp(pattern)}$`, "mu"), `${pattern} must be ignored`);
    }
  });

  it("ships an environment template with names only, never values", async () => {
    const template = await readFile(new URL("../.env.example", import.meta.url), "utf8");
    for (const line of template.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [name, value = ""] = line.split("=");
      assert.match(name, /^[A-Z0-9_]+$/u, line);
      if (/SECRET|PRIVATE_KEY|TOKEN|PASSWORD|DATABASE_URL/u.test(name)) {
        assert.ok(value === "" || /^replace-with-/u.test(value), `${name} carries no value`);
      }
    }
  });
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
