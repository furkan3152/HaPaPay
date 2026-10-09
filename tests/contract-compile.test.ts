import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import solc from "solc";

describe("onchain identity registry seam", () => {
  it("compiles an attestation-gated registry with link, unlink and resolution interfaces", async () => {
    const source = await readFile(new URL("../contracts/ArcIdentityRegistry.sol", import.meta.url), "utf8");
    const output = JSON.parse(solc.compile(JSON.stringify({
      language: "Solidity",
      sources: { "ArcIdentityRegistry.sol": { content: source } },
      settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
    })));
    const errors = (output.errors ?? []).filter((error: { severity: string }) => error.severity === "error");
    assert.deepEqual(errors, []);
    const artifact = output.contracts["ArcIdentityRegistry.sol"].ArcIdentityRegistry;
    const functions = artifact.abi.filter((item: { type: string }) => item.type === "function").map((item: { name: string }) => item.name);
    assert.ok(functions.includes("linkIdentity"));
    assert.ok(functions.includes("unlinkIdentity"));
    assert.ok(functions.includes("resolveProviderIdentity"));
    assert.ok(functions.includes("securityRevision"));
    assert.ok(artifact.evm.bytecode.object.length > 1000);
  });
});
