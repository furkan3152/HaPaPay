import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, parseUnits } from "viem";
import { formatUsdc, referralCode, referralLink } from "../src/domain/referrals";
import { DEFAULT_SP_RULES, referralFeeUnits, referralSp, validateSpRules } from "../src/domain/sp";
import { MemoryPaymentRepository } from "../server/payment-history-service";
import { MemoryReferralStore } from "../server/referral-store";
import { SpActivity } from "../server/sp-activity";
import { MemorySpRepository, SpService, type SpPaymentEvent } from "../server/sp-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";

const ALICE = getAddress("0x1111111111111111111111111111111111111111");
const BOB = getAddress("0x2222222222222222222222222222222222222222");
const CAROL = getAddress("0x3333333333333333333333333333333333333333");
const DAVE = getAddress("0x4444444444444444444444444444444444444444");
const JOINED = new Date("2026-10-05T09:00:00Z");
const LATER = new Date("2026-10-05T12:00:00Z");
const hash = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as const;

/** Codes handed out in order, so a test knows each account's code. */
function setup(options: { referralsInService?: boolean } = {}) {
  const clock = { now: JOINED };
  const codes = ["AAAA2222", "BBBB3333", "CCCC4444", "DDDD5555"];
  const referrals = new MemoryReferralStore(() => clock.now, () => codes.shift() ?? "ZZZZ9999");
  const repository = new MemorySpRepository(() => clock.now);
  const sp = new SpService({ repository, referrals: options.referralsInService === false ? undefined : referrals, now: () => clock.now, rulesCacheMs: 0 });
  const payments = new MemoryPaymentRepository();
  const activity = new SpActivity({ sp: new SpService({ repository, referrals, now: () => clock.now, rulesCacheMs: 0 }), identities: new VerifiedIdentityService(), now: () => clock.now, sources: { arc: { payments } } });
  return { sp, repository, referrals, activity, payments, clock };
}

let sequence = 0;
const usdc = (amount: string) => ({ symbol: "USDC", assetClass: "stable" as const, amount });
/** The 1% fee HaPaPay verified for a USDC payment of this amount, as the records keep it. */
const feeOf = (amount: string) => ({ units: parseUnits(amount, 6) / 100n, paymentUnits: parseUnits(amount, 6) });
/** A USDC payment by Bob with its verified fee, unless the change says otherwise (`fee: undefined` for a plain transfer). */
function payment(change: Partial<SpPaymentEvent> = {}): SpPaymentEvent {
  sequence++;
  const amount = change.amount ?? usdc("100");
  return { account: BOB, network: "solana", sourceKey: `solana:invite${sequence}:0`, counterparty: CAROL, amount, fee: feeOf(amount.amount), detail: "100 USDC to @carol on X", at: LATER, ...change };
}

/** Invites: 15% of the SP an invited account earns, and half the 1% fee on its payments in USDC. */
describe("invites", () => {
  it("starts at 15% of SP and half of the fee, and refuses a fee share above the fee", () => {
    assert.deepEqual(DEFAULT_SP_RULES.referral, { pointsShare: 0.15, feeShareBps: 50, dailyCap: 500 });
    assert.equal(referralSp(100, DEFAULT_SP_RULES), 15);
    assert.equal(referralSp(2.5, DEFAULT_SP_RULES), 0.3, "0.375 rounds down to the tenth");
    assert.equal(referralSp(0.5, DEFAULT_SP_RULES), 0, "0.075 is less than a tenth");
    assert.equal(referralSp(100, { ...DEFAULT_SP_RULES, earning: false }), 0);
    assert.equal(referralFeeUnits(1_000_000, DEFAULT_SP_RULES), 500_000n, "a $1 fee (on $100) earns $0.50, half of it");
    assert.equal(referralFeeUnits(250_000, DEFAULT_SP_RULES), 125_000n);
    assert.equal(referralFeeUnits(1_505_500, DEFAULT_SP_RULES), 752_750n, "exact to the millionth: half of $1.5055");
    assert.equal(referralFeeUnits(1_000_000, { ...DEFAULT_SP_RULES, referral: { ...DEFAULT_SP_RULES.referral, feeShareBps: 100 } }), 1_000_000n, "at most the whole fee");
    assert.equal(referralFeeUnits(-5, DEFAULT_SP_RULES), 0n);
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [{ pointsShare: 1.5, feeShareBps: 50, dailyCap: 500 }, /SP share/],
      [{ pointsShare: 0.15, feeShareBps: 101, dailyCap: 500 }, /at most|from 0 to 100/],
      [{ pointsShare: 0.15, feeShareBps: 12.5, dailyCap: 500 }, /whole number/],
      [{ pointsShare: 0.15, feeShareBps: 50, dailyCap: 0.55 }, /daily cap/],
    ];
    for (const [referral, message] of refusals) {
      const result = validateSpRules({ ...DEFAULT_SP_RULES, referral });
      assert.ok("error" in result && message.test(result.error), JSON.stringify(referral));
    }
    assert.ok("error" in validateSpRules({ ...DEFAULT_SP_RULES, referral: undefined }));
  });

  it("reads codes in any case, links to the desk and shows USDC to the cent or finer", () => {
    assert.equal(referralCode(" aaaa2222 "), "AAAA2222");
    for (const bad of ["AAAA222", "AAAA22220", "AAAA222O", "AAAA222I", "", null, 5]) assert.equal(referralCode(bad), undefined, String(bad));
    assert.equal(referralLink("https://hapapay.example/", "AAAA2222"), "https://hapapay.example/app?ref=AAAA2222");
    assert.equal(formatUsdc(500_000n), "$0.50");
    assert.equal(formatUsdc("125000"), "$0.125");
    assert.equal(formatUsdc(1_234_567_000n), "$1,234.567");
    assert.equal(formatUsdc(0n), "$0.00");
  });

  it("keeps Solana's transaction libraries out of what the desk loads first", () => {
    // The desk's first chunk reads invite codes and links on every page; only /admin and the server build a payout.
    for (const file of ["src/domain/referrals.ts", "src/referral-desk.ts", "src/components/SpPanel.tsx"]) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /from\s+["'](?:@solana|@solana-program)\//, `${file} imports a Solana library`);
      assert.doesNotMatch(source, /from\s+["'][./]*(?:domain\/)?(?:solana-[\w-]+|referral-payout)(?:\.js)?["']/, `${file} imports a Solana module`);
    }
    assert.match(readFileSync("src/components/AdminPage.tsx", "utf8"), /from "\.\.\/domain\/referral-payout"/);
  });

  it("joins a new account once with someone else's code, never itself, a cycle or an account that already paid", async () => {
    const { referrals, activity, payments } = setup();
    const aliceCode = await referrals.ensureCode(ALICE);
    assert.equal(aliceCode, "AAAA2222");
    assert.equal(await referrals.ensureCode(ALICE), aliceCode, "one code per account");
    const bobCode = await referrals.ensureCode(BOB);
    assert.equal(await activity.joinWithCode(BOB, "aaaa2222"), "joined");
    assert.equal(await activity.joinWithCode(BOB, aliceCode), "already");
    assert.equal(await activity.joinWithCode(ALICE, aliceCode), "self");
    assert.equal(await activity.joinWithCode(ALICE, bobCode), "cycle", "Bob joined with Alice's code, so Alice cannot join with his");
    assert.equal(await activity.joinWithCode(CAROL, "ZZZZ9999"), "unknown");
    assert.equal(await activity.joinWithCode(CAROL, "not a code"), "unknown");
    await payments.save({ chainId: 5042, transactionHash: hash(1), sender: DAVE, recipient: CAROL, platform: "x", username: "carol", amount: "5", blockNumber: 1n, confirmedAt: "2026-10-04T08:00:00.000Z" });
    assert.equal(await activity.joinWithCode(DAVE, aliceCode), "not_new", "Dave already paid someone through HaPaPay");
    assert.equal((await referrals.referrerOf(BOB))?.referrer, ALICE);
    assert.equal(await referrals.referrerOf(DAVE), undefined);
    assert.equal(await referrals.invitedCount(ALICE), 1);
    // Two new accounts joining with each other's code at the same moment: one joins, the other is a cycle.
    const [erin, frank] = [getAddress("0x6666666666666666666666666666666666666666"), getAddress("0x7777777777777777777777777777777777777777")];
    const [erinCode, frankCode] = [await referrals.ensureCode(erin), await referrals.ensureCode(frank)];
    const both = await Promise.all([activity.joinWithCode(erin, frankCode), activity.joinWithCode(frank, erinCode)]);
    assert.deepEqual([...both].sort(), ["cycle", "joined"]);
  });

  it("gives the inviter 15% of the SP the invited account earns and half of each payment's fee in USDC", async () => {
    const { sp, referrals, repository } = setup();
    await referrals.ensureCode(ALICE);
    await referrals.bind({ invitee: BOB, referrer: ALICE, code: "AAAA2222" });
    assert.deepEqual(await sp.awardPayment(payment()), { awarded: 110 }, "Bob: 100 SP and the first-payment bonus");
    const shares = (await repository.ledger({ account: ALICE, limit: 10, includeZero: true })).map((row) => [row.kind, row.amount, row.counterparty]);
    assert.deepEqual(shares.sort(), [["referral", 1.5, BOB], ["referral", 15, BOB]].sort(), "15% of 100 and 15% of the 10 SP bonus");
    const summary = await sp.referralSummary(ALICE);
    assert.deepEqual(summary, { code: "AAAA2222", invited: 1, joined: false, sp: 16.5, fees: { earned: "500000", paid: "0", owed: "500000" } });
    assert.equal((await sp.referralSummary(BOB))?.joined, true);
    assert.equal(await repository.balance(BOB), 110, "the invited account's own SP are untouched");
  });

  it("shares nothing from before the invite, with the inviter, to oneself, past the cap or while the inviter is stopped", async () => {
    const { sp, referrals, repository, clock } = setup();
    await referrals.ensureCode(ALICE);
    await sp.awardLinkedAccount({ account: BOB, platform: "github", providerUserId: "7", at: new Date("2026-10-01T00:00:00Z") });
    await referrals.bind({ invitee: BOB, referrer: ALICE, code: "AAAA2222" });
    clock.now = LATER;
    await sp.awardPayment(payment({ counterparty: ALICE, sourceKey: "solana:to-alice:0" }));
    await sp.awardPayment(payment({ counterparty: BOB, sourceKey: "solana:to-self:0" }));
    // The payment to Alice and the one to Bob himself share nothing; the first-payment bonus the first one earned is Bob's own.
    const fromBob = (await repository.ledger({ account: ALICE, limit: 10, includeZero: true })).map((row) => [row.detail, row.amount]);
    assert.deepEqual(fromBob, [["First payment of someone you invited", 1.5]], "and the linked account from before the invite shares nothing");
    assert.equal((await referrals.feeTotals(ALICE)).earned, 0n, "no USDC for a payment to the inviter or to oneself");

    await sp.saveRules({ actor: ALICE, rules: { ...DEFAULT_SP_RULES, referral: { ...DEFAULT_SP_RULES.referral, dailyCap: 20 } } });
    clock.now = new Date(LATER.getTime() + 60_000);
    const at = new Date(LATER.getTime() + 120_000);
    await sp.awardPayment(payment({ amount: usdc("100"), at, sourceKey: "solana:cap1:0" }));
    await sp.awardPayment(payment({ amount: usdc("100"), at, sourceKey: "solana:cap2:0", counterparty: DAVE }));
    const capped = (await repository.ledger({ account: ALICE, limit: 10, includeZero: true })).filter((row) => row.kind === "referral");
    assert.equal(capped.reduce((sum, row) => sum + row.amount, 0), 20, "the same day's 1.5 bonus share, 15, then 3.5 of the next 15: the invite cap of 20 holds");
    assert.ok(capped.some((row) => row.reason === "The daily cap on SP from people you invited was reached"));
    assert.equal((await referrals.feeTotals(ALICE)).earned, 1_000_000n, "the USDC share is not capped by SP's cap: $0.50 for each $100 payment");

    await sp.setFrozen({ actor: CAROL, account: ALICE, frozen: true, reason: "Review" });
    await sp.awardPayment(payment({ amount: usdc("10"), at: new Date(at.getTime() + 86_400_000), sourceKey: "solana:frozen:0" }));
    const stopped = (await repository.ledger({ account: ALICE, limit: 1, includeZero: true }))[0];
    assert.equal(stopped.amount, 0);
    assert.equal(stopped.reason, "SP earning is stopped for this account");
  });

  it("catches up what sharing missed, never twice, and takes the SP and the unpaid USDC back with a reversed entry", async () => {
    const { sp: withoutInvites, referrals, repository, clock } = setup({ referralsInService: false });
    await referrals.ensureCode(ALICE);
    await referrals.bind({ invitee: BOB, referrer: ALICE, code: "AAAA2222" });
    clock.now = LATER;
    await withoutInvites.awardPayment(payment({ sourceKey: "solana:missed:0" }));
    assert.equal((await repository.ledger({ account: ALICE, limit: 10 })).length, 0, "this service did not share");
    const sp = new SpService({ repository, referrals, now: () => clock.now, rulesCacheMs: 0 });
    const [first, second] = await Promise.all([sp.referralCatchUp(BOB), sp.referralCatchUp(BOB)]);
    assert.ok(first + second >= 2);
    assert.equal(await sp.referralCatchUp(BOB), 0, "nothing left to share");
    assert.equal(await repository.balance(ALICE), 16.5);
    assert.equal((await referrals.feeTotals(ALICE)).earned, 500_000n, "the reward was written once");

    const bobPayment = (await repository.ledger({ account: BOB, kind: "payment", limit: 1 }))[0];
    await sp.reverse({ actor: CAROL, entryId: bobPayment.id, reason: "Wash trade" });
    assert.equal(await repository.balance(BOB), 10);
    assert.equal(await repository.balance(ALICE), 1.5, "Alice's 15 SP share of that payment went with it");
    assert.deepEqual(await referrals.feeTotals(ALICE), { earned: 0n, paid: 0n }, "and its USDC reward, not paid yet, is never paid");
    const reversal = await referrals.feeReward(`fee-reverse:${bobPayment.sourceKey}`);
    assert.equal(reversal?.units, -500_000n);
    assert.equal(reversal?.reason, `#${bobPayment.id}, which it came from, was reversed: Wash trade`);
    await assert.rejects(() => sp.reverse({ actor: CAROL, entryId: bobPayment.id, reason: "Again" }), /already reversed/);
    assert.equal((await referrals.feeTotals(ALICE)).earned, 0n, "taken back once");
    await assert.rejects(() => referrals.insertFeeReward({ ...reversal!, sourceKey: "fee:solana:x:0", units: -1n, createdAt: LATER }), /never negative/);
  });

  it("sets a paid reward that is reversed against the next ones, and gives nothing for a row reversed before sharing or from a stopped account", async () => {
    const { sp, referrals, repository, clock } = setup();
    await referrals.ensureCode(ALICE);
    await referrals.bind({ invitee: BOB, referrer: ALICE, code: "AAAA2222" });
    clock.now = LATER;
    await sp.awardPayment(payment({ amount: usdc("200"), sourceKey: "solana:paid:0" }));
    assert.deepEqual(await referrals.owed(1_000_000n, 10), [{ referrer: ALICE, owed: 1_000_000n }]);
    await referrals.saveBatch({ id: "0123456789abcdef", payer: "Payer", items: [{ referrer: ALICE, address: "AliceSolana", units: "1000000" }], totalUnits: "1000000", lastValidBlockHeight: "250", createdBy: CAROL });
    await referrals.savePayouts([{ batch: "0123456789abcdef", referrer: ALICE, address: "AliceSolana", units: "1000000", signature: "signature", paidBy: CAROL }]);
    const paid = (await repository.ledger({ account: BOB, kind: "payment", limit: 1 }))[0];
    await sp.reverse({ actor: CAROL, entryId: paid.id, reason: "Wash trade" });
    assert.deepEqual(await referrals.feeTotals(ALICE), { earned: 0n, paid: 1_000_000n }, "the dollar already paid is now owed back");
    assert.deepEqual(await referrals.owed(1n, 10), []);
    assert.equal((await sp.referralSummary(ALICE))?.fees.owed, "-1000000");
    await sp.awardPayment(payment({ amount: usdc("400"), sourceKey: "solana:next:0" }));
    assert.deepEqual(await referrals.owed(1n, 10), [{ referrer: ALICE, owed: 1_000_000n }], "the next $2.00 pays that dollar back first");

    // Reversed before its share was written (sharing had failed): the catch-up gives nothing for it.
    const plain = new SpService({ repository, now: () => clock.now, rulesCacheMs: 0 });
    await plain.awardPayment(payment({ amount: usdc("100"), sourceKey: "solana:early:0" }));
    const early = (await repository.ledger({ account: BOB, kind: "payment", limit: 1 }))[0];
    assert.equal(early.sourceKey, "solana:early:0");
    await plain.reverse({ actor: CAROL, entryId: early.id, reason: "Mistake" });
    const before = await referrals.feeTotals(ALICE);
    await sp.referralCatchUp(BOB);
    assert.deepEqual(await referrals.feeTotals(ALICE), before, "no USDC for it");
    assert.equal(await repository.entryBySource(`referral:${early.id}`), undefined, "and no SP");

    // An invited account whose SP are stopped earns its inviter nothing, in SP or in USDC.
    await sp.setFrozen({ actor: CAROL, account: BOB, frozen: true, reason: "Review" });
    await sp.awardPayment(payment({ amount: usdc("100"), sourceKey: "solana:stopped:0", counterparty: DAVE }));
    assert.deepEqual(await referrals.feeTotals(ALICE), before);
    assert.equal(await sp.referralCatchUp(BOB), 0);
  });

  it("rewards only a fee verified on chain, and takes back the reward of a payment that earned no SP", async () => {
    const { sp, referrals, repository, clock } = setup();
    await referrals.ensureCode(ALICE);
    await referrals.bind({ invitee: BOB, referrer: ALICE, code: "AAAA2222" });
    clock.now = LATER;
    // A transfer that did not go through HaPaPay's fee: SP for Bob and Alice's SP share, but no USDC for Alice.
    await sp.awardPayment(payment({ amount: usdc("50"), fee: undefined, sourceKey: "solana:plain:0", counterparty: getAddress("0x5555555555555555555555555555555555555555") }));
    assert.equal((await referrals.feeTotals(ALICE)).earned, 0n, "no fee, no reward");
    assert.equal((await repository.entryBySource("solana:plain:0"))?.feeUsdUnits, null);
    // A fee below 1% (a lower rate) gives half of that fee, never half of 1%.
    await sp.awardPayment(payment({ amount: usdc("100"), fee: { units: 500_000n, paymentUnits: 100_000_000n }, sourceKey: "solana:half-rate:0", counterparty: DAVE }));
    assert.equal((await referrals.feeTotals(ALICE)).earned, 250_000n);

    // The fourth payment of the day to one person earns no SP, but its fee was paid, so it rewards Alice; reversing it
    // takes that reward back even though it earned no SP.
    for (let index = 0; index < 3; index++) await sp.awardPayment(payment({ amount: usdc("100"), sourceKey: `solana:pair${index}:0` }));
    await sp.awardPayment(payment({ amount: usdc("100000"), sourceKey: "solana:pair3:0" }));
    const fourth = await repository.entryBySource("solana:pair3:0");
    assert.equal(fourth?.amount, 0);
    assert.equal(fourth?.reason, "The daily limit of rewarded payments to this person was reached");
    assert.equal((await referrals.feeTotals(ALICE)).earned, 250_000n + 3n * 500_000n + 500_000_000n, "$500 for the $100,000 payment's $1,000 fee");
    await sp.reverse({ actor: CAROL, entryId: fourth!.id, reason: "Price check" });
    assert.equal((await referrals.feeTotals(ALICE)).earned, 250_000n + 3n * 500_000n);
    await assert.rejects(() => sp.reverse({ actor: CAROL, entryId: fourth!.id, reason: "Again" }), /already reversed/);
    const plain = await repository.entryBySource("solana:pair0:0");
    const noReward = (await repository.ledger({ account: BOB, limit: 50, includeZero: true })).find((row) => row.amount === 0 && row.kind === "payment" && row.sourceKey !== "solana:pair3:0");
    assert.equal(noReward, undefined, "every other payment earned SP");
    assert.ok(plain);
  });

  it("finishes a reversal that stopped halfway, and takes back a share written while the entry was being reversed", async () => {
    const { referrals, repository, clock } = setup();
    await referrals.ensureCode(ALICE);
    await referrals.bind({ invitee: BOB, referrer: ALICE, code: "AAAA2222" });
    clock.now = LATER;
    // A store that fails the first reward reversal, as a database fault between the two writes would.
    let failNext = true;
    const insert = referrals.insertFeeReward.bind(referrals);
    referrals.insertFeeReward = async (draft) => {
      if (draft.sourceKey.startsWith("fee-reverse:") && failNext) {
        failNext = false;
        throw new Error("connection lost");
      }
      return insert(draft);
    };
    const sp = new SpService({ repository, referrals, now: () => clock.now, rulesCacheMs: 0 });
    await sp.awardPayment(payment({ sourceKey: "solana:halfway:0" }));
    const entry = await repository.entryBySource("solana:halfway:0");
    await assert.rejects(() => sp.reverse({ actor: CAROL, entryId: entry!.id, reason: "Wash trade" }), /connection lost/);
    assert.equal((await referrals.feeTotals(ALICE)).earned, 500_000n, "the reward was not taken back yet");
    await sp.reverse({ actor: CAROL, entryId: entry!.id, reason: "Wash trade" });
    assert.equal((await referrals.feeTotals(ALICE)).earned, 0n, "running it again finished it");
    await assert.rejects(() => sp.reverse({ actor: CAROL, entryId: entry!.id, reason: "Wash trade" }), /already reversed/);

    // The admin reverses a payment while its share is being written: sharing sees the reversal after it writes, and
    // takes the share back.
    const plain = new SpService({ repository, now: () => clock.now, rulesCacheMs: 0 });
    await plain.awardPayment(payment({ sourceKey: "solana:race:0", counterparty: DAVE }));
    const raced = await repository.entryBySource("solana:race:0");
    const lookup = repository.entryBySource.bind(repository);
    let reversedMeanwhile = false;
    repository.entryBySource = async (sourceKey) => {
      // The reversal lands right after sharing checked for one, before the share is written.
      if (sourceKey === `reverse:${raced!.id}` && !reversedMeanwhile) {
        reversedMeanwhile = true;
        const missing = await lookup(sourceKey);
        await plain.reverse({ actor: CAROL, entryId: raced!.id, reason: "Mistake" });
        return missing;
      }
      return lookup(sourceKey);
    };
    const balance = await repository.balance(ALICE);
    const earned = (await referrals.feeTotals(ALICE)).earned;
    await sp.referralCatchUp(BOB);
    assert.equal(await repository.balance(ALICE), balance, "the share written meanwhile was taken back");
    assert.equal((await referrals.feeTotals(ALICE)).earned, earned, "and its reward");
  });
});
