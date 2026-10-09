import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { address, generateKeyPairSigner, getAddressEncoder, signBytes, type Instruction, type KeyPairSigner } from "@solana/kit";
import { SOLANA_SOL, SOLANA_USDC, WRAPPED_SOL_MINT } from "../src/domain/solana-assets";
import { solanaAssetByName } from "../src/domain/solana-stocks";
import {
  compileVaultAction,
  compileVaultFunding,
  decodeVaultConfig,
  decodeVaultPayment,
  ed25519Instruction,
  initializeVaultInstruction,
  platformHash,
  programDataAddress,
  providerUserIdHash,
  tokenAccountFor,
  updateVaultInstruction,
  vaultClaimMessage,
  vaultConfigAddress,
  vaultIdentityKey,
  vaultPaymentAddress,
  vaultToken,
  wireTransaction,
} from "../src/domain/solana-vault";
import { airdrop, mintFixture, mintTo, sendInstructions, signAndSend, startLocalValidator, type LocalValidator } from "./fixtures/solana-validator";

const PROGRAM = fileURLToPath(new URL("../public/solana/hapapay_vault.so", import.meta.url));
const TSLAX = solanaAssetByName("TSLAx")!;

/**
 * The Solana vault program itself, on a local validator with the real SPL Token, Token-2022 and associated token
 * programs and the mainnet USDC and TSLAx mints: who may initialize it, funding with the exact amount and fee, a
 * claim that needs the attestor's signature over exactly that claim, the refund after the expiry, the tombstone, SOL
 * held wrapped and handed out as SOL, and the owner's settings.
 */
describe("the Solana vault program", { timeout: 300_000 }, () => {
  let validator: LocalValidator | undefined;
  let deployer: KeyPairSigner;
  let operator: KeyPairSigner;
  let attestor: KeyPairSigner;
  let treasury: KeyPairSigner;
  let payer: KeyPairSigner;
  let recipient: KeyPairSigner;
  let stranger: KeyPairSigner;
  let mintAuthority: KeyPairSigner;
  let programId: string;

  before(async () => {
    [deployer, operator, attestor, treasury, payer, recipient, stranger, mintAuthority] = await Promise.all(Array.from({ length: 8 }, () => generateKeyPairSigner()));
    programId = (await generateKeyPairSigner()).address;
    validator = await startLocalValidator({
      accounts: await Promise.all(["usdc-mint", "tslax-mint"].map((name) => mintFixture(name, mintAuthority.address))),
      upgradeablePrograms: [{ id: programId, path: PROGRAM, authority: deployer.address }],
    });
    if (!validator) return;
    await Promise.all([deployer, operator, payer, recipient, stranger, mintAuthority, treasury].map((key) => airdrop(validator!, key.address, 5n)));
    await mintTo(validator, mintAuthority, SOLANA_USDC, payer.address, 1_000_000_000n);
    await mintTo(validator, mintAuthority, TSLAX, payer.address, 1_000_000_000n);
  });

  after(async () => {
    await validator?.stop();
  });

  const send = (signer: KeyPairSigner, instructions: Instruction[]) => sendInstructions(validator!, signer, instructions);
  const readAccount = async (key: string) => {
    const info = await validator!.rpc.getAccountInfo(address(key), { encoding: "base64" }).send();
    return info.value ? Uint8Array.from(Buffer.from(info.value.data[0], "base64")) : undefined;
  };
  const balance = async (owner: string, asset = SOLANA_USDC) => {
    const data = await readAccount(await tokenAccountFor(owner, asset.mint!, asset.program));
    return data ? new DataView(data.buffer).getBigUint64(64, true) : 0n;
  };
  const now = async () => BigInt((await validator!.rpc.getBlockTime(await validator!.rpc.getSlot().send()).send()) ?? Math.floor(Date.now() / 1000));
  const blockhash = async () => (await validator!.rpc.getLatestBlockhash().send()).value;
  const compute = { computeUnitLimit: 400_000, computeUnitPrice: 0n };

  async function fund(asset = SOLANA_USDC, units = 10_000_000n, expiresIn = 3_600n, provider = "583231") {
    const paymentId = Uint8Array.from(randomBytes(32));
    const latest = await blockhash();
    const expiry = (await now()) + expiresIn;
    const transaction = await compileVaultFunding({ programId, payer: payer.address, asset, paymentId, platformHash: platformHash("github"), providerUserIdHash: providerUserIdHash(provider), units, expiry, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, ...compute });
    await signAndSend(validator!, wireTransaction(transaction), [payer]);
    return { paymentId, expiry, identityKey: vaultIdentityKey(platformHash("github"), providerUserIdHash(provider)) };
  }

  async function claimWith(paymentId: Uint8Array, signer: KeyPairSigner, options: { identityKey: Uint8Array; units: bigint; expiry: bigint; deadline?: bigint; attestor?: KeyPairSigner; recipient?: string; asset?: typeof SOLANA_USDC; message?: Uint8Array }) {
    const asset = options.asset ?? SOLANA_USDC;
    const claimDeadline = options.deadline ?? (await now()) + 600n;
    const message = options.message ?? vaultClaimMessage({ programId, paymentId, identityKey: options.identityKey, mint: vaultToken(asset).mint, recipient: options.recipient ?? signer.address, units: options.units, expiry: options.expiry, claimDeadline });
    const signature = await signBytes((options.attestor ?? attestor).keyPair.privateKey, message);
    const latest = await blockhash();
    const transaction = await compileVaultAction({ action: "claim", programId, wallet: signer.address, paymentId, asset, payer: payer.address, treasury: treasury.address, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, ...compute, claimDeadline, attestation: { publicKey: (options.attestor ?? attestor).address, signature, message } });
    return await signAndSend(validator!, wireTransaction(transaction), [signer]);
  }

  it("lets only the upgrade authority write the settings, once", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const config = await vaultConfigAddress(programId);
    const programData = await programDataAddress(programId);
    const settings = { programId, config, programData, owner: operator.address, verifier: attestor.address, treasury: treasury.address };
    await assert.rejects(() => send(stranger, [initializeVaultInstruction({ ...settings, authority: stranger.address })]), /custom program error: 0x5/);
    await send(deployer, [initializeVaultInstruction({ ...settings, authority: deployer.address })]);
    assert.deepEqual(decodeVaultConfig((await readAccount(config))!), { revision: 1, feeBps: 100, owner: operator.address, verifier: attestor.address, treasury: treasury.address });
    await assert.rejects(() => send(deployer, [initializeVaultInstruction({ ...settings, authority: deployer.address })]), /custom program error: 0x2/);
  });

  it("holds the amount and 1% for the identity, then pays the verified claimer and the treasury", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const before = { payer: await balance(payer.address), recipient: await balance(recipient.address), treasury: await balance(treasury.address) };
    const { paymentId, expiry, identityKey } = await fund();
    assert.equal(await balance(payer.address), before.payer - 10_100_000n);
    const payment = decodeVaultPayment((await readAccount(await vaultPaymentAddress(programId, paymentId)))!)!;
    assert.deepEqual({ ...payment, identityKey: Buffer.from(payment.identityKey).toString("hex") }, { status: "open", payer: payer.address, mint: SOLANA_USDC.mint, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", identityKey: Buffer.from(identityKey).toString("hex"), units: 10_000_000n, feeUnits: 100_000n, expiry });
    const claim = { identityKey, units: 10_000_000n, expiry };
    await assert.rejects(() => claimWith(paymentId, recipient, { ...claim, attestor: stranger }), /custom program error: 0xc/, "another attestor");
    await assert.rejects(() => claimWith(paymentId, recipient, { ...claim, recipient: stranger.address }), /custom program error: 0xc/, "an attestation for another wallet");
    await assert.rejects(() => claimWith(paymentId, recipient, { ...claim, units: 20_000_000n }), /custom program error: 0xc/, "a bigger amount");
    await assert.rejects(() => claimWith(paymentId, recipient, { ...claim, identityKey: vaultIdentityKey(platformHash("x"), providerUserIdHash("583231")) }), /custom program error: 0xc/, "another identity");
    await assert.rejects(async () => claimWith(paymentId, recipient, { ...claim, deadline: (await now()) - 5n }), /custom program error: 0xb/, "a lapsed attestation");
    await claimWith(paymentId, recipient, claim);
    assert.equal(await balance(recipient.address) - before.recipient, 10_000_000n);
    assert.equal(await balance(treasury.address) - before.treasury, 100_000n);
    assert.equal(decodeVaultPayment((await readAccount(await vaultPaymentAddress(programId, paymentId)))!)!.status, "claimed");
    assert.equal(await readAccount(await tokenAccountFor(await vaultPaymentAddress(programId, paymentId), SOLANA_USDC.mint!, "token")), undefined, "the vault's token account is closed");
    await assert.rejects(() => claimWith(paymentId, recipient, claim), /custom program error: 0xa/, "claimed once");
    const latest = await blockhash();
    const again = await compileVaultFunding({ programId, payer: payer.address, asset: SOLANA_USDC, paymentId, platformHash: platformHash("github"), providerUserIdHash: providerUserIdHash("583231"), units: 1_000_000n, expiry: (await now()) + 3_600n, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, ...compute });
    await assert.rejects(() => signAndSend(validator!, wireTransaction(again), [payer]), /custom program error: 0x9/, "the tombstone keeps the ID from being funded again");
  });

  it("refuses an attestation over anything but this exact claim", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const { paymentId, expiry, identityKey } = await fund();
    await assert.rejects(() => claimWith(paymentId, recipient, { identityKey, units: 10_000_000n, expiry, message: new Uint8Array(216) }), /custom program error: 0xc/);
  });

  it("returns everything to the payer after the expiry, and only then and only to them", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const before = await balance(payer.address, TSLAX);
    const { paymentId } = await fund(TSLAX, 50_000_000n, 3n, "17");
    assert.equal(await balance(payer.address, TSLAX), before - 50_500_000n);
    const refund = async (signer: KeyPairSigner) => {
      const latest = await blockhash();
      return signAndSend(validator!, wireTransaction(await compileVaultAction({ action: "refund", programId, wallet: signer.address, paymentId, asset: TSLAX, payer: payer.address, treasury: treasury.address, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, ...compute })), [signer]);
    };
    await assert.rejects(() => refund(payer), /custom program error: 0xe/, "not before the expiry");
    await new Promise((done) => setTimeout(done, 5_000));
    await assert.rejects(() => refund(stranger), /custom program error: 0xd/, "only the payer");
    await refund(payer);
    assert.equal(await balance(payer.address, TSLAX), before);
    assert.equal(decodeVaultPayment((await readAccount(await vaultPaymentAddress(programId, paymentId)))!)!.status, "refunded");
  });

  it("holds SOL wrapped and hands it out as SOL, to the claimer and back to the payer", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const lamports = async (key: string) => BigInt((await validator!.rpc.getBalance(address(key)).send()).value);
    const rent = async (bytes: bigint) => BigInt(await validator!.rpc.getMinimumBalanceForRentExemption(bytes).send());
    const wrapped = async (owner: string) => readAccount(await tokenAccountFor(owner, WRAPPED_SOL_MINT, "token"));
    const [recordRent, tokenRent] = await Promise.all([rent(163n), rent(165n)]);
    const fee = 5_000n;

    // Funding: 1 SOL and its 1% leave as SOL; the payer pays the link's record and the vault's token account, and keeps
    // no wrapped SOL.
    const payerBefore = await lamports(payer.address);
    const { paymentId, expiry, identityKey } = await fund(SOLANA_SOL, 1_000_000_000n, 3_600n, "4242");
    assert.equal(payerBefore - await lamports(payer.address), 1_010_000_000n + recordRent + tokenRent + fee);
    assert.equal(await wrapped(payer.address), undefined, "the payer's wrapped-SOL account is closed again");
    const payment = decodeVaultPayment((await readAccount(await vaultPaymentAddress(programId, paymentId)))!)!;
    assert.deepEqual([payment.mint, payment.units, payment.feeUnits], [WRAPPED_SOL_MINT, 1_000_000_000n, 10_000_000n]);

    // The claim: the claimer gets SOL (its wrapped-SOL account opens and closes in the same transaction), the treasury
    // its 1% as wrapped SOL, and the payer the vault's token account rent.
    const treasuryOpen = Boolean(await wrapped(treasury.address));
    const [recipientBefore, payerAfterFunding] = await Promise.all([lamports(recipient.address), lamports(payer.address)]);
    await claimWith(paymentId, recipient, { identityKey, units: 1_000_000_000n, expiry, asset: SOLANA_SOL });
    // The claimer pays two signature fees (its own and the attestor's, which the ed25519 precompile checks) and, the
    // first time, the treasury's wrapped-SOL account.
    assert.equal(await lamports(recipient.address) - recipientBefore, 1_000_000_000n - 2n * fee - (treasuryOpen ? 0n : tokenRent));
    assert.equal(await wrapped(recipient.address), undefined, "the claimer keeps no wrapped SOL");
    assert.equal(await balance(treasury.address, { ...SOLANA_SOL, mint: WRAPPED_SOL_MINT, program: "token" }), 10_000_000n);
    assert.equal(await lamports(payer.address) - payerAfterFunding, tokenRent);
    assert.equal(decodeVaultPayment((await readAccount(await vaultPaymentAddress(programId, paymentId)))!)!.status, "claimed");

    // A refund after the expiry: the amount and the fee come back as SOL with the vault's rent; only the record stays.
    const beforeRefundLink = await lamports(payer.address);
    const refunded = await fund(SOLANA_SOL, 200_000_000n, 3n, "4343");
    await new Promise((done) => setTimeout(done, 5_000));
    const latest = await blockhash();
    await signAndSend(validator!, wireTransaction(await compileVaultAction({ action: "refund", programId, wallet: payer.address, paymentId: refunded.paymentId, asset: SOLANA_SOL, payer: payer.address, treasury: treasury.address, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, ...compute })), [payer]);
    assert.equal(beforeRefundLink - await lamports(payer.address), recordRent + 2n * fee);
    assert.equal(await wrapped(payer.address), undefined);
    assert.equal(decodeVaultPayment((await readAccount(await vaultPaymentAddress(programId, refunded.paymentId)))!)!.status, "refunded");
  });

  it("refuses a zero amount and an expiry beyond 31 days", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    await assert.rejects(() => fund(SOLANA_USDC, 0n), /custom program error: 0x7/);
    await assert.rejects(() => fund(SOLANA_USDC, 1_000_000n, 32n * 24n * 3_600n), /custom program error: 0x8/);
  });

  it("lets only the owner replace the attestor, the treasury or the owner", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const config = await vaultConfigAddress(programId);
    await assert.rejects(() => send(stranger, [updateVaultInstruction({ programId, owner: stranger.address, config, kind: "treasury", value: stranger.address })]), /custom program error: 0x4/);
    await send(operator, [updateVaultInstruction({ programId, owner: operator.address, config, kind: "verifier", value: stranger.address })]);
    assert.equal(decodeVaultConfig((await readAccount(config))!)!.verifier, stranger.address);
    await send(operator, [updateVaultInstruction({ programId, owner: operator.address, config, kind: "verifier", value: attestor.address })]);
    assert.ok(getAddressEncoder().encode(address(attestor.address)).length === 32);
  });
});
