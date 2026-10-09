import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApiMainnet,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  decodeVaultConfig,
  initializeVaultInstruction,
  programDataAddress,
  SYSTEM_PROGRAM_ADDRESS,
  UPGRADEABLE_LOADER_ADDRESS,
  vaultConfigAddress,
  type VaultConfigState,
} from "./solana-vault.js";

/**
 * Deploying the vault program the way the Solana CLI does it with the upgradeable loader (a buffer, the program bytes
 * written into it in chunks, the deployment, then the settings written and the upgrade authority handed to the
 * operator's own address in one transaction), run by the operator page. The operator keeps that authority so the
 * program can be closed and its rent returned once no link is open; the server accepts a program only while it still holds the pinned code.
 *
 * The page does not ask the operator's wallet for every chunk. It makes a temporary deployment key in the browser; the
 * operator's wallet sends that key the SOL the deployment needs in one approval; the key signs the buffer, the writes,
 * the deployment and the final transaction; whatever it has left goes back to the operator's wallet. The buffer and
 * program keys are derived from the deployment key, so a deployment interrupted by a closed tab resumes from the same
 * seed, and the server accepts the program only after it reads back the exact code, the operator as its upgrade
 * authority and the expected settings.
 */
export const BUFFER_HEADER_BYTES = 37;
export const PROGRAM_DATA_HEADER_BYTES = 45;
export const PROGRAM_ACCOUNT_BYTES = 36;
export const VAULT_CONFIG_BYTES = 108;
/** Bytes of program code per write transaction, below the 1232-byte transaction limit with room to spare. */
export const DEPLOY_CHUNK_BYTES = 950;
/** Compute units each kind of transaction asks for: about twice what each used on a local validator (2,670, 2,520, 2,820 and 12,410). */
export const DEPLOY_COMPUTE_UNITS = { buffer: 6_000, write: 5_000, deploy: 20_000, finalize: 40_000 } as const;
/** SOL kept on top of the estimate for priority fees and resent writes; it returns with the rest. */
export const DEPLOY_MARGIN_LAMPORTS = 5_000_000n;
const SIGNATURE_FEE_LAMPORTS = 5_000n;
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";

const u32 = (value: number) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; };
const u64 = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; };
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; };
const meta = (value: string, role: AccountRole) => ({ address: address(value), role });
const loader = () => address(UPGRADEABLE_LOADER_ADDRESS);

export function bufferLength(programLength: number) {
  return BUFFER_HEADER_BYTES + programLength;
}

/** The byte ranges each write transaction carries. */
export function deploymentChunks(programLength: number, chunk = DEPLOY_CHUNK_BYTES) {
  const chunks: Array<{ offset: number; length: number }> = [];
  for (let offset = 0; offset < programLength; offset += chunk) chunks.push({ offset, length: Math.min(chunk, programLength - offset) });
  return chunks;
}

export type DeploymentKeys = { deployer: KeyPairSigner; buffer: KeyPairSigner; program: KeyPairSigner };

/** The deployment key and the buffer and program keys derived from its 32-byte seed. */
export async function deploymentKeys(seed: Uint8Array): Promise<DeploymentKeys> {
  if (seed.length !== 32) throw new Error("A deployment seed is 32 bytes.");
  const derive = async (label: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", concat(seed, new TextEncoder().encode(label))));
  const [deployer, buffer, program] = await Promise.all([
    createKeyPairSignerFromPrivateKeyBytes(seed),
    derive("hapapay-vault-buffer").then((bytes) => createKeyPairSignerFromPrivateKeyBytes(bytes)),
    derive("hapapay-vault-program").then((bytes) => createKeyPairSignerFromPrivateKeyBytes(bytes)),
  ]);
  return { deployer, buffer, program };
}

type Lifetime = { blockhash: string; lastValidBlockHeight: bigint };
type Compute = { computeUnitPrice?: bigint };

function compile(feePayer: string, lifetime: Lifetime, instructions: Instruction[], compute?: { limit: number; price?: bigint }) {
  const budget: Instruction[] = compute ? [
    getSetComputeUnitLimitInstruction({ units: compute.limit }),
    ...((compute.price ?? 0n) > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: compute.price! })] : []),
  ] : [];
  return compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(address(feePayer), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: lifetime.blockhash as Blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight }, draft),
    (draft) => appendTransactionMessageInstructions([...budget, ...instructions], draft),
  ));
}

/** The operator's one approval: SOL from their wallet to the deployment key. */
export function compileFundDeployer(input: Lifetime & { operator: string; deployer: string; lamports: bigint }) {
  return compile(input.operator, input, [getTransferSolInstruction({ source: createNoopSigner(address(input.operator)), destination: address(input.deployer), amount: input.lamports })]);
}

/** Creates the buffer and makes the deployment key its authority. Signed by both. */
export function compileCreateBuffer(input: Lifetime & Compute & { deployer: string; buffer: string; lamports: bigint; programLength: number }) {
  return compile(input.deployer, input, [
    getCreateAccountInstruction({ payer: createNoopSigner(address(input.deployer)), newAccount: createNoopSigner(address(input.buffer)), lamports: input.lamports, space: BigInt(bufferLength(input.programLength)), programAddress: loader() }),
    { programAddress: loader(), accounts: [meta(input.buffer, AccountRole.WRITABLE), meta(input.deployer, AccountRole.READONLY)], data: u32(0) },
  ], { limit: DEPLOY_COMPUTE_UNITS.buffer, price: input.computeUnitPrice });
}

/** Writes one chunk of program code into the buffer. Signed by the deployment key, the buffer's authority. */
export function compileWrite(input: Lifetime & Compute & { deployer: string; buffer: string; offset: number; bytes: Uint8Array }) {
  return compile(input.deployer, input, [{
    programAddress: loader(),
    accounts: [meta(input.buffer, AccountRole.WRITABLE), meta(input.deployer, AccountRole.READONLY_SIGNER)],
    data: concat(u32(1), u32(input.offset), u64(BigInt(input.bytes.length)), input.bytes),
  }], { limit: DEPLOY_COMPUTE_UNITS.write, price: input.computeUnitPrice });
}

/** Creates the program account and deploys the buffer into it, the deployment key as upgrade authority for now. */
export async function compileDeploy(input: Lifetime & Compute & { deployer: string; buffer: string; program: string; programLamports: bigint; programLength: number }) {
  const programData = await programDataAddress(input.program);
  return compile(input.deployer, input, [
    getCreateAccountInstruction({ payer: createNoopSigner(address(input.deployer)), newAccount: createNoopSigner(address(input.program)), lamports: input.programLamports, space: BigInt(PROGRAM_ACCOUNT_BYTES), programAddress: loader() }),
    {
      programAddress: loader(),
      accounts: [
        meta(input.deployer, AccountRole.WRITABLE_SIGNER),
        meta(programData, AccountRole.WRITABLE),
        meta(input.program, AccountRole.WRITABLE),
        meta(input.buffer, AccountRole.WRITABLE),
        meta(RENT_SYSVAR, AccountRole.READONLY),
        meta(CLOCK_SYSVAR, AccountRole.READONLY),
        meta(SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY),
        meta(input.deployer, AccountRole.READONLY_SIGNER),
      ],
      data: concat(u32(2), u64(BigInt(input.programLength))),
    },
  ], { limit: DEPLOY_COMPUTE_UNITS.deploy, price: input.computeUnitPrice });
}

/**
 * Writes the vault's settings and hands the upgrade authority from the temporary deployment key to the owner (the
 * operator's address) in the same transaction, so the temporary key never holds the program once its settings exist.
 */
export async function compileFinalize(input: Lifetime & Compute & { deployer: string; program: string; owner: string; verifier: string; treasury: string }) {
  const programData = await programDataAddress(input.program);
  return compile(input.deployer, input, [
    initializeVaultInstruction({ programId: input.program, authority: input.deployer, config: await vaultConfigAddress(input.program), programData, owner: input.owner, verifier: input.verifier, treasury: input.treasury }),
    { programAddress: loader(), accounts: [meta(programData, AccountRole.WRITABLE), meta(input.deployer, AccountRole.READONLY_SIGNER), meta(input.owner, AccountRole.READONLY)], data: u32(4) },
  ], { limit: DEPLOY_COMPUTE_UNITS.finalize, price: input.computeUnitPrice });
}

/**
 * Closes a buffer or a program's code account and sends its SOL to `recipient`; `authority` signs and pays the fee.
 * The deployment key closes what an unfinished deployment left; the operator closes a finished program.
 */
export function compileClose(input: Lifetime & { authority: string; account: string; recipient: string; program?: string }) {
  return compile(input.authority, input, [{
    programAddress: loader(),
    accounts: [
      meta(input.account, AccountRole.WRITABLE),
      meta(input.recipient, AccountRole.WRITABLE),
      meta(input.authority, AccountRole.READONLY_SIGNER),
      ...(input.program ? [meta(input.program, AccountRole.WRITABLE)] : []),
    ],
    data: u32(5),
  }]);
}

/** Everything left on the deployment key, back to the operator's wallet; the key's own fee leaves it at zero. */
export function compileReturn(input: Lifetime & { deployer: string; recipient: string; lamports: bigint }) {
  return compile(input.deployer, input, [getTransferSolInstruction({ source: createNoopSigner(address(input.deployer)), destination: address(input.recipient), amount: input.lamports })]);
}

export type DeploymentCost = {
  /** What the operator's wallet sends the deployment key. */
  fund: bigint;
  /** What stays on chain while the program exists: the program's, its code's and the settings' rent, and the fees. */
  permanent: bigint;
  /** The code account's rent, which comes back to the operator when the program is closed. */
  returnable: bigint;
  /** The buffer's rent, held only until the deployment and then reused for the code account. */
  buffer: bigint;
  transactions: number;
};

/** The SOL a deployment takes, from the cluster's rent and the compute unit price. */
export async function deploymentCost(rpc: Rpc<SolanaRpcApiMainnet>, programLength: number, computeUnitPrice = 0n): Promise<DeploymentCost> {
  const rent = (bytes: number) => rpc.getMinimumBalanceForRentExemption(BigInt(bytes)).send();
  const [buffer, program, programData, config] = await Promise.all([rent(bufferLength(programLength)), rent(PROGRAM_ACCOUNT_BYTES), rent(PROGRAM_DATA_HEADER_BYTES + programLength), rent(VAULT_CONFIG_BYTES)]);
  const writes = deploymentChunks(programLength).length;
  const priority = (units: number) => (BigInt(units) * computeUnitPrice + 999_999n) / 1_000_000n;
  // Two signatures for the buffer and the deployment (the new account signs too), one for every other transaction.
  const fees = BigInt(writes + 7) * SIGNATURE_FEE_LAMPORTS + BigInt(writes) * priority(DEPLOY_COMPUTE_UNITS.write) + priority(DEPLOY_COMPUTE_UNITS.buffer) + priority(DEPLOY_COMPUTE_UNITS.deploy) + priority(DEPLOY_COMPUTE_UNITS.finalize);
  const permanent = program + programData + config + fees;
  return { fund: permanent + DEPLOY_MARGIN_LAMPORTS, permanent, returnable: programData, buffer, transactions: writes + 5 };
}

export type DeployedVault = { programId: string; programData: string; authority?: string; code?: Uint8Array; config?: VaultConfigState };

const keyAt = (bytes: Uint8Array, offset: number): string => getAddressDecoder().decode(bytes.slice(offset, offset + 32));

/** The loader's view of a program: its code account, upgrade authority and code; no code once it is closed. */
export async function readDeployedProgram(rpc: Rpc<SolanaRpcApiMainnet>, programId: string): Promise<DeployedVault | undefined> {
  const programAccount = await readAccount(rpc, programId);
  if (!programAccount || programAccount.owner !== UPGRADEABLE_LOADER_ADDRESS || programAccount.data.length !== PROGRAM_ACCOUNT_BYTES || new DataView(programAccount.data.buffer, programAccount.data.byteOffset).getUint32(0, true) !== 2) return undefined;
  const programData = keyAt(programAccount.data, 4);
  if (programData !== await programDataAddress(programId)) return undefined;
  const [data, config] = await Promise.all([readAccount(rpc, programData), readAccount(rpc, await vaultConfigAddress(programId))]);
  if (!data || data.owner !== UPGRADEABLE_LOADER_ADDRESS || data.data.length < PROGRAM_DATA_HEADER_BYTES || new DataView(data.data.buffer, data.data.byteOffset).getUint32(0, true) !== 3) return { programId, programData };
  return {
    programId,
    programData,
    authority: data.data[12] === 1 ? keyAt(data.data, 13) : undefined,
    code: data.data.slice(PROGRAM_DATA_HEADER_BYTES),
    config: config && config.owner === programId ? decodeVaultConfig(config.data) : undefined,
  };
}

async function readAccount(rpc: Rpc<SolanaRpcApiMainnet>, key: string) {
  const { value } = await rpc.getAccountInfo(address(key), { encoding: "base64", commitment: "confirmed" }).send();
  if (!value) return undefined;
  const binary = atob(value.data[0]);
  return { owner: value.owner as string, lamports: value.lamports as bigint, data: Uint8Array.from(binary, (character) => character.charCodeAt(0)) };
}

/** The code a program account holds, compared with a build: the same bytes, followed only by zeros. */
export function codeMatches(code: Uint8Array | undefined, build: Uint8Array) {
  if (!code || code.length < build.length) return false;
  for (let index = 0; index < build.length; index++) if (code[index] !== build[index]) return false;
  for (let index = build.length; index < code.length; index++) if (code[index] !== 0) return false;
  return true;
}

export type DeploymentProgress = { stage: "buffer" | "write" | "deploy" | "finalize" | "return"; done: number; total: number };

type Runner = {
  rpc: Rpc<SolanaRpcApiMainnet>;
  keys: DeploymentKeys;
  computeUnitPrice?: bigint;
  onProgress?: (progress: DeploymentProgress) => void;
  /** Waits between polls and sends; tests pass a shorter one. */
  sleep?: (milliseconds: number) => Promise<void>;
  pollMilliseconds?: number;
};

const SEND_SPACING_MILLISECONDS = 300;
const WRITE_WAVE = 8;

/**
 * Runs or resumes a deployment with the funded deployment key: the buffer if it does not exist, the chunks it does
 * not hold yet, the deployment, then the settings and the upgrade authority handed to `owner` in one transaction, and
 * finally everything left on the key back to `returnTo`. Returns the program ID once the program holds these
 * settings and `owner` holds its upgrade authority.
 */
export async function runVaultDeployment(input: Runner & { program: Uint8Array; owner: string; verifier: string; treasury: string; returnTo: string }) {
  const { rpc, keys } = input;
  const { deployer, buffer, program } = keys;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const price = input.computeUnitPrice ?? 0n;
  const chunks = deploymentChunks(input.program.length);
  const progress = input.onProgress ?? (() => undefined);
  const send = sender(input, sleep);

  let deployed = await readDeployedProgram(rpc, program.address);
  if (!deployed?.code) {
    let bufferAccount = await readAccount(rpc, buffer.address);
    if (!bufferAccount) {
      progress({ stage: "buffer", done: 0, total: 1 });
      const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(bufferLength(input.program.length))).send();
      await send.one([deployer, buffer], (lifetime) => compileCreateBuffer({ ...lifetime, computeUnitPrice: price, deployer: deployer.address, buffer: buffer.address, lamports, programLength: input.program.length }));
      bufferAccount = await readAccount(rpc, buffer.address);
    }
    if (!bufferAccount || bufferAccount.owner !== UPGRADEABLE_LOADER_ADDRESS || bufferAccount.data.length !== bufferLength(input.program.length) || bufferAccount.data[4] !== 1 || keyAt(bufferAccount.data, 5) !== deployer.address) {
      throw new Error("The deployment buffer on Solana is not the one this deployment key made.");
    }
    for (let round = 0; ; round++) {
      const held = bufferAccount.data;
      const missing = chunks.filter((chunk) => !input.program.subarray(chunk.offset, chunk.offset + chunk.length).every((byte, index) => held[BUFFER_HEADER_BYTES + chunk.offset + index] === byte));
      if (!missing.length) break;
      if (round === 4) throw new Error("The program bytes could not be written to Solana. Try again to resume.");
      let done = chunks.length - missing.length;
      progress({ stage: "write", done, total: chunks.length });
      await send.many(missing.map((chunk) => (lifetime: Lifetime) => compileWrite({ ...lifetime, computeUnitPrice: price, deployer: deployer.address, buffer: buffer.address, offset: chunk.offset, bytes: input.program.subarray(chunk.offset, chunk.offset + chunk.length) })), [deployer], () => progress({ stage: "write", done: ++done, total: chunks.length }));
      bufferAccount = (await readAccount(rpc, buffer.address))!;
    }
    progress({ stage: "deploy", done: 0, total: 1 });
    const programLamports = await rpc.getMinimumBalanceForRentExemption(BigInt(PROGRAM_ACCOUNT_BYTES)).send();
    const signature = await send.one([deployer, program], (lifetime) => compileDeploy({ ...lifetime, computeUnitPrice: price, deployer: deployer.address, buffer: buffer.address, program: program.address, programLamports, programLength: input.program.length }));
    // A program runs from the slot after its deployment, so the settings wait until the cluster has moved past it.
    const deployedIn = (await rpc.getSignatureStatuses([signature as never]).send()).value[0]?.slot ?? 0n;
    for (let attempt = 0; attempt < 120 && await rpc.getSlot({ commitment: "confirmed" }).send() <= deployedIn; attempt++) await sleep(input.pollMilliseconds ?? 1_000);
    deployed = await readDeployedProgram(rpc, program.address);
  }
  if (!deployed?.code || !codeMatches(deployed.code, input.program)) throw new Error("The deployed program does not hold the vault build.");
  if (deployed.authority === deployer.address && !deployed.config) {
    progress({ stage: "finalize", done: 0, total: 1 });
    // An endpoint that has not caught up with the deployment yet says so; the attempt is simply made again.
    for (let attempt = 0; ; attempt++) {
      try {
        await send.one([deployer], (lifetime) => compileFinalize({ ...lifetime, computeUnitPrice: price, deployer: deployer.address, program: program.address, owner: input.owner, verifier: input.verifier, treasury: input.treasury }));
        break;
      } catch (error) {
        if (attempt >= 10 || !/Program is not deployed|Unsupported program id/i.test((error as Error).message)) throw error;
        await sleep(input.pollMilliseconds ?? 1_000);
      }
    }
    deployed = await readDeployedProgram(rpc, program.address);
  }
  if (!deployed || deployed.authority !== input.owner) throw new Error("The vault program's upgrade authority is not the operator's address, so it was not finished.");
  const config = deployed.config;
  if (!config || config.owner !== input.owner || config.verifier !== input.verifier || config.treasury !== input.treasury) throw new Error("The vault program's settings are not the ones this server expects.");
  progress({ stage: "return", done: 0, total: 1 });
  await returnLeftovers(input, input.returnTo, send);
  return { programId: program.address };
}

/**
 * For a deployment that will not be finished: closes its buffer, or the deployed but unfinished program, and sends
 * everything on the deployment key back to `returnTo`. A finished program is never touched.
 */
export async function recoverVaultDeployment(input: Runner & { returnTo: string }) {
  const { rpc, keys } = input;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const send = sender(input, sleep);
  const bufferAccount = await readAccount(rpc, keys.buffer.address);
  if (bufferAccount?.owner === UPGRADEABLE_LOADER_ADDRESS && bufferAccount.data[4] === 1 && keyAt(bufferAccount.data, 5) === keys.deployer.address) {
    await send.one([keys.deployer], (lifetime) => compileClose({ ...lifetime, authority: keys.deployer.address, account: keys.buffer.address, recipient: keys.deployer.address }));
  }
  const deployed = await readDeployedProgram(rpc, keys.program.address);
  if (deployed?.authority === keys.deployer.address && !deployed.config) {
    await send.one([keys.deployer], (lifetime) => compileClose({ ...lifetime, authority: keys.deployer.address, account: deployed.programData, recipient: keys.deployer.address, program: keys.program.address }));
  }
  return await returnLeftovers(input, input.returnTo, send);
}

async function returnLeftovers(input: Runner, recipient: string, send: ReturnType<typeof sender>) {
  const { rpc, keys } = input;
  const { value: balance } = await rpc.getBalance(keys.deployer.address, { commitment: "confirmed" }).send();
  if (balance <= SIGNATURE_FEE_LAMPORTS) return 0n;
  await send.one([keys.deployer], (lifetime) => compileReturn({ ...lifetime, deployer: keys.deployer.address, recipient, lamports: balance - SIGNATURE_FEE_LAMPORTS }));
  return balance - SIGNATURE_FEE_LAMPORTS;
}

type Build = (lifetime: Lifetime) => ReturnType<typeof compileTransaction> | Promise<ReturnType<typeof compileTransaction>>;

/** Signs, sends and confirms with the deployment's own keys, resending until the cluster confirms or refuses. */
function sender(input: Runner, sleep: (milliseconds: number) => Promise<void>) {
  const { rpc } = input;
  const poll = input.pollMilliseconds ?? 1_000;
  const call = async <T>(request: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request();
      } catch (error) {
        // The public endpoint answers 429 when requests come too fast; anything else is a real answer.
        const status = (error as { context?: { statusCode?: number } }).context?.statusCode;
        if (status !== 429 || attempt >= 6) throw error;
        await sleep(2_000 * (attempt + 1));
      }
    }
  };
  const latest = async () => (await call(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send())).value;
  const sign = async (signers: KeyPairSigner[], build: Build, lifetime: Lifetime) => {
    const transaction = await signTransaction(signers.map((signer) => signer.keyPair), await build(lifetime));
    return { signature: getSignatureFromTransaction(transaction), wire: getBase64EncodedWireTransaction(transaction) };
  };
  const broadcast = (wire: ReturnType<typeof getBase64EncodedWireTransaction>, skipPreflight: boolean) => call(async () => {
    try {
      return await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight, preflightCommitment: "confirmed" }).send();
    } catch (error) {
      const logs = (error as { context?: { logs?: string[] } }).context?.logs;
      if (logs?.length) throw Object.assign(new Error(`${(error as Error).message}: ${logs.join(" | ")}`), { context: (error as { context?: unknown }).context });
      throw error;
    }
  });
  /** Waits for each signature; rebroadcasts the ones still unseen; "expired" once the blockhash can no longer land. */
  const settle = async (sent: Array<{ signature: string; wire: ReturnType<typeof getBase64EncodedWireTransaction> }>, lastValidBlockHeight: bigint, onConfirmed?: (signature: string) => void) => {
    const outcome = new Map<string, "confirmed" | "expired" | { error: unknown }>();
    for (let round = 1; ; round++) {
      await sleep(poll);
      const open = sent.filter((entry) => !outcome.has(entry.signature));
      const { value } = await call(() => rpc.getSignatureStatuses(open.map((entry) => entry.signature as never)).send());
      value.forEach((status, index) => {
        if (!status) return;
        if (status.err) outcome.set(open[index].signature, { error: status.err });
        else if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          outcome.set(open[index].signature, "confirmed");
          onConfirmed?.(open[index].signature);
        }
      });
      const still = sent.filter((entry) => !outcome.has(entry.signature));
      if (!still.length) return outcome;
      const height = await call(() => rpc.getBlockHeight({ commitment: "confirmed" }).send());
      if (height > lastValidBlockHeight) {
        for (const entry of still) outcome.set(entry.signature, "expired");
        return outcome;
      }
      if (round % 4 === 0) for (const entry of still) await broadcast(entry.wire, true).catch(() => undefined);
    }
  };
  const failure = (error: unknown) => new Error(`Solana refused a deployment transaction: ${JSON.stringify(error, (_, value) => typeof value === "bigint" ? value.toString() : value)}`);
  return {
    async one(signers: KeyPairSigner[], build: Build) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const lifetime = await latest();
        const entry = await sign(signers, build, lifetime);
        await broadcast(entry.wire, false);
        const result = (await settle([entry], lifetime.lastValidBlockHeight)).get(entry.signature);
        if (result === "confirmed") return entry.signature;
        if (typeof result === "object") throw failure(result.error);
      }
      throw new Error("Solana did not confirm the deployment transaction. Try again to resume.");
    },
    async many(builds: Build[], signers: KeyPairSigner[], onConfirmed: () => void) {
      const queue = [...builds];
      for (let rounds = 0; queue.length; rounds++) {
        if (rounds > builds.length + 20) throw new Error("Solana did not confirm the program writes. Try again to resume.");
        const wave = queue.splice(0, WRITE_WAVE);
        const lifetime = await latest();
        const sent: Array<{ signature: string; wire: ReturnType<typeof getBase64EncodedWireTransaction>; build: Build }> = [];
        for (const build of wave) {
          const entry = await sign(signers, build, lifetime);
          await broadcast(entry.wire, true);
          sent.push({ ...entry, build });
          await sleep(SEND_SPACING_MILLISECONDS);
        }
        const outcome = await settle(sent, lifetime.lastValidBlockHeight, onConfirmed);
        for (const entry of sent) {
          const result = outcome.get(entry.signature);
          if (typeof result === "object") throw failure(result.error);
          if (result === "expired") queue.push(entry.build);
        }
      }
    },
  };
}
