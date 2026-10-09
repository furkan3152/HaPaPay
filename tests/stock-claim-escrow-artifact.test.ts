import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAbiItem } from "viem/utils";
import type { Abi } from "viem";
import { compileOperatorContract, compileStockClaimEscrow } from "../scripts/generate-stock-claim-escrow-artifact";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact";
import { BURN_VAULT_ARTIFACT, FEE_FORWARDER_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../src/domain/fee-artifacts";
import { burnVaultAbi, feeForwarderAbi, payRouterAbi } from "../src/domain/fees";
import { ARC_IDENTITY_REGISTRY_ARTIFACT } from "../src/domain/arc-identity-registry-artifact";
import { arcIdentityRegistryAbi } from "../src/domain/arc-identity-registry";
import { stockClaimEscrowAbi } from "../src/domain/stock-claims";

type Item = Abi[number];
const signature = (item: Item) => item.type === "constructor"
  ? `constructor(${item.inputs.map((input) => `${input.type} ${input.name}`).join(", ")})`
  : `${item.type} ${formatAbiItem(item as Parameters<typeof formatAbiItem>[0])}`;

describe("stock claim escrow deploy artifact", () => {
  it("matches a fresh compile of the committed contract source", async () => {
    const compiled = await compileStockClaimEscrow();
    assert.equal(STOCK_CLAIM_ESCROW_ARTIFACT.sourceHash, compiled.sourceHash, "run npm run generate:stock-escrow after editing the contract");
    assert.equal(STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, compiled.bytecode);
    assert.equal(STOCK_CLAIM_ESCROW_ARTIFACT.runtimeCodeHash, compiled.runtimeCodeHash);
    assert.equal(STOCK_CLAIM_ESCROW_ARTIFACT.compiler, compiled.compiler);
    assert.match(STOCK_CLAIM_ESCROW_ARTIFACT.compiler, /^0\.8\.28\+/);
  });

  it("describes every constructor, function, event and error of the compiled contract", async () => {
    const compiled = await compileStockClaimEscrow();
    const expected = (compiled.abi as Item[]).map(signature).sort();
    const declared = (stockClaimEscrowAbi as readonly Item[]).map(signature).sort();
    assert.deepEqual(declared, expected);
  });
});

describe("fee contract and Arc registry deploy artifacts", () => {
  for (const [name, artifact, abi] of [
    ["HaPaPayRouter", PAY_ROUTER_ARTIFACT, payRouterAbi],
    ["HaPaPayBurnVault", BURN_VAULT_ARTIFACT, burnVaultAbi],
    ["HaPaPayFeeForwarder", FEE_FORWARDER_ARTIFACT, feeForwarderAbi],
    ["ArcIdentityRegistry", ARC_IDENTITY_REGISTRY_ARTIFACT, arcIdentityRegistryAbi],
  ] as const) {
    it(`${name} matches a fresh compile and its declared ABI`, async () => {
      const compiled = await compileOperatorContract(name);
      assert.equal(artifact.contractName, name);
      assert.equal(artifact.sourceHash, compiled.sourceHash, "run npm run generate:stock-escrow after editing the contract");
      assert.equal(artifact.bytecode, compiled.bytecode);
      assert.equal(artifact.runtimeCodeHash, compiled.runtimeCodeHash);
      assert.equal(artifact.compiler, compiled.compiler);
      assert.deepEqual((abi as readonly Item[]).map(signature).sort(), (compiled.abi as Item[]).map(signature).sort());
    });
  }

  it("keeps fee settings out of immutables, so every deployment has the same runtime code", async () => {
    // The server accepts a contract only by its runtime code hash; an immutable would differ per deployment.
    for (const name of ["StockClaimEscrow", "HaPaPayRouter", "HaPaPayBurnVault", "HaPaPayFeeForwarder", "ArcIdentityRegistry"] as const) {
      const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL(`../contracts/${name}.sol`, import.meta.url), "utf8"));
      assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /\bimmutable\b/, `${name} declares an immutable`);
    }
  });
});

