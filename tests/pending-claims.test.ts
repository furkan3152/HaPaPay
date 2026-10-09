import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Server } from "node:http";
import { newDb } from "pg-mem";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { ClaimRedemptionService } from "../server/claim-redemption-service";
import { MemoryClaimFundingRepository, PostgresClaimFundingRepository, type ClaimFundingRecord, type ClaimFundingRepository } from "../server/claim-funding-service";
import { readStockClaimConfig } from "../server/robinhood-network";
import {
  MemoryStockClaimRepository,
  PostgresStockClaimRepository,
  StockClaimService,
  stockClaimIdentityKey,
  type StockClaimRecord,
  type StockClaimRepository,
} from "../server/stock-claim-service";
import { StockTransferUnavailableError, type StockChainClient } from "../server/stock-transfer-service";
import { VerifiedIdentityService, type VerifiedSocialAccount } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { sortPendingVaultLinks, type PendingVaultLink } from "../src/domain/pending-claims";
import { ROBINHOOD_USDG } from "../src/domain/robinhood-assets";
import { STOCK_TOKEN_ALLOWLISTS } from "../src/domain/robinhood-stock-tokens";
import type { StockClaimPlatform } from "../src/domain/stock-claims";

const NOW = 1_790_000_000n;
const WALLET = getAddress("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a");
const STRANGER = getAddress("0x4444444444444444444444444444444444444444");
const ZERO = "0x0000000000000000000000000000000000000000";
const ESCROW = getAddress("0x8a7e4e1b6f1ca842a9b84e5cb18a46edf2ceb789");
const ARC_ESCROW = getAddress("0x6666666666666666666666666666666666666666");
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const NVDA = STOCK_TOKEN_ALLOWLISTS["robinhood-mainnet"].tokens.find((token) => token.symbol === "NVDA")!;
const OCTOCAT: VerifiedSocialAccount = { platform: "github", providerUserId: "583231", username: "octocat", verifiedAt: "2026-10-03T09:00:00.000Z" };
const DWR: VerifiedSocialAccount = { platform: "farcaster", providerUserId: "3", username: "dwr", verifiedAt: "2026-10-03T09:00:00.000Z" };
const TELEGRAM: VerifiedSocialAccount = { platform: "telegram", providerUserId: "77", username: "deniz", verifiedAt: "2026-10-03T09:00:00.000Z" };

const id = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
const key = (platform: StockClaimPlatform, providerUserId: string) => stockClaimIdentityKey(platform, providerUserId);
type Payment = readonly [Address, Address, Hex, bigint, bigint, bigint];

function stockRecord(paymentId: Hex, overrides: Partial<StockClaimRecord> = {}): StockClaimRecord {
  return {
    chainId: 4663,
    paymentId,
    escrow: ESCROW,
    fundingTransactionHash: `0x${paymentId.slice(4, 6).repeat(31)}ff` as Hex,
    tokenAddress: ROBINHOOD_USDG.address,
    tokenSymbol: "USDG",
    payer: STRANGER,
    recipientPlatform: "github",
    recipientUsername: "octocat",
    amount: "10",
    units: 10_000_000n,
    expiry: NOW + 3_600n,
    blockNumber: 100n,
    confirmedAt: "2026-10-03T09:00:00.000Z",
    ...overrides,
  };
}

function arcRecord(paymentId: Hex, overrides: Partial<ClaimFundingRecord> = {}): ClaimFundingRecord {
  return {
    chainId: 5042,
    transactionHash: `0x${paymentId.slice(4, 6).repeat(31)}ee` as Hex,
    paymentId,
    payer: STRANGER,
    recipientPlatform: "github",
    recipientUsername: "octocat",
    amount: "25",
    expiry: NOW + 3_600n,
    blockNumber: 100n,
    confirmedAt: "2026-10-03T09:00:00.000Z",
    ...overrides,
  };
}

describe("pending claim lookups in the funding records", () => {
  async function exerciseStock(repository: StockClaimRepository) {
    const soonest = stockRecord(id(1), { expiry: NOW });
    const later = stockRecord(id(2), { expiry: NOW + 100n, blockNumber: 11n });
    const sooner = stockRecord(id(3), { expiry: NOW + 50n, payer: WALLET });
    const onX = stockRecord(id(4), { recipientPlatform: "x", expiry: NOW + 60n });
    const closed = stockRecord(id(5), { expiry: NOW - 1n, payer: WALLET });
    const testnet = stockRecord(id(6), { chainId: 46630, payer: WALLET });
    for (const record of [soonest, later, sooner, onX, closed, testnet]) await repository.saveClaim(record);

    const github = [{ platform: "github" as const, username: "octocat" }];
    assert.deepEqual((await repository.waitingFor(4663, github, NOW, 10)).map((record) => record.paymentId), [id(1), id(3), id(2)], "open windows only, the exact expiry second included, soonest first");
    assert.deepEqual((await repository.waitingFor(4663, github, NOW, 2)).map((record) => record.paymentId), [id(1), id(3)]);
    assert.deepEqual((await repository.waitingFor(4663, [...github, { platform: "x", username: "octocat" }], NOW, 10)).map((record) => record.paymentId), [id(1), id(3), id(4), id(2)], "each account matches its own platform");
    assert.deepEqual(await repository.waitingFor(4663, [], NOW, 10), []);
    assert.deepEqual(await repository.waitingFor(4663, [{ platform: "github", username: "octo" }], NOW, 10), []);
    assert.deepEqual((await repository.fundedBy(4663, WALLET.toLowerCase() as Address, 10)).map((record) => record.paymentId), [id(3), id(5)], "a payer's links on this chain, latest deadline first, closed ones too");
    assert.deepEqual((await repository.fundedBy(46630, WALLET, 10)).map((record) => record.paymentId), [id(6)]);
  }

  async function exerciseArc(repository: ClaimFundingRepository) {
    await repository.save(arcRecord(id(1), { expiry: NOW + 10n }));
    await repository.save(arcRecord(id(2), { expiry: NOW, payer: WALLET }));
    await repository.save(arcRecord(id(3), { expiry: NOW - 1n, payer: WALLET }));
    await repository.save(arcRecord(id(4), { chainId: 5_042_002 }));
    await repository.save(arcRecord(id(5), { recipientPlatform: "farcaster", recipientUsername: "dwr", expiry: NOW + 5n }));
    const accounts = [{ platform: "github" as const, username: "octocat" }, { platform: "farcaster" as const, username: "dwr" }];
    assert.deepEqual((await repository.waitingFor(5042, accounts, NOW, 10)).map((record) => record.paymentId), [id(2), id(5), id(1)], "another Arc chain is never read");
    assert.deepEqual((await repository.waitingFor(5042, accounts, NOW, 1)).map((record) => record.paymentId), [id(2)]);
    assert.deepEqual((await repository.fundedBy(5042, WALLET, 10)).map((record) => record.paymentId), [id(2), id(3)]);
    assert.deepEqual(await repository.fundedBy(5_042_002, WALLET, 10), []);
  }

  it("finds open links by account and a payer's links in PostgreSQL", async () => {
    const database = newDb();
    const pool = new (database.adapters.createPg().Pool)();
    const stock = new PostgresStockClaimRepository(pool);
    await stock.migrate();
    await exerciseStock(stock);
    const arc = new PostgresClaimFundingRepository(pool);
    await arc.migrate();
    await exerciseArc(arc);
    await pool.end();
  });

  it("behaves the same in memory", async () => {
    await exerciseStock(new MemoryStockClaimRepository());
    await exerciseArc(new MemoryClaimFundingRepository());
  });
});

describe("pending Robinhood Chain vault links", () => {
  function setup(payments: Record<Hex, Payment>, options: { down?: boolean } = {}) {
    const repository = new MemoryStockClaimRepository();
    const reads: string[] = [];
    const client = {
      readContract: async (input: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        assert.equal(input.functionName, "payments");
        reads.push(String(input.args?.[0]));
        if (options.down) throw new Error("socket hang up");
        return payments[input.args?.[0] as Hex] ?? [ZERO, ZERO, `0x${"00".repeat(32)}`, 0n, 0n, 0n];
      },
    } as unknown as StockChainClient;
    const service = new StockClaimService({
      transfers: {
        availability: () => ({ enabled: true, tokens: { enabled: true } }),
        verifiedClient: async (network) => {
          reads.push(`client:${network}`);
          return client;
        },
        transactionReceipt: async () => { throw new Error("unused"); },
      },
      repository,
      directory: { lookup: async () => { throw new Error("unused"); } },
      config: readStockClaimConfig({ ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: generatePrivateKey(), CONTRACT_OWNER_ADDRESS: STRANGER }),
      now: () => Number(NOW) * 1000,
    });
    return { repository, service, reads };
  }

  it("lists links locked to the wallet's accounts and links it funded, as the escrow holds them now", async () => {
    const octocat = key("github", OCTOCAT.providerUserId);
    const { repository, service, reads } = setup({
      // Waiting for octocat: a Stock Token needs the statement, USDG does not.
      [id(1)]: [STRANGER, NVDA.address, octocat, 2n * 10n ** 18n, 2n * 10n ** 16n, NOW + 7_200n],
      [id(2)]: [STRANGER, ROBINHOOD_USDG.address, key("farcaster", "3"), 10_000_000n, 100_000n, NOW + 3_600n],
      // Sent to "octocat" while the handle belonged to another account: locked to that account, so not listed.
      [id(3)]: [STRANGER, ROBINHOOD_USDG.address, key("github", "999"), 5_000_000n, 50_000n, NOW + 3_600n],
      // Already claimed or refunded: the escrow no longer holds it.
      // [id(4)] reads as empty.
      // Funded by the wallet: still claimable by the recipient, then refundable once the window closed.
      [id(5)]: [WALLET, ROBINHOOD_USDG.address, key("x", "12"), 3_000_000n, 30_000n, NOW + 60n],
      [id(6)]: [WALLET, ROBINHOOD_USDG.address, key("github", "777"), 4_000_000n, 40_000n, NOW - 60n],
      // Sent to the wallet's own account: listed once, as a claim.
      [id(8)]: [WALLET, ROBINHOOD_USDG.address, octocat, 1_000_000n, 10_000n, NOW + 30n],
      // A token that is not on the mainnet list is never shown.
      [id(9)]: [WALLET, "0x9999999999999999999999999999999999999999", key("x", "12"), 1n, 0n, NOW + 30n],
    });
    await repository.saveClaim(stockRecord(id(1), { tokenAddress: NVDA.address, tokenSymbol: "NVDA", sourcePlatform: "x", sourceUsername: "alice" }));
    await repository.saveClaim(stockRecord(id(2), { recipientPlatform: "farcaster", recipientUsername: "dwr" }));
    await repository.saveClaim(stockRecord(id(3)));
    await repository.saveClaim(stockRecord(id(4)));
    await repository.saveClaim(stockRecord(id(5), { payer: WALLET, recipientPlatform: "x", recipientUsername: "bob" }));
    await repository.saveClaim(stockRecord(id(6), { payer: WALLET, recipientUsername: "carol", expiry: NOW - 60n }));
    await repository.saveClaim(stockRecord(id(7), { payer: WALLET, expiry: NOW - 600n }));
    await repository.saveClaim(stockRecord(id(8), { payer: WALLET }));
    await repository.saveClaim(stockRecord(id(9), { payer: WALLET, recipientPlatform: "x", recipientUsername: "bob" }));
    await repository.saveClaim(stockRecord(id(10), { chainId: 46630 }));

    const links = await service.pending({ network: "robinhood-mainnet", wallet: WALLET.toLowerCase(), accounts: [OCTOCAT, DWR, TELEGRAM] });
    const brief = (link: PendingVaultLink) => [link.paymentId, link.status, link.token.symbol, link.amount, `${link.recipient.platform}:${link.recipient.username}`, link.statementRequired ?? false];
    assert.deepEqual(links.incoming.map(brief).sort(), [
      [id(1), "claimable", "NVDA", "2", "github:octocat", true],
      [id(2), "claimable", "USDG", "10", "farcaster:dwr", false],
      [id(8), "claimable", "USDG", "1", "github:octocat", false],
    ].sort());
    assert.deepEqual(links.outgoing.map(brief).sort(), [
      [id(5), "waiting", "USDG", "3", "x:bob", false],
      [id(6), "refundable", "USDG", "4", "github:carol", false],
    ].sort());
    const nvda = links.incoming.find((link) => link.paymentId === id(1))!;
    assert.deepEqual(nvda, {
      network: "robinhood-mainnet",
      chainId: 4663,
      chainName: "Robinhood Chain",
      paymentId: id(1),
      escrow: ESCROW,
      token: { symbol: "NVDA", name: NVDA.name, address: NVDA.address, kind: NVDA.kind, decimals: 18 },
      amount: "2",
      recipient: { platform: "github", username: "octocat" },
      sender: { wallet: STRANGER, platform: "x", username: "alice" },
      expiresAt: new Date(Number(NOW + 7_200n) * 1000).toISOString(),
      status: "claimable",
      statementRequired: true,
      claimPath: `/claim/stock/robinhood-mainnet/${id(1)}`,
    });
    assert.equal(reads.filter((read) => read === id(8)).length, 1, "a link found both ways is read once");
    assert.equal(reads.some((read) => read === id(10)), false, "a testnet link is not read for mainnet");
  });

  it("reads nothing from the chain when no link names the wallet or its accounts", async () => {
    const { service, reads } = setup({});
    assert.deepEqual(await service.pending({ network: "robinhood-mainnet", wallet: WALLET, accounts: [OCTOCAT, TELEGRAM] }), { incoming: [], outgoing: [] });
    assert.deepEqual(reads, []);
  });

  it("fails the whole network when the escrow cannot be read, rather than guessing", async () => {
    const { repository, service } = setup({}, { down: true });
    await repository.saveClaim(stockRecord(id(1)));
    await assert.rejects(() => service.pending({ network: "robinhood-mainnet", wallet: WALLET, accounts: [OCTOCAT] }), StockTransferUnavailableError);
  });
});

describe("pending Arc vault links", () => {
  function service(payments: Record<Hex, Payment>, records?: ClaimFundingRepository) {
    return new ClaimRedemptionService({
      chainId: 5042,
      escrow: ARC_ESCROW,
      usdc: USDC,
      attestor: privateKeyToAccount(generatePrivateKey()),
      readPayment: async (paymentId) => {
        const [payer, token, identityKey, amount, fee, expiry] = payments[paymentId] ?? [ZERO, ZERO, `0x${"00".repeat(32)}`, 0n, 0n, 0n];
        return { payer, token, identityKey, amount, fee, expiry };
      },
      records,
      network: { id: "arc-mainnet", name: "Arc Mainnet" },
      now: () => new Date(Number(NOW) * 1000),
    });
  }

  it("lists USDC links for the wallet's accounts and the links it funded, read back from the escrow", async () => {
    const records = new MemoryClaimFundingRepository();
    await records.save(arcRecord(id(1), { sourceIdentity: { platform: "github", username: "alice" } }));
    await records.save(arcRecord(id(2)));
    await records.save(arcRecord(id(3)));
    await records.save(arcRecord(id(4), { payer: WALLET, recipientUsername: "bob" }));
    await records.save(arcRecord(id(5), { payer: WALLET, recipientUsername: "carol", expiry: NOW - 1n }));
    const octocat = key("github", OCTOCAT.providerUserId);
    const links = await service({
      [id(1)]: [STRANGER, USDC, octocat, 25_000_000n, 250_000n, NOW + 3_600n],
      // Locked to another account that once used the handle.
      [id(2)]: [STRANGER, USDC, key("github", "999"), 25_000_000n, 250_000n, NOW + 3_600n],
      // Not USDC: an Arc link is only ever USDC.
      [id(3)]: [STRANGER, ROBINHOOD_USDG.address, octocat, 25_000_000n, 250_000n, NOW + 3_600n],
      [id(4)]: [WALLET, USDC, key("github", "4"), 1_500_000n, 15_000n, NOW + 3_600n],
      [id(5)]: [WALLET, USDC, key("github", "5"), 2_000_000n, 20_000n, NOW - 1n],
    }, records).pending({ wallet: WALLET, accounts: [OCTOCAT, TELEGRAM] });
    assert.deepEqual(links.incoming, [{
      network: "arc-mainnet",
      chainId: 5042,
      chainName: "Arc Mainnet",
      paymentId: id(1),
      escrow: ARC_ESCROW,
      token: { symbol: "USDC", name: "USDC", address: USDC, decimals: 6 },
      amount: "25",
      recipient: { platform: "github", username: "octocat" },
      sender: { wallet: STRANGER, platform: "github", username: "alice" },
      expiresAt: new Date(Number(NOW + 3_600n) * 1000).toISOString(),
      status: "claimable",
      claimPath: `/claim/${id(1)}`,
    }]);
    assert.deepEqual(links.outgoing.map((link) => [link.paymentId, link.status, link.amount]), [[id(4), "waiting", "1.5"], [id(5), "refundable", "2"]]);
  });

  it("lists nothing without funding records", async () => {
    assert.deepEqual(await service({}).pending({ wallet: WALLET, accounts: [OCTOCAT] }), { incoming: [], outgoing: [] });
  });

  it("finds a refundable link behind twenty newer links that were claimed", async () => {
    // Audit, 2026-10-06: the limit applied to records before settled links were dropped, so the old link vanished.
    const repository = new MemoryClaimFundingRepository();
    const now = 2_000_000_000n;
    const old = `0x${"01".repeat(32)}` as Hex;
    const record = (paymentId: Hex, expiry: bigint, blockNumber: bigint): ClaimFundingRecord => ({
      chainId: 5042, transactionHash: paymentId.replace("0x", "0xf") .slice(0, 66) as Hex, paymentId, payer: WALLET, recipientPlatform: "github",
      recipientUsername: `user${blockNumber}`, amount: "1", expiry, blockNumber, confirmedAt: "2026-10-02T00:00:00.000Z",
    });
    await repository.save(record(old, now - 3_600n, 1n));
    for (let index = 2n; index < 22n; index++) {
      const id = `0x${index.toString(16).padStart(64, "0")}` as Hex;
      await repository.save({ ...record(id, now + 86_400n * index, index), transactionHash: `0x${(1000n + index).toString(16).padStart(64, "0")}` as Hex });
    }
    const redemptions = new ClaimRedemptionService({
      chainId: 5042, escrow: "0x5555555555555555555555555555555555555555", usdc: "0x3600000000000000000000000000000000000000",
      attestor: privateKeyToAccount(generatePrivateKey()),
      // Only the old link is still in the escrow; the twenty others were claimed.
      readPayment: async (paymentId: Hex) => paymentId === old
        ? { payer: WALLET, token: "0x3600000000000000000000000000000000000000", identityKey: `0x${"ab".repeat(32)}`, amount: 500_000_000n, fee: 5_000_000n, expiry: now - 3_600n }
        : { payer: ZERO, token: ZERO, identityKey: `0x${"00".repeat(32)}`, amount: 0n, fee: 0n, expiry: 0n },
      records: repository,
      network: { id: "arc-mainnet", name: "Arc Mainnet" },
      now: () => new Date(Number(now) * 1000),
    });
    const { outgoing } = await redemptions.pending({ wallet: WALLET, accounts: [] });
    assert.deepEqual(outgoing.map((link) => [link.paymentId, link.amount, link.status]), [[old, "500", "refundable"]]);
  });
});

describe("the pending claims list in the browser's order", () => {
  it("puts the soonest claim deadline first and the links you can take back before the ones still waiting", () => {
    const link = (paymentId: Hex, status: PendingVaultLink["status"], expiresAt: string) => ({ paymentId, status, expiresAt }) as PendingVaultLink;
    const sorted = sortPendingVaultLinks({
      incoming: [link(id(1), "claimable", "2026-10-05T00:00:00.000Z"), link(id(2), "claimable", "2026-10-04T00:00:00.000Z")],
      outgoing: [link(id(3), "waiting", "2026-10-04T00:00:00.000Z"), link(id(4), "refundable", "2026-10-01T00:00:00.000Z"), link(id(5), "refundable", "2026-09-30T00:00:00.000Z")],
      unavailable: [],
    });
    assert.deepEqual(sorted.incoming.map((entry) => entry.paymentId), [id(2), id(1)]);
    assert.deepEqual(sorted.outgoing.map((entry) => entry.paymentId), [id(5), id(4), id(3)]);
  });
});

describe("GET /api/claims/pending", () => {
  it("answers only a wallet session, passes its verified accounts with their provider IDs, and names a network it could not read", async () => {
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "pending-claims-api-secret-with-32-chars" });
    const identities = new VerifiedIdentityService();
    const account = privateKeyToAccount(generatePrivateKey());
    identities.link(account.address, OCTOCAT);
    identities.link(account.address, TELEGRAM);
    const seen: Array<{ source: string; wallet: string; accounts: string[] }> = [];
    const arcLink = { paymentId: id(1), status: "claimable", expiresAt: "2026-10-05T00:00:00.000Z" } as PendingVaultLink;
    const stockLink = { paymentId: id(2), status: "claimable", expiresAt: "2026-10-04T00:00:00.000Z" } as PendingVaultLink;
    const sent = { paymentId: id(3), status: "refundable", expiresAt: "2026-10-01T00:00:00.000Z" } as PendingVaultLink;
    let robinhoodDown = false;
    const redemptions = {
      details: async () => { throw new Error("the list is not a payment ID"); },
      prepareClaim: async () => { throw new Error("unused"); },
      prepareRefund: async () => { throw new Error("unused"); },
      pending: async (input: { wallet: string; accounts: VerifiedSocialAccount[] }) => {
        seen.push({ source: "arc", wallet: input.wallet, accounts: input.accounts.map((entry) => `${entry.platform}:${entry.providerUserId}`).sort() });
        return { incoming: [arcLink], outgoing: [] };
      },
    };
    const stockClaims = {
      availability: async () => ({ enabled: false }),
      feeSchedule: async () => undefined,
      deployment: async () => { throw new Error("unused"); },
      register: async () => { throw new Error("unused"); },
      prepare: async () => { throw new Error("unused"); },
      confirmFunding: async () => { throw new Error("unused"); },
      details: async () => { throw new Error("unused"); },
      prepareClaim: async () => { throw new Error("unused"); },
      prepareRefund: async () => { throw new Error("unused"); },
      pending: async (input: { network: string; wallet: string }) => {
        seen.push({ source: input.network, wallet: input.wallet, accounts: [] });
        if (robinhoodDown) throw new StockTransferUnavailableError("Robinhood Chain is not reachable right now. Try again shortly.");
        return { incoming: [stockLink], outgoing: [sent] };
      },
    };
    const server = await listen(createApp({ auth, identities, redemptions: redemptions as never, stockClaims: stockClaims as never }));
    const bare = await listen(createApp({ auth, identities }));
    try {
      assert.equal((await fetch(`${origin(server)}/api/claims/pending`)).status, 401);
      const cookie = await signIn(origin(server), account);
      const read = async (target: Server) => {
        const response = await fetch(`${origin(target)}/api/claims/pending`, { headers: { Cookie: cookie } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        return response.json() as Promise<{ incoming: PendingVaultLink[]; outgoing: PendingVaultLink[]; unavailable: string[] }>;
      };
      const listed = await read(server);
      assert.deepEqual(listed.incoming.map((link) => link.paymentId), [id(2), id(1)], "both networks, soonest deadline first");
      assert.deepEqual(listed.outgoing.map((link) => link.paymentId), [id(3)]);
      assert.deepEqual(listed.unavailable, []);
      assert.deepEqual(seen.sort((left, right) => left.source.localeCompare(right.source)), [
        { source: "arc", wallet: account.address, accounts: ["github:583231", "telegram:77"] },
        { source: "robinhood-mainnet", wallet: account.address, accounts: [] },
      ]);

      robinhoodDown = true;
      const partial = await read(server);
      assert.deepEqual(partial.incoming.map((link) => link.paymentId), [id(1)]);
      assert.deepEqual(partial.unavailable, ["Robinhood Chain"]);

      assert.deepEqual(await read(bare), { incoming: [], outgoing: [], unavailable: [] }, "a server without vaults lists nothing");
    } finally {
      await close(server);
      await close(bare);
    }
  });
});

async function listen(app: ReturnType<typeof createApp>) {
  return new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
}

function origin(listener: Server) {
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function close(listener: Server) {
  return new Promise<void>((resolve) => listener.close(() => resolve()));
}

async function signIn(base: string, account: ReturnType<typeof privateKeyToAccount>) {
  const challenge = await (await fetch(`${base}/api/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  })).json() as { id: string; message: string };
  const login = await fetch(`${base}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) }),
  });
  return login.headers.get("set-cookie")?.split(";")[0] ?? "";
}
