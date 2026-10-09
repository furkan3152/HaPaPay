import { randomBytes } from "node:crypto";
import { getBase58Encoder, getBase64Encoder, isAddress } from "@solana/kit";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { verifySolanaSignature } from "./solana-network.js";
import { MemoryTransientStateStore, type TransientStateStore } from "./transient-state-store.js";

type SqlResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

/**
 * A HaPaPay account is still its wallet address (the session's EVM address), and it may add one Solana address,
 * proven by that Solana wallet's own signature. Linked
 * identities keep resolving to the account; payments on Solana go to the account's Solana address.
 */
export type AddressFamily = "solana";

export class AddressTakenError extends Error {}
/** Changing where Solana payments go needs the account wallet's signature too. Answered as 403. */
export class WalletConsentError extends Error {
  constructor() {
    super("Sign with your wallet too: changing where Solana payments reach you needs your wallet's signature.");
  }
}

export interface AccountAddressRepository {
  get(wallet: Address, family: AddressFamily): Promise<string | undefined>;
  walletFor(family: AddressFamily, address: string): Promise<Address | undefined>;
  /** Sets the account's address for a family; refuses an address another account already has. */
  set(wallet: Address, family: AddressFamily, address: string, verifiedAt: Date): Promise<void>;
  remove(wallet: Address, family: AddressFamily): Promise<void>;
}

export class MemoryAccountAddressRepository implements AccountAddressRepository {
  private readonly byWallet = new Map<string, string>();
  private readonly byAddress = new Map<string, Address>();

  async get(wallet: Address, family: AddressFamily) {
    return this.byWallet.get(`${family}:${wallet}`);
  }

  async walletFor(family: AddressFamily, address: string) {
    return this.byAddress.get(`${family}:${address}`);
  }

  async set(wallet: Address, family: AddressFamily, address: string) {
    const owner = this.byAddress.get(`${family}:${address}`);
    if (owner && owner !== wallet) throw new AddressTakenError("This Solana address is already added to another HaPaPay wallet.");
    const previous = this.byWallet.get(`${family}:${wallet}`);
    if (previous) this.byAddress.delete(`${family}:${previous}`);
    this.byWallet.set(`${family}:${wallet}`, address);
    this.byAddress.set(`${family}:${address}`, wallet);
  }

  async remove(wallet: Address, family: AddressFamily) {
    const previous = this.byWallet.get(`${family}:${wallet}`);
    if (previous) this.byAddress.delete(`${family}:${previous}`);
    this.byWallet.delete(`${family}:${wallet}`);
  }
}

export class PostgresAccountAddressRepository implements AccountAddressRepository {
  constructor(private readonly pool: SqlPool) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS account_addresses (
        wallet_address TEXT NOT NULL,
        family TEXT NOT NULL,
        address TEXT NOT NULL,
        verified_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (wallet_address, family),
        UNIQUE (family, address)
      )
    `);
  }

  async get(wallet: Address, family: AddressFamily) {
    const result = await this.pool.query("SELECT address FROM account_addresses WHERE wallet_address = $1 AND family = $2", [getAddress(wallet), family]);
    return result.rows[0] ? String(result.rows[0].address) : undefined;
  }

  async walletFor(family: AddressFamily, address: string) {
    const result = await this.pool.query("SELECT wallet_address FROM account_addresses WHERE family = $1 AND address = $2", [family, address]);
    return result.rows[0] ? getAddress(String(result.rows[0].wallet_address)) : undefined;
  }

  async set(wallet: Address, family: AddressFamily, address: string, verifiedAt: Date) {
    const owner = await this.walletFor(family, address);
    if (owner && owner !== getAddress(wallet)) throw new AddressTakenError("This Solana address is already added to another HaPaPay wallet.");
    try {
      await this.pool.query(
        `INSERT INTO account_addresses (wallet_address, family, address, verified_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (wallet_address, family) DO UPDATE SET address = EXCLUDED.address, verified_at = EXCLUDED.verified_at`,
        [getAddress(wallet), family, address, verifiedAt.toISOString()],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new AddressTakenError("This Solana address is already added to another HaPaPay wallet.");
      throw error;
    }
  }

  async remove(wallet: Address, family: AddressFamily) {
    await this.pool.query("DELETE FROM account_addresses WHERE wallet_address = $1 AND family = $2", [getAddress(wallet), family]);
  }
}

type SolanaChallenge = { wallet: Address; address: string; message: string; expiresAt: number };

/**
 * Adds a Solana address to the session's account after that Solana wallet signs a one-time message naming both the
 * account and the address. Nothing is signed by the server and nothing moves.
 */
export class AccountAddressService {
  private readonly now: () => Date;
  private readonly nonce: () => string;
  private readonly stateStore: TransientStateStore;

  constructor(private readonly options: {
    domain: string;
    repository: AccountAddressRepository;
    stateStore?: TransientStateStore;
    now?: () => Date;
    nonce?: () => string;
  }) {
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(18).toString("base64url"));
    this.stateStore = options.stateStore ?? new MemoryTransientStateStore();
  }

  solana(wallet: Address) {
    return this.options.repository.get(getAddress(wallet), "solana");
  }

  walletForSolana(address: string) {
    return this.options.repository.walletFor("solana", address);
  }

  async createSolanaChallenge(wallet: Address, address: string) {
    if (!isAddress(address)) throw new Error("This is not a Solana address.");
    const id = this.nonce();
    const issuedAt = this.now();
    const expiresAt = issuedAt.getTime() + 5 * 60_000;
    const message = [
      `${this.options.domain} wants to add a Solana address to your HaPaPay wallet`,
      "",
      `Wallet: ${getAddress(wallet)}`,
      `Solana address: ${address}`,
      `Nonce: ${id}`,
      `Issued at: ${issuedAt.toISOString()}`,
      `Expiration: ${new Date(expiresAt).toISOString()}`,
      "Purpose: Receive and send payments on Solana with this address.",
      "This request does not move funds.",
    ].join("\n");
    await this.stateStore.put("solana-address-challenge", id, { wallet: getAddress(wallet), address, message, expiresAt } satisfies SolanaChallenge, expiresAt);
    return { id, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Checks the Solana wallet's signature (base58 or base64) of the challenge and records the address. Where Solana
   * payments to the account go changes only with the account wallet's consent: its sign-in from the last ten minutes,
   * or its own signature of the same message (audit, 2026-10-06: a copied session alone could point them elsewhere).
   */
  async verifySolana(wallet: Address, input: { challengeId: string; signature: string; walletSignature?: string; freshSession?: boolean }) {
    const challenge = await this.stateStore.take<SolanaChallenge>("solana-address-challenge", input.challengeId);
    if (!challenge) throw new Error("Challenge was not found or was already used.");
    if (challenge.expiresAt <= this.now().getTime()) throw new Error("Challenge expired.");
    if (challenge.wallet !== getAddress(wallet)) throw new Error("Challenge belongs to a different wallet.");
    const signature = decodeSignature(input.signature);
    if (!signature || !verifySolanaSignature(challenge.address, new TextEncoder().encode(challenge.message), signature)) {
      throw new Error("The Solana signature does not match the challenge.");
    }
    if (!input.freshSession) {
      const consent = typeof input.walletSignature === "string" && /^0x[0-9a-fA-F]{130}$/.test(input.walletSignature)
        && await verifyMessage({ address: challenge.wallet, message: challenge.message, signature: input.walletSignature as Hex }).catch(() => false);
      if (!consent) throw new WalletConsentError();
    }
    await this.options.repository.set(challenge.wallet, "solana", challenge.address, this.now());
    return { address: challenge.address };
  }

  removeSolana(wallet: Address) {
    return this.options.repository.remove(getAddress(wallet), "solana");
  }
}

function decodeSignature(value: string) {
  try {
    const bytes = /^[1-9A-HJ-NP-Za-km-z]+$/.test(value) ? getBase58Encoder().encode(value) : getBase64Encoder().encode(value);
    return bytes.length === 64 ? new Uint8Array(bytes) : undefined;
  } catch {
    return undefined;
  }
}
