import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { formatUsdc } from "../src/domain/referrals";
import { countedUiAmount, recordedUiAmount } from "../src/domain/solana-amounts";
import { SOLANA_USDC } from "../src/domain/solana-assets";
import { SOLANA_MAINNET } from "../src/domain/solana-chains";
import { solanaAssetByName } from "../src/domain/solana-stocks";
import { MemoryReferralStore } from "../server/referral-store";
import { MemorySolanaTransferRepository, SolanaTransferError, SolanaTransferService } from "../server/solana-transfer-service";
import { MemorySolanaVaultRepository } from "../server/solana-vault-service";
import { SpActivity } from "../server/sp-activity";
import { MemorySpRepository, SpService } from "../server/sp-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";

/**
 * Audit, 2026-10-06: a Solana confirm took the amount text and the units from the browser separately and checked only
 * the units on chain, so a payment of 1 USDC could be recorded as 100,000 USDC, with SP and an inviter's USDC reward
 * counted from that text, and a transaction that moved nothing could be recorded as any amount. Recorded amounts now
 * come from the verified units, and SP, rewards and history count rows by their units, older rows included.
 */
const INVITEE = getAddress("0x1111111111111111111111111111111111111111");
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const INVITER = getAddress("0x3333333333333333333333333333333333333333");
const CLAIMER = getAddress("0x4444444444444444444444444444444444444444");
const SENDER_SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const RECIPIENT_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TREASURY = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH";
const TSLAX = solanaAssetByName("TSLAx")!;

/** A confirmed USDC transaction that paid the recipient `recipientGain` units and the treasury `treasuryGain`. */
function rpcPaying(recipientGain: bigint, treasuryGain: bigint) {
  const entry = (owner: string, amount: bigint) => ({ accountIndex: 0, mint: SOLANA_USDC.mint!, owner, uiTokenAmount: { amount: amount.toString() } });
  return {
    getGenesisHash: () => ({ send: async () => SOLANA_MAINNET.genesisHash }),
    getTransaction: () => ({
      send: async () => ({
        slot: 1n,
        blockTime: BigInt(Math.floor(Date.parse("2026-10-05T12:00:00Z") / 1000)),
        meta: {
          err: null, preBalances: [], postBalances: [],
          preTokenBalances: [entry(SENDER_SOL, 5_000_000n), entry(RECIPIENT_SOL, 0n), entry(TREASURY, 0n)],
          postTokenBalances: [entry(SENDER_SOL, 5_000_000n - recipientGain - treasuryGain), entry(RECIPIENT_SOL, recipientGain), entry(TREASURY, treasuryGain)],
        },
        transaction: { message: { accountKeys: [{ pubkey: SENDER_SOL }, { pubkey: RECIPIENT_SOL }, { pubkey: TREASURY }], instructions: [] } },
      }),
    }),
  };
}

function service(repository: MemorySolanaTransferRepository, rpc: ReturnType<typeof rpcPaying>) {
  return new SolanaTransferService({
    config: { network: SOLANA_MAINNET.id, rpcUrl: "http://localhost.invalid", treasury: TREASURY, transfers: { enabled: true }, stocks: { enabled: false }, problems: [] } as never,
    rpc: rpc as never,
    repository,
    confirmAttempts: 1,
    confirmRetryMs: 0,
  });
}

const payment = (amount: string, units: string) => ({ recipientWallet: RECIPIENT, recipientAddress: RECIPIENT_SOL, platform: "github", username: "bob", amount, units });

async function invitedDesk(now: Date, sources: ConstructorParameters<typeof SpActivity>[0]["sources"]) {
  const referrals = new MemoryReferralStore(() => new Date("2026-10-05T09:00:00Z"), () => "AAAA2222");
  await referrals.ensureCode(INVITER);
  await referrals.bind({ invitee: INVITEE, referrer: INVITER, code: "AAAA2222" });
  const sp = new SpService({ repository: new MemorySpRepository(() => now), referrals, now: () => now, rulesCacheMs: 0 });
  return { referrals, sp, activity: new SpActivity({ sp, identities: new VerifiedIdentityService(), now: () => now, sources }) };
}

describe("Solana amounts recorded from the units the chain moved", () => {
  it("keeps the reviewed amount only when it names exactly the verified units", () => {
    assert.equal(recordedUiAmount("1", 1_000_000n, 6), "1");
    assert.equal(recordedUiAmount("1.50", 1_500_000n, 6), "1.50", "the reviewed text, when it is the same amount");
    assert.equal(recordedUiAmount("100000", 1_000_000n, 6), "1", "a larger amount beside the units is replaced");
    assert.equal(recordedUiAmount("0.0000005", 1n, 6), "0.000001", "more decimals than the token has are never kept");
    assert.equal(recordedUiAmount(undefined, 2_500_000_000n, 9), "2.5");
    assert.equal(recordedUiAmount("0.25", 24_691_358n, 8, 1.0125), "0.25", "a scaled xStock keeps the amount a wallet showed");
    assert.equal(recordedUiAmount("10", 24_691_358n, 8, 1.0125), "0.25");
  });

  it("counts a row by its units: exactly without a multiplier, and within a factor of two for a scaled xStock", () => {
    assert.equal(countedUiAmount({ amount: "100000", units: "1000000" }, SOLANA_USDC), "1");
    assert.equal(countedUiAmount({ amount: "900", units: "0" }, SOLANA_USDC), undefined, "a row that moved nothing counts for nothing");
    assert.equal(countedUiAmount({ amount: "0.25", units: 24_691_358n }, TSLAX), "0.25");
    assert.equal(countedUiAmount({ amount: "1000", units: 24_691_358n }, TSLAX), "0.24691358");
  });

  it("records 1 USDC for a confirm that names 100,000 USDC beside 1 USDC of units, and refuses units of nothing", async () => {
    const repository = new MemorySolanaTransferRepository();
    const [record] = await service(repository, rpcPaying(1_000_000n, 10_000n)).confirm({
      signature: "5".repeat(88), asset: SOLANA_USDC, sender: { wallet: INVITEE, address: SENDER_SOL }, payments: [payment("100000", "1000000")],
    });
    assert.deepEqual([record.amount, record.units, record.feeUnits], ["1", "1000000", "10000"]);
    await assert.rejects(
      () => service(new MemorySolanaTransferRepository(), rpcPaying(0n, 0n)).confirm({
        signature: "5".repeat(88), asset: SOLANA_USDC, sender: { wallet: INVITEE, address: SENDER_SOL }, payments: [payment("1000", "0")],
      }),
      (error) => error instanceof SolanaTransferError && /more than zero/.test(error.message),
    );
  });

  it("counts SP, invite shares and the inviter's USDC from the units, for rows recorded before this fix too", async () => {
    const now = new Date("2026-10-05T13:00:00Z");
    const repository = new MemorySolanaTransferRepository();
    // Rows as the old confirm wrote them: 1 USDC paid with its 0.01 fee, recorded as 100,000; and a row that moved nothing.
    await repository.save([
      { signature: "5".repeat(88), paymentIndex: 0, mint: SOLANA_USDC.mint!, tokenSymbol: "USDC", senderWallet: INVITEE, senderAddress: SENDER_SOL, recipientWallet: RECIPIENT, recipientAddress: RECIPIENT_SOL, platform: "github", username: "bob", amount: "100000", units: "1000000", feeUnits: "10000", slot: 1n, confirmedAt: "2026-10-05T12:00:00.000Z" },
      { signature: "6".repeat(88), paymentIndex: 0, mint: SOLANA_USDC.mint!, tokenSymbol: "USDC", senderWallet: INVITEE, senderAddress: SENDER_SOL, recipientWallet: RECIPIENT, recipientAddress: RECIPIENT_SOL, platform: "github", username: "bob", amount: "1000", units: "0", feeUnits: "0", slot: 2n, confirmedAt: "2026-10-05T12:01:00.000Z" },
    ]);
    const { referrals, sp, activity } = await invitedDesk(now, { solana: { transfers: repository } });
    await activity.syncAccount(INVITEE, { links: false });
    const payments = await sp.repository.ledger({ account: INVITEE, kind: "payment", limit: 5, includeZero: true });
    assert.deepEqual(payments.map((row) => row.usdCents), [100], "one payment, valued at $1; the empty row earns nothing");
    assert.ok(await sp.repository.balance(INVITEE) < 20, "SP for $1 and the first-payment bonus, not the daily cap");
    assert.equal(formatUsdc((await referrals.feeTotals(INVITER)).earned), "$0.005", "half of the real 0.01 USDC fee");

    // The sender's and the recipient's Activity: the empty row is not shown, and the amount is the one that moved.
    const history = await service(repository, rpcPaying(0n, 0n)).list(RECIPIENT);
    assert.deepEqual(history.map((entry) => [entry.direction, entry.amount]), [["received", "1"]]);
  });

  it("values a claimed vault link recorded with an inflated amount by the units the vault held", async () => {
    const now = new Date("2026-10-05T13:00:00Z");
    const links = new MemorySolanaVaultRepository();
    await links.saveClaim({
      paymentId: `0x${"ab".repeat(32)}`, programId: "Prog1111111111111111111111111111111111111111", fundingSignature: "7".repeat(88), mint: SOLANA_USDC.mint!, tokenSymbol: "USDC",
      payerWallet: INVITEE, payerAddress: SENDER_SOL, recipientPlatform: "github", recipientUsername: "bob", amount: "100000", units: 1_000_000n,
      expiry: BigInt(Math.floor(now.getTime() / 1000)) + 86_400n, slot: 1n, confirmedAt: "2026-10-05T12:00:00.000Z",
    });
    const { referrals, sp, activity } = await invitedDesk(now, {
      solana: { transfers: new MemorySolanaTransferRepository(), links, settle: async () => ({ state: "claimed", claimer: CLAIMER }) },
    });
    await activity.syncAccount(INVITEE, { links: "now" });
    assert.equal(formatUsdc((await referrals.feeTotals(INVITER)).earned), "$0.005", "half of the link's real 0.01 USDC fee");
    assert.ok(await sp.repository.balance(CLAIMER) < 20, "the claimer earns SP for 1 USDC, not the daily cap");
  });
});
