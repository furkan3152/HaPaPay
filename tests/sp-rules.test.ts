import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SP_RULES, amountUsd, boostAt, capped, formatSp, formatSpBrief, isTenths, roundSp, validateSpRules, volumeSp, type SpRules } from "../src/domain/sp";

const at = new Date("2026-10-05T12:00:00Z");
const rules = (change: Partial<SpRules> = {}): SpRules => ({ ...DEFAULT_SP_RULES, ...change });

/** SP's rules: earned by payments and vault links on every network, one balance per account. */
describe("SP rules", () => {
  it("earns 1 SP a dollar and nothing for the payment itself, the same on every network and asset by default", () => {
    for (const network of ["solana", "arc", "robinhood"] as const) {
      for (const asset of ["stable", "crypto", "stock"] as const) {
        assert.equal(volumeSp({ usd: 25, network, asset, rules: DEFAULT_SP_RULES, at, kind: "payment" }), 25);
      }
    }
    assert.equal(volumeSp({ usd: 10, network: "arc", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "claim" }), 5, "a claim earns half an SP a dollar");
  });

  it("counts to one decimal, rounded down, without the float's error", () => {
    assert.equal(volumeSp({ usd: 12.75, network: "solana", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "payment" }), 12.7);
    assert.equal(volumeSp({ usd: 12.75, network: "solana", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "claim" }), 6.3, "6.375 rounds down");
    assert.equal(volumeSp({ usd: 0.7 * 3, network: "solana", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "payment" }), 2.1, "0.7 x 3 is 2.1, not 2.0");
    assert.equal(volumeSp({ usd: 1.15, network: "solana", asset: "stable", rules: rules({ perPayment: 0.5 }), at, kind: "payment" }), 1.6, "a payment's own SP is added before rounding");
  });

  it("earns the same for one payment as for the same dollars in small payments", () => {
    const whole = volumeSp({ usd: 50, network: "solana", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "payment" });
    const split = Array.from({ length: 10 }, () => volumeSp({ usd: 5, network: "solana", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "payment" })).reduce((sum, value) => sum + value, 0);
    assert.equal(whole, 50);
    assert.equal(split, whole);
  });

  it("earns nothing under the minimum, when earning is off, or for a value that is not a number", () => {
    assert.equal(volumeSp({ usd: 0.99, network: "solana", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "payment" }), 0);
    assert.equal(volumeSp({ usd: 1, network: "solana", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "payment" }), 1, "a dollar earns 1 SP");
    assert.equal(volumeSp({ usd: 500, network: "solana", asset: "stable", rules: rules({ earning: false }), at, kind: "payment" }), 0);
    assert.equal(volumeSp({ usd: Number.NaN, network: "solana", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "payment" }), 0);
    assert.equal(volumeSp({ usd: Number.POSITIVE_INFINITY, network: "solana", asset: "stable", rules: DEFAULT_SP_RULES, at, kind: "payment" }), 0);
  });

  it("applies the network, asset and boost multipliers, and the boost only inside its window", () => {
    const boosted = rules({
      networks: { solana: 1.5, arc: 1, robinhood: 1 },
      assets: { stable: 1, crypto: 1, stock: 2 },
      boost: { multiplier: 2, startsAt: "2026-10-05T00:00:00.000Z", endsAt: "2026-10-06T00:00:00.000Z" },
    });
    assert.equal(volumeSp({ usd: 10, network: "solana", asset: "stock", rules: boosted, at, kind: "payment" }), 60);
    assert.equal(volumeSp({ usd: 10.05, network: "solana", asset: "stock", rules: boosted, at, kind: "payment" }), 60.3);
    assert.equal(boostAt(boosted, new Date("2026-10-06T00:00:00Z")), 1, "the end is outside the window");
    assert.equal(boostAt(boosted, new Date("2026-10-05T00:00:00Z")), 2, "the start is inside");
  });

  it("stops at the daily cap, to the tenth", () => {
    assert.equal(capped(50, 980, DEFAULT_SP_RULES), 20);
    assert.equal(capped(12.5, 999.9, DEFAULT_SP_RULES), 0.1, "1,000 - 999.9 is 0.1, not 0.10000000000002274");
    assert.equal(capped(50, 1_000, DEFAULT_SP_RULES), 0);
    assert.equal(capped(50, 1_250, DEFAULT_SP_RULES), 0, "never negative");
  });

  it("values the records' decimal amounts in dollars, and nothing else", () => {
    assert.equal(amountUsd("25", 1), 25);
    assert.equal(amountUsd("0.15", 152.3), 0.15 * 152.3);
    assert.equal(amountUsd("2", 251.2), 502.4);
    assert.equal(amountUsd("1", 0), 0, "no price, no value");
    assert.equal(amountUsd("0", 1), 0);
    for (const amount of ["", "-1", "1e5", "0x10", " 1", "1.", ".5", "Infinity"]) assert.equal(amountUsd(amount, 1), 0, amount);
  });

  it("accepts the defaults and amounts with one decimal, and refuses rules out of range, by field name", () => {
    assert.deepEqual(validateSpRules(DEFAULT_SP_RULES), { rules: DEFAULT_SP_RULES });
    const tenths = validateSpRules({ ...DEFAULT_SP_RULES, dailyCap: 0.1 + 0.2, bonuses: { ...DEFAULT_SP_RULES.bonuses, linkedAccount: 2.5 } });
    assert.ok("rules" in tenths && tenths.rules.dailyCap === 0.3 && tenths.rules.bonuses.linkedAccount === 2.5, "one decimal is kept, and the float's error is not");
    const refusals: Array<[Partial<Record<string, unknown>>, RegExp]> = [
      [{ earning: "yes" }, /earning/],
      [{ perDollar: -1 }, /perDollar/],
      [{ perDollar: 101 }, /perDollar/],
      [{ perPayment: 0.25 }, /perPayment must have at most one decimal/],
      [{ dailyCap: 10.55 }, /dailyCap must have at most one decimal/],
      [{ pairDailyLimit: 2.5 }, /pairDailyLimit must be a whole number/],
      [{ minUsd: Number.NaN }, /minUsd/],
      [{ networks: { solana: 11, arc: 1, robinhood: 1 } }, /network multiplier/],
      [{ assets: { stable: 1, crypto: 1 } }, /asset multiplier/],
      [{ bonuses: { ...DEFAULT_SP_RULES.bonuses, firstPayment: 0.55 } }, /bonus/],
      [{ bonuses: { ...DEFAULT_SP_RULES.bonuses, firstPayment: 10_001 } }, /bonus/],
      [{ boost: { multiplier: 0.5, startsAt: "2026-10-05T00:00:00Z", endsAt: "2026-10-06T00:00:00Z" } }, /boost/],
      [{ boost: { multiplier: 2, startsAt: "2026-10-06T00:00:00Z", endsAt: "2026-10-05T00:00:00Z" } }, /end after it starts/],
      [{ boost: { multiplier: 2, startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-05T00:00:00Z" } }, /at most 31 days/],
    ];
    for (const [change, message] of refusals) {
      const result = validateSpRules({ ...DEFAULT_SP_RULES, ...change });
      assert.ok("error" in result && message.test(result.error), JSON.stringify(change));
    }
    assert.ok("error" in validateSpRules(null));
    const withBoost = validateSpRules({ ...DEFAULT_SP_RULES, boost: { multiplier: 2, startsAt: "2026-10-05T00:00:00+03:00", endsAt: "2026-10-06T00:00:00+03:00" } });
    assert.ok("rules" in withBoost && withBoost.rules.boost?.startsAt === "2026-10-04T21:00:00.000Z", "boost times are kept in UTC");
  });

  it("knows a tenth of an SP and puts sums back on it", () => {
    for (const value of [0, 12.5, -2.5, 0.1 + 0.2, 1_000_000.1]) assert.ok(isTenths(value), String(value));
    for (const value of [12.55, 0.05, Number.NaN, Number.POSITIVE_INFINITY, "1"]) assert.ok(!isTenths(value), String(value));
    assert.equal(roundSp(0.1 + 0.2), 0.3);
    assert.equal(roundSp(10 + 1.1 + 2.2), 13.3);
    assert.ok(Object.is(roundSp(-0.04), 0), "never -0");
  });

  it("shows balances with one decimal, and rule amounts without a trailing .0", () => {
    assert.equal(formatSp(1234567.9), "1,234,567.9");
    assert.equal(formatSp(25), "25.0");
    assert.equal(formatSp(-25), "-25.0");
    assert.equal(formatSp(0.1 + 0.2), "0.3");
    assert.equal(formatSp(-0), "0.0");
    assert.equal(formatSpBrief(1_000), "1,000");
    assert.equal(formatSpBrief(2.5), "2.5");
  });
});
