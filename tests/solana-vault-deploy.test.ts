import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import {
  DEPLOY_COMPUTE_UNITS,
  codeMatches,
  compileClose,
  compileFundDeployer,
  deploymentChunks,
  deploymentCost,
  deploymentKeys,
  readDeployedProgram,
  recoverVaultDeployment,
  runVaultDeployment,
  type DeploymentProgress,
} from "../src/domain/solana-program-deploy";
import { initializeVaultInstruction, programDataAddress, vaultConfigAddress, wireTransaction } from "../src/domain/solana-vault";
import { SOLANA_VAULT_ARTIFACT } from "../src/domain/solana-vault-artifact";
import { checkSolanaToolchain } from "../scripts/build-solana-vault";
import { airdrop, sendInstructions, signAndSend, startLocalValidator, type LocalValidator } from "./fixtures/solana-validator";

const PROGRAM = new URL("../public/solana/hapapay_vault.so", import.meta.url);
const quick = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, Math.min(milliseconds, 50)));

/**
 * The operator page's deployment, run against a fresh local validator: the operator's wallet funds a temporary key in
 * one transfer; the key writes the build, deploys it, writes the settings and hands the upgrade authority to the
 * operator in one transaction, then sends what it has left back. An interrupted deployment resumes from its seed, one
 * that is abandoned gives its SOL back, and the operator can close a finished program to get its code's rent back.
 */
describe("deploying the Solana vault program from the operator page", { timeout: 600_000 }, () => {
  let validator: LocalValidator | undefined;
  let operator: KeyPairSigner;
  let attestor: KeyPairSigner;
  let treasury: KeyPairSigner;
  let build: Uint8Array;
  let finished: { programId: string; returnable: bigint } | undefined;

  before(async () => {
    [operator, attestor, treasury] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    build = new Uint8Array(await readFile(PROGRAM));
    validator = await startLocalValidator();
    if (validator) await airdrop(validator, operator.address, 10n);
  });

  after(async () => {
    await validator?.stop();
  });

  const balance = async (key: string) => (await validator!.rpc.getBalance(address(key), { commitment: "confirmed" }).send()).value;
  async function fund(deployer: string, lamports: bigint) {
    const { value: latest } = await validator!.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    await signAndSend(validator!, wireTransaction(compileFundDeployer({ ...latest, operator: operator.address, deployer, lamports })), [operator]);
  }

  it("ships the pinned build", () => {
    assert.equal(build.length, SOLANA_VAULT_ARTIFACT.size);
    assert.equal(createHash("sha256").update(build).digest("hex"), SOLANA_VAULT_ARTIFACT.sha256);
  });

  it("builds only with the toolchain the pin was made with", () => {
    assert.doesNotThrow(() => checkSolanaToolchain("cargo-build-sbf 4.4.0\nplatform-tools v1.57\nrustc 1.95.0\n"));
    for (const other of ["cargo-build-sbf 4.5.0\nplatform-tools v1.57\n", "cargo-build-sbf 4.4.0\nplatform-tools v1.58\n", ""]) {
      assert.throws(() => checkSolanaToolchain(other), /pinned vault build needs cargo-build-sbf 4\.4\.0 with platform-tools v1\.57/);
    }
  });

  it("deploys the program with the server's settings and the operator as its upgrade authority from one funding transfer, resuming after an interruption", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const rpc = validator.rpc;
    const seed = Uint8Array.from(randomBytes(32));
    const keys = await deploymentKeys(seed);
    const cost = await deploymentCost(rpc, build.length);
    assert.equal(cost.transactions, deploymentChunks(build.length).length + 5);
    const operatorBefore = await balance(operator.address);
    await fund(keys.deployer.address, cost.fund);
    const settings = { owner: operator.address, verifier: attestor.address, treasury: treasury.address, returnTo: operator.address };

    // The tab closes after the first writes land.
    let writes = 0;
    await assert.rejects(() => runVaultDeployment({ rpc, keys, program: build, ...settings, sleep: quick, pollMilliseconds: 200, onProgress: (progress: DeploymentProgress) => {
      if (progress.stage === "write" && ++writes > 20) throw new Error("closed");
    } }), /closed/);
    assert.equal(await readDeployedProgram(rpc, keys.program.address), undefined, "nothing is deployed yet");

    const stages = new Set<string>();
    const resumed = await deploymentKeys(seed);
    assert.equal(resumed.program.address, keys.program.address, "the same seed gives the same program ID");
    const result = await runVaultDeployment({ rpc, keys: resumed, program: build, ...settings, sleep: quick, pollMilliseconds: 200, onProgress: (progress) => stages.add(progress.stage) });
    assert.equal(result.programId, keys.program.address);
    assert.deepEqual([...stages], ["write", "deploy", "finalize", "return"], "the buffer is reused and only missing chunks are written");

    const deployed = (await readDeployedProgram(rpc, result.programId))!;
    assert.equal(deployed.authority, operator.address, "only the operator's wallet can upgrade or close it");
    assert.ok(codeMatches(deployed.code, build));
    assert.equal(deployed.programData, await programDataAddress(result.programId));
    assert.deepEqual(deployed.config, { revision: 1, feeBps: 100, owner: operator.address, verifier: attestor.address, treasury: treasury.address });
    assert.equal(await balance(keys.deployer.address), 0n, "the deployment key is left empty");
    assert.equal(await balance(keys.buffer.address), 0n, "the buffer's rent went into the code account");
    const spent = operatorBefore - await balance(operator.address);
    assert.ok(spent <= cost.permanent + 50_000n, `the operator paid ${spent}, about the estimate of ${cost.permanent}`);

    // The settings can never be written again, not even by the key that deployed it.
    await airdrop(validator, keys.deployer.address, 1n);
    const config = await vaultConfigAddress(result.programId);
    await assert.rejects(() => sendInstructions(validator!, keys.deployer, [initializeVaultInstruction({ programId: result.programId, authority: keys.deployer.address, config, programData: deployed.programData, owner: keys.deployer.address, verifier: keys.deployer.address, treasury: keys.deployer.address })]), /custom program error: 0x(2|5)/);

    // Every kind of transaction asked for enough compute, with room to spare.
    const signatures = await rpc.getSignaturesForAddress(address(keys.deployer.address), { limit: 1000, commitment: "confirmed" }).send();
    const used = await Promise.all(signatures.map(async (entry) => {
      const transaction = await rpc.getTransaction(entry.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" }).send();
      return Number(transaction?.meta?.computeUnitsConsumed ?? 0);
    }));
    const chunkWrites = used.filter((units) => units === used[Math.floor(used.length / 2)]);
    assert.ok(chunkWrites.length >= deploymentChunks(build.length).length && chunkWrites[0] * 1.5 <= DEPLOY_COMPUTE_UNITS.write, `a write used ${chunkWrites[0]} compute units`);
    assert.ok(Math.max(...used) * 1.5 <= DEPLOY_COMPUTE_UNITS.finalize, `the largest transaction used ${Math.max(...used)} compute units`);
    finished = { programId: result.programId, returnable: cost.returnable };
  });

  it("lets only the operator close the finished program, and returns its code's rent to the operator", async (t) => {
    if (!validator || !finished) return t.skip("solana-test-validator is not installed");
    const rpc = validator.rpc;
    const { programId, returnable } = finished;
    const deployed = (await readDeployedProgram(rpc, programId))!;
    const held = await balance(deployed.programData);
    assert.equal(held, returnable, "the code account holds the rent the estimate names");
    const close = async (signer: KeyPairSigner) => {
      const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      return signAndSend(validator!, wireTransaction(compileClose({ ...latest, authority: signer.address, account: deployed.programData, recipient: signer.address, program: programId })), [signer]);
    };
    const stranger = await generateKeyPairSigner();
    await airdrop(validator, stranger.address, 1n);
    await assert.rejects(() => close(stranger), /custom program error|IncorrectAuthority|Error/i, "another key cannot close it");
    assert.ok((await readDeployedProgram(rpc, programId))?.code, "the program is still there");

    const before = await balance(operator.address);
    await close(operator);
    const after = await balance(operator.address);
    assert.equal(after - before, held - 5_000n, "the code's rent came back to the operator, less the fee");
    assert.equal((await readDeployedProgram(rpc, programId))?.code, undefined, "nothing runs at the address any more");
  });

  it("gives an abandoned deployment's SOL back, buffer included", async (t) => {
    if (!validator) return t.skip("solana-test-validator is not installed");
    const rpc = validator.rpc;
    const keys = await deploymentKeys(Uint8Array.from(randomBytes(32)));
    const cost = await deploymentCost(rpc, build.length);
    const operatorBefore = await balance(operator.address);
    await fund(keys.deployer.address, cost.fund);
    let writes = 0;
    await assert.rejects(() => runVaultDeployment({ rpc, keys, program: build, owner: operator.address, verifier: attestor.address, treasury: treasury.address, returnTo: operator.address, sleep: quick, pollMilliseconds: 200, onProgress: (progress) => {
      if (progress.stage === "write" && ++writes > 5) throw new Error("closed");
    } }), /closed/);
    assert.ok(await balance(keys.buffer.address) > 0n, "the buffer holds rent");
    const returned = await recoverVaultDeployment({ rpc, keys, returnTo: operator.address, sleep: quick, pollMilliseconds: 200 });
    assert.ok(returned > 0n);
    assert.equal(await balance(keys.buffer.address), 0n);
    assert.equal(await balance(keys.deployer.address), 0n);
    const spent = operatorBefore - await balance(operator.address);
    assert.ok(spent < 200_000n, `only fees are lost: ${spent} lamports`);
  });
});
