import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSigner } from "@solana/kit";
import { effectiveMultiplier, multiplierChangesSoon, solanaFee, uiAmountToUnits, unitsToUiAmount } from "../src/domain/solana-amounts";
import { SOLANA_SOL, SOLANA_USDC, SOLANA_USDG } from "../src/domain/solana-assets";
import { SOLANA_XSTOCK_COUNT } from "../src/domain/solana-stock-count";
import { allowlistedSolanaAsset, KNOWN_SOLANA_TICKERS, SOLANA_ASSETS, SOLANA_XSTOCKS, solanaAssetByName } from "../src/domain/solana-stocks";
import { buildSolanaTransfer, matchesSolanaTransfer, SOLANA_MAX_COMPUTE_UNITS, type PreparedSolanaTransfer } from "../src/domain/solana-transfers";

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

async function prepared(asset = SOLANA_USDC, people = 2, note?: string) {
  const [sender, treasury, ...recipients] = await Promise.all(Array.from({ length: people + 2 }, () => generateKeyPairSigner()));
  const payments = recipients.map((recipient, index) => ({ recipient: recipient.address, units: BigInt(1_000_000 * (index + 1)) }));
  const built = await buildSolanaTransfer({ sender: sender.address, asset, payments, treasury: treasury.address, note, blockhash: BLOCKHASH, lastValidBlockHeight: 9n, computeUnitLimit: 120_000, computeUnitPrice: 5_000n });
  const transfer: PreparedSolanaTransfer = {
    network: "solana-mainnet",
    asset: { symbol: asset.symbol, mint: asset.mint, decimals: asset.decimals, program: asset.program },
    sender: sender.address,
    treasury: treasury.address,
    feeBps: 100,
    payments: payments.map(({ recipient, units }) => ({ recipient, units: units.toString(), amount: "1" })),
    transactions: [{ transaction: built.transaction, blockhash: BLOCKHASH, lastValidBlockHeight: "9", computeUnitLimit: 120_000, computeUnitPrice: "5000", payments: payments.map((_, index) => index) }],
    newAccounts: 0,
    rentLamports: "0",
    networkFeeLamports: "0",
    totalUnits: "0",
    feeUnits: "0",
  };
  const review = { sender: sender.address, treasury: treasury.address, asset: transfer.asset, payments, note };
  return { transfer, review, built };
}

describe("Solana assets", () => {
  it("lists USDC and USDG first, then the verified xStocks, finds them by ticker or symbol, and lists no SOL", () => {
    assert.deepEqual(SOLANA_ASSETS.slice(0, 2).map(({ symbol }) => symbol), ["USDC", "USDG"]);
    // HaPaPay sends stablecoins and stocks, not SOL.
    assert.equal(SOLANA_ASSETS.some(({ symbol }) => symbol === "SOL"), false);
    assert.ok(SOLANA_XSTOCKS.length > 900);
    assert.equal(SOLANA_XSTOCK_COUNT, SOLANA_XSTOCKS.length, "the home page's xStock count is written with the list itself");
    assert.ok(SOLANA_XSTOCKS.every((asset) => asset.program === "token-2022" && asset.decimals === 8 && asset.scaled && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset.mint!)));
    assert.equal(solanaAssetByName("tsla")?.symbol, "TSLAx");
    assert.equal(solanaAssetByName("TSLAx")?.mint, "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB");
    assert.equal(solanaAssetByName("usdc"), SOLANA_USDC);
    assert.equal(solanaAssetByName("sol"), undefined);
    assert.ok(KNOWN_SOLANA_TICKERS.has("NVDA") && KNOWN_SOLANA_TICKERS.has("NVDAX"));
  });

  it("accepts a listed symbol only with its own mint", () => {
    assert.equal(allowlistedSolanaAsset({ symbol: "USDC", mint: SOLANA_USDC.mint }), SOLANA_USDC);
    assert.equal(allowlistedSolanaAsset({ symbol: "USDC", mint: SOLANA_USDG.mint }), undefined);
    assert.equal(allowlistedSolanaAsset({ symbol: "SOL" }), undefined, "SOL is not sent");
    assert.equal(allowlistedSolanaAsset({ symbol: "usdc", mint: SOLANA_USDC.mint }), undefined, "the symbol must match exactly");
  });
});

describe("Solana amounts", () => {
  it("takes 1% on top, rounded down per payment", () => {
    assert.equal(solanaFee(1_000_000n), 10_000n);
    assert.equal(solanaFee(99n), 0n);
    assert.equal(solanaFee(2_500_001n), 25_000n);
  });

  it("converts amounts as wallets show them through a scaled multiplier", () => {
    assert.equal(uiAmountToUnits("1.5", 6), 1_500_000n);
    assert.equal(uiAmountToUnits("1", 8, 1.0017011968010740), 99_830_169n);
    assert.equal(unitsToUiAmount(99_830_169n, 8, 1.0017011968010740), "1");
    assert.throws(() => uiAmountToUnits("1", 8, 0), /multiplier cannot be read/);
    const config = { multiplier: 1, newMultiplier: 1.02, newMultiplierEffectiveTimestamp: 1_000n };
    assert.equal(effectiveMultiplier(config, 999n), 1);
    assert.equal(effectiveMultiplier(config, 1_000n), 1.02);
    assert.equal(multiplierChangesSoon(config, 500n), true, "a change in under ten minutes stops preparation");
    assert.equal(multiplierChangesSoon(config, 100n), false);
    assert.equal(multiplierChangesSoon(config, 1_000n), false, "a change that already happened is just the multiplier");
  });
});

describe("the browser's check of a prepared Solana transfer", () => {
  it("accepts the exact transaction for SOL, USDC and a Token-2022 stock, with or without a note", async () => {
    for (const [asset, note] of [[SOLANA_SOL, undefined], [SOLANA_USDC, "thanks"], [solanaAssetByName("NVDA")!, "🎉 team"]] as const) {
      const { transfer, review } = await prepared(asset, 2, note);
      assert.equal(await matchesSolanaTransfer(transfer, review), true, asset.symbol);
    }
  });

  it("refuses any difference from the review", async () => {
    const { transfer, review } = await prepared(SOLANA_USDC, 2, "lunch");
    assert.equal(await matchesSolanaTransfer(transfer, { ...review, note: undefined }), false, "a note the review did not show");
    assert.equal(await matchesSolanaTransfer(transfer, { ...review, payments: [review.payments[1], review.payments[0]] }), false, "payments reordered");
    assert.equal(await matchesSolanaTransfer(transfer, { ...review, payments: review.payments.map((payment) => ({ ...payment, units: payment.units * 2n })) }), false, "bigger amounts");
    assert.equal(await matchesSolanaTransfer({ ...transfer, treasury: review.payments[0].recipient }, review), false, "the treasury changed");
    assert.equal(await matchesSolanaTransfer({ ...transfer, feeBps: 200 }, review), false, "another fee rate");
    assert.equal(await matchesSolanaTransfer({ ...transfer, asset: { ...transfer.asset, mint: SOLANA_USDG.mint } }, review), false, "another mint");
    assert.equal(await matchesSolanaTransfer({ ...transfer, transactions: [{ ...transfer.transactions[0], payments: [0] }] }, review), false, "a payment left out");
    assert.equal(await matchesSolanaTransfer({ ...transfer, transactions: [{ ...transfer.transactions[0], computeUnitLimit: SOLANA_MAX_COMPUTE_UNITS + 1 }] }, review), false, "compute over the cap");
    assert.equal(await matchesSolanaTransfer({ ...transfer, transactions: [{ ...transfer.transactions[0], blockhash: "11111111111111111111111111111111" }] }, review), false, "another lifetime than the bytes carry");
    const other = await prepared(SOLANA_USDC, 2, "lunch");
    assert.equal(await matchesSolanaTransfer({ ...transfer, transactions: other.transfer.transactions }, review), false, "another sender's transaction");
  });
});
