import { randomBytes } from "node:crypto";
import { getAddress, type Address } from "viem";
import { parseSolanaClaimPath } from "../src/domain/solana-chains.js";
import { MemoryTransientStateStore, type TransientStateStore } from "./transient-state-store.js";

export type OAuthProvider = "github" | "x" | "discord" | "farcaster";

/** The browser asked to return somewhere other than an app page. Maps to HTTP 400. */
export class InvalidOAuthReturnPathError extends Error {
  constructor() {
    super("Invalid OAuth return path.");
    this.name = "InvalidOAuthReturnPathError";
  }
}

type OAuthFlow = {
  wallet: Address;
  provider: OAuthProvider;
  codeVerifier?: string;
  returnTo: string;
  expiresAt: number;
};

export class OAuthFlowStore {
  private readonly stateStore: TransientStateStore;
  private readonly now: () => Date;
  private readonly random: () => string;

  constructor(options: { now?: () => Date; random?: () => string; stateStore?: TransientStateStore } = {}) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? (() => randomBytes(32).toString("base64url"));
    this.stateStore = options.stateStore ?? new MemoryTransientStateStore();
  }

  async create(input: { wallet: string; provider: OAuthProvider; returnTo?: string }) {
    const state = this.random();
    const returnTo = safeReturnPath(input.returnTo);
    const flow: OAuthFlow = {
      wallet: getAddress(input.wallet),
      provider: input.provider,
      codeVerifier: input.provider === "x" ? randomBytes(48).toString("base64url") : undefined,
      returnTo,
      expiresAt: this.now().getTime() + 10 * 60_000,
    };
    await this.stateStore.put("oauth-flow", state, flow, flow.expiresAt);
    return { state, codeVerifier: flow.codeVerifier, expiresAt: new Date(flow.expiresAt).toISOString() };
  }

  async consume(input: { state: string; wallet: string; provider: OAuthProvider }) {
    const flow = await this.stateStore.take<OAuthFlow>("oauth-flow", input.state);
    if (!flow) throw new Error("OAuth state was not found or was already used.");
    if (flow.expiresAt <= this.now().getTime()) throw new Error("OAuth state expired.");
    if (flow.wallet !== getAddress(input.wallet)) throw new Error("OAuth state belongs to a different wallet.");
    if (flow.provider !== input.provider) throw new Error("OAuth state belongs to a different provider.");
    return { wallet: flow.wallet, provider: flow.provider, codeVerifier: flow.codeVerifier, returnTo: flow.returnTo ?? "/" };
  }
}

function safeReturnPath(input?: string) {
  // The payment desk itself: linking from the home page returns there.
  if (!input || input === "/") return "/";
  if (/^\/claim\/0x[0-9a-fA-F]{64}$/.test(input)) return input;
  if (/^\/claim\/stock\/robinhood-(?:mainnet|testnet)\/0x[0-9a-fA-F]{64}$/.test(input)) return input;
  // A Solana vault link's claim page (audit, 2026-10-06: its GitHub and X Connect were refused as a bad return path).
  if (parseSolanaClaimPath(input)) return input;
  if (/^\/pay\/(github|x|telegram|discord|farcaster)\/[^/?#]{1,64}$/.test(input)) return input;
  throw new InvalidOAuthReturnPathError();
}
