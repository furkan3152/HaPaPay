import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { address, generateKeyPairSigner, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { getAddress, type Address } from "viem";
import { REFERRAL_PAYOUT_MAX_ITEMS, referralPayoutMemo } from "../src/domain/referrals";
import { buildReferralPayout, matchesReferralPayout, type PreparedReferralPayout } from "../src/domain/referral-payout";
import { SOLANA_TOKEN_PROGRAM_ADDRESSES, SOLANA_USDC } from "../src/domain/solana-assets";
import { solanaRpc, type SolanaRpc } from "../server/solana-network";
import { MemoryReferralStore } from "../server/referral-store";
import { ReferralPayoutError, ReferralPayouts } from "../server/referral-payouts";
import { airdrop, mintFixture, mintTo, signAndSend, startLocalValidator, type LocalValidator } from "./fixtures/solana-validator";

const ADMIN = getAddress("0x00000000000000000000000000000000000000ad");
const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(7));
const wallet = (index: number) => getAddress(`0x${(index + 0xa0).toString(16).padStart(40, "0")}`);

/** A reward for an inviter, as sharing an invited account's payment writes it. */
let rewardSequence = 0;
async function reward(store: MemoryReferralStore, referrer: Address, units: bigint) {
  rewardSequence++;
  await store.insertFeeReward({
    sourceKey: `fee:solana:payout-test-${rewardSequence}:0`, referrer, invitee: wallet(90), network: "solana", paymentUsdCents: Number(units / 50n),
    units, spEntryId: String(rewardSequence), rulesVersion: 1, reason: null, createdAt: new Date("2026-10-05T10:00:00Z"),
  });
}

/** An RPC that answers the payout service's few reads from what a test sets. */
function fakeRpc(state: { height: bigint; lastValid: bigint; transactions: Map<string, unknown>; signatures: Array<{ signature: string; memo: string | null; err: unknown; blockTime: bigint | null }>; simulation?: { err: unknown; logs: string[] } }) {
  const answer = (value: unknown) => ({ send: async () => value });
  return {
    getLatestBlockhash: () => answer({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: state.lastValid } }),
    simulateTransaction: () => answer({ value: { err: state.simulation?.err ?? null, logs: state.simulation?.logs ?? [], unitsConsumed: 60_000n } }),
    getSignaturesForAddress: () => answer(state.signatures),
    getBlockHeight: () => answer(state.height),
    getTransaction: (signature: string) => answer(state.transactions.get(String(signature)) ?? null),
  } as unknown as SolanaRpc;
}

/** A confirmed payout transaction as an RPC returns it (jsonParsed): who paid, the memo, and each USDC balance before and after. */
function paidTransaction(payer: string, memo: string, paid: Array<{ address: string; units: bigint }>, options: { err?: unknown } = {}) {
  const balance = (owner: string, amount: bigint, index: number) => ({ accountIndex: index, mint: SOLANA_USDC.mint, owner, uiTokenAmount: { amount: amount.toString(), decimals: 6 } });
  return {
    slot: 10n,
    blockTime: 1_791_200_000n,
    meta: {
      err: options.err ?? null,
      preTokenBalances: [balance(payer, 100_000_000n, 1), ...paid.map((item, index) => balance(item.address, 0n, index + 2))],
      postTokenBalances: [balance(payer, 100_000_000n - paid.reduce((sum, item) => sum + item.units, 0n), 1), ...paid.map((item, index) => balance(item.address, item.units, index + 2))],
    },
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true, writable: true }], instructions: [{ program: "spl-memo", programId: "Memo", parsed: memo }] } },
  };
}

async function setup(options: { referrers?: number; owed?: (index: number) => bigint; frozen?: number[]; withoutAddress?: number[]; audit?: (entry: { admin: Address; batch: { id: string }; signature: string }) => Promise<unknown> } = {}) {
  const store = new MemoryReferralStore();
  const keys = await Promise.all(Array.from({ length: (options.referrers ?? 3) + 1 }, () => generateKeyPairSigner()));
  const payer = keys[0];
  const addresses = new Map<Address, string>();
  for (let index = 0; index < (options.referrers ?? 3); index++) {
    await reward(store, wallet(index), options.owed?.(index) ?? BigInt(index + 2) * 1_000_000n);
    if (!options.withoutAddress?.includes(index)) addresses.set(wallet(index), keys[index + 1].address);
  }
  const state = { height: 100n, lastValid: 250n, transactions: new Map<string, unknown>(), signatures: [] as Array<{ signature: string; memo: string | null; err: unknown; blockTime: bigint | null }>, simulation: undefined as undefined | { err: unknown; logs: string[] } };
  const payouts = new ReferralPayouts({
    store,
    rpc: fakeRpc(state),
    solana: { onMainnet: async () => undefined, computePrice: async () => 1_000n },
    solanaAddress: async (account) => addresses.get(account),
    frozen: async (account) => (options.frozen ?? []).some((index) => wallet(index) === account),
    audit: options.audit,
    confirmAttempts: 1,
    confirmRetryMs: 1,
  });
  return { store, payouts, payer, addresses, state };
}

const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(9));

/** Invite rewards paid in USDC on Solana: prepared by the server, signed by an admin's wallet. */
describe("invite reward payouts", () => {
  it("builds a payout the admin page checks byte for byte, and refuses anything changed", async () => {
    const [payer, first, second] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    const items = [{ address: first.address, units: 1_500_000n }, { address: second.address, units: 2_000_000n }];
    const plan = { payer: payer.address, batch: "0123456789abcdef", items, blockhash: BLOCKHASH, lastValidBlockHeight: 250n, computeUnitLimit: 80_000, computeUnitPrice: 1_000n };
    const built = await buildReferralPayout(plan);
    const prepared: PreparedReferralPayout = {
      batch: plan.batch, payer: payer.address, items: items.map((item, index) => ({ referrer: wallet(index), address: item.address, units: item.units.toString() })),
      totalUnits: "3500000", transaction: built.transaction, blockhash: BLOCKHASH, lastValidBlockHeight: "250", computeUnitLimit: 80_000, computeUnitPrice: "1000",
    };
    const review = { payer: payer.address, batch: plan.batch, items };
    assert.equal(await matchesReferralPayout(prepared, review), true);
    assert.equal(await matchesReferralPayout(prepared, { ...review, items: [items[0], { ...items[1], units: 2_000_001n }] }), false, "another amount");
    assert.equal(await matchesReferralPayout(prepared, { ...review, items: [items[0], { ...items[1], address: payer.address }] }), false, "another address");
    assert.equal(await matchesReferralPayout(prepared, { ...review, items: [items[0]] }), false, "a person missing");
    assert.equal(await matchesReferralPayout(prepared, { ...review, batch: "fedcba9876543210" }), false, "another batch, so another memo");
    assert.equal(await matchesReferralPayout({ ...prepared, computeUnitLimit: 500_000 }, review), false, "compute over the cap");
    const swapped = await buildReferralPayout({ ...plan, items: [items[0], { ...items[1], address: payer.address }] });
    assert.equal(await matchesReferralPayout({ ...prepared, transaction: swapped.transaction }, review), false, "a transaction paying someone else");
    assert.ok(built.size <= 1232);
    const eight = await Promise.all(Array.from({ length: REFERRAL_PAYOUT_MAX_ITEMS }, () => generateKeyPairSigner()));
    assert.ok((await buildReferralPayout({ ...plan, items: eight.map((key) => ({ address: key.address, units: 1_000_000n })) })).size <= 1232, "eight people with new accounts fit one transaction");
  });

  it("pays everyone owed a dollar with a Solana address, at most eight, never the paying wallet or a stopped account", async () => {
    const { payouts, store, addresses, payer } = await setup({ referrers: 12, owed: (index) => (index === 11 ? 999_999n : BigInt(20 - index) * 1_000_000n), frozen: [1], withoutAddress: [2] });
    const prepared = await payouts.prepare({ payer: payer.address, admin: ADMIN });
    assert.equal(prepared.items.length, REFERRAL_PAYOUT_MAX_ITEMS);
    const paid = prepared.items.map((item) => item.referrer);
    assert.ok(!paid.includes(wallet(1)), "a stopped account is not paid");
    assert.ok(!paid.includes(wallet(2)), "an account without a Solana address cannot be paid");
    assert.ok(!paid.includes(wallet(11)), "less than a dollar waits");
    assert.deepEqual(paid, [0, 3, 4, 5, 6, 7, 8, 9].map(wallet), "most owed first");
    assert.ok(prepared.items.every((item) => item.address === addresses.get(item.referrer as Address)));
    assert.equal(prepared.totalUnits, prepared.items.reduce((sum, item) => sum + BigInt(item.units), 0n).toString());
    assert.equal(await matchesReferralPayout(prepared, { payer: payer.address, batch: prepared.batch, items: prepared.items.map((item) => ({ address: item.address, units: BigInt(item.units) })) }), true);
    assert.equal((await store.batch(prepared.batch))?.createdBy, ADMIN);
    await assert.rejects(() => payouts.prepare({ payer: "not-an-address", admin: ADMIN }), ReferralPayoutError);
  });

  it("pays the people it can even when more than fifty owed more cannot be paid, and never someone whose stop cannot be read", async () => {
    // Audit, 2026-10-06: only the fifty owed most were looked at, and a failed read of a stop counted as not stopped.
    const { payouts, payer } = await setup({
      referrers: 54,
      owed: (index) => (index < 52 ? 9_000_000n : 2_000_000n),
      withoutAddress: Array.from({ length: 52 }, (_, index) => index),
    });
    const prepared = await payouts.prepare({ payer: payer.address, admin: ADMIN });
    assert.deepEqual(prepared.items.map((item) => item.referrer).sort(), [wallet(52), wallet(53)].sort());

    const unreadable = new ReferralPayouts({
      store: (await setup({ referrers: 2 })).store,
      rpc: fakeRpc({ height: 100n, lastValid: 250n, transactions: new Map(), signatures: [] }),
      solana: { onMainnet: async () => undefined, computePrice: async () => 1_000n },
      solanaAddress: async () => payer.address === "x" ? undefined : "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      frozen: async () => { throw new Error("the flags could not be read"); },
    });
    assert.ok((await unreadable.owed()).every((entry) => entry.frozen), "an unreadable stop is shown as stopped");
    await assert.rejects(() => unreadable.prepare({ payer: payer.address, admin: ADMIN }), /Nobody with a Solana address is owed/);
  });

  it("records a payout only from a transaction that paid each person exactly, and only once", async () => {
    const { payouts, store, payer, state } = await setup({ referrers: 2 });
    const prepared = await payouts.prepare({ payer: payer.address, admin: ADMIN });
    const memo = referralPayoutMemo(prepared.batch);
    const items = prepared.items.map((item) => ({ address: item.address, units: BigInt(item.units) }));
    const refused = async (transaction: unknown, message: RegExp) => {
      state.transactions.set(SIGNATURE, transaction);
      await assert.rejects(() => payouts.confirm({ batch: prepared.batch, signature: SIGNATURE, admin: ADMIN }), message);
    };
    await refused(paidTransaction(payer.address, memo, [items[0], { ...items[1], units: items[1].units - 1n }]), /did not pay .* exactly/);
    await refused(paidTransaction(payer.address, referralPayoutMemo("fedcba9876543210"), items), /not this payout/);
    await refused(paidTransaction(items[0].address, memo, items), /not paid from the wallet/);
    await refused(paidTransaction(payer.address, memo, items, { err: { InstructionError: [2, "Custom"] } }), /failed/);
    assert.equal((await store.feeTotals(wallet(0))).paid, 0n, "nothing was recorded");

    state.transactions.set(SIGNATURE, paidTransaction(payer.address, memo, items));
    const paid = await payouts.confirm({ batch: prepared.batch, signature: SIGNATURE, admin: ADMIN });
    assert.equal(paid.status, "paid");
    assert.equal(paid.recorded, 2);
    assert.deepEqual(await store.owed(1n, 10), [], "both are paid in full");
    const again = await payouts.confirm({ batch: prepared.batch, signature: SIGNATURE, admin: ADMIN });
    assert.equal(again.recorded, 0, "a batch is recorded once");
    assert.equal((await store.totals()).paid, 5_000_000n);
  });

  it("finds a payout by its memo, waits while a batch may still land, and prepares again once it cannot", async () => {
    const { payouts, payer, state, store } = await setup({ referrers: 2 });
    const first = await payouts.prepare({ payer: payer.address, admin: ADMIN });
    assert.equal((await payouts.confirm({ batch: first.batch, admin: ADMIN })).status, "waiting");
    await assert.rejects(() => payouts.prepare({ payer: payer.address, admin: ADMIN }), /may still land/);
    state.height = state.lastValid + 1n;
    assert.equal((await payouts.confirm({ batch: first.batch, admin: ADMIN })).status, "expired", "its blockhash is too old for it to land now");
    const second = await payouts.prepare({ payer: payer.address, admin: ADMIN });
    assert.notEqual(second.batch, first.batch);

    // The admin's browser closed before it reported the signature: the payer's history shows it by its memo.
    const memo = referralPayoutMemo(second.batch);
    state.signatures = [{ signature: SIGNATURE, memo: `[${memo.length}] ${memo}`, err: null, blockTime: 1_791_200_000n }];
    state.transactions.set(SIGNATURE, paidTransaction(payer.address, memo, second.items.map((item) => ({ address: item.address, units: BigInt(item.units) }))));
    const found = await payouts.confirm({ batch: second.batch, admin: ADMIN });
    assert.equal(found.status, "paid", "a transaction that landed counts even once its blockhash is old");
    assert.equal(found.signature, SIGNATURE);
    const recent = await payouts.recent(5);
    assert.deepEqual(recent.map((batch) => batch.status), ["paid", "expired"]);
    assert.equal((await store.payoutsOf(first.batch)).length, 0, "the expired batch is never paid");
  });

  it("lets only the earliest of two payouts prepared at the same moment go ahead", async () => {
    const { payouts, payer, store } = await setup({ referrers: 2 });
    const save = store.saveBatch.bind(store);
    let rival: string | undefined;
    // Another admin's batch lands between this admin's check of recent batches and its own save.
    store.saveBatch = async (batch) => {
      if (!rival) rival = (await save({ ...batch, id: "0000000000000000" })).id;
      return save(batch);
    };
    await assert.rejects(() => payouts.prepare({ payer: payer.address, admin: ADMIN }), /prepared at the same moment/);
    assert.equal(rival, "0000000000000000");
  });

  it("skips another wallet's transaction with the memo, and never lets a payout that may have landed expire", async () => {
    const { payouts, payer, state } = await setup({ referrers: 2 });
    const first = await payouts.prepare({ payer: payer.address, admin: ADMIN });
    const memo = referralPayoutMemo(first.batch);
    const items = first.items.map((item) => ({ address: item.address, units: BigInt(item.units) }));
    // Once a memo is public anyone can send a transaction that mentions the payer with it; it is read and skipped.
    const stranger = (await generateKeyPairSigner()).address;
    const SPOOF = getBase58Decoder().decode(new Uint8Array(64).fill(3));
    state.signatures = [{ signature: SPOOF, memo: `[${memo.length}] ${memo}`, err: null, blockTime: 1_791_200_000n }];
    state.transactions.set(SPOOF, paidTransaction(stranger, memo, items));
    assert.equal((await payouts.confirm({ batch: first.batch, admin: ADMIN })).status, "waiting", "not found, and its blockhash is still valid");
    state.height = state.lastValid + 1n;
    assert.equal((await payouts.confirm({ batch: first.batch, admin: ADMIN })).status, "expired", "the stranger's transaction never blocks payouts");
    const second = await payouts.prepare({ payer: payer.address, admin: ADMIN });

    // The payer's transaction with the memo is found, but the RPC cannot return it yet: the batch waits even though its
    // blockhash is too old, so the next payout cannot pay the same people again.
    state.height = 100n;
    state.lastValid = 250n;
    const memo2 = referralPayoutMemo(second.batch);
    state.signatures = [{ signature: SIGNATURE, memo: `[${memo2.length}] ${memo2}`, err: null, blockTime: 1_791_200_000n }];
    state.height = 251n;
    assert.equal((await payouts.confirm({ batch: second.batch, admin: ADMIN })).status, "waiting");
    await assert.rejects(() => payouts.prepare({ payer: payer.address, admin: ADMIN }), /may still land/);
    const OTHER = getBase58Decoder().decode(new Uint8Array(64).fill(5));
    assert.equal((await payouts.confirm({ batch: second.batch, signature: OTHER, admin: ADMIN })).status, "waiting", "a signature Solana does not return yet never makes it expire");
    state.transactions.set(SIGNATURE, paidTransaction(payer.address, memo2, second.items.map((item) => ({ address: item.address, units: BigInt(item.units) }))));
    assert.equal((await payouts.confirm({ batch: second.batch, admin: ADMIN })).status, "paid");
  });

  it("writes the audit row before it records a payout, and records nothing when it cannot", async () => {
    const audits: string[] = [];
    let failAudit = true;
    const { payouts, payer, state, store } = await setup({
      referrers: 1,
      audit: async ({ batch, signature }) => {
        if (failAudit) throw new Error("audit log unavailable");
        audits.push(`${batch.id}:${signature}`);
      },
    });
    const prepared = await payouts.prepare({ payer: payer.address, admin: ADMIN });
    const memo = referralPayoutMemo(prepared.batch);
    state.transactions.set(SIGNATURE, paidTransaction(payer.address, memo, prepared.items.map((item) => ({ address: item.address, units: BigInt(item.units) }))));
    await assert.rejects(() => payouts.confirm({ batch: prepared.batch, signature: SIGNATURE, admin: ADMIN }), /audit log unavailable/);
    assert.equal((await store.payoutsOf(prepared.batch)).length, 0, "no payout without its audit row");
    // The next payout waits for this one (found by its memo), and records it with its audit row first.
    failAudit = false;
    state.signatures = [{ signature: SIGNATURE, memo: `[${memo.length}] ${memo}`, err: null, blockTime: 1_791_200_000n }];
    await assert.rejects(() => payouts.prepare({ payer: payer.address, admin: ADMIN }), /Nobody with a Solana address is owed/);
    assert.deepEqual(audits, [`${prepared.batch}:${SIGNATURE}`], "recorded while preparing the next one, with its audit row");
    assert.equal((await store.payoutsOf(prepared.batch)).length, 1);
    await payouts.confirm({ batch: prepared.batch, signature: SIGNATURE, admin: ADMIN });
    assert.equal(audits.length, 1, "recorded once, audited once");
  });

  it("says what the paying wallet needs when it cannot pay", async () => {
    const { payouts, payer, state } = await setup({ referrers: 1 });
    state.simulation = { err: { InstructionError: [3, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"] };
    await assert.rejects(() => payouts.prepare({ payer: payer.address, admin: ADMIN }), /needs \$2\.00 in USDC/);
  });
});

/**
 * The same payout on a local validator that holds the real USDC mint at its mainnet address (only its mint authority
 * swapped for a test key): prepared by the server, checked like the admin page, signed by the payer, recorded from chain.
 */
describe("invite reward payouts on a local validator with the mainnet USDC mint", { timeout: 180_000 }, () => {
  let validator: LocalValidator | undefined;
  let authority: KeyPairSigner;
  let payer: KeyPairSigner;
  let first: KeyPairSigner;
  let second: KeyPairSigner;

  before(async () => {
    [authority, payer, first, second] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
    validator = await startLocalValidator({ accounts: [await mintFixture("usdc-mint", authority.address)] });
    if (!validator) return;
    await Promise.all([airdrop(validator, authority.address), airdrop(validator, payer.address)]);
    await mintTo(validator, authority, SOLANA_USDC, payer.address, 10_000_000n);
  });

  after(async () => {
    await validator?.stop();
  });

  const usdcBalance = async (owner: string) => {
    const [account] = await findAssociatedTokenPda({ owner: address(owner), mint: address(SOLANA_USDC.mint!), tokenProgram: address(SOLANA_TOKEN_PROGRAM_ADDRESSES.token) });
    const info = await validator!.rpc.getAccountInfo(account, { encoding: "base64" }).send();
    return info.value ? BigInt((await validator!.rpc.getTokenAccountBalance(account).send()).value.amount) : 0n;
  };

  it("pays two inviters exactly what they are owed in one transaction and records it from the chain", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const store = new MemoryReferralStore();
    await reward(store, wallet(0), 1_500_000n);
    await reward(store, wallet(1), 2_250_000n);
    const addresses = new Map<Address, string>([[wallet(0), first.address], [wallet(1), second.address]]);
    const payouts = new ReferralPayouts({
      store,
      rpc: solanaRpc(validator.rpcUrl, validator.rpcUrl),
      solana: { onMainnet: async () => undefined, computePrice: async () => 1_000n },
      solanaAddress: async (account) => addresses.get(account),
      frozen: async () => false,
      confirmRetryMs: 300,
    });
    const prepared = await payouts.prepare({ payer: payer.address, admin: ADMIN });
    const review = { payer: payer.address, batch: prepared.batch, items: prepared.items.map((item) => ({ address: item.address, units: BigInt(item.units) })) };
    assert.equal(await matchesReferralPayout(prepared, review), true, "the admin page accepts what the server prepared");
    const signature = await signAndSend(validator, prepared.transaction, [payer]);
    const state = await payouts.confirm({ batch: prepared.batch, signature, admin: ADMIN });
    assert.equal(state.status, "paid");
    assert.equal(state.recorded, 2);
    assert.equal(await usdcBalance(first.address), 1_500_000n);
    assert.equal(await usdcBalance(second.address), 2_250_000n);
    assert.equal(await usdcBalance(payer.address), 10_000_000n - 3_750_000n);
    assert.deepEqual(await store.owed(1n, 10), []);
    assert.equal((await payouts.confirm({ batch: prepared.batch, admin: ADMIN })).recorded, 0, "recorded once");
  });
});
