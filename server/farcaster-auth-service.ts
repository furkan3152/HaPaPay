import { randomBytes } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { MemoryTransientStateStore, type TransientStateStore } from "./transient-state-store.js";

type FarcasterResult<T> = Promise<
  | { isError: false; data: T; error?: never }
  | { isError: true; data?: never; error?: Error }
>;

type FarcasterChannelClient = {
  createChannel(args: {
    domain: string;
    siweUri: string;
    nonce: string;
    expirationTime: string;
    acceptAuthAddress: boolean;
  }): FarcasterResult<{ channelToken: string; url: string; nonce: string }>;
  status(args: { channelToken: string }): FarcasterResult<{
    state: "pending" | "completed";
    nonce: string;
    message?: string;
    signature?: Hex;
    fid?: number;
    username?: string;
  }>;
  verifySignInMessage(args: {
    domain: string;
    nonce: string;
    message: string;
    signature: Hex;
    acceptAuthAddress: boolean;
  }): Promise<
    | { isError: false; success: boolean; fid: number; error?: never }
    | { isError: true; success?: never; fid?: never; error?: Error }
  >;
};

/**
 * A Farcaster sign-in that did not finish, with a message written for the person. The relay's and the RPC's own errors
 * are never passed on: they can carry the configured endpoint (audit, 2026-10-06: a failed verification showed the
 * Optimism RPC URL in the identities dialog).
 */
export class FarcasterSignInError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 502 = 401) {
    super(message);
    this.name = "FarcasterSignInError";
  }
}

type PendingRequest = {
  wallet: Address;
  channelToken: string;
  nonce: string;
  expiresAt: number;
};

export class FarcasterAuthService {
  private readonly stateStore: TransientStateStore;
  private readonly now: () => Date;
  private readonly random: () => string;
  private readonly nonce: () => string;

  constructor(private readonly options: {
    domain: string;
    siweUri: string;
    client: FarcasterChannelClient;
    now?: () => Date;
    random?: () => string;
    nonce?: () => string;
    stateStore?: TransientStateStore;
  }) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? (() => randomBytes(24).toString("base64url"));
    this.nonce = options.nonce ?? (() => randomBytes(16).toString("hex"));
    this.stateStore = options.stateStore ?? new MemoryTransientStateStore();
  }

  async start(inputWallet: string) {
    const wallet = getAddress(inputWallet);
    const requestId = this.random();
    const nonce = this.nonce();
    const expiresAt = this.now().getTime() + 10 * 60_000;
    const channel = await this.options.client.createChannel({
      domain: this.options.domain,
      siweUri: this.options.siweUri,
      nonce,
      expirationTime: new Date(expiresAt).toISOString(),
      acceptAuthAddress: true,
    });
    if (channel.isError) throw new FarcasterSignInError("Farcaster sign-in could not start right now. Try again in a moment.", 502);
    const channelData = channel.data;
    if (channelData.nonce !== nonce) throw new FarcasterSignInError("Farcaster sign-in could not start right now. Try again in a moment.", 502);
    await this.stateStore.put("farcaster-request", requestId, {
      wallet,
      channelToken: channelData.channelToken,
      nonce,
      expiresAt,
    }, expiresAt);
    return { requestId, url: channelData.url, expiresAt: new Date(expiresAt).toISOString() };
  }

  async complete(inputWallet: string, requestId: string) {
    const request = await this.stateStore.get<PendingRequest>("farcaster-request", requestId);
    if (!request) throw new FarcasterSignInError("Farcaster request was not found.");
    if (request.expiresAt <= this.now().getTime()) throw new FarcasterSignInError("Farcaster request expired.");
    if (request.wallet !== getAddress(inputWallet)) throw new FarcasterSignInError("Farcaster request belongs to a different wallet.");

    const status = await this.options.client.status({ channelToken: request.channelToken });
    if (status.isError) throw new FarcasterSignInError("Farcaster did not answer just now. Try again in a moment.", 502);
    const statusData = status.data;
    if (statusData.state !== "completed") return { state: "pending" as const };
    const consumed = await this.stateStore.take<PendingRequest>("farcaster-request", requestId);
    if (!consumed) throw new FarcasterSignInError("Farcaster request was already used.");
    if (
      statusData.nonce !== consumed.nonce ||
      !statusData.message ||
      !statusData.signature ||
      !statusData.fid ||
      !statusData.username
    ) {
      throw new FarcasterSignInError("Farcaster relay returned an incomplete identity.");
    }

    let verified: Awaited<ReturnType<FarcasterChannelClient["verifySignInMessage"]>>;
    try {
      verified = await this.options.client.verifySignInMessage({
        domain: this.options.domain,
        nonce: consumed.nonce,
        message: statusData.message,
        signature: statusData.signature,
        acceptAuthAddress: true,
      });
    } catch {
      throw new FarcasterSignInError("Farcaster could not confirm this sign-in just now. Start it again in a moment.", 502);
    }
    if (verified.isError || !verified.success) {
      throw new FarcasterSignInError("Farcaster could not confirm this sign-in. Start it again.");
    }
    if (verified.fid !== statusData.fid) throw new FarcasterSignInError("Farcaster FID mismatch.");
    return {
      state: "verified" as const,
      account: {
        platform: "farcaster" as const,
        providerUserId: String(verified.fid),
        username: statusData.username,
      },
    };
  }
}
