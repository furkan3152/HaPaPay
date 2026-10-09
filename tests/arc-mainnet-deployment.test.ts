import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getContractAddress, type Address, type Hex } from "viem";
import { findArcMainnetDeployment, type ArcMainnetReader } from "../server/arc-mainnet-deployment";
import { compileOperatorContract } from "../scripts/generate-stock-claim-escrow-artifact";

const operator = "0x1111111111111111111111111111111111111111" as Address;
const stranger = "0x2222222222222222222222222222222222222222" as Address;
const identityVerifier = "0x1111111111111111111111111111111111111111" as Address;
const claimVerifier = "0x3333333333333333333333333333333333333333" as Address;
const at = (nonce: number) => getContractAddress({ from: operator, nonce: BigInt(nonce) });

const builds = Promise.all([
  compileOperatorContract("HaPaPayFeeForwarder"),
  compileOperatorContract("HaPaPayRouter"),
  compileOperatorContract("ArcIdentityRegistry"),
  compileOperatorContract("StockClaimEscrow"),
]).then(([forwarder, router, registry, escrow]) => ({
  forwarder: forwarder.deployedBytecode as Hex,
  router: router.deployedBytecode as Hex,
  registry: registry.deployedBytecode as Hex,
  escrow: escrow.deployedBytecode as Hex,
}));

type Created = { role: "forwarder" | "router" | "registry" | "escrow" | "other"; bindings?: Record<string, Address> };

/** An Arc Mainnet where the operator created `contracts` at those nonces and has sent `nonce` transactions. */
async function chain(nonce: number, contracts: Record<number, Created>): Promise<ArcMainnetReader> {
  const code = await builds;
  const byAddress = new Map(Object.entries(contracts).map(([index, created]) => [at(Number(index)), created]));
  return {
    getTransactionCount: async () => nonce,
    getBytecode: async ({ address }) => {
      const created = byAddress.get(address);
      if (!created) return undefined;
      return created.role === "other" ? "0x6080" : code[created.role];
    },
    readContract: async ({ address, functionName }) => {
      const value = byAddress.get(address)?.bindings?.[functionName];
      if (!value) throw new Error("execution reverted");
      return value;
    },
    getTransactionReceipt: async () => null,
  };
}

describe("finding the operator's Arc Mainnet deployment on chain", () => {
  it("resumes from the newest forwarder when only forwarders were deployed, as after interrupted attempts", async () => {
    const reader = await chain(26, {
      22: { role: "forwarder", bindings: { treasury: operator } },
      23: { role: "forwarder", bindings: { treasury: operator } },
      24: { role: "forwarder", bindings: { treasury: operator } },
      25: { role: "forwarder", bindings: { treasury: operator } },
    });
    assert.deepEqual(await findArcMainnetDeployment(reader, { operator, identityVerifier, claimVerifier }), { forwarder: at(25) });
  });

  it("returns one consistent set: the escrow on its router, the router on its forwarder, and the registry", async () => {
    const reader = await chain(12, {
      2: { role: "forwarder", bindings: { treasury: operator } },
      3: { role: "router", bindings: { owner: operator, treasury: operator, burnVault: at(2) } },
      5: { role: "forwarder", bindings: { treasury: operator } },
      6: { role: "forwarder", bindings: { treasury: stranger } },
      7: { role: "registry", bindings: { owner: operator, verifier: identityVerifier } },
      8: { role: "escrow", bindings: { owner: operator, verifier: claimVerifier, feeRouter: at(3) } },
      9: { role: "registry", bindings: { owner: operator, verifier: stranger } },
      10: { role: "other" },
    });
    assert.deepEqual(await findArcMainnetDeployment(reader, { operator, identityVerifier, claimVerifier }), {
      forwarder: at(2),
      router: at(3),
      registry: at(7),
      escrow: at(8),
    });
  });

  it("ignores contracts that pay or answer to anyone else, or sit on an unknown router", async () => {
    const reader = await chain(8, {
      1: { role: "forwarder", bindings: { treasury: stranger } },
      2: { role: "router", bindings: { owner: operator, treasury: operator, burnVault: at(1) } },
      3: { role: "forwarder", bindings: { treasury: operator } },
      4: { role: "router", bindings: { owner: stranger, treasury: operator, burnVault: at(3) } },
      5: { role: "router", bindings: { owner: operator, treasury: stranger, burnVault: at(3) } },
      6: { role: "escrow", bindings: { owner: operator, verifier: claimVerifier, feeRouter: at(4) } },
      7: { role: "registry", bindings: { owner: stranger, verifier: identityVerifier } },
    });
    assert.deepEqual(await findArcMainnetDeployment(reader, { operator, identityVerifier, claimVerifier }), { forwarder: at(3) });
  });

  it("looks only at the operator's latest transactions, and finds nothing on a fresh wallet", async () => {
    const old = await chain(60, { 3: { role: "forwarder", bindings: { treasury: operator } } });
    assert.deepEqual(await findArcMainnetDeployment(old, { operator, identityVerifier, claimVerifier }), {});
    assert.deepEqual(await findArcMainnetDeployment(await chain(0, {}), { operator, identityVerifier, claimVerifier }), {});
  });
});
