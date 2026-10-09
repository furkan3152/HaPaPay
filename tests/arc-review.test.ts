import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, keccak256, parseUnits, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_MAINNET, ARC_TESTNET } from "../src/domain/arc-chains";
import { matchesArcBatch, matchesArcClaimAction, matchesArcClaimFunding, matchesArcPayment } from "../src/domain/arc-review";
import { arcUsdcApproveAbi, buildArcUsdcTransfer } from "../src/domain/arc-transaction";
import { routedApproveCall, routedPayCall } from "../src/domain/routed-payments";
import { payRouterAbi, type PreparedPlatformFee } from "../src/domain/fees";
import { stockClaimEscrowAbi } from "../src/domain/stock-claims";

const wallet = privateKeyToAccount(`0x${"44".repeat(32)}`).address;
const recipient = "0x2222222222222222222222222222222222222222" as const;
const router = "0x5555555555555555555555555555555555555555" as const;
const escrow = "0x4444444444444444444444444444444444444444" as const;
const paymentRef = `0x${"ab".repeat(32)}` as const;
const usdc = ARC_MAINNET.usdcAddress;
const fee = (units: bigint, feeUnits = units / 100n): PreparedPlatformFee => ({
  router,
  feeBps: 100,
  units: feeUnits.toString(),
  amount: "",
  burnShare: (feeUnits / 2n).toString(),
  treasuryShare: (feeUnits - feeUnits / 2n).toString(),
  totalUnits: (units + feeUnits).toString(),
  totalAmount: "",
});
const routed = (overrides: Record<string, unknown> = {}) => {
  const units = parseUnits("4", 6);
  return {
    networkId: "arc-mainnet",
    chainId: ARC_MAINNET.chainId,
    fee: fee(units),
    paymentRef,
    transactions: [
      routedApproveCall({ token: usdc, router, units: units + units / 100n }),
      routedPayCall({ token: usdc, router, recipient, units, paymentRef, note: overrides.note as string | undefined }),
    ].map((call) => ({ ...call, from: wallet })),
    ...overrides,
  };
};
const review = { network: "arc-mainnet" as const, recipient, amount: "4", wallet };

describe("Arc payment review in the browser", () => {
  it("accepts exactly the reviewed routed payment: approve the router for amount plus fee, then pay the recipient", () => {
    assert.equal(matchesArcPayment(routed(), review), true);
  });

  it("accepts a note only as reviewed: the same text after pay's arguments and nothing else", () => {
    assert.equal(matchesArcPayment(routed({ note: "thanks for dinner" }), { ...review, note: "thanks for dinner" }), true);
    assert.equal(matchesArcPayment(routed({ note: "thanks for dinner" }), review), false, "a note the sender did not review");
    assert.equal(matchesArcPayment(routed(), { ...review, note: "thanks for dinner" }), false, "the reviewed note is missing");
    assert.equal(matchesArcPayment(routed({ note: "thanks for dinnner" }), { ...review, note: "thanks for dinner" }), false, "another note");
    const padded = routed();
    padded.transactions[1] = { ...padded.transactions[1], data: `${padded.transactions[1].data}00` as Hex };
    assert.equal(matchesArcPayment(padded, review), false, "anything appended to the call");
    const testnet = { networkId: "arc-testnet", chainId: ARC_TESTNET.chainId, transaction: { ...buildArcUsdcTransfer({ usdc: ARC_TESTNET.usdcAddress, recipient, amount: "4" }), from: wallet } };
    assert.equal(matchesArcPayment(testnet, { ...review, network: "arc-testnet", note: "rent" }), false, "a payment without the router carries no note");
  });

  it("accepts a batch on the bundled chain and USDC through the reviewed router only", () => {
    const units = [parseUnits("3.333334", 6), parseUnits("3.333333", 6)];
    const people = [recipient, "0x3333333333333333333333333333333333333333" as const];
    const total = units.reduce((sum, value) => sum + value + value / 100n, 0n);
    const batch = {
      networkId: "arc-mainnet",
      chainId: ARC_MAINNET.chainId,
      note: "dinner",
      feeBps: 100,
      totalUnits: total.toString(),
      totalAmount: "",
      approval: { ...routedApproveCall({ token: usdc, router, units: total }), purpose: "approve" as const, from: wallet, value: "0x0" as const },
      payments: units.map((value, index) => ({
        recipient: { platform: "x", username: `p${index}`, address: people[index] },
        amount: "",
        units: value.toString(),
        fee: fee(value),
        paymentRef: `0x${String(index + 1).padStart(64, "0")}` as Hex,
        transaction: { ...routedPayCall({ token: usdc, router, recipient: people[index], units: value, paymentRef: `0x${String(index + 1).padStart(64, "0")}` as Hex, note: "dinner" }), purpose: "pay" as const, from: wallet, value: "0x0" as const },
      })),
    };
    const reviewed = { network: "arc-mainnet" as const, router, wallet, note: "dinner", payments: [{ recipient, amount: "3.333334" }, { recipient: people[1], amount: "3.333333" }] };
    assert.equal(matchesArcBatch(batch, reviewed), true);
    assert.equal(matchesArcBatch({ ...batch, chainId: ARC_TESTNET.chainId }, reviewed), false, "another chain");
    assert.equal(matchesArcBatch(batch, { ...reviewed, network: "arc-testnet" }), false, "another network's USDC");
    assert.equal(matchesArcBatch(batch, { ...reviewed, router: recipient }), false, "another router");
  });

  it("accepts the payment alone when an earlier approval covers it, but never an approval alone", () => {
    const [approval, payment] = routed().transactions;
    assert.equal(matchesArcPayment(routed({ transactions: [payment] }), review), true);
    assert.equal(matchesArcPayment(routed({ transactions: [approval] }), review), false);
    assert.equal(matchesArcPayment(routed({ transactions: [{ ...payment, purpose: "approve" }] }), review), false);
    assert.equal(matchesArcPayment(routed({ transactions: [payment, approval] }), review), false, "the approval comes first");
  });

  it("refuses another chain, recipient, amount, fee above 1%, spender, router, sender or native value", () => {
    const units = parseUnits("4", 6);
    const base = routed();
    const [approval, payment] = base.transactions;
    const cases: Array<[string, Record<string, unknown>, typeof review?]> = [
      ["testnet chain under a mainnet review", { networkId: "arc-testnet", chainId: ARC_TESTNET.chainId }],
      ["mainnet id with another chain ID", { chainId: ARC_TESTNET.chainId }],
      ["fee above 1%", { fee: fee(units, units / 100n + 1n) }],
      ["fee total that does not add up", { fee: { ...fee(units), totalUnits: (units + units).toString() } }],
      ["approval to another spender", { transactions: [{ ...approval, data: encodeFunctionData({ abi: arcUsdcApproveAbi, functionName: "approve", args: [recipient, units + units / 100n] }) }, payment] }],
      ["approval larger than the total", { transactions: [{ ...approval, data: encodeFunctionData({ abi: arcUsdcApproveAbi, functionName: "approve", args: [router, units * 2n] }) }, payment] }],
      ["approval sent to another token", { transactions: [{ ...approval, to: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }, payment] }],
      ["payment to a different router", { transactions: [approval, { ...payment, to: escrow }] }],
      ["payment to another recipient", { transactions: [approval, { ...payment, data: encodeFunctionData({ abi: payRouterAbi, functionName: "pay", args: [usdc, escrow, units, paymentRef] }) }] }],
      ["payment of another amount", { transactions: [approval, { ...payment, data: encodeFunctionData({ abi: payRouterAbi, functionName: "pay", args: [usdc, recipient, units + 1n, paymentRef] }) }] }],
      ["payment with another reference", { transactions: [approval, { ...payment, data: encodeFunctionData({ abi: payRouterAbi, functionName: "pay", args: [usdc, recipient, units, `0x${"cd".repeat(32)}`] }) }] }],
      ["call from another wallet", { transactions: [{ ...approval, from: recipient }, payment] }],
      ["native value", { transactions: [approval, { ...payment, value: "0x1" }] }],
      ["three calls", { transactions: [approval, payment, payment] }],
    ];
    for (const [label, overrides] of cases) assert.equal(matchesArcPayment({ ...base, ...overrides }, review), false, label);
  });

  it("accepts a fee-free single transfer only on Arc Testnet", () => {
    const transaction = { ...buildArcUsdcTransfer({ usdc, recipient, amount: "4" }), from: wallet };
    assert.equal(matchesArcPayment({ networkId: "arc-testnet", chainId: ARC_TESTNET.chainId, transaction }, { ...review, network: "arc-testnet" }), true);
    assert.equal(matchesArcPayment({ networkId: "arc-mainnet", chainId: ARC_MAINNET.chainId, transaction }, review), false, "Arc Mainnet always carries the fee");
    assert.equal(matchesArcPayment({ networkId: "arc-testnet", chainId: ARC_TESTNET.chainId, transaction: { ...transaction, data: buildArcUsdcTransfer({ usdc, recipient: escrow, amount: "4" }).data } }, { ...review, network: "arc-testnet" }), false);
  });
});

describe("Arc vault link review in the browser", () => {
  const now = new Date("2026-10-03T12:00:00.000Z");
  const units = parseUnits("12.5", 6);
  const expiry = BigInt(Math.floor(now.getTime() / 1000) + 72 * 3600);
  const paymentId = `0x${"ef".repeat(32)}` as const;
  const funding = (overrides: { token?: Hex; amount?: bigint; expiry?: bigint; platform?: string; approve?: bigint } = {}) => ({
    networkId: "arc-mainnet",
    chainId: ARC_MAINNET.chainId,
    paymentId,
    escrow,
    fee: fee(units),
    transactions: [
      { purpose: "approve", to: usdc, from: wallet, value: "0x0", data: encodeFunctionData({ abi: arcUsdcApproveAbi, functionName: "approve", args: [escrow, overrides.approve ?? units + units / 100n] }) },
      { purpose: "fund", to: escrow, from: wallet, value: "0x0", data: encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "createPayment", args: [paymentId, overrides.token ?? usdc, keccak256(stringToHex(overrides.platform ?? "github")), keccak256(stringToHex("424242")), overrides.amount ?? units, overrides.expiry ?? expiry] }) },
    ],
  });
  const linkReview = { network: "arc-mainnet" as const, platform: "github", amount: "12.5", wallet, now };

  it("accepts approve of amount plus fee and createPayment of exactly the reviewed USDC link", () => {
    assert.equal(matchesArcClaimFunding(funding(), linkReview), true);
    const [approval, fund] = funding().transactions;
    assert.equal(matchesArcClaimFunding({ ...funding(), transactions: [fund] }, linkReview), true, "an earlier approval may already cover it");
    assert.equal(matchesArcClaimFunding({ ...funding(), transactions: [approval] }, linkReview), false);
  });

  it("refuses another token, amount, platform, approval, or a window past 31 days", () => {
    assert.equal(matchesArcClaimFunding(funding({ token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }), linkReview), false);
    assert.equal(matchesArcClaimFunding(funding({ amount: units + 1n }), linkReview), false);
    assert.equal(matchesArcClaimFunding(funding({ platform: "x" }), linkReview), false);
    assert.equal(matchesArcClaimFunding(funding({ approve: units * 2n }), linkReview), false);
    assert.equal(matchesArcClaimFunding(funding({ expiry: expiry + 40n * 86_400n }), linkReview), false);
    assert.equal(matchesArcClaimFunding({ ...funding(), fee: fee(units, units / 50n) }, linkReview), false);
  });

  it("accepts a claim to the session wallet and a refund of this link only", () => {
    const claim = { transaction: { to: escrow, from: wallet, value: "0x0", data: encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "claim", args: [paymentId, wallet, 1n, "0x1234"] }) } };
    assert.equal(matchesArcClaimAction(claim, { action: "claim", paymentId, wallet }), true);
    assert.equal(matchesArcClaimAction(claim, { action: "claim", paymentId: `0x${"12".repeat(32)}`, wallet }), false);
    assert.equal(matchesArcClaimAction({ transaction: { ...claim.transaction, data: encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "claim", args: [paymentId, recipient, 1n, "0x1234"] }) } }, { action: "claim", paymentId, wallet }), false);
    const refund = { transaction: { to: escrow, from: wallet, value: "0x0", data: encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "refund", args: [paymentId] }) } };
    assert.equal(matchesArcClaimAction(refund, { action: "refund", paymentId, wallet }), true);
    assert.equal(matchesArcClaimAction(refund, { action: "claim", paymentId, wallet }), false);
    const approval = { transaction: { to: usdc, from: wallet, value: "0x0", data: encodeFunctionData({ abi: arcUsdcApproveAbi, functionName: "approve", args: [escrow, 1n] }) } };
    assert.equal(matchesArcClaimAction(approval, { action: "refund", paymentId, wallet }), false, "an approval is never sent as a claim action");
  });
});
