import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWalletSessionController } from "../src/domain/wallet-session-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const walletA = "0x1111111111111111111111111111111111111111";
const walletB = "0x2222222222222222222222222222222222222222";

describe("wallet session read lifecycle", () => {
  it("does not let an earlier restored wallet overwrite a newly verified wallet", async () => {
    const initialSession = deferred<{ authenticated: boolean; address: string }>();
    const session = createWalletSessionController({
      readSession: () => initialSession.promise,
      readProfile: async () => ({ wallet: walletB, accounts: ["github:wallet-b"] }),
      readPayments: async () => ["wallet-b-receipt"],
      publish: () => {},
    });
    const restoring = session.restore();
    await session.verify(async () => ({ address: walletB }));
    initialSession.resolve({ authenticated: true, address: walletA });
    await restoring;

    assert.equal(session.getSnapshot().wallet, walletB);
    assert.deepEqual(session.getSnapshot().accounts, ["github:wallet-b"]);
    assert.deepEqual(session.getSnapshot().payments, ["wallet-b-receipt"]);
  });

  it("discards profile and payment responses started for the previous wallet", async () => {
    const oldProfile = deferred<{ wallet: string; accounts: string[] }>();
    const oldPayments = deferred<string[]>();
    const oldReadsStarted = deferred<void>();
    let cookieWallet = walletA;
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: cookieWallet }),
      readProfile: () => cookieWallet === walletA ? oldProfile.promise : Promise.resolve({ wallet: walletB, accounts: ["github:b"] }),
      readPayments: () => {
        if (cookieWallet === walletA) { oldReadsStarted.resolve(); return oldPayments.promise; }
        return Promise.resolve(["receipt-b"]);
      },
      publish: () => {},
    });
    const restoring = session.restore();
    await oldReadsStarted.promise;
    await session.verify(async () => { cookieWallet = walletB; return { address: walletB }; });
    oldProfile.resolve({ wallet: walletA, accounts: ["github:a"] });
    oldPayments.resolve(["receipt-a"]);
    await restoring;

    assert.deepEqual(session.getSnapshot().accounts, ["github:b"]);
    assert.deepEqual(session.getSnapshot().payments, ["receipt-b"]);
    assert.equal(session.getSnapshot().wallet, walletB);
  });

  it("joins repeated wallet verification instead of opening competing prompts", async () => {
    const prompt = deferred<{ address: string }>();
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: false }),
      readProfile: async () => ({ wallet: walletB, accounts: [] }),
      readPayments: async () => [],
      publish: () => {},
    });
    const first = session.verify(() => prompt.promise);
    const second = session.verify(async () => ({ address: walletA }));
    assert.equal(first, second, "Both controls observe the same wallet prompt outcome");
    const restoring = session.restore();
    prompt.resolve({ address: walletB });
    assert.deepEqual(await first, { status: "verified" });
    await restoring;
    assert.equal(session.getSnapshot().wallet, walletB);
  });

  it("recovers the current cookie session after a failed verification instead of cached wallet data", async () => {
    let cookieWallet = walletA;
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: cookieWallet }),
      readProfile: async () => ({ wallet: cookieWallet, accounts: [`identity:${cookieWallet}`] }),
      readPayments: async () => [`receipt:${cookieWallet}`],
      publish: () => {},
    });
    await session.restore();
    const lostResponse = new Error("Verification response interrupted");
    const outcome = await session.verify(async () => {
      // The server may have set a new cookie before a response is interrupted.
      cookieWallet = walletB;
      throw lostResponse;
    });
    assert.deepEqual(outcome, { status: "failed", error: lostResponse });
    assert.equal(session.getSnapshot().wallet, walletB);
    assert.deepEqual(session.getSnapshot().accounts, [`identity:${walletB}`]);
    assert.deepEqual(session.getSnapshot().payments, [`receipt:${walletB}`]);
  });

  it("keeps the newest refreshed receipts when an older history request finishes later", async () => {
    const oldPayments = deferred<string[]>();
    let readPayments = async () => ["original-receipt"];
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: async () => ({ wallet: walletB, accounts: [] }),
      readPayments: () => readPayments(),
      publish: () => {},
    });
    await session.restore();
    readPayments = () => oldPayments.promise;
    const olderRefresh = session.refreshPayments();
    readPayments = async () => ["new-receipt", "original-receipt"];
    await session.refreshPayments();
    oldPayments.resolve(["original-receipt"]);
    await olderRefresh;
    assert.deepEqual(session.getSnapshot().payments, ["new-receipt", "original-receipt"]);
    assert.equal(session.getSnapshot().paymentsStatus, "ready");
  });

  it("ignores stale history errors and preserves verified data on a current refresh failure", async () => {
    const oldPayments = deferred<string[]>();
    let readPayments = async () => ["original-receipt"];
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: async () => ({ wallet: walletB, accounts: [] }),
      readPayments: () => readPayments(),
      publish: () => {},
    });
    await session.restore();
    readPayments = () => oldPayments.promise;
    const olderRefresh = session.refreshPayments();
    readPayments = async () => ["latest-receipt"];
    await session.refreshPayments();
    oldPayments.reject(new Error("Old request failed"));
    await olderRefresh;
    assert.equal(session.getSnapshot().paymentsStatus, "ready");
    readPayments = async () => { throw new Error("Current request failed"); };
    await session.refreshPayments();
    assert.equal(session.getSnapshot().paymentsStatus, "error");
    assert.equal(session.getSnapshot().sessionStatus, "ready");
    assert.deepEqual(session.getSnapshot().payments, ["latest-receipt"]);
  });

  it("keeps the latest linked identities when earlier profile reads finish later", async () => {
    const oldProfile = deferred<{ wallet: string; accounts: string[] }>();
    let readProfile = async () => ({ wallet: walletB, accounts: ["github:b"] });
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: () => readProfile(),
      readPayments: async () => [],
      publish: () => {},
    });
    await session.restore();
    readProfile = () => oldProfile.promise;
    const olderRefresh = session.refreshProfile();
    readProfile = async () => ({ wallet: walletB, accounts: ["github:b", "x:b"] });
    await session.refreshProfile();
    oldProfile.resolve({ wallet: walletB, accounts: ["github:b"] });
    await olderRefresh;
    assert.deepEqual(session.getSnapshot().accounts, ["github:b", "x:b"]);
  });

  it("does not keep old identities visible after the current profile refresh fails", async () => {
    let unavailable = false;
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: async () => {
        if (unavailable) throw new Error("Profile unavailable");
        return { wallet: walletB, accounts: ["github:b"] };
      },
      readPayments: async () => ["verified-receipt"],
      publish: () => {},
    });
    await session.restore();
    unavailable = true;
    await session.refreshProfile();
    assert.deepEqual(session.getSnapshot().accounts, []);
    assert.equal(session.getSnapshot().profileStatus, "error");
    assert.equal(session.getSnapshot().sessionStatus, "ready");
    assert.deepEqual(session.getSnapshot().payments, ["verified-receipt"]);
  });

  it("reads the linked accounts again after a brief outage instead of hiding them", async () => {
    let failures = 1;
    const waits: number[] = [];
    const statuses: string[] = [];
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: async () => {
        if (failures-- > 0) throw new Error("Profile unavailable");
        return { wallet: walletB, accounts: ["github:b"] };
      },
      readPayments: async () => [],
      publish: (snapshot) => statuses.push(snapshot.profileStatus),
      profileRetryDelays: [800, 2500],
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    await session.restore();
    assert.deepEqual(waits, [800]);
    assert.deepEqual(session.getSnapshot().accounts, ["github:b"]);
    assert.equal(session.getSnapshot().profileStatus, "ready");
    assert.equal(statuses.includes("error"), false, "the outage never showed as an error");
  });

  it("still hides the accounts when every retry fails", async () => {
    let unavailable = false;
    const waits: number[] = [];
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: async () => {
        if (unavailable) throw new Error("Profile unavailable");
        return { wallet: walletB, accounts: ["github:b"] };
      },
      readPayments: async () => [],
      publish: () => {},
      profileRetryDelays: [800, 2500],
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    await session.restore();
    unavailable = true;
    await session.refreshProfile();
    assert.deepEqual(waits, [800, 2500]);
    assert.deepEqual(session.getSnapshot().accounts, []);
    assert.equal(session.getSnapshot().profileStatus, "error");
    assert.equal(session.getSnapshot().sessionStatus, "ready");
  });

  it("drops a retry once a newer read or another wallet has replaced it", async () => {
    const pause = deferred<void>();
    let readProfile = async (): Promise<{ wallet: string; accounts: string[] }> => { throw new Error("Profile unavailable"); };
    let reads = 0;
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: () => { reads += 1; return readProfile(); },
      readPayments: async () => [],
      publish: () => {},
      profileRetryDelays: [800],
      wait: () => pause.promise,
    });
    const restoring = session.restore();
    await new Promise((resolve) => setImmediate(resolve));
    readProfile = async () => ({ wallet: walletB, accounts: ["github:b", "x:b"] });
    await session.refreshProfile();
    readProfile = async () => ({ wallet: walletB, accounts: ["stale"] });
    const readsBefore = reads;
    pause.resolve();
    await restoring;
    assert.equal(reads, readsBefore, "the replaced read never runs again");
    assert.deepEqual(session.getSnapshot().accounts, ["github:b", "x:b"]);
    assert.equal(session.getSnapshot().profileStatus, "ready");
  });

  it("fails closed when the profile belongs to another wallet and discards pending receipts", async () => {
    const payments = deferred<string[]>();
    const profileStarted = deferred<void>();
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: async () => { profileStarted.resolve(); return { wallet: walletA, accounts: ["github:a"] }; },
      readPayments: () => payments.promise,
      publish: () => {},
    });
    const restoring = session.restore();
    await profileStarted.promise;
    payments.resolve(["wrong-wallet-receipt"]);
    await restoring;
    assert.equal(session.getSnapshot().wallet, undefined);
    assert.deepEqual(session.getSnapshot().accounts, []);
    assert.deepEqual(session.getSnapshot().payments, []);
    assert.equal(session.getSnapshot().sessionStatus, "error");
  });

  it("cancels old work without disabling a later restore and ignores expired callback contexts", async () => {
    const firstSession = deferred<{ authenticated: boolean; address: string }>();
    let readSession = () => firstSession.promise;
    const session = createWalletSessionController({
      readSession: () => readSession(),
      readProfile: async () => ({ wallet: walletB, accounts: ["github:b"] }),
      readPayments: async () => ["receipt-b"],
      publish: () => {},
    });
    const firstRestore = session.restore();
    const expiredContext = session.capture();
    session.cancel();
    readSession = async () => ({ authenticated: true, address: walletB });
    await session.restore();
    firstSession.resolve({ authenticated: true, address: walletA });
    await firstRestore;
    await session.refreshProfile(expiredContext);
    await session.refreshPayments(expiredContext);
    assert.equal(session.isCurrent(expiredContext), false);
    assert.equal(session.isCurrent(session.capture()), true);
    assert.equal(session.getSnapshot().wallet, walletB);
    assert.deepEqual(session.getSnapshot().accounts, ["github:b"]);
    assert.deepEqual(session.getSnapshot().payments, ["receipt-b"]);
  });

  it("fails closed without rejecting background reads when session recovery is unavailable", async () => {
    const session = createWalletSessionController({
      readSession: async () => { throw new Error("Session unavailable"); },
      readProfile: async () => ({ wallet: walletA, accounts: ["github:a"] }),
      readPayments: async () => ["receipt-a"],
      publish: () => {},
    });
    await session.restore();
    assert.equal(session.getSnapshot().sessionStatus, "error");
    const rejected = new Error("Wallet rejected");
    assert.deepEqual(await session.verify(async () => { throw rejected; }), { status: "failed", error: rejected });
    assert.equal(session.getSnapshot().wallet, undefined);
    assert.deepEqual(session.getSnapshot().accounts, []);
    assert.deepEqual(session.getSnapshot().payments, []);
  });

  it("restores the current cookie after cancelled authentication finishes without starting a second prompt", async () => {
    const prompt = deferred<{ address: string }>();
    const promptStarted = deferred<void>();
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: async () => ({ wallet: walletB, accounts: ["github:b"] }),
      readPayments: async () => ["receipt-b"],
      publish: () => {},
    });
    const verifying = session.verify(() => { promptStarted.resolve(); return prompt.promise; });
    await promptStarted.promise;
    session.cancel();
    const restoring = session.restore();
    assert.equal(session.verify(async () => ({ address: walletA })), verifying);
    prompt.resolve({ address: walletB });
    assert.deepEqual(await verifying, { status: "stale" });
    await restoring;
    assert.equal(session.getSnapshot().wallet, walletB);
    assert.deepEqual(session.getSnapshot().payments, ["receipt-b"]);
  });

  it("ignores a stale bootstrap failure after wallet verification succeeds", async () => {
    const oldSession = deferred<{ authenticated: boolean; address?: string }>();
    const session = createWalletSessionController({
      readSession: () => oldSession.promise,
      readProfile: async () => ({ wallet: walletB, accounts: ["github:b"] }),
      readPayments: async () => ["receipt-b"],
      publish: () => {},
    });
    const restoring = session.restore();
    await session.verify(async () => ({ address: walletB }));
    oldSession.reject(new Error("Old bootstrap failed"));
    await restoring;
    assert.equal(session.getSnapshot().sessionStatus, "ready");
    assert.equal(session.getSnapshot().wallet, walletB);
  });

  it("does not clear newer linked identities when an older profile request fails", async () => {
    const oldProfile = deferred<{ wallet: string; accounts: string[] }>();
    let readProfile = async () => ({ wallet: walletB, accounts: ["github:b"] });
    const session = createWalletSessionController({
      readSession: async () => ({ authenticated: true, address: walletB }),
      readProfile: () => readProfile(),
      readPayments: async () => [],
      publish: () => {},
    });
    await session.restore();
    readProfile = () => oldProfile.promise;
    const oldRefresh = session.refreshProfile();
    readProfile = async () => ({ wallet: walletB, accounts: ["github:b", "x:b"] });
    await session.refreshProfile();
    oldProfile.reject(new Error("Old profile failed"));
    await oldRefresh;
    assert.equal(session.getSnapshot().profileStatus, "ready");
    assert.deepEqual(session.getSnapshot().accounts, ["github:b", "x:b"]);
  });
});
