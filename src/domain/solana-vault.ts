import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getSyncNativeInstruction } from "@solana-program/token";
import { keccak256, stringToBytes } from "viem";
import { SOLANA_TOKEN_PROGRAM_ADDRESSES, WRAPPED_SOL_MINT, type SolanaAssetListing } from "./solana-assets.js";
import { SOLANA_MAX_COMPUTE_UNIT_PRICE, SOLANA_MAX_COMPUTE_UNITS } from "./solana-transfers.js";
import { solanaFee } from "./solana-amounts.js";
import type { StockClaimPlatform } from "./stock-claims.js";
import type { VaultLock } from "./vault-lock.js";

/**
 * HaPaPay's Solana vault program (programs/hapapay-vault, security revision 1): the Solana counterpart of the
 * StockClaimEscrow contract. These are its accounts, instructions and the claim attestation, shared by the server,
 * which prepares unsigned transactions, and the browser, which rebuilds them from the review before the wallet opens.
 */
export const SOLANA_VAULT_REVISION = 1;
export const SOLANA_VAULT_MAX_WINDOW_SECONDS = 31 * 24 * 60 * 60;
/** A claim attestation is good for ten minutes, like the EVM vault's. */
export const SOLANA_CLAIM_SIGNATURE_SECONDS = 600;
export const SOLANA_VAULT_CLAIM_DOMAIN = "HAPAPAY::SOLANA-VAULT::CLAIM::V1";
export const ED25519_PROGRAM_ADDRESS = "Ed25519SigVerify111111111111111111111111111";
export const UPGRADEABLE_LOADER_ADDRESS = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
export const INSTRUCTIONS_SYSVAR_ADDRESS = "Sysvar1nstructions1111111111111111111111111";
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const addressBytes = (value: string) => new Uint8Array(getAddressEncoder().encode(address(value)));
const u64 = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; };
const i64 = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, value, true); return bytes; };
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; };
const hexBytes = (hex: string) => Uint8Array.from((hex.replace(/^0x/, "").match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** The platform and provider-ID hashes the vault keys an identity with, the same as the EVM vault's. */
export function platformHash(platform: string) {
  return hexBytes(keccak256(stringToBytes(platform)));
}
export function providerUserIdHash(providerUserId: string) {
  return hexBytes(keccak256(stringToBytes(providerUserId)));
}
/** `keccak256(platform hash ‖ provider user ID hash)`, which the program stores and the attestation names. */
export function vaultIdentityKey(platformHashBytes: Uint8Array, providerHashBytes: Uint8Array) {
  return hexBytes(keccak256(concat(platformHashBytes, providerHashBytes)));
}

export async function vaultConfigAddress(programId: string) {
  return (await getProgramDerivedAddress({ programAddress: address(programId), seeds: [stringToBytes("config")] }))[0];
}

export async function vaultPaymentAddress(programId: string, paymentId: Uint8Array) {
  return (await getProgramDerivedAddress({ programAddress: address(programId), seeds: [stringToBytes("payment"), paymentId] }))[0];
}

export async function programDataAddress(programId: string) {
  return (await getProgramDerivedAddress({ programAddress: address(UPGRADEABLE_LOADER_ADDRESS), seeds: [addressBytes(programId)] }))[0];
}

export async function tokenAccountFor(owner: string, mint: string, program: SolanaAssetListing["program"]) {
  return (await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(SOLANA_TOKEN_PROGRAM_ADDRESSES[program ?? "token"]) }))[0];
}

/**
 * The token a vault link holds for an asset: the asset's own mint, or wrapped SOL for SOL (which has no mint). The
 * program records this mint, so a link for SOL reads back as wrapped SOL; `wrapped` says the transactions wrap and
 * unwrap it around the program.
 */
export function vaultToken(asset: Pick<SolanaAssetListing, "mint" | "program">) {
  const wrapped = !asset.mint || asset.mint === WRAPPED_SOL_MINT;
  return { mint: asset.mint ?? WRAPPED_SOL_MINT, program: wrapped ? "token" as const : asset.program ?? "token" as const, wrapped };
}

const meta = (value: string, role: AccountRole) => ({ address: address(value), role });

export function initializeVaultInstruction(input: { programId: string; authority: string; config: string; programData: string; owner: string; verifier: string; treasury: string }): Instruction {
  return {
    programAddress: address(input.programId),
    accounts: [
      meta(input.authority, AccountRole.WRITABLE_SIGNER),
      meta(input.config, AccountRole.WRITABLE),
      meta(input.programId, AccountRole.READONLY),
      meta(input.programData, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY),
    ],
    data: concat(Uint8Array.of(0), addressBytes(input.owner), addressBytes(input.verifier), addressBytes(input.treasury)),
  };
}

/** The settings instructions only the owner signs: 4 replaces the attestor, 5 the treasury, 6 the owner. */
export function updateVaultInstruction(input: { programId: string; owner: string; config: string; kind: "verifier" | "treasury" | "owner"; value: string }): Instruction {
  const tag = { verifier: 4, treasury: 5, owner: 6 }[input.kind];
  return {
    programAddress: address(input.programId),
    accounts: [meta(input.owner, AccountRole.READONLY_SIGNER), meta(input.config, AccountRole.WRITABLE)],
    data: concat(Uint8Array.of(tag), addressBytes(input.value)),
  };
}

export type VaultFundingPlan = {
  programId: string;
  payer: string;
  asset: Pick<SolanaAssetListing, "mint" | "program">;
  paymentId: Uint8Array;
  platformHash: Uint8Array;
  providerUserIdHash: Uint8Array;
  units: bigint;
  expiry: bigint;
  blockhash: string;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPrice: bigint;
};

async function createPaymentInstruction(plan: VaultFundingPlan): Promise<Instruction> {
  const { mint, program } = vaultToken(plan.asset);
  const tokenProgram = SOLANA_TOKEN_PROGRAM_ADDRESSES[program];
  const payment = await vaultPaymentAddress(plan.programId, plan.paymentId);
  return {
    programAddress: address(plan.programId),
    accounts: [
      meta(plan.payer, AccountRole.WRITABLE_SIGNER),
      meta(await vaultConfigAddress(plan.programId), AccountRole.READONLY),
      meta(payment, AccountRole.WRITABLE),
      meta(await tokenAccountFor(payment, mint, program), AccountRole.WRITABLE),
      meta(await tokenAccountFor(plan.payer, mint, program), AccountRole.WRITABLE),
      meta(mint, AccountRole.READONLY),
      meta(tokenProgram, AccountRole.READONLY),
      meta(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY),
    ],
    data: concat(Uint8Array.of(1), plan.paymentId, plan.platformHash, plan.providerUserIdHash, u64(plan.units), i64(plan.expiry)),
  };
}

function compile(feePayer: string, plan: { blockhash: string; lastValidBlockHeight: bigint; computeUnitLimit: number; computeUnitPrice: bigint }, instructions: Instruction[]) {
  const all: Instruction[] = [getSetComputeUnitLimitInstruction({ units: plan.computeUnitLimit }), ...(plan.computeUnitPrice > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: plan.computeUnitPrice })] : []), ...instructions];
  return compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(address(feePayer), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: plan.blockhash as Blockhash, lastValidBlockHeight: plan.lastValidBlockHeight }, draft),
    (draft) => appendTransactionMessageInstructions(all, draft),
  ));
}

/** The payer's (or claimer's) own wrapped-SOL account closed into their wallet: whatever it holds comes back as SOL. */
async function unwrapInstruction(owner: string) {
  return getCloseAccountInstruction({ account: await tokenAccountFor(owner, WRAPPED_SOL_MINT, "token"), destination: address(owner), owner: createNoopSigner(address(owner)) });
}

/**
 * Funding a vault link: one `create_payment` that moves the amount plus 1% into the payment's own token account. For
 * SOL the payer's own wrapped-SOL account is opened, given the amount plus 1% and synced first, and closed again after,
 * so the payer keeps no wrapped SOL and gets that account's rent straight back.
 */
export async function compileVaultFunding(plan: VaultFundingPlan) {
  if (!vaultToken(plan.asset).wrapped) return compile(plan.payer, plan, [await createPaymentInstruction(plan)]);
  const payer = createNoopSigner(address(plan.payer));
  const wrappedAccount = await tokenAccountFor(plan.payer, WRAPPED_SOL_MINT, "token");
  return compile(plan.payer, plan, [
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: wrappedAccount, owner: address(plan.payer), mint: address(WRAPPED_SOL_MINT), tokenProgram: address(SOLANA_TOKEN_PROGRAM_ADDRESSES.token) }),
    getTransferSolInstruction({ source: payer, destination: wrappedAccount, amount: plan.units + vaultFee(plan.units) }),
    getSyncNativeInstruction({ account: wrappedAccount }),
    await createPaymentInstruction(plan),
    await unwrapInstruction(plan.payer),
  ]);
}

/** The 216-byte message the claim attestor signs: the domain, then everything the claim depends on. */
export function vaultClaimMessage(input: { programId: string; paymentId: Uint8Array; identityKey: Uint8Array; mint: string; recipient: string; units: bigint; expiry: bigint; claimDeadline: bigint }) {
  return concat(
    stringToBytes(SOLANA_VAULT_CLAIM_DOMAIN),
    addressBytes(input.programId),
    input.paymentId,
    input.identityKey,
    addressBytes(input.mint),
    addressBytes(input.recipient),
    u64(input.units),
    i64(input.expiry),
    i64(input.claimDeadline),
  );
}

/** The ed25519 precompile instruction checking one signature with everything inline, as the program requires. */
export function ed25519Instruction(input: { publicKey: string; signature: Uint8Array; message: Uint8Array }): Instruction {
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  header[0] = 1;
  const keyOffset = 16;
  const signatureOffset = keyOffset + 32;
  const messageOffset = signatureOffset + 64;
  view.setUint16(2, signatureOffset, true);
  view.setUint16(4, 0xffff, true);
  view.setUint16(6, keyOffset, true);
  view.setUint16(8, 0xffff, true);
  view.setUint16(10, messageOffset, true);
  view.setUint16(12, input.message.length, true);
  view.setUint16(14, 0xffff, true);
  return { programAddress: address(ED25519_PROGRAM_ADDRESS), accounts: [], data: concat(header, addressBytes(input.publicKey), input.signature, input.message) };
}

export type VaultActionPlan = {
  programId: string;
  wallet: string;
  paymentId: Uint8Array;
  asset: Pick<SolanaAssetListing, "mint" | "program">;
  payer: string;
  treasury: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPrice: bigint;
} & ({ action: "claim"; claimDeadline: bigint; attestation: { publicKey: string; signature: Uint8Array; message: Uint8Array } } | { action: "refund" });

/**
 * A claim: the claimer's and the treasury's token accounts opened if needed (rent from the claimer), the attestor's
 * signature checked by the precompile, then `claim`. A refund: the payer's token account opened if needed, then
 * `refund`. For SOL the wallet's wrapped-SOL account is closed at the end, so the SOL arrives as SOL and that
 * account's rent comes back. The wallet signing is always the session's own.
 */
export async function compileVaultAction(plan: VaultActionPlan) {
  const { mint, program, wrapped } = vaultToken(plan.asset);
  const tokenProgram = SOLANA_TOKEN_PROGRAM_ADDRESSES[program];
  const payment = await vaultPaymentAddress(plan.programId, plan.paymentId);
  const vault = await tokenAccountFor(payment, mint, program);
  const signer = createNoopSigner(address(plan.wallet));
  const open = async (owner: string) => getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: await tokenAccountFor(owner, mint, program), owner: address(owner), mint: address(mint), tokenProgram: address(tokenProgram) });
  const unwrap = wrapped ? [await unwrapInstruction(plan.wallet)] : [];
  if (plan.action === "refund") {
    return compile(plan.wallet, plan, [
      await open(plan.wallet),
      {
        programAddress: address(plan.programId),
        accounts: [
          meta(plan.wallet, AccountRole.WRITABLE_SIGNER),
          meta(payment, AccountRole.WRITABLE),
          meta(vault, AccountRole.WRITABLE),
          meta(await tokenAccountFor(plan.wallet, mint, program), AccountRole.WRITABLE),
          meta(mint, AccountRole.READONLY),
          meta(tokenProgram, AccountRole.READONLY),
        ],
        data: concat(Uint8Array.of(3), plan.paymentId),
      },
      ...unwrap,
    ]);
  }
  return compile(plan.wallet, plan, [
    await open(plan.wallet),
    await open(plan.treasury),
    ed25519Instruction(plan.attestation),
    {
      programAddress: address(plan.programId),
      accounts: [
        meta(plan.wallet, AccountRole.WRITABLE_SIGNER),
        meta(await vaultConfigAddress(plan.programId), AccountRole.READONLY),
        meta(payment, AccountRole.WRITABLE),
        meta(vault, AccountRole.WRITABLE),
        meta(await tokenAccountFor(plan.wallet, mint, program), AccountRole.WRITABLE),
        meta(await tokenAccountFor(plan.treasury, mint, program), AccountRole.WRITABLE),
        meta(plan.payer, AccountRole.WRITABLE),
        meta(mint, AccountRole.READONLY),
        meta(tokenProgram, AccountRole.READONLY),
        meta(INSTRUCTIONS_SYSVAR_ADDRESS, AccountRole.READONLY),
      ],
      data: concat(Uint8Array.of(2), plan.paymentId, i64(plan.claimDeadline)),
    },
    ...unwrap,
  ]);
}

export function wireTransaction(transaction: ReturnType<typeof compileTransaction>) {
  return getBase64EncodedWireTransaction(transaction);
}

export type VaultConfigState = { revision: number; feeBps: number; owner: string; verifier: string; treasury: string };
export type VaultPaymentState = { status: "open" | "claimed" | "refunded"; payer: string; mint: string; tokenProgram: string; identityKey: Uint8Array; units: bigint; feeUnits: bigint; expiry: bigint };

const tag = (bytes: Uint8Array, text: string) => bytes.length >= 8 && text.split("").every((character, index) => bytes[index] === character.charCodeAt(0));
const keyAt = (bytes: Uint8Array, offset: number) => getAddressDecoder().decode(bytes.slice(offset, offset + 32));

export function decodeVaultConfig(bytes: Uint8Array): VaultConfigState | undefined {
  if (bytes.length !== 108 || !tag(bytes, "HAPA-CFG")) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { revision: bytes[8], feeBps: view.getUint16(10, true), owner: keyAt(bytes, 12), verifier: keyAt(bytes, 44), treasury: keyAt(bytes, 76) };
}

export function decodeVaultPayment(bytes: Uint8Array): VaultPaymentState | undefined {
  if (bytes.length !== 163 || !tag(bytes, "HAPA-PAY") || bytes[8] !== SOLANA_VAULT_REVISION) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = ({ 1: "open", 2: "claimed", 3: "refunded" } as const)[bytes[10] as 1 | 2 | 3];
  if (!status) return undefined;
  return {
    status,
    payer: keyAt(bytes, 11),
    mint: keyAt(bytes, 43),
    tokenProgram: keyAt(bytes, 75),
    identityKey: bytes.slice(107, 139),
    units: view.getBigUint64(139, true),
    feeUnits: view.getBigUint64(147, true),
    expiry: view.getBigInt64(155, true),
  };
}

/** What a prepared vault transaction carries besides its bytes: the settings the browser rebuilds it with. */
export type PreparedVaultTransaction = { transaction: string; blockhash: string; lastValidBlockHeight: string; computeUnitLimit: number; computeUnitPrice: string };

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function decodedMessage(transaction: string, signer: string) {
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const signers = Object.entries(decoded.signatures);
  if (signers.length !== 1 || signers[0][0] !== signer || signers[0][1] !== null) return undefined;
  return new Uint8Array(decoded.messageBytes);
}

function boundedCompute(part: PreparedVaultTransaction) {
  const price = BigInt(part.computeUnitPrice);
  return Number.isInteger(part.computeUnitLimit) && part.computeUnitLimit >= 1 && part.computeUnitLimit <= SOLANA_MAX_COMPUTE_UNITS && price >= 0n && price <= SOLANA_MAX_COMPUTE_UNIT_PRICE;
}

/**
 * The browser's check of a vault funding: the bytes must be exactly `create_payment` on the reviewed program for the
 * reviewed asset, units, platform and expiry window, from the session's own Solana wallet.
 */
export async function matchesVaultFunding(prepared: PreparedVaultTransaction & { programId: string; paymentId: string; providerUserIdHash: string; expiry: string; units: string }, review: { programId: string; payer: string; asset: Pick<SolanaAssetListing, "mint" | "program">; platform: string; units: bigint; nowSeconds: bigint }) {
  try {
    if (prepared.programId !== review.programId || prepared.units !== review.units.toString() || !boundedCompute(prepared)) return false;
    const expiry = BigInt(prepared.expiry);
    if (expiry <= review.nowSeconds || expiry > review.nowSeconds + BigInt(SOLANA_VAULT_MAX_WINDOW_SECONDS)) return false;
    const paymentId = hexBytes(prepared.paymentId);
    const provider = hexBytes(prepared.providerUserIdHash);
    if (paymentId.length !== 32 || provider.length !== 32) return false;
    const message = decodedMessage(prepared.transaction, review.payer);
    if (!message) return false;
    const rebuilt = await compileVaultFunding({
      programId: review.programId,
      payer: review.payer,
      asset: review.asset,
      paymentId,
      platformHash: platformHash(review.platform),
      providerUserIdHash: provider,
      units: review.units,
      expiry,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight),
      computeUnitLimit: prepared.computeUnitLimit,
      computeUnitPrice: BigInt(prepared.computeUnitPrice),
    });
    return sameBytes(message, new Uint8Array(rebuilt.messageBytes));
  } catch {
    return false;
  }
}

/**
 * The browser's check of a claim or refund: the bytes must be exactly the vault action for this payment, paying the
 * session's own wallet (a claim's attestation comes from the server and is checked by the program itself).
 */
export async function matchesVaultAction(prepared: PreparedVaultTransaction & { action: "claim" | "refund"; claimDeadline?: string; attestation?: { publicKey: string; signature: string; message: string } }, review: { programId: string; wallet: string; paymentId: string; asset: Pick<SolanaAssetListing, "mint" | "program">; payer: string; treasury: string; action: "claim" | "refund" }) {
  try {
    if (prepared.action !== review.action || !boundedCompute(prepared)) return false;
    const message = decodedMessage(prepared.transaction, review.wallet);
    if (!message) return false;
    const base = { programId: review.programId, wallet: review.wallet, paymentId: hexBytes(review.paymentId), asset: review.asset, payer: review.payer, treasury: review.treasury, blockhash: prepared.blockhash, lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight), computeUnitLimit: prepared.computeUnitLimit, computeUnitPrice: BigInt(prepared.computeUnitPrice) };
    const rebuilt = review.action === "refund"
      ? await compileVaultAction({ ...base, action: "refund" })
      : await compileVaultAction({ ...base, action: "claim", claimDeadline: BigInt(prepared.claimDeadline ?? "0"), attestation: { publicKey: prepared.attestation!.publicKey, signature: hexBytes(prepared.attestation!.signature), message: hexBytes(prepared.attestation!.message) } });
    return sameBytes(message, new Uint8Array(rebuilt.messageBytes));
  } catch {
    return false;
  }
}

/** The fee a vault link adds on top: 1% of the amount, rounded down, as the program computes it. */
export function vaultFee(units: bigint) {
  return solanaFee(units);
}

export const toHex = (bytes: Uint8Array) => `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
export { hexBytes as fromHex };

export { parseSolanaClaimPath, solanaClaimPath } from "./solana-chains.js";

export { vaultHoldsAsset } from "./solana-assets.js";

/** What `/api/solana/claims/prepare` returns: one unsigned `create_payment` and what the review shows beside it. */
export type PreparedSolanaVaultFunding = PreparedVaultTransaction & {
  network: "solana-mainnet";
  programId: string;
  payer: string;
  paymentId: `0x${string}`;
  platform: StockClaimPlatform;
  providerUserIdHash: `0x${string}`;
  recipient: { platform: StockClaimPlatform; username: string };
  /** Whether the link waits for the recipient's account or for their name (`vault-lock.ts`). */
  lock: VaultLock;
  asset: { symbol: string; name: string; mint: string; decimals: number; program: "token" | "token-2022"; kind: SolanaAssetListing["kind"]; scaled?: boolean };
  amount: string;
  units: string;
  feeUnits: string;
  multiplier?: number;
  expiry: string;
  expiresAt: string;
  /** Rent the payer leaves in the payment record (kept for good, so an ID can never be funded twice). */
  rentLamports: string;
  networkFeeLamports: string;
  claimPath: string;
};

/** A claim or refund, ready for the session's Solana wallet. */
export type PreparedSolanaVaultAction = PreparedVaultTransaction & {
  network: "solana-mainnet";
  action: "claim" | "refund";
  programId: string;
  paymentId: `0x${string}`;
  wallet: string;
  payer: string;
  treasury: string;
  asset: { symbol: string; name: string; mint: string; decimals: number; program: "token" | "token-2022" };
  amount: string;
  claimDeadline?: string;
  attestation?: { publicKey: string; signature: string; message: string };
};

/** The claim page's view of a Solana link, read from the program. */
export type SolanaVaultLinkDetails = {
  network: "solana-mainnet";
  programId: string;
  paymentId: `0x${string}`;
  payer: string;
  asset: { symbol: string; name: string; mint: string; decimals: number; program: "token" | "token-2022"; kind: SolanaAssetListing["kind"] };
  amount: string;
  fee?: string;
  expiresAt: string;
  status: "claimable" | "expired" | "settled";
  recipient?: { platform: StockClaimPlatform; username: string };
  /** Whether an open link waits for the recipient's account or for their name. */
  lock?: VaultLock;
  sourceIdentity?: { platform: string; username: string };
  fundingSignature?: string;
};

/** The operator page's view of the Solana vault. Public keys and names only; no secret leaves the server. */
export type SolanaVaultStatus = {
  network: "solana-mainnet";
  artifact: { size: number; sha256: string; revision: number; path: string };
  operator?: string;
  verifier?: string;
  treasury?: string;
  /** Environment variable names the server still needs before a program can be registered. */
  setup: string[];
  program?: {
    id: string;
    registeredAt: string;
    /** When the operator stopped new links, the first step before closing the program. */
    retiredAt?: string;
    /** The program's code account is gone: it was closed and its rent returned. */
    closed?: boolean;
    /** Read from chain once new links are stopped: the links the program still holds, and when closing is safe. */
    close?: { openLinks: number; lastExpiry?: string; readyAt: string; ready: boolean };
  };
  enabled: boolean;
  reason?: string;
};

/**
 * How long new links stay stopped before the program may be closed: longer than any funding the server prepared
 * before it stopped can still land (a transaction expires with its blockhash, about a minute later).
 */
export const SOLANA_VAULT_CLOSE_WAIT_SECONDS = 120;

/** The bytes the program's open payment accounts start with, for a filtered scan of the program's accounts. */
export const VAULT_PAYMENT_SCAN = { size: 163, tag: "HAPA-PAY", statusOffset: 10, open: 1, expiryOffset: 155 } as const;
