import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { ARC_TESTNET, readArcContractConfig, readArcNetworkConfig, type ArcContractEnvironment } from "../server/arc-network";
import { buildStartupServices, verifyStartupContractCapabilities, type StartupContractCapabilities } from "../server/index";
import { MemoryClaimFundingRepository } from "../server/claim-funding-service";
import { MemoryPaymentRepository } from "../server/payment-history-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { compileOperatorContract } from "../scripts/generate-stock-claim-escrow-artifact";

const registry = "0x1111111111111111111111111111111111111111" as Address;
const escrow = "0x2222222222222222222222222222222222222222" as Address;
const owner = "0x3333333333333333333333333333333333333333" as Address;
const router = "0x6666666666666666666666666666666666666666" as Address;
const forwarder = "0x7777777777777777777777777777777777777777" as Address;
const identityKey = `0x${"11".repeat(32)}` as Hex;
const claimKey = `0x${"22".repeat(32)}` as Hex;
const identityVerifier = privateKeyToAccount(identityKey).address;
const claimVerifier = privateKeyToAccount(claimKey).address;
const network = readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" });

const builds = Promise.all([
  compileOperatorContract("ArcIdentityRegistry"),
  compileOperatorContract("StockClaimEscrow"),
  compileOperatorContract("HaPaPayRouter"),
  compileOperatorContract("HaPaPayFeeForwarder"),
]);

/** A chain that serves the reviewed registry, escrow, router and forwarder builds, with overrides to refuse. */
async function client(overrides: Record<string, unknown> = {}) {
  const [registryBuild, escrowBuild, routerBuild, forwarderBuild] = await builds;
  const values: Record<string, unknown> = {
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
      return values[`code:${address}`] as Hex | undefined;
    },
    async readContract({ address, functionName }: { address: Address; functionName: string }) {
      const result = values[`${address}:${functionName}`];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const bothEnvironment: ArcContractEnvironment = {
  ARC_IDENTITY_REGISTRY_ADDRESS: registry,
  IDENTITY_ATTESTOR_PRIVATE_KEY: identityKey,
  ARC_CLAIM_ESCROW_ADDRESS: escrow,
  CLAIM_ATTESTOR_PRIVATE_KEY: claimKey,
  CONTRACT_OWNER_ADDRESS: owner,
};
const contracts = (environment: ArcContractEnvironment) => readArcContractConfig(environment, "testnet");

function buildServices(capabilities: StartupContractCapabilities) {
  return buildStartupServices({
    network,
    capabilities,
    contracts: contracts(bothEnvironment),
    paymentRepository: new MemoryPaymentRepository(),
    claimFundingRepository: new MemoryClaimFundingRepository(),
    recipientDirectory: {
      lookup: async () => ({ platform: "github" as const, providerUserId: "outside-42", username: "outside" }),
    },
    client: {
      async getTransactionReceipt() {
        throw new Error("Receipt reads are not expected while testing startup wiring.");
      },
      async readContract() {
        return 100n;
      },
      async readEscrowPayment() {
        return { payer: owner, token: ARC_TESTNET.usdcAddress, identityKey: `0x${"00".repeat(32)}` as Hex, amount: 1n, fee: 0n, expiry: 1n };
      },
    },
  });
}

describe("startup contract capability gates", () => {
  it("supports none, registry-only, escrow-only, and both without coupling valid capabilities", async () => {
    const none = await verifyStartupContractCapabilities({ network, client: await client(), contracts: contracts({}) });
    assert.deepEqual(none, { problems: {} });

    const registryOnly = await verifyStartupContractCapabilities({
      network,
      client: await client(),
      contracts: contracts({ ARC_IDENTITY_REGISTRY_ADDRESS: registry, IDENTITY_ATTESTOR_PRIVATE_KEY: identityKey, CONTRACT_OWNER_ADDRESS: owner }),
    });
    assert.equal(registryOnly.identityRegistry?.securityRevision, 2n);
    assert.equal(registryOnly.claimEscrow, undefined);

    const escrowOnly = await verifyStartupContractCapabilities({
      network,
      client: await client(),
      contracts: contracts({ ARC_CLAIM_ESCROW_ADDRESS: escrow, CLAIM_ATTESTOR_PRIVATE_KEY: claimKey, CONTRACT_OWNER_ADDRESS: owner }),
    });
    assert.equal(escrowOnly.identityRegistry, undefined);
    assert.equal(escrowOnly.claimEscrow?.securityRevision, 2n);
    assert.deepEqual(escrowOnly.claimEscrow?.fees, { router, burnVault: forwarder, treasury: owner, feeBps: 100, burnShareBps: 5000, sink: "forwarder" });

    const both = await verifyStartupContractCapabilities({ network, client: await client(), contracts: contracts(bothEnvironment) });
    assert.equal(both.identityRegistry?.securityRevision, 2n);
    assert.equal(both.claimEscrow?.securityRevision, 2n);
    assert.deepEqual(both.problems, {});
  });

  it("fails closed per contract for old code, binding mismatches, fee contracts, missing attestors, and invalid owner configuration", async () => {
    const oldRegistry = await verifyStartupContractCapabilities({ network, client: await client({ [`${registry}:securityRevision`]: 1n }), contracts: contracts(bothEnvironment) });
    assert.equal(oldRegistry.identityRegistry, undefined);
    assert.match(oldRegistry.problems.identityRegistry ?? "", /security revision must be 2/);
    assert.equal(oldRegistry.claimEscrow?.securityRevision, 2n);

    const greedyRouter = await verifyStartupContractCapabilities({ network, client: await client({ [`${router}:FEE_BPS`]: 200n }), contracts: contracts(bothEnvironment) });
    assert.equal(greedyRouter.identityRegistry?.securityRevision, 2n);
    assert.equal(greedyRouter.claimEscrow, undefined);
    assert.match(greedyRouter.problems.claimEscrow ?? "", /does not charge the reviewed 1% fee/);

    const foreignForwarder = await verifyStartupContractCapabilities({ network, client: await client({ [`${forwarder}:treasury`]: claimVerifier }), contracts: contracts(bothEnvironment) });
    assert.equal(foreignForwarder.claimEscrow, undefined, "a forwarder paying anyone but the operator is refused");

    const noClaimAttestor = await verifyStartupContractCapabilities({ network, client: await client(), contracts: contracts({ ...bothEnvironment, CLAIM_ATTESTOR_PRIVATE_KEY: undefined }) });
    assert.equal(noClaimAttestor.claimEscrow, undefined);

    const invalidOwner = await verifyStartupContractCapabilities({ network, client: await client(), contracts: contracts({ ...bothEnvironment, CONTRACT_OWNER_ADDRESS: "not-an-address" }) });
    assert.equal(invalidOwner.identityRegistry, undefined);
    assert.equal(invalidOwner.claimEscrow, undefined);
    assert.match(invalidOwner.problems.claimEscrow ?? "", /not a valid address/);
  });

  it("returns no contract capabilities when the selected chain or USDC is unavailable", async () => {
    const unavailable = await verifyStartupContractCapabilities({
      network: { ready: false, reason: "chain verification failed" },
      client: await client(),
      contracts: contracts(bothEnvironment),
    });
    assert.deepEqual(unavailable, { problems: {} });
  });

  it("reads Arc Mainnet's contracts only from ARC_MAINNET_* names and refuses an attestor key shared with any other role", () => {
    const mainnetIdentity = `0x${"33".repeat(32)}`;
    const mainnetClaim = `0x${"44".repeat(32)}`;
    const config = readArcContractConfig({
      ...bothEnvironment,
      ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS: registry,
      ARC_MAINNET_CLAIM_ESCROW_ADDRESS: escrow,
      ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY: mainnetIdentity,
      ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: mainnetClaim,
      ROBINHOOD_OPERATOR_ADDRESS: owner,
    }, "mainnet");
    assert.deepEqual(config, { registryAddress: registry, identityAttestorKey: mainnetIdentity, escrowAddress: escrow, claimAttestorKey: mainnetClaim, operator: owner, setup: [] });
    assert.deepEqual(readArcContractConfig(bothEnvironment, "mainnet").setup, [
      "ARC_MAINNET_OPERATOR_ADDRESS or ROBINHOOD_OPERATOR_ADDRESS",
      "ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY",
      "ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY",
      "ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS",
      "ARC_MAINNET_CLAIM_ESCROW_ADDRESS",
    ], "testnet values never stand in for mainnet ones");
    for (const shared of [identityKey, claimKey, mainnetIdentity]) {
      const refused = readArcContractConfig({ ...bothEnvironment, ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY: mainnetIdentity, ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: shared, ROBINHOOD_OPERATOR_ADDRESS: owner }, "mainnet");
      assert.equal(refused.claimAttestorKey, undefined, "a reused attestor key is refused");
      assert.ok(refused.setup.includes("ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY"));
    }
    assert.equal(readArcContractConfig({ ARC_MAINNET_OPERATOR_ADDRESS: registry, ROBINHOOD_OPERATOR_ADDRESS: owner }, "mainnet").operator, registry, "an explicit Arc Mainnet operator wins");
  });

  it("checks the Arc Mainnet registry's owner every time, so it is refused while no operator is set", async () => {
    const mainnet = readArcNetworkConfig({ ARC_NETWORK_MODE: "mainnet" });
    const registryEnvironment: ArcContractEnvironment = { ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS: registry, ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY: identityKey };
    const unowned = await verifyStartupContractCapabilities({ network: mainnet, client: await client(), contracts: readArcContractConfig(registryEnvironment, "mainnet") });
    assert.equal(unowned.identityRegistry, undefined);
    assert.equal(unowned.problems.identityRegistry, "The operator wallet is not set, so the registry's owner cannot be verified.");
    const owned = await verifyStartupContractCapabilities({ network: mainnet, client: await client(), contracts: readArcContractConfig({ ...registryEnvironment, ROBINHOOD_OPERATOR_ADDRESS: owner }, "mainnet") });
    assert.equal(owned.identityRegistry?.securityRevision, 2n);
    const foreign = await verifyStartupContractCapabilities({ network: mainnet, client: await client(), contracts: readArcContractConfig({ ...registryEnvironment, ROBINHOOD_OPERATOR_ADDRESS: claimVerifier }, "mainnet") });
    assert.equal(foreign.identityRegistry, undefined, "a registry owned by another wallet is refused");
  });

  it("constructs production startup services only from independently verified capabilities", async () => {
    const both = await verifyStartupContractCapabilities({ network, client: await client(), contracts: contracts(bothEnvironment) });
    const allServices = buildServices(both);
    assert.ok(allServices.payments, "direct receipt/history service should be available on valid Arc Testnet");
    assert.equal("registryLink" in allServices, false, "the desk writes no identity records, so no registry call is ever prepared");
    assert.ok(allServices.claims, "claim preparation should use the verified escrow gate");
    assert.ok(allServices.claimFundings, "funding confirmation should use the verified escrow gate");
    assert.ok(allServices.redemptions, "claim and refund signing should use the verified escrow gate");
    assert.equal(allServices.arcFees?.schedule.router, router, "direct payments use the router behind the verified escrow");

    const oldCapabilities = buildServices({
      identityRegistry: { ...both.identityRegistry!, securityRevision: 1n },
      claimEscrow: { ...both.claimEscrow!, securityRevision: 3n },
      problems: {},
    });
    assert.equal(oldCapabilities.claims, undefined);
    assert.equal(oldCapabilities.claimFundings, undefined);
    assert.equal(oldCapabilities.redemptions, undefined);
    assert.equal(oldCapabilities.arcFees, undefined);
    assert.ok(oldCapabilities.payments);

    const oldRegistry = buildServices(await verifyStartupContractCapabilities({ network, client: await client({ [`${registry}:securityRevision`]: 1n }), contracts: contracts(bothEnvironment) }));
    assert.ok(oldRegistry.claims);
    assert.ok(oldRegistry.claimFundings);
    assert.ok(oldRegistry.redemptions);
    assert.ok(oldRegistry.payments);

    const wrongEscrow = buildServices(await verifyStartupContractCapabilities({ network, client: await client({ [`${escrow}:securityRevision`]: 3n }), contracts: contracts(bothEnvironment) }));
    assert.equal(wrongEscrow.claims, undefined);
    assert.equal(wrongEscrow.claimFundings, undefined);
    assert.equal(wrongEscrow.redemptions, undefined);
    assert.equal(wrongEscrow.arcFees, undefined);
    assert.ok(wrongEscrow.payments);
  });
});

describe("old-contract HTTP behavior", () => {
  let server: Server;
  let origin: string;
  let cookie: string;

  before(async () => {
    const capabilities = await verifyStartupContractCapabilities({
      network,
      client: await client({ [`${registry}:securityRevision`]: 1n, [`${escrow}:securityRevision`]: 1n }),
      contracts: contracts(bothEnvironment),
    });
    assert.equal(capabilities.identityRegistry, undefined);
    assert.equal(capabilities.claimEscrow, undefined);
    const startupServices = buildServices(capabilities);
    assert.ok(startupServices.payments);
    assert.equal(startupServices.claims, undefined);
    assert.equal(startupServices.claimFundings, undefined);
    assert.equal(startupServices.redemptions, undefined);

    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "startup-contract-gate-secret-32chars" });
    const sender = privateKeyToAccount(`0x${"44".repeat(32)}`);
    const identities = new VerifiedIdentityService();
    identities.link(sender.address, { platform: "github", providerUserId: "sender", username: "sender", verifiedAt: new Date().toISOString() });
    identities.link("0x5555555555555555555555555555555555555555", { platform: "x", providerUserId: "recipient", username: "recipient", verifiedAt: new Date().toISOString() });
    const app = createApp({ auth, identities, network, ...startupServices });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test port.");
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    const challenge = await fetch(`${origin}/api/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: sender.address }),
    }).then((response) => response.json()) as { id: string; message: string };
    const signature = await sender.signMessage({ message: challenge.message });
    const login = await fetch(`${origin}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: sender.address, challengeId: challenge.id, signature }),
    });
    cookie = login.headers.get("set-cookie") ?? "";
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  it("keeps fee-free testnet direct preparation and receipt history available while every contract route fails closed", async () => {
    const networkStatus = await fetch(`${origin}/api/network`);
    assert.equal(networkStatus.status, 200);
    const status = await networkStatus.json() as Record<string, unknown>;
    assert.equal(status.fees, null);
    assert.equal("registryReady" in status || "registryConfigured" in status, false);

    const direct = await fetch(`${origin}/api/payment/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        kind: "send", amount: "1", token: "USDC", status: "draft",
        recipient: { platform: "x", username: "recipient" },
        expectedRecipientAddress: "0x5555555555555555555555555555555555555555",
      }),
    });
    assert.equal(direct.status, 200);
    assert.equal((await direct.json() as { transaction: { to: string } }).transaction.to, ARC_TESTNET.usdcAddress);

    const history = await fetch(`${origin}/api/payments`, { headers: { Cookie: cookie } });
    assert.equal(history.status, 200);
    assert.deepEqual(await history.json(), { payments: [] });

    const paymentId = `0x${"ab".repeat(32)}`;
    const unavailableRequests = [
      fetch(`${origin}/api/claims/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ platform: "github", username: "outside", amount: "1", expiryHours: 24 }),
      }),
      fetch(`${origin}/api/claims/confirm-funding`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          transactionHash: `0x${"cd".repeat(32)}`,
          paymentId,
          platform: "github",
          username: "outside",
          amount: "1",
        }),
      }),
      fetch(`${origin}/api/claims/${paymentId}/prepare-claim`, { method: "POST", headers: { Cookie: cookie } }),
      fetch(`${origin}/api/claims/${paymentId}/prepare-refund`, { method: "POST", headers: { Cookie: cookie } }),
    ];
    for (const response of await Promise.all(unavailableRequests)) {
      assert.equal(response.status, 503);
      const body = JSON.stringify(await response.json());
      assert.equal(body.includes("data"), false);
      assert.equal(body.includes("signature"), false);
      assert.equal(body.includes("approve"), false);
    }

    const removed = await fetch(`${origin}/api/identity/github`, { method: "DELETE", headers: { Cookie: cookie } });
    assert.equal(removed.status, 200);
    const removedBody = await removed.json() as { accounts: unknown[] };
    assert.deepEqual(removedBody.accounts, []);
    assert.equal("onchainRecordMayRemain" in removedBody, false, "a link lives only in the database, so removing it removes all of it");
  });
});
