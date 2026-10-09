import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import { DEFAULT_SP_RULES } from "../src/domain/sp";
import { MemorySpRepository, SP_PRICE_GRACE_MS, SpRequestError, SpService, type SpPaymentEvent } from "../server/sp-service";
import { MemoryReferralStore } from "../server/referral-store";

const ALICE = getAddress("0x1111111111111111111111111111111111111111");
const BOB = getAddress("0x2222222222222222222222222222222222222222");
const CAROL = getAddress("0x3333333333333333333333333333333333333333");
const DAY = new Date("2026-10-05T10:00:00Z");

function service(options: { now?: Date; prices?: Record<string, number> } = {}) {
  const clock = { now: options.now ?? new Date("2026-10-05T12:00:00Z") };
  const repository = new MemorySpRepository(() => clock.now);
  const sp = new SpService({
    repository,
    now: () => clock.now,
    rulesCacheMs: 0,
    prices: async (_network, symbol) => options.prices?.[symbol],
  });
  return { sp, repository, clock };
}

let sequence = 0;
function payment(change: Partial<SpPaymentEvent> = {}): SpPaymentEvent {
  sequence++;
  return {
    account: ALICE,
    network: "solana",
    sourceKey: `solana:sig${sequence}:0`,
    counterparty: BOB,
    amount: { symbol: "USDC", assetClass: "stable", amount: "25" },
    detail: "25 USDC to @bob on GitHub",
    at: DAY,
    ...change,
  };
}

/** SP's ledger rules: once per payment, capped, and every row kept. */
describe("SP awards", () => {
  it("awards 25 SP for a 25 USDC payment, the first-payment bonus once, and never twice for the same payment", async () => {
    const { sp, repository } = service();
    const first = payment();
    assert.deepEqual(await sp.awardPayment(first), { awarded: 25 + 10 });
    assert.deepEqual(await sp.awardPayment(first), { awarded: 0 }, "the same payment earns once");
    assert.deepEqual(await sp.awardPayment(payment()), { awarded: 25 }, "the bonus comes with the first payment only");
    assert.equal(await repository.balance(ALICE), 60);
    assert.equal(await repository.balance(BOB), 0, "the recipient of a payment earns nothing for it");
    const kinds = (await repository.ledger({ account: ALICE, limit: 10 })).map((row) => row.kind).sort();
    assert.deepEqual(kinds, ["first_payment", "payment", "payment"]);
  });

  it("counts SP to one decimal, rounded down, and keeps sums and the cap on the tenth", async () => {
    const { sp, repository, clock } = service();
    await sp.saveRules({ actor: CAROL, rules: { ...DEFAULT_SP_RULES, dailyCap: 15.5 } });
    const later = new Date(clock.now.getTime() + 60_000);
    const usdc = (amount: string) => ({ symbol: "USDC", assetClass: "stable" as const, amount });
    assert.deepEqual(await sp.awardPayment(payment({ amount: usdc("12.75"), at: later })), { awarded: 22.7 }, "12.7 SP and the first-payment bonus");
    assert.deepEqual(await sp.awardPayment(payment({ counterparty: CAROL, amount: usdc("3.3"), at: later })), { awarded: 2.8 }, "15.5 - 12.7 is 2.8 under the cap, not 2.8000000000000007");
    assert.deepEqual(await sp.awardPayment(payment({ counterparty: CAROL, amount: usdc("1.1"), at: later })), { awarded: 0 }, "the cap is reached");
    assert.equal(await repository.balance(ALICE), 25.5);
    const amounts = (await repository.ledger({ account: ALICE, limit: 10, includeZero: true })).map((row) => row.amount).sort((left, right) => left - right);
    assert.deepEqual(amounts, [0, 2.8, 10, 12.7]);
    assert.equal((await sp.summary(ALICE)).today, 15.5);
  });

  it("values non-stable assets at their price and waits for a price before closing with no SP", async () => {
    const { sp, repository, clock } = service({ prices: { TSLAx: 250 } });
    assert.deepEqual(await sp.awardPayment(payment({ amount: { symbol: "TSLAx", assetClass: "stock", amount: "2" } })), { awarded: 500 + 10 });
    const unpriced = payment({ amount: { symbol: "SOL", assetClass: "crypto", amount: "3" } });
    assert.deepEqual(await sp.awardPayment(unpriced), { awarded: 0, pending: true }, "no price yet: nothing written");
    assert.equal((await repository.sourceKeys([unpriced.sourceKey])).size, 0);
    clock.now = new Date(DAY.getTime() + SP_PRICE_GRACE_MS + 60_000);
    assert.deepEqual(await sp.awardPayment(unpriced), { awarded: 0 });
    const [closed] = await repository.ledger({ account: ALICE, limit: 1, includeZero: true });
    assert.equal(closed.sourceKey, unpriced.sourceKey);
    assert.equal(closed.amount, 0);
    assert.match(closed.reason ?? "", /No US dollar price/);
  });

  it("pays at most three payments a day to the same person, and nothing for a payment to oneself", async () => {
    const { sp, repository } = service();
    for (let index = 0; index < 3; index++) assert.ok((await sp.awardPayment(payment())).awarded > 0);
    assert.deepEqual(await sp.awardPayment(payment()), { awarded: 0 }, "the fourth to Bob that day");
    assert.ok((await sp.awardPayment(payment({ counterparty: CAROL }))).awarded > 0, "another person still earns");
    assert.ok((await sp.awardPayment(payment({ at: new Date("2026-10-06T01:00:00Z") }))).awarded > 0, "the next UTC day starts again");
    assert.deepEqual(await sp.awardPayment(payment({ counterparty: ALICE })), { awarded: 0 });
    const reasons = (await repository.ledger({ account: ALICE, limit: 20, includeZero: true })).filter((row) => row.amount === 0).map((row) => row.reason);
    assert.deepEqual(reasons.sort(), ["A payment to oneself earns no SP", "The daily limit of rewarded payments to this person was reached"]);
  });

  it("stops at the daily cap, counting only the day the payment happened, even when it is synced later", async () => {
    const { sp, repository } = service();
    // 2,000 USDC earns 2,000 SP before the cap: the cap keeps it at 1,000 (the bonus is outside the cap).
    assert.deepEqual(await sp.awardPayment(payment({ amount: { symbol: "USDC", assetClass: "stable", amount: "2000" }, at: new Date("2026-10-06T09:00:00Z") })), { awarded: 1_000 + 10 });
    assert.deepEqual(await sp.awardPayment(payment({ counterparty: CAROL, at: new Date("2026-10-06T10:00:00Z") })), { awarded: 0 }, "the cap is reached that day");
    // A payment from the day before, recorded only now, counts against its own day, where nothing has been earned.
    assert.deepEqual(await sp.awardPayment(payment({ at: new Date("2026-10-05T23:59:00Z") })), { awarded: 25 });
    const capped = (await repository.ledger({ account: ALICE, limit: 10, includeZero: true })).find((row) => row.reason === "The daily SP cap was reached");
    assert.ok(capped, "the capped payment says why");
  });

  it("writes payments with no SP while earning is off or the account is stopped, and gives no bonus for them", async () => {
    const { sp, repository, clock } = service();
    await sp.setFrozen({ actor: CAROL, account: ALICE, frozen: true, reason: "Reviewing" });
    assert.deepEqual(await sp.awardPayment(payment()), { awarded: 0 });
    await sp.setFrozen({ actor: CAROL, account: ALICE, frozen: false, reason: "Reviewed" });
    await sp.saveRules({ actor: CAROL, rules: { ...DEFAULT_SP_RULES, earning: false }, note: "Paused" });
    // The rules in force at the payment's time apply: a new version applies from its own creation on.
    const later = new Date(clock.now.getTime() + 60_000);
    assert.deepEqual(await sp.awardPayment(payment({ at: later })), { awarded: 0 });
    assert.equal(await repository.balance(ALICE), 0);
    assert.ok(!(await repository.ledger({ account: ALICE, limit: 10, includeZero: true })).some((row) => row.kind === "first_payment"));
  });

  it("pays a claimed vault link to the claimer and to the sender, with the invite bonus up to a monthly limit", async () => {
    const { sp, repository, clock } = service();
    const claim = (link: string, change: Partial<Parameters<SpService["awardClaim"]>[0]> = {}) => sp.awardClaim({
      claimer: BOB, sender: ALICE, network: "arc", link, amount: { symbol: "USDC", assetClass: "stable", amount: "10" },
      detail: "10 USDC vault link", at: DAY, fundedAt: DAY, ...change,
    });
    // The claimer: half an SP a dollar and the first-claim bonus. The sender: the link's payment SP, the first-payment bonus and the invite bonus.
    assert.deepEqual(await claim("arc:0x01"), { claimer: { awarded: 5 + 5 }, sender: { awarded: 10 + 10 + 5 } });
    assert.deepEqual(await claim("arc:0x01"), { claimer: { awarded: 0 }, sender: { awarded: 0 } }, "a link earns once");
    assert.deepEqual(await claim("arc:0x02", { claimer: null }), { claimer: { awarded: 0 }, sender: { awarded: 10 + 5 } }, "an unknown claimer still pays the sender");
    assert.deepEqual(await claim("arc:0x03", { claimer: ALICE }), { claimer: { awarded: 0 }, sender: { awarded: 0 } }, "a link to oneself earns nothing");
    await sp.saveRules({ actor: CAROL, rules: { ...DEFAULT_SP_RULES, inviteMonthlyLimit: 2 } });
    const later = new Date(clock.now.getTime() + 60_000);
    assert.deepEqual(await claim("arc:0x04", { at: later }), { claimer: { awarded: 5 }, sender: { awarded: 10 } }, "the third invite this month earns no bonus");
    assert.deepEqual(await claim("arc:0x05", { at: later, amount: { symbol: "USDC", assetClass: "stable", amount: "12.75" } }), { claimer: { awarded: 6.3 }, sender: { awarded: 12.7 } }, "to the tenth, rounded down");
    assert.equal(await repository.balance(BOB), 10 + 5 + 6.3);
  });

  it("gives the linked-account and Solana address bonuses once per account and once ever per account or address", async () => {
    const { sp, repository } = service();
    assert.deepEqual(await sp.awardLinkedAccount({ account: ALICE, platform: "github", providerUserId: "583231", at: DAY }), { awarded: 2 });
    assert.deepEqual(await sp.awardLinkedAccount({ account: ALICE, platform: "github", providerUserId: "583231", at: DAY }), { awarded: 0 });
    assert.deepEqual(await sp.awardLinkedAccount({ account: ALICE, platform: "github", providerUserId: "999", at: DAY }), { awarded: 0 }, "a second GitHub account on the same wallet");
    assert.deepEqual(await sp.awardLinkedAccount({ account: BOB, platform: "github", providerUserId: "583231", at: DAY }), { awarded: 0 }, "the same GitHub account on another wallet");
    assert.deepEqual(await sp.awardLinkedAccount({ account: ALICE, platform: "x", providerUserId: "12", at: DAY }), { awarded: 2 });
    assert.deepEqual(await sp.awardSolanaAddress({ account: ALICE, address: "So1anaAddress1111111111111111111111111111111", at: DAY }), { awarded: 2 });
    assert.deepEqual(await sp.awardSolanaAddress({ account: ALICE, address: "So1anaAddress2222222222222222222222222222222", at: DAY }), { awarded: 0 });
    assert.deepEqual(await sp.awardSolanaAddress({ account: BOB, address: "So1anaAddress1111111111111111111111111111111", at: DAY }), { awarded: 0 });
    assert.equal(await repository.balance(ALICE), 6);
  });

  it("adjusts and reverses with a reason, keeping the original row, once", async () => {
    const { sp, repository } = service();
    await sp.awardPayment(payment());
    const added = await sp.adjust({ actor: CAROL, account: ALICE, amount: 1_000, reason: "Launch gift" });
    assert.equal(added.kind, "adjustment");
    assert.equal(await repository.balance(ALICE), 1_035);
    const reversed = await sp.reverse({ actor: CAROL, entryId: added.id, reason: "Sent twice" });
    assert.equal(reversed.amount, -1_000);
    await assert.rejects(() => sp.reverse({ actor: CAROL, entryId: added.id, reason: "Again" }), /already reversed/);
    await assert.rejects(() => sp.reverse({ actor: CAROL, entryId: reversed.id, reason: "Undo" }), /cannot be reversed/);
    await assert.rejects(() => sp.adjust({ actor: CAROL, account: ALICE, amount: 1.25, reason: "Too fine" }), SpRequestError);
    await assert.rejects(() => sp.adjust({ actor: CAROL, account: ALICE, amount: 10_000_000.5, reason: "Too much" }), /10,000,000/);
    await assert.rejects(() => sp.adjust({ actor: CAROL, account: ALICE, amount: 10, reason: "" }), /reason/);
    const half = await sp.adjust({ actor: CAROL, account: ALICE, amount: -12.5, reason: "Half of a refund" });
    assert.equal(half.amount, -12.5);
    assert.equal(half.detail, "Taken by HaPaPay");
    assert.equal(await repository.balance(ALICE), 22.5);
    assert.ok(await repository.entry(added.id), "the adjustment row stays");
  });

  it("refuses rules out of range and keeps every version", async () => {
    const { sp, repository } = service();
    await assert.rejects(() => sp.saveRules({ actor: CAROL, rules: { ...DEFAULT_SP_RULES, perDollar: -1 } }), /perDollar/);
    const saved = await sp.saveRules({ actor: CAROL, rules: { ...DEFAULT_SP_RULES, perDollar: 2 }, note: "Double" });
    assert.equal(saved.version, 2);
    assert.deepEqual((await repository.rulesHistory(10)).map((version) => version.version), [2, 1]);
    assert.equal((await repository.rulesAt(new Date(0))).version, 1, "activity from before SP counts by the first rules");
  });

  it("serializes awards per account, so concurrent payments never pass the cap", async () => {
    const { sp, repository, clock } = service();
    await sp.saveRules({ actor: CAROL, rules: { ...DEFAULT_SP_RULES, dailyCap: 100.5, pairDailyLimit: 1_000 } });
    const later = new Date(clock.now.getTime() + 60_000);
    const results = await Promise.all(Array.from({ length: 12 }, () => sp.awardPayment(payment({ at: later }))));
    const earned = results.reduce((sum, result) => sum + result.awarded, 0);
    assert.equal(earned, 100.5 + 10, "the cap and the bonus, no more: four payments and half an SP of the fifth");
    assert.equal(await repository.balance(ALICE), 110.5);
  });

  it("pages an account's history newest first", async () => {
    const { sp } = service();
    for (let hour = 0; hour < 5; hour++) await sp.awardPayment(payment({ counterparty: getAddress(`0x${(hour + 10).toString(16).padStart(40, "0")}`) as Address, at: new Date(Date.UTC(2026, 9, 5, hour)) }));
    const first = await sp.history(ALICE, 3);
    assert.equal(first.entries.length, 3);
    assert.ok(first.next);
    const second = await sp.history(ALICE, 3, first.next!);
    assert.equal(second.entries.length, 3, "six rows: five payments and the bonus");
    assert.equal(second.next, null);
    const all = [...first.entries, ...second.entries].map((entry) => entry.createdAt);
    assert.deepEqual(all, [...all].sort().reverse());
  });

  it("leaves a reversed invite share out of the SP from invites", async () => {
    // Audit, 2026-10-06: the desk and /admin kept showing a reversed share as earned.
    const now = new Date("2026-10-05T13:00:00Z");
    const invitee = "0x1111111111111111111111111111111111111111" as const;
    const inviter = "0x3333333333333333333333333333333333333333" as const;
    const referrals = new MemoryReferralStore(() => new Date("2026-10-05T09:00:00Z"), () => "AAAA2222");
    await referrals.ensureCode(inviter);
    await referrals.bind({ invitee, referrer: inviter, code: "AAAA2222" });
    const sp = new SpService({ repository: new MemorySpRepository(() => now), referrals, now: () => now, rulesCacheMs: 0 });
    await sp.awardPayment({
      account: invitee, network: "arc", sourceKey: "arc:0x01", counterparty: "0x2222222222222222222222222222222222222222",
      amount: { symbol: "USDC", assetClass: "stable", amount: "100" }, fee: { units: 1_000_000n, paymentUnits: 100_000_000n }, detail: "100 USDC", at: now,
    });
    const [share] = await sp.repository.ledger({ account: inviter, kind: "referral", limit: 5 });
    await sp.reverse({ actor: "0x9999999999999999999999999999999999999999", entryId: share.id, reason: "review" });
    assert.equal((await sp.referralSummary(inviter))?.sp, await sp.repository.balance(inviter));
  });
});
