import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getAddressEncoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintToCheckedInstruction } from "@solana-program/token";
import { getMintToCheckedInstruction as getMintToChecked2022Instruction } from "@solana-program/token-2022";
import { resolveSolanaBinary } from "../../scripts/solana-binary";
import { SOLANA_TOKEN_PROGRAM_ADDRESSES, type SolanaAssetListing } from "../../src/domain/solana-assets";

/** Polls of 200 ms before a transaction counts as lost: generous, since the full suite runs several validators at once. */
const CONFIRM_ATTEMPTS = 600;

export type MintFixture = { pubkey: string; account: { lamports: number; data: [string, "base64"]; owner: string; executable: boolean; rentEpoch: number; space: number } };

/** A mainnet mint saved under tests/fixtures/solana, with its mint authority replaced so a test can mint it locally. */
export async function mintFixture(name: string, authority: string): Promise<MintFixture> {
  const fixture = JSON.parse(await readFile(new URL(`./solana/${name}.json`, import.meta.url), "utf8")) as MintFixture;
  const data = Buffer.from(fixture.account.data[0], "base64");
  // A mint starts with its authority as COption<Pubkey>: a 4-byte tag (1 = Some) and the key.
  data.writeUInt32LE(1, 0);
  Buffer.from(getAddressEncoder().encode(address(authority))).copy(data, 4);
  return { ...fixture, account: { ...fixture.account, data: [data.toString("base64"), "base64"], rentEpoch: 0 } };
}

export type LocalValidator = {
  rpcUrl: string;
  rpc: Rpc<SolanaRpcApi>;
  stop(): Promise<void>;
};

/**
 * A throwaway local Solana cluster (solana-test-validator) with the given accounts preloaded at their mainnet
 * addresses and optional programs. Undefined when the tool is not installed, so the caller can skip.
 */
export async function startLocalValidator(options: { accounts?: MintFixture[]; programs?: Array<{ id: string; path: string }>; upgradeablePrograms?: Array<{ id: string; path: string; authority: string }> } = {}): Promise<LocalValidator | undefined> {
  const binary = resolveSolanaBinary("solana-test-validator");
  if (!binary) return undefined;
  const directory = await mkdtemp(join(tmpdir(), "hapapay-solana-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const args = ["--reset", "--quiet", "--ledger", join(directory, "ledger"), "--rpc-port", String(port), "--faucet-port", String(port + 10), "--gossip-port", String(port + 11), "--dynamic-port-range", `${port + 12}-${port + 40}`, "--bind-address", "127.0.0.1"];
  for (const [index, account] of (options.accounts ?? []).entries()) {
    const file = join(directory, `account-${index}.json`);
    await writeFile(file, JSON.stringify(account));
    args.push("--account", account.pubkey, file);
  }
  for (const program of options.programs ?? []) args.push("--bpf-program", program.id, program.path);
  for (const program of options.upgradeablePrograms ?? []) args.push("--upgradeable-program", program.id, program.path, program.authority);
  const child: ChildProcess = spawn(binary, args, { stdio: "ignore", cwd: directory });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const rpc = createSolanaRpc(rpcUrl) as Rpc<SolanaRpcApi>;
  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((done) => setTimeout(done, 300));
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 480; attempt++) {
    try {
      if ((await rpc.getHealth().send()) === "ok" && (await rpc.getSlot().send()) > 0n) return { rpcUrl, rpc, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  await stop();
  throw new Error("The local Solana validator did not start.");
}

/** Signs and sends instructions from `payer`, waiting until the transaction is confirmed. */
export async function sendInstructions(validator: LocalValidator, payer: KeyPairSigner, instructions: Instruction[]) {
  const { value: blockhash } = await validator.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(payer, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(blockhash, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return await sendSigned(validator, getBase64EncodedWireTransaction(signed));
}

/** Signs a prepared (unsigned, base64) transaction with these keys and sends it, as a wallet would. */
export async function signAndSend(validator: LocalValidator, transaction: string, signers: KeyPairSigner[]) {
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const signed = await signTransaction(signers.map((signer) => signer.keyPair), decoded as never);
  return await sendSigned(validator, getBase64EncodedWireTransaction(signed));
}

async function sendSigned(validator: LocalValidator, wire: ReturnType<typeof getBase64EncodedWireTransaction>) {
  const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)) as never);
  try {
    await validator.rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  } catch (error) {
    // Name the failing program's logs (they carry "custom program error: 0x…") instead of only "simulation failed".
    const context = (error as { context?: { logs?: string[] } }).context;
    throw new Error(`${(error as Error).message}: ${(context?.logs ?? []).join(" | ")}`);
  }
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
    const status = (await validator.rpc.getSignatureStatuses([signature]).send()).value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("The transaction was not confirmed.");
}

export async function airdrop(validator: LocalValidator, owner: string, sol = 10n) {
  const signature = await validator.rpc.requestAirdrop(address(owner), lamports(sol * 1_000_000_000n)).send();
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
    const status = (await validator.rpc.getSignatureStatuses([signature]).send()).value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("The airdrop was not confirmed.");
}

/** Mints `units` of a listed token to `owner`, opening their token account first; `authority` is the fixture's. */
export async function mintTo(validator: LocalValidator, authority: KeyPairSigner, asset: SolanaAssetListing, owner: string, units: bigint) {
  const tokenProgram = address(SOLANA_TOKEN_PROGRAM_ADDRESSES[asset.program ?? "token"]);
  const mint = address(asset.mint!);
  const [token] = await findAssociatedTokenPda({ owner: address(owner), mint, tokenProgram });
  const mintInstruction = asset.program === "token-2022"
    ? getMintToChecked2022Instruction({ mint, token, mintAuthority: authority, amount: units, decimals: asset.decimals })
    : getMintToCheckedInstruction({ mint, token, mintAuthority: authority, amount: units, decimals: asset.decimals });
  await sendInstructions(validator, authority, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: token, owner: address(owner), mint, tokenProgram }),
    mintInstruction,
  ]);
  return token;
}
