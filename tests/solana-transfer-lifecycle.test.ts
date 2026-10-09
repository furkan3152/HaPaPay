import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { address, generateKeyPairSigner, lamports, type KeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda } from "@solana-program/token";
import { formatUnits, getAddress } from "viem";
import { PAYMENT_NOTE_PREFIX } from "../src/domain/payment-note";
import { effectiveMultiplier, uiAmountToUnits, unitsToUiAmount } from "../src/domain/solana-amounts";
import { NO_SOL_SENDING, SOLANA_SOL, SOLANA_TOKEN_PROGRAM_ADDRESSES, SOLANA_USDC, type SolanaAssetListing } from "../src/domain/solana-assets";
import { solanaAssetByName } from "../src/domain/solana-stocks";
import { matchesSolanaTransfer } from "../src/domain/solana-transfers";
import { readSolanaConfig, solanaRpc } from "../server/solana-network";
import { MemorySolanaTransferRepository, SolanaTransferError, SolanaTransferService, SolanaUnavailableError } from "../server/solana-transfer-service";
import { airdrop, mintFixture, mintTo, sendInstructions, signAndSend, startLocalValidator, type LocalValidator } from "./fixtures/solana-validator";

const TSLAX = solanaAssetByName("TSLA")!;
const NVDAX = solanaAssetByName("NVDAx")!;

/**
 * Solana transfers against a local validator that holds the real mainnet mints (USDC, TSLAx, NVDAx with their
 * Token-2022 extensions, multiplier included) at their mainnet addresses, with only the mint authority swapped for a
 * test key: prepare from a review, the browser's byte-for-byte check, a wallet's signature, and the record from chain.
 */
describe("Solana transfers on a local validator with the mainnet mints", { timeout: 180_000 }, () => {
  let validator: LocalValidator | undefined;
  let authority: KeyPairSigner;
  let sender: KeyPairSigner;
  let treasury: KeyPairSigner;
  let alice: KeyPairSigner;
  let bob: KeyPairSigner;
  let service: SolanaTransferService;
  let genesisHash: string;
  const senderWallet = getAddress("0x00000000000000000000000000000000000000a1");

  before(async () => {
    [authority, sender, treasury, alice, bob] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()));
    validator = await startLocalValidator({
      accounts: await Promise.all(["usdc-mint", "tslax-mint", "nvdax-mint"].map((name) => mintFixture(name, authority.address))),
    });
    if (!validator) return;
    await Promise.all([airdrop(validator, authority.address), airdrop(validator, sender.address), airdrop(validator, treasury.address, 1n)]);
    await mintTo(validator, authority, SOLANA_USDC, sender.address, 100_000_000n);
    await mintTo(validator, authority, TSLAX, sender.address, 500_000_000n);
    await mintTo(validator, authority, NVDAX, sender.address, 500_000_000n);
    const config = readSolanaConfig({ SOLANA_RPC_URL: "https://localhost.invalid/", SOLANA_TREASURY_ADDRESS: treasury.address, SOLANA_STOCK_TRANSFERS: "enabled" });
    const rpc = solanaRpc(validator.rpcUrl, validator.rpcUrl);
    genesisHash = await rpc.getGenesisHash().send();
    service = new SolanaTransferService({ config, rpc, repository: new MemorySolanaTransferRepository(), confirmRetryMs: 300, genesisHash });
  });

  after(async () => {
    await validator?.stop();
  });

  const tokenBalance = async (owner: string, asset: SolanaAssetListing) => {
    const [account] = await findAssociatedTokenPda({ owner: address(owner), mint: address(asset.mint!), tokenProgram: address(SOLANA_TOKEN_PROGRAM_ADDRESSES[asset.program ?? "token"]) });
    const info = await validator!.rpc.getAccountInfo(account, { encoding: "base64" }).send();
    if (!info.value) return 0n;
    return BigInt((await validator!.rpc.getTokenAccountBalance(account).send()).value.amount);
  };

  async function sendReviewed(asset: SolanaAssetListing, payments: Array<{ recipient: string; amount: string; username: string }>, note?: string) {
    const prepared = await service.prepare({ sender: sender.address, asset, payments: payments.map(({ recipient, amount }) => ({ recipient, amount })), note });
    const review = { sender: sender.address, treasury: treasury.address, asset: { symbol: asset.symbol, mint: asset.mint, decimals: asset.decimals, program: asset.program }, payments: prepared.payments.map(({ recipient, units }) => ({ recipient, units: BigInt(units) })), note };
    assert.equal(await matchesSolanaTransfer(prepared, review), true, "the browser accepts what the server prepared");
    const signatures = [];
    for (const part of prepared.transactions) signatures.push(await signAndSend(validator!, part.transaction, [sender]));
    const recorded = [];
    for (const [index, part] of prepared.transactions.entries()) {
      recorded.push(...await service.confirm({
        signature: signatures[index],
        asset,
        sender: { wallet: senderWallet, address: sender.address },
        payments: part.payments.map((position) => ({ recipientWallet: getAddress(`0x${(position + 1).toString(16).padStart(40, "0")}`), recipientAddress: prepared.payments[position].recipient, platform: "x", username: payments[position].username, amount: payments[position].amount, units: prepared.payments[position].units })),
        note,
      }));
    }
    return { prepared, signatures, recorded };
  }

  it("pays two people USDC in one transaction with the fee and the note, and records each from the chain", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const before = { alice: await tokenBalance(alice.address, SOLANA_USDC), bob: await tokenBalance(bob.address, SOLANA_USDC), treasury: await tokenBalance(treasury.address, SOLANA_USDC) };
    const { prepared, recorded } = await sendReviewed(SOLANA_USDC, [{ recipient: alice.address, amount: "1", username: "alice" }, { recipient: bob.address, amount: "2.5", username: "bob" }], "team lunch 🎉");
    assert.equal(prepared.transactions.length, 1);
    assert.equal(prepared.newAccounts, 3, "both recipients and the treasury get a USDC account, paid by the sender");
    assert.equal(prepared.feeUnits, "35000");
    assert.equal(await tokenBalance(alice.address, SOLANA_USDC) - before.alice, 1_000_000n);
    assert.equal(await tokenBalance(bob.address, SOLANA_USDC) - before.bob, 2_500_000n);
    assert.equal(await tokenBalance(treasury.address, SOLANA_USDC) - before.treasury, 35_000n);
    assert.deepEqual(recorded.map(({ username, units, note }) => [username, units, note]), [["alice", "1000000", "team lunch 🎉"], ["bob", "2500000", "team lunch 🎉"]]);
    const transaction = await validator.rpc.getTransaction(recorded[0].signature as never, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send();
    const memo = transaction!.transaction.message.instructions.find((instruction) => "parsed" in instruction && (instruction as { program?: string }).program === "spl-memo");
    assert.equal((memo as unknown as { parsed: string }).parsed, `${PAYMENT_NOTE_PREFIX}team lunch 🎉`);
  });

  it("moves xStocks as wallets show them, through the scaled multiplier", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const mint = await service.mintState(NVDAX);
    const multiplier = effectiveMultiplier(mint.scaled, BigInt(Math.floor(Date.now() / 1000)));
    assert.notEqual(multiplier, 1, "NVDAx carries a multiplier on mainnet");
    const units = uiAmountToUnits("1", 8, multiplier);
    const before = await tokenBalance(alice.address, NVDAX);
    const { prepared } = await sendReviewed(NVDAX, [{ recipient: alice.address, amount: "1", username: "alice" }]);
    assert.equal(prepared.multiplier, multiplier);
    assert.equal(prepared.payments[0].units, units.toString());
    assert.equal(await tokenBalance(alice.address, NVDAX) - before, units);
    const { prepared: tsla } = await sendReviewed(TSLAX, [{ recipient: bob.address, amount: "0.25", username: "bob" }], "for you");
    assert.equal(tsla.payments[0].units, "25000000");
  });

  it("prepares no SOL payment: HaPaPay sends stablecoins and stocks", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    // The route refuses SOL, and the service does too.
    await assert.rejects(
      () => service.prepare({ sender: sender.address, asset: SOLANA_SOL, payments: [{ recipient: alice.address, amount: "0.2" }] }),
      (error) => error instanceof SolanaTransferError && error.message === NO_SOL_SENDING,
    );
  });

  it("checks the SOL a split request spends in all", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    // Audit, 2026-10-06: a request split in two was prepared although only its first transaction could pay its rent,
    // so the second failed after the first paid.
    const short = await generateKeyPairSigner();
    await mintTo(validator, authority, TSLAX, short.address, 5_000_000_000n);
    // Enough SOL for the first transaction's new accounts and fee, not for both transactions'.
    const funded = await validator.rpc.getMinimumBalanceForRentExemption(182n).send() * 9n + 1_500_000n;
    await sendInstructions(validator, authority, [getTransferSolInstruction({ source: authority, destination: address(short.address), amount: lamports(funded) })]);
    const people = await Promise.all(Array.from({ length: 10 }, () => generateKeyPairSigner()));
    await assert.rejects(
      () => service.prepare({ sender: short.address, asset: TSLAX, payments: people.map((person) => ({ recipient: person.address, amount: "0.3" })) }),
      (error) => error instanceof SolanaTransferError
        && /^Your Solana wallet holds 0\.0\d+ SOL; these payments need about 0\.0\d+ SOL: the network fee, and 1\d accounts for TSLAx it opens for people who hold none yet, and the small balance Solana keeps in every wallet\.$/.test(error.message),
    );
    await sendInstructions(validator, authority, [getTransferSolInstruction({ source: authority, destination: address(short.address), amount: lamports(1_000_000_000n) })]);
    const prepared = await service.prepare({ sender: short.address, asset: TSLAX, payments: people.map((person) => ({ recipient: person.address, amount: "0.3" })) });
    assert.equal(prepared.transactions.length, 2, "with the SOL for both, both are prepared");
  });

  it("splits a batch whose note does not fit one transaction, and the browser still accepts it", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const people = await Promise.all(Array.from({ length: 6 }, () => generateKeyPairSigner()));
    const note = "🎉".repeat(140);
    const { prepared, recorded } = await sendReviewed(SOLANA_USDC, people.map((person, index) => ({ recipient: person.address, amount: "0.1", username: `p${index}` })), note);
    assert.ok(prepared.transactions.length > 1, "a long note splits the batch");
    assert.equal(recorded.length, 6);
  });

  it("refuses a short balance, a tampered transaction, another note and a second record", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    await assert.rejects(() => service.prepare({ sender: sender.address, asset: SOLANA_USDC, payments: [{ recipient: alice.address, amount: "1000" }] }), (error) => error instanceof SolanaTransferError && /holds .* USDC; these payments need 1010 USDC/.test(error.message));
    const prepared = await service.prepare({ sender: sender.address, asset: SOLANA_USDC, payments: [{ recipient: alice.address, amount: "1" }], note: "a" });
    const review = { sender: sender.address, treasury: treasury.address, asset: { symbol: "USDC", mint: SOLANA_USDC.mint, decimals: 6, program: "token" as const }, payments: [{ recipient: alice.address, units: 1_000_000n }], note: "a" };
    assert.equal(await matchesSolanaTransfer(prepared, { ...review, payments: [{ recipient: bob.address, units: 1_000_000n }] }), false, "another recipient");
    assert.equal(await matchesSolanaTransfer(prepared, { ...review, note: "b" }), false, "another note");
    assert.equal(await matchesSolanaTransfer(prepared, { ...review, treasury: alice.address }), false, "another treasury");
    assert.equal(await matchesSolanaTransfer({ ...prepared, transactions: prepared.transactions.map((part) => ({ ...part, computeUnitPrice: "999999999" })) }, review), false, "a priority price over the cap");
    const signature = await signAndSend(validator, prepared.transactions[0].transaction, [sender]);
    const confirm = (note?: string, amount = "1") => service.confirm({ signature, asset: SOLANA_USDC, sender: { wallet: senderWallet, address: sender.address }, payments: [{ recipientWallet: senderWallet, recipientAddress: alice.address, platform: "x", username: "alice", amount, units: "1000000" }], note });
    await assert.rejects(() => confirm("b"), /note is not the reviewed note/);
    await assert.rejects(() => service.confirm({ signature, asset: SOLANA_USDC, sender: { wallet: senderWallet, address: sender.address }, payments: [{ recipientWallet: senderWallet, recipientAddress: bob.address, platform: "x", username: "bob", amount: "1", units: "1000000" }], note: "a" }), /did not pay @bob exactly/);
    // Audit, 2026-10-06: a payment that moved nothing is never recorded, and the amount recorded is the one the chain
    // moved, whatever amount text the browser sends beside the units.
    await assert.rejects(() => service.confirm({ signature, asset: SOLANA_USDC, sender: { wallet: senderWallet, address: sender.address }, payments: [{ recipientWallet: senderWallet, recipientAddress: bob.address, platform: "x", username: "bob", amount: "900", units: "0" }], note: "a" }), /more than zero/);
    const [recorded] = await confirm("a", "100000");
    assert.deepEqual([recorded.amount, recorded.units], ["1", "1000000"]);
    await assert.rejects(() => confirm("a"), /already recorded/);
    assert.deepEqual(await service.status(signature), { status: "0x1", slot: (await service.status(signature))!.slot });
  });

  it("reads what a wallet holds as wallets show it, for the chat's choice of network", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    // A request written without a network goes where the sender's wallet holds the asset.
    const multiplier = effectiveMultiplier((await service.mintState(NVDAX)).scaled, BigInt(Math.floor(Date.now() / 1000)));
    assert.notEqual(multiplier, 1);
    assert.equal(await service.holding(sender.address, NVDAX), unitsToUiAmount(await tokenBalance(sender.address, NVDAX), 8, multiplier), "an xStock reads as the wallet shows it");
    assert.equal(await service.holding(sender.address, SOLANA_USDC), formatUnits(await tokenBalance(sender.address, SOLANA_USDC), 6));
    const stranger = await generateKeyPairSigner();
    assert.equal(await service.holding(stranger.address, SOLANA_USDC), "0", "no token account holds nothing");
    const config = readSolanaConfig({ SOLANA_RPC_URL: "https://localhost.invalid/", SOLANA_TREASURY_ADDRESS: treasury.address });
    const elsewhere = new SolanaTransferService({ config, rpc: solanaRpc(validator.rpcUrl, validator.rpcUrl), repository: new MemorySolanaTransferRepository() });
    assert.equal(await elsewhere.holding(sender.address, SOLANA_USDC), undefined, "an RPC that is not Solana mainnet answers nothing");
  });

  it("says what a Solana address holds of SOL and every listed asset, for the account's own view", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    // Tokens paid to a wallet Privy made must show in the account's own view.
    const held = await service.holdings(sender.address);
    assert.ok(held && Number(held.sol) > 0, "the wallet's SOL");
    const bySymbol = Object.fromEntries(held!.tokens.map(({ symbol, amount }) => [symbol, amount]));
    for (const asset of [SOLANA_USDC, TSLAX, NVDAX]) assert.equal(bySymbol[asset.symbol], await service.holding(sender.address, asset), `${asset.symbol} as wallets show it`);
    const stranger = await generateKeyPairSigner();
    assert.deepEqual(await service.holdings(stranger.address), { sol: "0", tokens: [] }, "a new wallet holds nothing");
    const config = readSolanaConfig({ SOLANA_RPC_URL: "https://localhost.invalid/", SOLANA_TREASURY_ADDRESS: treasury.address });
    const elsewhere = new SolanaTransferService({ config, rpc: solanaRpc(validator.rpcUrl, validator.rpcUrl), repository: new MemorySolanaTransferRepository() });
    assert.equal(await elsewhere.holdings(sender.address), undefined, "an RPC that is not Solana mainnet answers nothing");
  });

  it("records a payment sent from the treasury's own wallet, with no fee recorded", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    // A payment sent from the treasury's own wallet pays its 1% fee to itself, so the record carries no fee.
    const config = readSolanaConfig({ SOLANA_RPC_URL: "https://localhost.invalid/", SOLANA_TREASURY_ADDRESS: sender.address, SOLANA_STOCK_TRANSFERS: "enabled" });
    const own = new SolanaTransferService({ config, rpc: solanaRpc(validator.rpcUrl, validator.rpcUrl), repository: new MemorySolanaTransferRepository(), confirmRetryMs: 300, genesisHash });
    const before = { alice: await tokenBalance(alice.address, TSLAX), sender: await tokenBalance(sender.address, TSLAX) };
    const prepared = await own.prepare({ sender: sender.address, asset: TSLAX, payments: [{ recipient: alice.address, amount: "0.01" }] });
    const review = { sender: sender.address, treasury: sender.address, asset: { symbol: TSLAX.symbol, mint: TSLAX.mint, decimals: TSLAX.decimals, program: TSLAX.program }, payments: prepared.payments.map(({ recipient, units }) => ({ recipient, units: BigInt(units) })) };
    assert.equal(await matchesSolanaTransfer(prepared, review), true, "the browser accepts it as prepared");
    const signature = await signAndSend(validator, prepared.transactions[0].transaction, [sender]);
    const units = prepared.payments[0].units;
    assert.equal(await tokenBalance(alice.address, TSLAX) - before.alice, BigInt(units), "the recipient got exactly the amount");
    assert.equal(before.sender - await tokenBalance(sender.address, TSLAX), BigInt(units), "the fee went from the treasury to itself");
    const payments = [{ recipientWallet: getAddress("0x00000000000000000000000000000000000000b2"), recipientAddress: alice.address, platform: "github", username: "alice", amount: "0.01", units }];
    await assert.rejects(() => service.confirm({ signature, asset: TSLAX, sender: { wallet: senderWallet, address: sender.address }, payments }), /did not carry the 1% fee/, "any other sender still owes the treasury its fee");
    const recorded = await own.confirm({ signature, asset: TSLAX, sender: { wallet: senderWallet, address: sender.address }, payments });
    assert.deepEqual(recorded.map(({ username, units: recordedUnits, feeUnits }) => [username, recordedUnits, feeUnits]), [["alice", units, "0"]], "recorded, with no fee");
    await assert.rejects(() => own.confirm({ signature, asset: TSLAX, sender: { wallet: senderWallet, address: sender.address }, payments: [{ ...payments[0], units: (BigInt(units) + 1n).toString() }] }), /did not pay @alice exactly/, "the recipient's amount is still checked");
  });

  it("prepares and records nothing through an RPC that is not Solana mainnet", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    assert.notEqual(genesisHash, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "the local validator is its own cluster");
    const config = readSolanaConfig({ SOLANA_RPC_URL: "https://localhost.invalid/", SOLANA_TREASURY_ADDRESS: treasury.address });
    const elsewhere = new SolanaTransferService({ config, rpc: solanaRpc(validator.rpcUrl, validator.rpcUrl), repository: new MemorySolanaTransferRepository(), confirmRetryMs: 300 });
    const notMainnet = (error: unknown) => error instanceof SolanaUnavailableError && /not Solana mainnet/.test(error.message);
    await assert.rejects(() => elsewhere.prepare({ sender: sender.address, asset: SOLANA_USDC, payments: [{ recipient: alice.address, amount: "10" }] }), notMainnet);
    await assert.rejects(() => elsewhere.confirm({ signature: "1".repeat(64), asset: SOLANA_USDC, sender: { wallet: senderWallet, address: sender.address }, payments: [{ recipientWallet: senderWallet, recipientAddress: alice.address, platform: "x", username: "alice", amount: "10", units: "10000000" }] }), notMainnet);
  });
});
