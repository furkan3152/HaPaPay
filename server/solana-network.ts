import { createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";
import { createDefaultRpcTransport, createSolanaRpcFromTransport, getAddressDecoder, getAddressEncoder, getBase58Encoder, isAddress, type RpcTransport } from "@solana/kit";
import { SOLANA_MAINNET, parseSolanaBrowserRpcUrl } from "../src/domain/solana-chains.js";

type SolanaEnvironment = Partial<Record<
  | "SOLANA_RPC_URL"
  | "SOLANA_BROWSER_RPC_URL"
  | "SOLANA_TREASURY_ADDRESS"
  | "SOLANA_TRANSFERS"
  | "SOLANA_STOCK_TRANSFERS"
  | "SOLANA_OPERATOR_ADDRESS"
  | "SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY",
  string | undefined
>>;

export type SolanaSwitch = { enabled: boolean; reason?: string };

/** An ed25519 key the server signs vault claim attestations with. The secret never leaves this process. */
export type SolanaAttestor = { publicKey: string; sign(message: Uint8Array): Uint8Array };

export type SolanaConfig = {
  network: typeof SOLANA_MAINNET.id;
  /** Server-side RPC. It may carry a provider key, so it is never returned to the browser. */
  rpcUrl: string;
  /**
   * The pages' RPC (`SOLANA_BROWSER_RPC_URL`): a QuickNode Solana mainnet endpoint that allows only this site, sent to
   * every page because Solana's public endpoint refuses browsers. Unset when missing or not such an endpoint.
   */
  browserRpcUrl?: string;
  /** Where the 1% fee goes, all of it. Payments are off without it. */
  treasury?: string;
  /**
   * USDC and USDG, and claims of SOL vault links (HaPaPay no longer sends SOL). On by default once a treasury is set;
   * `SOLANA_TRANSFERS=disabled` turns them off.
   */
  transfers: SolanaSwitch;
  /** xStocks move only when the operator sets `SOLANA_STOCK_TRANSFERS=enabled`, as Stock Tokens on Robinhood Chain. */
  stocks: SolanaSwitch;
  /** The wallet that deploys and owns the Solana vault program's settings. */
  operator?: string;
  attestor?: SolanaAttestor;
  problems: string[];
};

function rpcUrl(value: string | undefined) {
  const input = value?.trim();
  if (!input) return SOLANA_MAINNET.rpcUrl;
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.toString() : undefined;
}

function solanaAddress(value: string | undefined) {
  const input = value?.trim();
  return input && isAddress(input) ? input : undefined;
}

function readSwitch(value: string | undefined, defaultOn: boolean, off: string, invalid: string): SolanaSwitch & { invalid?: boolean } {
  const input = value?.trim().toLowerCase() ?? "";
  if (input === "enabled" || (input === "" && defaultOn)) return { enabled: true };
  if (input === "disabled" || input === "") return { enabled: false, reason: off };
  return { enabled: false, reason: invalid, invalid: true };
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * An attestor key as Solana tools write it: a JSON array of 64 numbers (solana-keygen), base58 of the 64-byte secret
 * key (wallet exports), or base58 of the 32-byte seed. The public half of a 64-byte key must match its seed.
 */
export function readSolanaAttestorKey(value: string | undefined): SolanaAttestor | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  let bytes: Uint8Array;
  if (input.startsWith("[")) {
    const numbers = JSON.parse(input) as unknown;
    if (!Array.isArray(numbers) || !numbers.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) throw new Error("Not a key.");
    bytes = Uint8Array.from(numbers as number[]);
  } else {
    bytes = new Uint8Array(getBase58Encoder().encode(input));
  }
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("A Solana key has 32 or 64 bytes.");
  const seed = bytes.slice(0, 32);
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const publicBytes = new Uint8Array(spki.subarray(ED25519_SPKI_PREFIX.length));
  if (bytes.length === 64 && !bytes.slice(32).every((byte, index) => byte === publicBytes[index])) throw new Error("The key's public half does not match.");
  return {
    publicKey: getAddressDecoder().decode(publicBytes),
    sign: (message) => new Uint8Array(signBytes(null, message, privateKey)),
  };
}

function publicKeyObject(address: string): KeyObject {
  const bytes = getAddressEncoder().encode(address as never);
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(bytes)]), format: "der", type: "spki" });
}

/** Whether `signature` is `address`'s ed25519 signature of `message` (a Solana wallet's signMessage). */
export function verifySolanaSignature(address: string, message: Uint8Array, signature: Uint8Array) {
  if (!isAddress(address) || signature.length !== 64) return false;
  try {
    return verifyBytes(null, message, publicKeyObject(address), signature);
  } catch {
    return false;
  }
}

/**
 * Solana settings from the environment. The cluster is fixed to mainnet; the environment can only point at an RPC
 * provider, name the treasury and the operator, switch transfers, and hold the vault attestor. A malformed value
 * switches its feature off and is reported by name, never with its value.
 */
export function readSolanaConfig(environment: SolanaEnvironment): SolanaConfig {
  const problems: string[] = [];
  const url = rpcUrl(environment.SOLANA_RPC_URL);
  if (!url) problems.push("SOLANA_RPC_URL must be an https URL without credentials in it.");
  const browserRpcUrl = parseSolanaBrowserRpcUrl(environment.SOLANA_BROWSER_RPC_URL);
  if (environment.SOLANA_BROWSER_RPC_URL?.trim() && !browserRpcUrl) problems.push("SOLANA_BROWSER_RPC_URL must be a QuickNode Solana mainnet endpoint (https://<name>.solana-mainnet.quiknode.pro/<token>/).");
  const treasury = solanaAddress(environment.SOLANA_TREASURY_ADDRESS);
  if (environment.SOLANA_TREASURY_ADDRESS?.trim() && !treasury) problems.push("SOLANA_TREASURY_ADDRESS is not a Solana address.");
  const operator = solanaAddress(environment.SOLANA_OPERATOR_ADDRESS);
  if (environment.SOLANA_OPERATOR_ADDRESS?.trim() && !operator) problems.push("SOLANA_OPERATOR_ADDRESS is not a Solana address.");
  let attestor: SolanaAttestor | undefined;
  try {
    attestor = readSolanaAttestorKey(environment.SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY);
  } catch {
    problems.push("SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY is not a Solana key.");
  }
  // The attestor signs claims and nothing else, so it can never be the wallet that owns the settings or takes fees.
  if (attestor && (attestor.publicKey === operator || attestor.publicKey === treasury)) {
    problems.push("SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY must be a new key used for nothing else, not the operator's or the treasury's.");
    attestor = undefined;
  }
  const noTreasury = { enabled: false, reason: "The Solana fee treasury is not set on this server (SOLANA_TREASURY_ADDRESS)." };
  const transfers = readSwitch(environment.SOLANA_TRANSFERS, true, "Solana transfers are turned off on this server.", "Solana transfers are misconfigured on this server.");
  const stocks = readSwitch(
    environment.SOLANA_STOCK_TRANSFERS,
    false,
    "xStocks transfers on Solana are turned off on this server. The operator enables them after reviewing eligibility.",
    "xStocks transfers on Solana are misconfigured on this server.",
  );
  if (transfers.invalid) problems.push("SOLANA_TRANSFERS must be enabled or disabled.");
  if (stocks.invalid) problems.push("SOLANA_STOCK_TRANSFERS must be enabled or disabled.");
  return {
    network: SOLANA_MAINNET.id,
    rpcUrl: url ?? SOLANA_MAINNET.rpcUrl,
    browserRpcUrl,
    treasury,
    transfers: !url ? { enabled: false, reason: "The Solana RPC setting is not valid." } : transfers.enabled && !treasury ? noTreasury : { enabled: transfers.enabled, reason: transfers.reason },
    stocks: !url ? { enabled: false, reason: "The Solana RPC setting is not valid." } : stocks.enabled && !treasury ? noTreasury : { enabled: stocks.enabled, reason: stocks.reason },
    operator,
    attestor,
    problems,
  };
}

/**
 * A Solana RPC client. A provider RPC (`SOLANA_RPC_URL`) falls back to the public mainnet endpoint when the provider
 * cannot be reached or answers with an HTTP error; an answer from either (a JSON-RPC error included) is final.
 */
export function solanaRpc(url: string, fallbackUrl: string = SOLANA_MAINNET.rpcUrl) {
  const primary = createDefaultRpcTransport({ url });
  const secondary = fallbackUrl !== url ? createDefaultRpcTransport({ url: fallbackUrl }) : undefined;
  const transport: RpcTransport = async (request) => {
    try {
      return await primary(request);
    } catch (error) {
      if (!secondary) throw error;
      return await secondary(request);
    }
  };
  return createSolanaRpcFromTransport(transport);
}

export type SolanaRpc = ReturnType<typeof solanaRpc>;
