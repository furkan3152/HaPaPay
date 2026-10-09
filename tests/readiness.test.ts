import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { ARC_MAINNET, ARC_TESTNET, readArcNetworkConfig } from "../server/arc-network";
import {
  buildConfigurationReadiness,
  verifyClaimEscrowContract,
  verifyIdentityRegistryContract,
} from "../server/readiness";
import { compileOperatorContract } from "../scripts/generate-stock-claim-escrow-artifact";

const registry = "0x1111111111111111111111111111111111111111" as Address;
const escrow = "0x2222222222222222222222222222222222222222" as Address;
const identityVerifier = "0x3333333333333333333333333333333333333333" as Address;
const claimVerifier = "0x4444444444444444444444444444444444444444" as Address;
const owner = "0x5555555555555555555555555555555555555555" as Address;

describe("deployment configuration readiness seam", () => {
  it("reports only missing variable names and keeps configured secret values out of the result", () => {
    const configuredSecret = "github-secret-that-must-never-appear";
    const report = buildConfigurationReadiness({
      SESSION_SECRET: "s".repeat(32),
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: configuredSecret,
      ARC_NETWORK_MODE: "testnet",
    }, readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }), true, {
      identityRegistry: true,
      claimEscrow: true,
    });

    assert.equal(report.ready, false);
    assert.equal(report.network.environment, "testnet");
    assert.equal(report.network.chainId, ARC_TESTNET.chainId);
    assert.equal(report.network.runtimeVerified, true);
    assert.deepEqual(report.checks.find((check) => check.id === "github_oauth"), {
      id: "github_oauth",
      status: "ready",
      missing: [],
    });
    assert.deepEqual(report.checks.find((check) => check.id === "x_oauth"), {
      id: "x_oauth",
      status: "missing",
      missing: ["X_CLIENT_ID"],
    });
    assert.ok(report.missingVariables.includes("DATABASE_URL"));
    assert.ok(report.missingVariables.includes("OPENROUTER_API_KEY"));
    assert.ok(report.missingVariables.includes("ARC_IDENTITY_REGISTRY_ADDRESS"));
    assert.ok(report.missingVariables.includes("ARC_CLAIM_ESCROW_ADDRESS"));
    assert.ok(report.missingVariables.includes("X_API_BEARER_TOKEN"));
    assert.equal(JSON.stringify(report).includes(configuredSecret), false);
    assert.equal(report.missingVariables.includes("DEPLOYER_PRIVATE_KEY"), false);
  });

  it("counts a published example session secret as missing", () => {
    for (const secret of ["replace-with-at-least-32-random-characters", "development-only-session-secret-change-me"]) {
      const report = buildConfigurationReadiness({ SESSION_SECRET: secret }, readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }), true);
      assert.deepEqual(report.checks.find((check) => check.id === "session_security"), { id: "session_security", status: "missing", missing: ["SESSION_SECRET"] });
      assert.equal(JSON.stringify(report).includes(secret), false);
    }
  });

  it("becomes ready after every runtime capability is configured and the selected Arc network verifies", () => {
    const report = buildConfigurationReadiness({
      SESSION_SECRET: "s".repeat(32),
      DATABASE_URL: "postgres://runtime-database",
      OPENROUTER_API_KEY: "openrouter-key",
      GITHUB_CLIENT_ID: "github-id",
      GITHUB_CLIENT_SECRET: "github-secret",
      X_CLIENT_ID: "x-id",
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_BOT_USERNAME: "hapapay_bot",
      DISCORD_CLIENT_ID: "discord-id",
      DISCORD_CLIENT_SECRET: "discord-secret",
      FARCASTER_OPTIMISM_RPC_URL: "https://optimism.example",
      ARC_IDENTITY_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
      IDENTITY_ATTESTOR_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      ARC_CLAIM_ESCROW_ADDRESS: "0x2222222222222222222222222222222222222222",
      CLAIM_ATTESTOR_PRIVATE_KEY: `0x${"22".repeat(32)}`,
      X_API_BEARER_TOKEN: "x-bearer",
    }, readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }), true, {
      identityRegistry: true,
      claimEscrow: true,
    });

    assert.equal(report.ready, true);
    assert.deepEqual(report.missingVariables, []);
    assert.equal(report.checks.every((check) => check.status === "ready"), true);
  });

  it("keeps configured contracts unverified until their live bindings pass", () => {
    const report = buildConfigurationReadiness({
      ARC_IDENTITY_REGISTRY_ADDRESS: registry,
      IDENTITY_ATTESTOR_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      ARC_CLAIM_ESCROW_ADDRESS: escrow,
      CLAIM_ATTESTOR_PRIVATE_KEY: `0x${"22".repeat(32)}`,
    }, readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }), true);

    assert.deepEqual(report.checks.find((check) => check.id === "identity_registry"), {
      id: "identity_registry",
      status: "unverified",
      missing: [],
    });
    assert.deepEqual(report.checks.find((check) => check.id === "claim_escrow"), {
      id: "claim_escrow",
      status: "unverified",
      missing: [],
    });
  });

  it("marks a fully supplied but non-canonical mainnet tuple unverified instead of pretending variables are missing", () => {
    const environment = {
      ARC_NETWORK_MODE: "mainnet",
      ARC_MAINNET_RPC_URL: "https://rpc.mainnet.example",
      ARC_MAINNET_CHAIN_ID: "5042",
      ARC_MAINNET_USDC_ADDRESS: "0x1111111111111111111111111111111111111111",
    };
    const network = readArcNetworkConfig(environment);
    const report = buildConfigurationReadiness(environment, network, false);
    assert.deepEqual(report.checks.find((check) => check.id === "arc_network_config"), {
      id: "arc_network_config",
      status: "unverified",
      missing: [],
    });
    assert.equal(report.missingVariables.includes("ARC_MAINNET_RPC_URL"), false);
  });

  it("selects Arc Mainnet from the mode alone and asks for its own contract names", () => {
    for (const environment of [
      { ARC_NETWORK_MODE: "mainnet" },
      { ARC_NETWORK_MODE: "mainnet", ARC_MAINNET_RPC_URL: ARC_MAINNET.rpcUrl, ARC_MAINNET_CHAIN_ID: String(ARC_MAINNET.chainId), ARC_MAINNET_USDC_ADDRESS: ARC_MAINNET.usdcAddress },
    ]) {
      const network = readArcNetworkConfig(environment);
      const report = buildConfigurationReadiness(environment, network, true);
      assert.deepEqual(report.checks.find((check) => check.id === "arc_network_config"), { id: "arc_network_config", status: "ready", missing: [] });
      assert.equal(report.network.chainId, ARC_MAINNET.chainId);
      assert.deepEqual(report.checks.find((check) => check.id === "claim_escrow")?.missing, ["ARC_MAINNET_CLAIM_ESCROW_ADDRESS", "ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY"]);
      assert.deepEqual(report.checks.find((check) => check.id === "identity_registry")?.missing, ["ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS", "ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY"]);
      assert.equal(report.missingVariables.includes("ARC_CLAIM_ESCROW_ADDRESS"), false, "testnet names are never asked for on mainnet");
    }
  });
});

describe("live Arc contract readiness", () => {
  const router = "0x6666666666666666666666666666666666666666" as Address;
  const forwarder = "0x7777777777777777777777777777777777777777" as Address;

  async function client(overrides: Partial<Record<string, Address | Hex | bigint | Error | undefined>> = {}) {
    const [registryBuild, escrowBuild, routerBuild, forwarderBuild] = await Promise.all([
      compileOperatorContract("ArcIdentityRegistry"),
      compileOperatorContract("StockClaimEscrow"),
      compileOperatorContract("HaPaPayRouter"),
      compileOperatorContract("HaPaPayFeeForwarder"),
    ]);
    const values: Record<string, Address | Hex | bigint | Error | undefined> = {
      [`code:${registry}`]: registryBuild.deployedBytecode,
      [`code:${escrow}`]: escrowBuild.deployedBytecode,
      [`code:${router}`]: routerBuild.deployedBytecode,
      [`code:${forwarder}`]: forwarderBuild.deployedBytecode,
      [`${registry}:securityRevision`]: 2n,
      [`${registry}:verifier`]: identityVerifier,
      [`${registry}:owner`]: owner,
      [`${escrow}:securityRevision`]: 2n,
      [`${escrow}:verifier`]: claimVerifier,
      [`${escrow}:owner`]: owner,
      [`${escrow}:feeRouter`]: router,
      [`${router}:securityRevision`]: 1n,
      [`${router}:FEE_BPS`]: 100n,
      [`${router}:BURN_SHARE_BPS`]: 5000n,
      [`${router}:owner`]: owner,
      [`${router}:treasury`]: owner,
      [`${router}:burnVault`]: forwarder,
      [`${forwarder}:securityRevision`]: 1n,
      [`${forwarder}:treasury`]: owner,
      ...overrides,
    };
    return {
      async getBytecode({ address }: { address: Address }) {
        const value = values[`code:${address}`];
        if (value instanceof Error) throw value;
        return value as Hex | undefined;
      },
      async readContract({ address, functionName }: { address: Address; functionName: string }) {
        const value = values[`${address}:${functionName}`];
        if (value instanceof Error) throw value;
        return value;
      },
    };
  }
  const expectedEscrow = { escrow, claimVerifier, operator: owner, chainName: "Arc Mainnet" };

  it("accepts the reviewed registry and the reviewed escrow whose fee forwarder pays the operator", async () => {
    assert.deepEqual(await verifyIdentityRegistryContract({ registry, identityVerifier, owner }, await client()), { securityRevision: 2n });
    assert.deepEqual(await verifyClaimEscrowContract(expectedEscrow, await client()), {
      securityRevision: 2n,
      fees: { router, burnVault: forwarder, treasury: owner, feeBps: 100, burnShareBps: 5000, sink: "forwarder" },
    });
  });

  it("requires the exact reviewed revisions before reading registry or escrow trust bindings", async () => {
    for (const revision of [1n, 3n]) {
      await assert.rejects(verifyIdentityRegistryContract({ registry, identityVerifier, owner }, await client({ [`${registry}:securityRevision`]: revision })), /security revision/i);
      await assert.rejects(verifyClaimEscrowContract(expectedEscrow, await client({ [`${escrow}:securityRevision`]: revision })), /security revision/i);
    }
  });

  it("fails closed when securityRevision is missing, reverts, or returns a malformed ABI value", async () => {
    for (const invalid of [undefined, new Error("execution reverted"), "2" as unknown as bigint]) {
      await assert.rejects(verifyIdentityRegistryContract({ registry, identityVerifier, owner }, await client({ [`${registry}:securityRevision`]: invalid })), /security revision/i);
    }
  });

  it("fails closed for code that is not the reviewed build and for every mismatched binding", async () => {
    const someCode = "0x6000" as Hex;
    const registryCases: Array<[string, Partial<Record<string, Address | Hex | Error | undefined>>, RegExp]> = [
      ["registry code", { [`code:${registry}`]: "0x" }, /not the reviewed ArcIdentityRegistry build/i],
      ["registry other code", { [`code:${registry}`]: someCode }, /not the reviewed ArcIdentityRegistry build/i],
      ["registry unreadable code", { [`code:${registry}`]: new Error("rpc https://provider.example/key down") }, /: Arc contract code could not be read\.$/],
      ["registry verifier", { [`${registry}:verifier`]: claimVerifier }, /identity registry verifier does not match/i],
      ["registry owner", { [`${registry}:owner`]: claimVerifier }, /identity registry owner does not match/i],
    ];
    for (const [label, overrides, expectedError] of registryCases) {
      await assert.rejects(verifyIdentityRegistryContract({ registry, identityVerifier, owner }, await client(overrides)), expectedError, label);
    }
    const escrowCases: Array<[string, Partial<Record<string, Address | Hex | bigint | Error | undefined>>, RegExp]> = [
      ["escrow code", { [`code:${escrow}`]: undefined }, /not the reviewed StockClaimEscrow build/i],
      ["escrow other code", { [`code:${escrow}`]: someCode }, /not the reviewed StockClaimEscrow build/i],
      ["escrow verifier", { [`${escrow}:verifier`]: identityVerifier }, /claim escrow verifier does not match/i],
      ["escrow owner", { [`${escrow}:owner`]: identityVerifier }, /owner does not match the configured operator/i],
      ["router code", { [`code:${router}`]: someCode }, /not the reviewed HaPaPayRouter build/i],
      ["router fee", { [`${router}:FEE_BPS`]: 101n }, /does not charge the reviewed 1% fee split in half/i],
      ["router treasury", { [`${router}:treasury`]: identityVerifier }, /owned by the operator wallet and pay its treasury half to it/i],
      ["forwarder code", { [`code:${forwarder}`]: someCode }, /not the reviewed HaPaPayFeeForwarder build/i],
      ["forwarder treasury", { [`${forwarder}:treasury`]: identityVerifier }, /forward to the operator wallet/i],
      ["burn vault instead of forwarder", { [`code:${forwarder}`]: (await compileOperatorContract("HaPaPayBurnVault")).deployedBytecode }, /not the reviewed HaPaPayFeeForwarder build/i],
    ];
    for (const [label, overrides, expectedError] of escrowCases) {
      await assert.rejects(verifyClaimEscrowContract(expectedEscrow, await client(overrides)), expectedError, label);
    }
  });

  it("does not require a registry owner comparison when no expected owner is configured", async () => {
    await assert.doesNotReject(verifyIdentityRegistryContract({ registry, identityVerifier }, await client({ [`${registry}:owner`]: identityVerifier })));
  });
});
