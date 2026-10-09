import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { MemoryClaimFundingRepository, type ClaimFundingRecord } from "../server/claim-funding-service";
import { MemoryPaymentRepository } from "../server/payment-history-service";
import { MemorySolanaTransferRepository, NATIVE_SOL_MINT } from "../server/solana-transfer-service";
import { MemorySolanaVaultRepository, type SolanaClaimRecord } from "../server/solana-vault-service";
import { SpActivity } from "../server/sp-activity";
import { MemorySpRepository, SpRequestError, SpService } from "../server/sp-service";
import { MemoryStockClaimRepository } from "../server/stock-claim-service";
import { MemoryStockTransferRepository } from "../server/stock-transfer-service";
import { MemoryTransientStateStore } from "../server/transient-state-store";
import type { VaultSettlement } from "../server/vault-settlement";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { ROBINHOOD_USDG } from "../src/domain/robinhood-assets";
import { SOLANA_USDC } from "../src/domain/solana-assets";

const ALICE = getAddress("0x1111111111111111111111111111111111111111");
const BOB = getAddress("0x2222222222222222222222222222222222222222");
const NOW = new Date("2026-10-05T12:00:00Z");
const SECONDS = BigInt(NOW.getTime() / 1000);
const hash = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;

function setup() {
  const sp = new SpService({ repository: new MemorySpRepository(() => NOW), now: () => NOW, rulesCacheMs: 0, prices: async () => undefined });
  const identities = new VerifiedIdentityService();
  const payments = new MemoryPaymentRepository();
  const stockTransfers = new MemoryStockTransferRepository();
  const solanaTransfers = new MemorySolanaTransferRepository();
  const arcLinks = new MemoryClaimFundingRepository();
  const solanaLinks = new MemorySolanaVaultRepository();
  const settlements = new Map<string, VaultSettlement>();
  const settleCalls: Array<{ paymentId: string; claimTransaction?: Hex; candidates: Address[] }> = [];
  const settle = async (record: { paymentId: string }, input: { claimTransaction?: Hex; candidates: readonly { wallet: Address }[] }) => {
    settleCalls.push({ paymentId: record.paymentId, claimTransaction: input.claimTransaction, candidates: input.candidates.map((candidate) => candidate.wallet) });
    return settlements.get(record.paymentId) ?? { state: "open" as const };
  };
  let solanaAddress: string | undefined;
  const activity = new SpActivity({
    sp,
    identities,
    now: () => NOW,
    stateStore: new MemoryTransientStateStore(),
    linkScanMs: 60_000,
    sources: {
      arc: { payments, links: arcLinks, settle },
      robinhood: { transfers: stockTransfers, links: new MemoryStockClaimRepository(), settle },
      solana: { transfers: solanaTransfers, address: async () => solanaAddress, links: solanaLinks, settle },
    },
  });
  return { sp, identities, payments, stockTransfers, solanaTransfers, arcLinks, solanaLinks, settlements, settleCalls, activity, setSolanaAddress: (value: string) => { solanaAddress = value; } };
}

const arcLink = (paymentId: Hex, change: Partial<ClaimFundingRecord> = {}): ClaimFundingRecord => ({
  chainId: 5042, transactionHash: hash(0xf0), paymentId, payer: ALICE, recipientPlatform: "github", recipientUsername: "bob",
  amount: "10", expiry: SECONDS + 86_400n, blockNumber: 1n, confirmedAt: "2026-10-04T12:00:00.000Z", ...change,
});

/** SP for everything an account did on every network, once. */
describe("SP activity", () => {
  it("awards payments sent on Arc, Robinhood Chain and Solana mainnet, never testnets or received ones, once", async () => {
    const { payments, stockTransfers, solanaTransfers, activity, sp } = setup();
    await payments.save({ chainId: 5042, transactionHash: hash(1), sender: ALICE, recipient: BOB, platform: "github", username: "bob", amount: "25", feeUnits: "250000", blockNumber: 1n, confirmedAt: "2026-10-05T08:00:00.000Z" });
    await payments.save({ chainId: 5042002, transactionHash: hash(2), sender: ALICE, recipient: BOB, platform: "github", username: "bob", amount: "500", feeUnits: "5000000", blockNumber: 1n, confirmedAt: "2026-10-05T08:00:00.000Z" });
    await payments.save({ chainId: 5042, transactionHash: hash(3), sender: BOB, recipient: ALICE, platform: "x", username: "alice", amount: "99", feeUnits: "990000", blockNumber: 2n, confirmedAt: "2026-10-05T08:30:00.000Z" });
    await stockTransfers.save({ chainId: 4663, transactionHash: hash(4), tokenAddress: ROBINHOOD_USDG.address, tokenSymbol: "USDG", sender: ALICE, recipient: BOB, platform: "github", username: "bob", amount: "10.55", units: 10_550_000n, feeUnits: "105500", blockNumber: 1n, confirmedAt: "2026-10-05T09:00:00.000Z" });
    await stockTransfers.save({ chainId: 46630, transactionHash: hash(5), tokenAddress: ROBINHOOD_USDG.address, tokenSymbol: "USDG", sender: ALICE, recipient: BOB, platform: "github", username: "bob", amount: "10", units: 10_000_000n, feeUnits: "100000", blockNumber: 1n, confirmedAt: "2026-10-05T09:00:00.000Z" });
    // A plain transfer sent around the desk's fee router (audit, 2026-10-06): recorded, and earning nothing.
    await stockTransfers.save({ chainId: 4663, transactionHash: hash(6), tokenAddress: ROBINHOOD_USDG.address, tokenSymbol: "USDG", sender: ALICE, recipient: BOB, platform: "github", username: "bob", amount: "334", units: 334_000_000n, blockNumber: 2n, confirmedAt: "2026-10-05T09:30:00.000Z" });
    await solanaTransfers.save([
      { signature: "sig1", paymentIndex: 0, mint: SOLANA_USDC.mint!, tokenSymbol: "USDC", senderWallet: ALICE, senderAddress: "A", recipientWallet: BOB, recipientAddress: "B", platform: "github", username: "bob", amount: "5", units: "5000000", feeUnits: "50000", slot: 1n, confirmedAt: "2026-10-05T10:00:00.000Z" },
      { signature: "sig1", paymentIndex: 1, mint: NATIVE_SOL_MINT, tokenSymbol: "SOL", senderWallet: ALICE, senderAddress: "A", recipientWallet: BOB, recipientAddress: "B", platform: "github", username: "bob", amount: "1", units: "1000000000", feeUnits: "0", slot: 1n, confirmedAt: "2026-10-05T10:00:00.000Z" },
    ]);
    const result = await activity.syncAccount(ALICE, { links: false });
    // Arc 25 USDC: 25 + the first-payment bonus; Robinhood 10.55 USDG: 10.5; Solana 5 USDC: 5; SOL has no price yet.
    assert.equal(result.awarded, 50.5);
    assert.equal(result.pending, 1);
    assert.equal((await activity.syncAccount(ALICE, { links: false })).awarded, 0, "a second sync awards nothing new");
    assert.equal(await sp.repository.balance(ALICE), 50.5);
    assert.equal((await activity.syncAccount(BOB, { links: false })).awarded, 99 + 10, "Bob's own payment on Arc");
    const plain = await sp.repository.entryBySource(`robinhood:${hash(6)}`);
    assert.deepEqual([plain?.amount, plain?.reason], [0, "It did not pay HaPaPay's fee, so it earns no SP"]);
  });

  it("keeps the fee each network verified on the payment's SP row, and none for a transfer that paid none", async () => {
    const { payments, stockTransfers, solanaTransfers, solanaLinks, settlements, identities, activity, sp } = setup();
    await payments.save({ chainId: 5042, transactionHash: hash(0x21), sender: ALICE, recipient: BOB, platform: "github", username: "bob", amount: "25", feeUnits: "250000", blockNumber: 1n, confirmedAt: "2026-10-05T08:00:00.000Z" });
    await payments.save({ chainId: 5042, transactionHash: hash(0x22), sender: ALICE, recipient: BOB, platform: "github", username: "bob", amount: "30", blockNumber: 2n, confirmedAt: "2026-10-05T08:10:00.000Z" });
    await stockTransfers.save({ chainId: 4663, transactionHash: hash(0x23), tokenAddress: ROBINHOOD_USDG.address, tokenSymbol: "USDG", sender: ALICE, recipient: BOB, platform: "github", username: "bob", amount: "10.55", units: 10_550_000n, feeUnits: "105500", blockNumber: 1n, confirmedAt: "2026-10-05T09:00:00.000Z" });
    await solanaTransfers.save([
      { signature: "fee1", paymentIndex: 0, mint: SOLANA_USDC.mint!, tokenSymbol: "USDC", senderWallet: ALICE, senderAddress: "A", recipientWallet: BOB, recipientAddress: "B", platform: "github", username: "bob", amount: "5", units: "5000000", feeUnits: "50000", slot: 1n, confirmedAt: "2026-10-05T10:00:00.000Z" },
    ]);
    // A Solana link Bob claimed: the program took exactly 1% on top when it was funded.
    identities.link(BOB, { platform: "github", providerUserId: "42", username: "bob", verifiedAt: "2026-10-01T00:00:00.000Z" });
    const link: SolanaClaimRecord = {
      paymentId: hash(0x24), programId: "Prog", fundingSignature: "fund-fee", mint: SOLANA_USDC.mint!, tokenSymbol: "USDC", payerWallet: ALICE, payerAddress: "A",
      recipientPlatform: "github", recipientUsername: "bob", amount: "20", units: 20_000_000n, expiry: SECONDS + 3_600n, slot: 1n, confirmedAt: "2026-10-05T07:00:00.000Z",
    };
    await solanaLinks.saveClaim(link);
    settlements.set(hash(0x24), { state: "claimed", claimer: BOB });
    await activity.syncAccount(ALICE, { links: false });
    await activity.syncAccount(BOB);
    const fee = async (sourceKey: string) => (await sp.repository.entryBySource(sourceKey))?.feeUsdUnits;
    assert.equal(await fee(`arc:${hash(0x21)}`), 250_000, "the router's 0.25 USDC fee, in millionths of a dollar");
    assert.equal(await fee(`arc:${hash(0x22)}`), null, "a plain transfer paid no fee");
    assert.equal(await fee(`robinhood:${hash(0x23)}`), 105_500);
    assert.equal(await fee("solana:fee1:0"), 50_000);
    assert.equal(await fee(`vault:solana:${hash(0x24)}`), 200_000, "the link's fee, paid at the claim");
  });

  it("tells the syncing account only the SP it earned itself when a link it sent is claimed", async () => {
    // Audit, 2026-10-06: the sender's sync added the claimer's SP to the sender's toast.
    const { arcLinks, settlements, activity, sp } = setup();
    const paymentId = hash(0x41);
    await arcLinks.save({ chainId: 5042, transactionHash: hash(0x42), paymentId, payer: ALICE, recipientPlatform: "github", recipientUsername: "bob", amount: "100", expiry: SECONDS + 86_400n, blockNumber: 1n, confirmedAt: "2026-10-04T12:00:00.000Z" });
    settlements.set(paymentId, { state: "claimed", claimer: BOB });
    const result = await activity.syncAccount(ALICE, { links: "now" });
    assert.equal(result.awarded, await sp.repository.balance(ALICE));
    assert.ok(await sp.repository.balance(BOB) > 0, "Bob earned SP for claiming, which Alice's sync does not report as hers");
  });

  it("awards linked accounts and the Solana address once", async () => {
    const { identities, activity, setSolanaAddress } = setup();
    identities.link(ALICE, { platform: "github", providerUserId: "583231", username: "alice", verifiedAt: "2026-10-01T00:00:00.000Z" });
    identities.link(ALICE, { platform: "telegram", providerUserId: "77", username: "alice", verifiedAt: "2026-10-02T00:00:00.000Z" });
    setSolanaAddress("So1anaAddress1111111111111111111111111111111");
    assert.equal((await activity.syncAccount(ALICE, { links: false })).awarded, 2 + 2 + 2);
    assert.equal((await activity.syncAccount(ALICE, { links: false })).awarded, 0);
  });

  it("awards a claimed link to its claimer and its sender, closes a refunded one, and reads chains at most once a minute", async () => {
    const { identities, arcLinks, solanaLinks, settlements, settleCalls, activity, sp } = setup();
    identities.link(BOB, { platform: "github", providerUserId: "42", username: "bob", verifiedAt: "2026-10-01T00:00:00.000Z" });
    await arcLinks.save(arcLink(hash(0x0a)));
    const solanaRecord: SolanaClaimRecord = {
      paymentId: hash(0x0b), programId: "Prog", fundingSignature: "fund", mint: SOLANA_USDC.mint!, tokenSymbol: "USDC", payerWallet: ALICE, payerAddress: "A",
      recipientPlatform: "github", recipientUsername: "bob", amount: "20", units: 20_000_000n, expiry: SECONDS - 3_600n, slot: 1n, confirmedAt: "2026-10-01T12:00:00.000Z",
    };
    await solanaLinks.saveClaim(solanaRecord);
    settlements.set(hash(0x0a), { state: "claimed", claimer: BOB });
    settlements.set(hash(0x0b), { state: "refunded" });

    // Bob's sync finds the Arc link sent to his account (window open) and the chain says he claimed it.
    const bob = await activity.syncAccount(BOB);
    assert.equal(bob.awarded, 2 + 5 + 5, "Bob's GitHub bonus, claim and first claim; Alice's SP for the same link are hers, not in Bob's answer");
    assert.deepEqual(settleCalls.map((call) => call.paymentId), [hash(0x0a)]);
    assert.equal(await sp.repository.balance(BOB), 12);
    assert.equal(await sp.repository.balance(ALICE), 25);

    // Alice's sync reads only what has not earned: the refunded Solana link is closed with no SP.
    settleCalls.length = 0;
    assert.equal((await activity.syncAccount(ALICE)).awarded, 0);
    assert.deepEqual(settleCalls.map((call) => call.paymentId), [hash(0x0b)]);
    const closed = (await sp.repository.ledger({ account: ALICE, limit: 10, includeZero: true })).find((row) => row.sourceKey === `vault:solana:${hash(0x0b)}`);
    assert.equal(closed?.amount, 0);
    assert.match(closed?.reason ?? "", /refunded/);

    settleCalls.length = 0;
    await activity.syncAccount(ALICE);
    assert.deepEqual(settleCalls, [], "the next scan waits for the minute");
  });

  it("checks a reported claim against the chain, with the claim transaction on EVM networks", async () => {
    const { identities, arcLinks, settlements, settleCalls, activity } = setup();
    identities.link(BOB, { platform: "github", providerUserId: "42", username: "bob", verifiedAt: "2026-10-01T00:00:00.000Z" });
    await arcLinks.save(arcLink(hash(0x0c)));
    assert.deepEqual(await activity.reportClaim(BOB, { network: "arc", paymentId: hash(0x0c), transaction: hash(0xcc) }), { status: "open", awarded: 0 });
    assert.equal(settleCalls[0].claimTransaction, hash(0xcc));
    assert.deepEqual(settleCalls[0].candidates, [BOB, BOB], "the reporter, and whoever holds the handle now");
    settlements.set(hash(0x0c), { state: "claimed", claimer: BOB });
    assert.deepEqual(await activity.reportClaim(BOB, { network: "arc", paymentId: hash(0x0c).toUpperCase().replace("0X", "0x"), transaction: hash(0xcc) }), { status: "awarded", awarded: 5 + 5 });
    assert.deepEqual(await activity.reportClaim(BOB, { network: "arc", paymentId: hash(0x0c) }), { status: "already", awarded: 0 });
    await assert.rejects(() => activity.reportClaim(BOB, { network: "arc", paymentId: hash(0x0d) }), SpRequestError);
  });
});
