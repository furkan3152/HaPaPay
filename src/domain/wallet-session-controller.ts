type ReadStatus = "idle" | "loading" | "ready" | "error";

export type WalletSessionSnapshot<Account, Payment> = {
  wallet?: string;
  accounts: Account[];
  /** The Solana address the account proved with that wallet's signature, read with the accounts. */
  solanaAddress?: string;
  payments: Payment[];
  sessionStatus: "idle" | "loading" | "verifying" | "ready" | "anonymous" | "error";
  profileStatus: ReadStatus;
  paymentsStatus: ReadStatus;
};

type SessionResult = { authenticated: boolean; address?: string };
type VerificationResult = { status: "verified" | "failed" | "stale"; error?: unknown };

export function createWalletSessionController<Account, Payment>(transport: {
  readSession: () => Promise<SessionResult>;
  readProfile: () => Promise<{ wallet: string; accounts: Account[]; solanaAddress?: string | null }>;
  readPayments: () => Promise<Payment[]>;
  publish: (snapshot: WalletSessionSnapshot<Account, Payment>) => void;
  /** Pauses before reading the linked accounts again after a failed read; the read fails only when every retry has. */
  profileRetryDelays?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const wait = transport.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let generation = 0;
  let paymentRequest = 0;
  let profileRequest = 0;
  let verification: Promise<VerificationResult> | undefined;
  let snapshot: WalletSessionSnapshot<Account, Payment> = {
    accounts: [], payments: [], sessionStatus: "idle", profileStatus: "idle", paymentsStatus: "idle",
  };
  const publish = (change: Partial<WalletSessionSnapshot<Account, Payment>>) => {
    snapshot = { ...snapshot, ...change };
    transport.publish(snapshot);
  };
  const begin = (sessionStatus: WalletSessionSnapshot<Account, Payment>["sessionStatus"]) => {
    const context = ++generation;
    publish({ wallet: undefined, accounts: [], solanaAddress: undefined, payments: [], sessionStatus, profileStatus: "idle", paymentsStatus: "idle" });
    return context;
  };
  async function hydrate(address: string, context: number) {
    publish({ wallet: address, sessionStatus: "ready" });
    await Promise.all([refreshProfile(context), refreshPayments(context)]);
  }
  async function refreshProfile(context = generation) {
    if (context !== generation || !snapshot.wallet) return;
    const request = ++profileRequest;
    publish({ profileStatus: "loading" });
    for (const delay of [0, ...(transport.profileRetryDelays ?? [])]) {
      if (delay) await wait(delay);
      if (context !== generation || request !== profileRequest) return;
      try {
        const profile = await transport.readProfile();
        if (context !== generation || request !== profileRequest) return;
        if (profile.wallet.toLowerCase() !== snapshot.wallet?.toLowerCase()) { begin("error"); return; }
        publish({ accounts: profile.accounts, solanaAddress: profile.solanaAddress ?? undefined, profileStatus: "ready" });
        return;
      } catch {
        // A brief outage (a cold database, a dropped connection) is read again before the accounts are hidden.
      }
    }
    if (context === generation && request === profileRequest) publish({ accounts: [], solanaAddress: undefined, profileStatus: "error" });
  }
  async function refreshPayments(context = generation) {
    if (context !== generation || !snapshot.wallet) return;
    const request = ++paymentRequest;
    publish({ paymentsStatus: "loading" });
    try {
      const payments = await transport.readPayments();
      if (context !== generation || request !== paymentRequest) return;
      publish({ payments, paymentsStatus: "ready" });
    } catch {
      if (context === generation && request === paymentRequest) publish({ paymentsStatus: "error" });
    }
  }
  async function restoreCurrentCookie(context: number) {
    try {
      const result = await transport.readSession();
      if (context !== generation) return;
      if (result.authenticated && result.address) await hydrate(result.address, context);
      else publish({ sessionStatus: "anonymous" });
    } catch {
      if (context === generation) publish({ sessionStatus: "error" });
    }
  }
  async function restore() {
    if (verification) {
      const context = generation;
      const result = await verification;
      if (result.status !== "stale" || context !== generation) return;
    }
    await restoreCurrentCookie(begin("loading"));
  }
  function verify(authenticate: () => Promise<{ address: string }>): Promise<VerificationResult> {
    if (verification) return verification;
    const context = begin("verifying");
    verification = Promise.resolve().then(async () => {
      try {
        const result = await authenticate();
        if (context !== generation) return { status: "stale" as const };
        await hydrate(result.address, context);
        return { status: context === generation ? "verified" as const : "stale" as const };
      } catch (error) {
        if (context !== generation) return { status: "stale" as const };
        await restoreCurrentCookie(context);
        return context === generation ? { status: "failed" as const, error } : { status: "stale" as const };
      }
    }).finally(() => { verification = undefined; });
    return verification;
  }
  function cancel() {
    generation++;
    snapshot = { accounts: [], payments: [], sessionStatus: "idle", profileStatus: "idle", paymentsStatus: "idle" };
  }
  return {
    restore, verify, refreshProfile, refreshPayments, cancel,
    capture: () => generation,
    isCurrent: (context: number) => context === generation,
    getSnapshot: () => snapshot,
  };
}
