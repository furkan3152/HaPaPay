import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concatHex, getAddress, stringToHex, type Hex } from "viem";
import { preparedFee } from "../server/stock-transfer-service";
import { appendPaymentNote } from "../src/domain/payment-note";
import {
  matchesRoutedBatch,
  matchesRoutedCall,
  routedApproveCall,
  routedPayCall,
  splitUnits,
  type PreparedBatch,
} from "../src/domain/routed-payments";

const token = getAddress("0x3600000000000000000000000000000000000000");
const router = getAddress("0x8888888888888888888888888888888888888888");
const wallet = getAddress("0x9999999999999999999999999999999999999999");
const people = [getAddress("0x1111111111111111111111111111111111111111"), getAddress("0x2222222222222222222222222222222222222222"), getAddress("0x3333333333333333333333333333333333333333")];
const ref = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const schedule = { router, burnVault: router, treasury: wallet, feeBps: 100, burnShareBps: 5000 } as const;

function batch(units: bigint[], options: { note?: string; approve?: boolean; feeBps?: bigint } = {}): PreparedBatch {
  const bps = options.feeBps ?? 100n;
  const payments = units.map((value, index) => {
    const fee = preparedFee(schedule, { fee: value * bps / 10_000n, bps }, value, 6);
    return {
      recipient: { platform: "x", username: `p${index}`, address: people[index] },
      amount: String(value),
      units: value.toString(),
      fee,
      paymentRef: ref(index + 1),
      transaction: { ...routedPayCall({ token, router, recipient: people[index], units: value, paymentRef: ref(index + 1), note: options.note }), purpose: "pay" as const, from: wallet, value: "0x0" as const },
    };
  });
  const total = payments.reduce((sum, payment) => sum + BigInt(payment.fee.totalUnits), 0n);
  return {
    networkId: "arc-mainnet",
    chainId: 5042,
    ...(options.note ? { note: options.note } : {}),
    feeBps: Number(bps),
    totalUnits: total.toString(),
    totalAmount: String(total),
    ...(options.approve === false ? {} : { approval: { ...routedApproveCall({ token, router, units: total }), purpose: "approve" as const, from: wallet, value: "0x0" as const } }),
    payments,
  };
}

const review = (units: bigint[], note?: string) => ({ token, router, wallet, note, payments: units.map((value, index) => ({ recipient: people[index], units: value.toString() })) });

describe("payments through the fee router", () => {
  it("splits an amount as evenly as base units allow, the first people taking the remainder", () => {
    assert.deepEqual(splitUnits(10_000_000n, 3), [3_333_334n, 3_333_333n, 3_333_333n]);
    assert.deepEqual(splitUnits(10n ** 18n, 3), [333_333_333_333_333_334n, 333_333_333_333_333_333n, 333_333_333_333_333_333n]);
    assert.deepEqual(splitUnits(6n, 3), [2n, 2n, 2n]);
    assert.deepEqual(splitUnits(1n, 2), [1n, 0n], "a share can be zero; the desk refuses such a split");
    assert.equal(splitUnits(7_777_777n, 7).reduce((sum, share) => sum + share, 0n), 7_777_777n, "nothing is lost");
    assert.throws(() => splitUnits(5n, 0));
  });

  it("matches a call byte for byte, the note included and nothing else after the arguments", () => {
    const expected = routedPayCall({ token, router, recipient: people[0], units: 5n, paymentRef: ref(1), note: "rent" });
    const call = { ...expected, from: wallet };
    assert.equal(matchesRoutedCall(call, expected, wallet), true);
    assert.equal(matchesRoutedCall({ ...call, data: appendPaymentNote(routedPayCall({ token, router, recipient: people[0], units: 5n, paymentRef: ref(1) }).data, "rant") }, expected, wallet), false, "another note");
    assert.equal(matchesRoutedCall({ ...call, data: concatHex([expected.data, stringToHex("x")]) }, expected, wallet), false, "anything appended");
    assert.equal(matchesRoutedCall(call, routedPayCall({ token, router, recipient: people[0], units: 5n, paymentRef: ref(1) }), wallet), false, "a note the review did not have");
    assert.equal(matchesRoutedCall({ ...call, from: people[1] }, expected, wallet), false, "another sender");
    assert.equal(matchesRoutedCall({ ...call, value: "0x1" }, expected, wallet), false, "native value");
    assert.equal(matchesRoutedCall({ ...call, purpose: "approve" }, expected, wallet), false);
    assert.equal(matchesRoutedCall({ ...call, to: token }, expected, wallet), false);
  });

  it("accepts a batch only as reviewed: the same people and amounts in order, one approval of the exact total, the note on every payment", () => {
    const units = [3_333_334n, 3_333_333n, 3_333_333n];
    assert.equal(matchesRoutedBatch(batch(units, { note: "dinner" }), review(units, "dinner")), true);
    assert.equal(matchesRoutedBatch(batch(units, { approve: false }), review(units)), true, "an earlier approval may already cover it");
    assert.equal(matchesRoutedBatch(batch(units, { note: "dinner" }), review(units)), false, "a note the sender did not review");
    assert.equal(matchesRoutedBatch(batch(units), review(units, "dinner")), false, "the reviewed note is missing");
    assert.equal(matchesRoutedBatch(batch(units), review([...units].reverse())), false, "another order");
    assert.equal(matchesRoutedBatch(batch(units.slice(0, 2)), review(units)), false, "someone left out");
    assert.equal(matchesRoutedBatch(batch(units, { feeBps: 200n }), review(units)), false, "a fee above 1%");
    const short = batch(units);
    short.approval = { ...routedApproveCall({ token, router, units: BigInt(short.totalUnits) + 1n }), purpose: "approve", from: wallet, value: "0x0" };
    assert.equal(matchesRoutedBatch(short, review(units)), false, "an approval for more than the payments");
    const repeated = batch(units);
    repeated.payments[1] = { ...repeated.payments[1], paymentRef: ref(1), transaction: { ...repeated.payments[1].transaction, data: routedPayCall({ token, router, recipient: people[1], units: units[1], paymentRef: ref(1) }).data } };
    assert.equal(matchesRoutedBatch(repeated, review(units)), false, "two payments with one reference");
    const redirected = batch(units);
    redirected.payments[2] = { ...redirected.payments[2], transaction: { ...redirected.payments[2].transaction, data: routedPayCall({ token, router, recipient: wallet, units: units[2], paymentRef: ref(3) }).data } };
    assert.equal(matchesRoutedBatch(redirected, review(units)), false, "a payment to someone else");
    const total = batch(units);
    total.totalUnits = "1";
    assert.equal(matchesRoutedBatch(total, review(units)), false, "a total that does not add up");
  });
});
