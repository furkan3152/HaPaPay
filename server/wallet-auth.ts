import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { MemoryTransientStateStore, type TransientStateStore } from "./transient-state-store.js";

type ChallengeRecord = {
  address: Address;
  message: string;
  expiresAt: number;
};

type SessionPayload = {
  address: Address;
  expiresAt: number;
};

/** A wallet session, with when its signature was made (its expiry less the session's length). */
export type WalletSession = SessionPayload & { issuedAt: number };

/**
 * One wallet signature keeps the desk signed in for 30 days, so linked accounts stay in view between visits. The
 * session is a signed, stateless token: it is never extended, so a copied cookie stops working when it expires.
 */
export const WALLET_SESSION_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long after its signature a session counts as fresh: the sign-in itself may add its Solana wallet, while a later
 * change of where Solana payments go also needs the wallet's own signature (audit, 2026-10-06: a copied session alone
 * could redirect them).
 */
export const FRESH_SESSION_MS = 10 * 60_000;

/** A wallet that is not an Ethereum address. Answered as 400 with its message. */
export class InvalidWalletError extends Error {}
/** A signature, challenge or wallet that does not prove the sign-in. Answered as 401 with its message. */
export class SignInRejectedError extends Error {}

export class WalletAuthService {
  private readonly stateStore: TransientStateStore;
  private readonly domain: string;
  private readonly uri: string;
  private readonly sessionSecret: string;
  private readonly now: () => Date;
  private readonly nonce: () => string;

  constructor(options: {
    domain: string;
    sessionSecret: string;
    now?: () => Date;
    nonce?: () => string;
    stateStore?: TransientStateStore;
    /** The site's origin (`https://hapapay.example`) for the sign-in message's URI; `https://` and the domain without one. */
    uri?: string;
  }) {
    if (options.sessionSecret.length < 32) {
      throw new Error("Session secret must contain at least 32 characters.");
    }
    this.domain = options.domain;
    this.uri = options.uri ?? `https://${options.domain}`;
    this.sessionSecret = options.sessionSecret;
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? generateSiweNonce;
    this.stateStore = options.stateStore ?? new MemoryTransientStateStore();
  }

  /**
   * A Sign-In with Ethereum message (EIP-4361) for this site's domain and origin, so a wallet warns when another site
   * asks for it (audit, 2026-10-06: a site relaying the old free-form message got a session without any warning).
   */
  async createChallenge(inputAddress: string) {
    if (typeof inputAddress !== "string" || !isAddress(inputAddress)) throw new InvalidWalletError("Enter a wallet address.");
    const address = getAddress(inputAddress);
    const id = this.nonce();
    const issuedAt = this.now();
    const expiresAt = issuedAt.getTime() + 5 * 60_000;
    const message = createSiweMessage({
      domain: this.domain,
      address,
      statement: "Sign in to HaPaPay to link verified social accounts to this wallet. This request does not move funds.",
      uri: this.uri,
      version: "1",
      chainId: 1,
      nonce: id,
      issuedAt,
      expirationTime: new Date(expiresAt),
    });

    await this.stateStore.put("wallet-challenge", id, { address, message, expiresAt }, expiresAt);
    return { id, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  async verifyChallenge(input: { address: string; challengeId: string; signature: Hex }) {
    if (typeof input.challengeId !== "string" || !input.challengeId) throw new SignInRejectedError("Sign the sign-in message first.");
    const challenge = await this.stateStore.take<ChallengeRecord>("wallet-challenge", input.challengeId);
    if (!challenge) throw new SignInRejectedError("Challenge was not found or was already used.");
    if (challenge.expiresAt <= this.now().getTime()) throw new SignInRejectedError("Challenge expired.");

    if (typeof input.address !== "string" || !isAddress(input.address)) throw new SignInRejectedError("Challenge belongs to a different wallet.");
    const address = getAddress(input.address);
    if (address !== challenge.address) throw new SignInRejectedError("Challenge belongs to a different wallet.");
    // The message is the one this server wrote for this site, read back field by field before the signature.
    const fields = parseSiweMessage(challenge.message);
    if (fields.domain !== this.domain || fields.uri !== this.uri || fields.nonce !== input.challengeId || fields.address !== address) {
      throw new SignInRejectedError("Wallet signature does not match the challenge.");
    }
    const valid = typeof input.signature === "string" && /^0x[0-9a-fA-F]+$/.test(input.signature)
      && await verifyMessage({ address, message: challenge.message, signature: input.signature }).catch(() => false);
    if (!valid) throw new SignInRejectedError("Wallet signature does not match the challenge.");

    const payload: SessionPayload = { address, expiresAt: this.now().getTime() + WALLET_SESSION_SECONDS * 1000 };
    return { token: this.signPayload(payload), address, expiresAt: new Date(payload.expiresAt).toISOString() };
  }

  /** Whether a session's signature is recent enough to change where Solana payments go without signing again. */
  isFresh(session: WalletSession) {
    return this.now().getTime() - session.issuedAt <= FRESH_SESSION_MS;
  }

  readSession(token: string): WalletSession | undefined {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return undefined;
    const expected = this.mac(encoded);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;

    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
      if (payload.expiresAt <= this.now().getTime()) return undefined;
      return { ...payload, address: getAddress(payload.address), issuedAt: payload.expiresAt - WALLET_SESSION_SECONDS * 1000 };
    } catch {
      return undefined;
    }
  }

  private signPayload(payload: SessionPayload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${this.mac(encoded)}`;
  }

  private mac(value: string) {
    return createHmac("sha256", this.sessionSecret).update(value).digest("base64url");
  }
}
