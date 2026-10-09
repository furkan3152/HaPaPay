import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { AccountRole, address, generateKeyPairSigner, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { getAddress } from "viem";
import { NO_SOL_SENDING, SOLANA_SOL, SOLANA_USDC, type SolanaAssetListing } from "../src/domain/solana-assets";
import { compileClose, compileFundDeployer, deploymentCost, deploymentKeys, readDeployedProgram, runVaultDeployment } from "../src/domain/solana-program-deploy";
import { solanaAssetByName } from "../src/domain/solana-stocks";
import { matchesVaultAction, matchesVaultFunding, programDataAddress, SOLANA_VAULT_CLOSE_WAIT_SECONDS, tokenAccountFor, UPGRADEABLE_LOADER_ADDRESS, wireTransaction } from "../src/domain/solana-vault";
import { readSolanaAttestorKey, readSolanaConfig, solanaRpc } from "../server/solana-network";
import { MemorySolanaTransferRepository, SolanaTransactionExpiredError, SolanaTransferError, SolanaTransferService, SolanaUnavailableError } from "../server/solana-transfer-service";
import { MemorySolanaVaultRepository, SolanaVaultOperatorError, SolanaVaultService } from "../server/solana-vault-service";
import { RecipientLookupUnavailableError } from "../server/recipient-discovery";
import { VaultNameLockOffer } from "../server/vault-recipient";
import { airdrop, mintFixture, mintTo, sendInstructions, signAndSend, startLocalValidator, type LocalValidator } from "./fixtures/solana-validator";

const TSLAX = solanaAssetByName("TSLAx")!;
const quick = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, Math.min(milliseconds, 50)));
const payerWallet = getAddress("0x00000000000000000000000000000000000000a1");
const alice = { platform: "github" as const, providerUserId: "583231", username: "alice", verifiedAt: "2026-10-04T12:00:00.000Z" };

/**
 * The server's side of Solana vault links on a local validator with the mainnet USDC and TSLAx mints: the operator's
 * program deployed from the operator page's code, registered only after the server reads it back, then a link funded
 * from a prepared transaction the browser accepts, recorded from chain, listed for both sides and claimed with the
 * attestor's signature; SOL the same way, held wrapped and claimed as SOL.
 */
describe("Solana vault links through the server", { timeout: 600_000 }, () => {
  let validator: LocalValidator | undefined;
  let operator: KeyPairSigner;
  let treasury: KeyPairSigner;
  let payer: KeyPairSigner;
  let recipient: KeyPairSigner;
  let mintAuthority: KeyPairSigner;
  let programId: string;
  let vault: SolanaVaultService;
  let vaultRecords: MemorySolanaVaultRepository;
  let later: SolanaVaultService;
  let afterWindow: SolanaVaultService;
  let attestorPublicKey: string;
  /** The same server, while X refuses its lookups. */
  let xRefusing: SolanaVaultService;

  before(async () => {
    [operator, treasury, payer, recipient, mintAuthority] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()));
    validator = await startLocalValidator({ accounts: await Promise.all(["usdc-mint", "tslax-mint"].map((name) => mintFixture(name, mintAuthority.address))) });
    if (!validator) return;
    await Promise.all([operator, payer, recipient, mintAuthority, treasury].map((key) => airdrop(validator!, key.address, 5n)));
    await mintTo(validator, mintAuthority, SOLANA_USDC, payer.address, 1_000_000_000n);
    await mintTo(validator, mintAuthority, TSLAX, payer.address, 1_000_000_000n);
    // The treasury already holds a USDC account, as it does after its first fee.
    await mintTo(validator, mintAuthority, SOLANA_USDC, treasury.address, 0n);

    const attestorSecret = getBase58Decoder().decode(Uint8Array.from(randomBytes(32)));
    attestorPublicKey = readSolanaAttestorKey(attestorSecret)!.publicKey;
    const config = readSolanaConfig({
      SOLANA_RPC_URL: "https://localhost.invalid/",
      SOLANA_TREASURY_ADDRESS: treasury.address,
      SOLANA_OPERATOR_ADDRESS: operator.address,
      SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY: attestorSecret,
      SOLANA_STOCK_TRANSFERS: "enabled",
    });
    const rpc = solanaRpc(validator.rpcUrl, validator.rpcUrl);
    const transfers = new SolanaTransferService({ config, rpc, repository: new MemorySolanaTransferRepository(), confirmRetryMs: 300, genesisHash: await rpc.getGenesisHash().send() });
    const directory = {
      lookup: async (platform: string, username: string) => ({ platform: platform as "github", providerUserId: username === "alice" ? alice.providerUserId : "17", username }),
      supports: () => true,
    };
    const repository = new MemorySolanaVaultRepository();
    vaultRecords = repository;
    vault = new SolanaVaultService({ config, rpc, repository, transfers, directory, confirmRetryMs: 300, cacheMs: 0 });
    // The same server a little later, once new links have been stopped longer than a prepared funding can still land.
    later = new SolanaVaultService({ config, rpc, repository, transfers, directory, confirmRetryMs: 300, cacheMs: 0, now: () => new Date(Date.now() + (SOLANA_VAULT_CLOSE_WAIT_SECONDS + 5) * 1000) });
    // The same server a day later, once a 24-hour window has closed.
    afterWindow = new SolanaVaultService({ config, rpc, repository, transfers, directory, confirmRetryMs: 300, cacheMs: 0, now: () => new Date(Date.now() + 25 * 60 * 60 * 1000) });
    xRefusing = new SolanaVaultService({ config, rpc, repository, transfers, directory: { lookup: async () => { throw new RecipientLookupUnavailableError("X is not answering."); }, supports: () => true }, confirmRetryMs: 300, cacheMs: 0 });

    // The operator page's deployment, with this server's operator, attestor and treasury.
    const build = new Uint8Array(await readFile(new URL("../public/solana/hapapay_vault.so", import.meta.url)));
    const keys = await deploymentKeys(Uint8Array.from(randomBytes(32)));
    const cost = await deploymentCost(validator.rpc, build.length);
    const { value: latest } = await validator.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    await signAndSend(validator, wireTransaction(compileFundDeployer({ ...latest, operator: operator.address, deployer: keys.deployer.address, lamports: cost.fund })), [operator]);
    programId = (await runVaultDeployment({ rpc: validator.rpc, keys, program: build, owner: operator.address, verifier: attestorPublicKey, treasury: treasury.address, returnTo: operator.address, sleep: quick, pollMilliseconds: 200 })).programId;
  });

  after(async () => {
    await validator?.stop();
  });

  const balance = async (owner: string, asset: SolanaAssetListing) => {
    const account = await tokenAccountFor(owner, asset.mint!, asset.program);
    const info = await validator!.rpc.getAccountInfo(account, { encoding: "base64" }).send();
    return info.value ? BigInt((await validator!.rpc.getTokenAccountBalance(account).send()).value.amount) : 0n;
  };

  it("registers the program only for the operator and only after reading it back", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    assert.deepEqual(await vault.availability(), { enabled: false, reason: "The Solana vault program is not deployed yet." });
    await assert.rejects(() => vault.register({ programId, operatorAddress: payer.address }), (error) => error instanceof SolanaVaultOperatorError);
    await assert.rejects(() => vault.register({ programId: payer.address, operatorAddress: operator.address }), /No upgradeable-loader program/);
    const status = await vault.register({ programId, operatorAddress: operator.address });
    assert.equal(status.enabled, true);
    assert.equal(status.program?.id, programId);
    assert.deepEqual([status.operator, status.verifier, status.treasury, status.setup], [operator.address, attestorPublicKey, treasury.address, []]);
  });

  it("funds a USDC link the browser accepts, records it from chain, lists it for both sides and pays the verified claimer", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const prepared = await vault.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "10", platform: "github", username: "alice", expiryHours: 48 });
    assert.equal(prepared.programId, programId);
    assert.deepEqual([prepared.units, prepared.feeUnits, prepared.recipient.username], ["10000000", "100000", "alice"]);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    assert.equal(await matchesVaultFunding(prepared, { programId, payer: payer.address, asset: SOLANA_USDC, platform: "github", units: 10_000_000n, nowSeconds }), true, "the browser rebuilds the same bytes");
    assert.equal(await matchesVaultFunding(prepared, { programId, payer: payer.address, asset: SOLANA_USDC, platform: "github", units: 20_000_000n, nowSeconds }), false, "and refuses another amount");
    assert.equal(await matchesVaultFunding(prepared, { programId, payer: payer.address, asset: SOLANA_USDC, platform: "x", units: 10_000_000n, nowSeconds }), false, "or another platform");

    const before = { payer: await balance(payer.address, SOLANA_USDC), recipient: await balance(recipient.address, SOLANA_USDC), treasury: await balance(treasury.address, SOLANA_USDC) };
    const signature = await signAndSend(validator!, prepared.transaction, [payer]);
    const confirm = { signature, paymentId: prepared.paymentId, programId, payerWallet, payerAddress: payer.address, asset: SOLANA_USDC, amount: "10", platform: "github" as const, username: "alice" };
    await assert.rejects(() => vault.confirmFunding({ ...confirm, units: "20000000" }), /does not hold the reviewed link/);
    await assert.rejects(() => vault.confirmFunding({ ...confirm, units: "0" }), /more than zero/);
    // Audit, 2026-10-06: the link records the amount its units hold, not the amount text the browser sends with them.
    const recorded = await vault.confirmFunding({ ...confirm, amount: "100000", units: prepared.units });
    assert.equal(recorded.claimPath, `/claim/solana/${prepared.paymentId}`);
    assert.equal((await vaultRecords.claim(prepared.paymentId))?.amount, "10");
    assert.equal(await balance(payer.address, SOLANA_USDC), before.payer - 10_100_000n);

    const sent = await vault.pending({ wallet: payerWallet, solanaAddress: payer.address, accounts: [] });
    assert.deepEqual(sent.outgoing.map((link) => [link.status, link.amount, link.token.symbol, link.recipient.username]), [["waiting", "10", "USDC", "alice"]]);
    const waiting = await vault.pending({ wallet: getAddress("0x00000000000000000000000000000000000000b2"), solanaAddress: recipient.address, accounts: [alice] });
    assert.deepEqual(waiting.incoming.map((link) => [link.status, link.amount, link.escrow]), [["claimable", "10", programId]]);
    const open = await vault.details(prepared.paymentId);
    assert.deepEqual([open.status, open.recipient?.username], ["claimable", "alice"], "an open link names the account it waits for");

    await assert.rejects(() => vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [{ ...alice, providerUserId: "999" }] }), /None of your verified accounts/);
    await assert.rejects(() => vault.prepareRefund({ paymentId: prepared.paymentId, wallet: payer.address }), /after the claim window closes/);
    await assert.rejects(() => vault.prepareRefund({ paymentId: prepared.paymentId, wallet: recipient.address }), /Only the Solana address that funded/);

    const claim = await vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [alice] });
    const review = { programId, wallet: recipient.address, paymentId: prepared.paymentId, asset: SOLANA_USDC, payer: payer.address, treasury: treasury.address, action: "claim" as const };
    assert.equal(await matchesVaultAction(claim, review), true, "the browser rebuilds the same claim");
    assert.equal(await matchesVaultAction(claim, { ...review, wallet: payer.address }), false, "for this wallet only");
    await signAndSend(validator!, claim.transaction, [recipient]);
    assert.equal(await balance(recipient.address, SOLANA_USDC) - before.recipient, 10_000_000n);
    assert.equal(await balance(treasury.address, SOLANA_USDC) - before.treasury, 100_000n);
    const settled = await vault.details(prepared.paymentId);
    assert.equal(settled.status, "settled");
    assert.equal(settled.recipient, undefined, "a settled link names nobody");
    assert.equal(settled.sourceIdentity, undefined);
    assert.deepEqual((await vault.pending({ wallet: payerWallet, solanaAddress: payer.address, accounts: [] })).outgoing, []);
    await assert.rejects(() => vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [alice] }), /already claimed or refunded/);
  });

  it("lets a link wait for a Discord name: whoever connects Discord with it claims, never a newer account", async (t) => {
    // Money sent to someone who has not joined can be claimed once they connect that platform.
    if (!validator) return t.skip("solana-test-validator is not installed");
    const prepared = await vault.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "3", platform: "discord", username: "@New.Friend", expiryHours: 48 });
    assert.deepEqual([prepared.lock, prepared.recipient.platform, prepared.recipient.username], ["name", "discord", "new.friend"]);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    assert.equal(await matchesVaultFunding(prepared, { programId, payer: payer.address, asset: SOLANA_USDC, platform: "discord", units: 3_000_000n, nowSeconds }), true, "the browser rebuilds the same bytes");
    await assert.rejects(() => vault.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "3", platform: "telegram", username: "bob", expiryHours: 48 }), /Invalid Telegram username/, "a name the platform cannot have gets no link");
    const signature = await signAndSend(validator!, prepared.transaction, [payer]);
    const recorded = await vault.confirmFunding({ signature, paymentId: prepared.paymentId, programId, payerWallet, payerAddress: payer.address, asset: SOLANA_USDC, amount: "3", units: prepared.units, platform: "discord", username: "new.friend", lock: "name" });
    assert.equal(recorded.claimPath, `/claim/solana/${prepared.paymentId}`);
    const page = await vault.details(prepared.paymentId);
    assert.deepEqual([page.status, page.lock, page.recipient?.platform, page.recipient?.username], ["claimable", "name", "discord", "new.friend"]);

    // Discord IDs carry when the account was made: one made a year ago, and one made after the link.
    const snowflake = (madeAt: number) => String((BigInt(madeAt) - 1_420_070_400_000n) << 22n);
    const holder = { platform: "discord" as const, providerUserId: snowflake(Date.now() - 365 * 86_400_000), username: "new.friend", verifiedAt: new Date().toISOString() };
    const newer = { ...holder, providerUserId: snowflake(Date.now() + 60_000) };
    const other = { ...holder, username: "someone.else" };
    // The name as Discord said it at a sign-in before the link: its holder may have renamed since.
    const stale = { ...holder, verifiedAt: new Date(Date.now() - 86_400_000).toISOString() };
    const wallet = getAddress("0x00000000000000000000000000000000000000c3");
    assert.deepEqual((await vault.pending({ wallet, solanaAddress: recipient.address, accounts: [holder] })).incoming.map((link) => [link.paymentId, link.recipient.username]), [[prepared.paymentId, "new.friend"]], "it waits under Claims once Discord is connected with that name");
    assert.deepEqual((await vault.pending({ wallet, solanaAddress: recipient.address, accounts: [newer] })).incoming, [], "an account made after the link does not see it");
    assert.deepEqual((await vault.pending({ wallet, solanaAddress: recipient.address, accounts: [other] })).incoming, []);
    assert.deepEqual((await vault.pending({ wallet, solanaAddress: recipient.address, accounts: [stale] })).incoming, [], "a name Discord confirmed before the link does not see it");
    await assert.rejects(() => vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [stale] }), /waits for the Discord name @new\.friend\. Connect Discord to HaPaPay with the account that has that name now \(connect it again if it is connected already\)/);
    await assert.rejects(() => vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [newer] }), /waits for the Discord name @new\.friend.*an account made after the link cannot claim it/);
    await assert.rejects(() => vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [other] }), /waits for the Discord name @new\.friend/);
    await assert.rejects(() => vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [{ ...holder, platform: "x" as never }] }), /waits for the Discord name/, "the same name on another platform is not it");

    const before = await balance(recipient.address, SOLANA_USDC);
    const claim = await vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [holder] });
    await signAndSend(validator!, claim.transaction, [recipient]);
    assert.equal(await balance(recipient.address, SOLANA_USDC) - before, 3_000_000n);
    const settled = await vault.settlement({ programId, paymentId: prepared.paymentId }, { candidates: [{ wallet, accounts: [holder] }] });
    assert.deepEqual(settled, { state: "claimed", claimer: wallet }, "SP finds who claimed a link that waited for a name");
  });

  it("locks an X link to the name only when the sender agreed to it", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const refusing = xRefusing;
    await assert.rejects(() => refusing.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "1", platform: "x", username: "jack", expiryHours: 48 }), (error) => error instanceof VaultNameLockOffer && /lock it to the X name @jack instead/.test(error.message));
    const named = await refusing.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "1", platform: "x", username: "jack", expiryHours: 48, lock: "name" });
    assert.deepEqual([named.lock, named.recipient.username], ["name", "jack"]);
  });

  it("prepares no SOL link: HaPaPay sends stablecoins and stocks", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    // HaPaPay sends no SOL. The program still holds any SPL token, so its own tests keep wrapped SOL.
    await assert.rejects(
      () => vault.prepare({ payer: payer.address, asset: SOLANA_SOL, amount: "0.25", platform: "github", username: "alice", expiryHours: 48 }),
      (error) => error instanceof SolanaTransferError && error.message === NO_SOL_SENDING,
    );
  });

  it("needs the eligibility statement to claim an xStock", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    await assert.rejects(() => vault.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "1", platform: "github", username: "alice", expiryHours: 2 }), /between 24 hours and 30 days/);
    const prepared = await vault.prepare({ payer: payer.address, asset: TSLAX, amount: "0.5", platform: "github", username: "alice", expiryHours: 24 });
    const signature = await signAndSend(validator!, prepared.transaction, [payer]);
    await vault.confirmFunding({ signature, paymentId: prepared.paymentId, programId, payerWallet, payerAddress: payer.address, asset: TSLAX, amount: "0.5", units: prepared.units, platform: "github", username: "alice" });
    const waiting = await vault.pending({ wallet: getAddress("0x00000000000000000000000000000000000000b2"), solanaAddress: recipient.address, accounts: [alice] });
    assert.equal(waiting.incoming.find((link) => link.paymentId === prepared.paymentId)?.statementRequired, true);
    await assert.rejects(() => vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [alice] }), /Confirm that you may hold xStocks/);
    const claim = await vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [alice], eligibilityConfirmed: true });
    await signAndSend(validator!, claim.transaction, [recipient]);
    assert.equal(await balance(recipient.address, TSLAX), BigInt(prepared.units));
  });

  it("records a link whose window closed before its record arrived, for its payer to take back, and says when a funding never landed", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const prepared = await vault.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "1", platform: "github", username: "alice", expiryHours: 24 });
    const signature = await signAndSend(validator!, prepared.transaction, [payer]);
    const confirm = { signature, paymentId: prepared.paymentId, programId, payerWallet, payerAddress: payer.address, asset: SOLANA_USDC, amount: "1", units: prepared.units, platform: "github" as const, username: "alice" };
    // Audit, 2026-10-06: a record that reached the server only after the window (a tab closed first) was refused, and
    // the link reached no Claims list. A day later it is recorded and listed to its payer to take back.
    await afterWindow.confirmFunding(confirm);
    const sent = await afterWindow.pending({ wallet: payerWallet, solanaAddress: payer.address, accounts: [] });
    assert.deepEqual(sent.outgoing.filter((link) => link.paymentId === prepared.paymentId).map((link) => link.status), ["refundable"]);
    const offered = await afterWindow.pending({ wallet: getAddress("0x00000000000000000000000000000000000000b2"), solanaAddress: recipient.address, accounts: [alice] });
    assert.equal(offered.incoming.some((link) => link.paymentId === prepared.paymentId), false, "and never offered to its recipient");

    // A funding that never reached Solana is said to have expired once its last valid block is final, not before.
    const never = getBase58Decoder().decode(Uint8Array.from(randomBytes(64)));
    await assert.rejects(() => vault.confirmFunding({ ...confirm, signature: never, lastValidBlockHeight: 0n }), (error) => error instanceof SolanaTransactionExpiredError);
    await assert.rejects(() => vault.confirmFunding({ ...confirm, signature: never, lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight) + 1_000_000n }), /not confirmed this transaction yet/);

    // In real time its window is open, so it is claimed and the vault holds nothing more for the tests below.
    const claim = await vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [alice] });
    await signAndSend(validator!, claim.transaction, [recipient]);
  });

  it("accepts the program only while the operator's wallet holds its upgrade key", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const programData = await programDataAddress(programId);
    const handOver = (from: KeyPairSigner, to: string) => sendInstructions(validator!, from, [{
      programAddress: address(UPGRADEABLE_LOADER_ADDRESS),
      accounts: [{ address: address(programData), role: AccountRole.WRITABLE }, { address: from.address, role: AccountRole.READONLY_SIGNER }, { address: address(to), role: AccountRole.READONLY }],
      data: Uint8Array.of(4, 0, 0, 0),
    }]);
    const stranger = await generateKeyPairSigner();
    await airdrop(validator, stranger.address, 1n);
    await handOver(operator, stranger.address);
    await assert.rejects(() => vault.register({ programId, operatorAddress: operator.address }), /upgrade authority is not the operator/);
    assert.match((await vault.availability()).reason ?? "", /upgrade authority is not the operator/, "new links stop at once");
    await assert.rejects(() => vault.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "1", platform: "github", username: "alice", expiryHours: 48 }), (error) => error instanceof SolanaUnavailableError);
    await handOver(stranger, operator.address);
    assert.equal((await vault.register({ programId, operatorAddress: operator.address })).enabled, true);
  });

  it("stops new links, keeps sent ones claimable, and lets the operator close the program once it holds none", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const prepared = await vault.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "2", platform: "github", username: "alice", expiryHours: 48 });
    const signature = await signAndSend(validator!, prepared.transaction, [payer]);
    await vault.confirmFunding({ signature, paymentId: prepared.paymentId, programId, payerWallet, payerAddress: payer.address, asset: SOLANA_USDC, amount: "2", units: prepared.units, platform: "github", username: "alice" });

    await assert.rejects(() => vault.retire({ operatorAddress: payer.address }), (error) => error instanceof SolanaVaultOperatorError);
    const stopped = await vault.retire({ operatorAddress: operator.address });
    assert.equal(stopped.enabled, false);
    assert.match(stopped.reason ?? "", /New vault links are stopped/);
    assert.ok(stopped.program?.retiredAt);
    assert.deepEqual([stopped.program?.close?.openLinks, stopped.program?.close?.ready], [1, false], "the link it holds is counted from chain");
    await assert.rejects(() => vault.prepare({ payer: payer.address, asset: SOLANA_USDC, amount: "1", platform: "github", username: "alice", expiryHours: 48 }), /New vault links are stopped/);

    // Opening new links again and stopping them once more works the same way.
    assert.equal((await vault.register({ programId, operatorAddress: operator.address })).enabled, true);
    await vault.retire({ operatorAddress: operator.address });

    // The link sent before the stop is still claimed as usual.
    const claim = await vault.prepareClaim({ paymentId: prepared.paymentId, wallet: recipient.address, accounts: [alice] });
    await signAndSend(validator!, claim.transaction, [recipient]);
    const empty = await vault.status();
    assert.deepEqual([empty.program?.close?.openLinks, empty.program?.close?.ready], [0, false], "closing waits until nothing prepared before the stop can land");
    const ready = await later.status();
    assert.deepEqual([ready.program?.close?.openLinks, ready.program?.close?.ready], [0, true]);

    const deployed = (await readDeployedProgram(validator.rpc, programId))!;
    const { value: latest } = await validator.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    await signAndSend(validator, wireTransaction(compileClose({ ...latest, authority: operator.address, account: deployed.programData, recipient: operator.address, program: programId })), [operator]);
    const closed = await later.status();
    assert.equal(closed.program?.closed, true);
    assert.equal(closed.enabled, false);
    assert.match(closed.reason ?? "", /vault program is closed/);
    await assert.rejects(() => vault.register({ programId, operatorAddress: operator.address }), /No upgradeable-loader program/);
  });
});
