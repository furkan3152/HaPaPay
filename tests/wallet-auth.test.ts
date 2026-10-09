import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { InvalidWalletError, SignInRejectedError, WALLET_SESSION_SECONDS, WalletAuthService } from "../server/wallet-auth";

describe("wallet authentication seam", () => {
  it("creates a one-time wallet session from a valid signed challenge", async () => {
    const account = privateKeyToAccount(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const auth = new WalletAuthService({
      domain: "hapapay.example",
      sessionSecret: "test-secret-with-at-least-32-characters",
      now: () => new Date("2026-09-13T10:00:00.000Z"),
      nonce: () => "fixedNonce123",
    });

    const challenge = await auth.createChallenge(account.address);
    const signature = await account.signMessage({ message: challenge.message });
    const session = await auth.verifyChallenge({
      address: account.address,
      challengeId: challenge.id,
      signature,
    });

    assert.equal(auth.readSession(session.token)?.address, account.address);
    await assert.rejects(
      auth.verifyChallenge({ address: account.address, challengeId: challenge.id, signature }),
      /already used/,
    );
  });

  it("asks for a Sign-In with Ethereum message for this site, so a wallet warns when another site relays it", async () => {
    // Audit, 2026-10-06: the free-form message let a phishing site relay the sign-in without any wallet warning.
    const account = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const auth = new WalletAuthService({
      domain: "hapapay.example",
      uri: "https://hapapay.example",
      sessionSecret: "test-secret-with-at-least-32-characters",
      now: () => new Date("2026-10-06T08:00:00.000Z"),
      nonce: () => "abcdefgh12345678",
    });
    const challenge = await auth.createChallenge(account.address);
    assert.equal(challenge.message, [
      "hapapay.example wants you to sign in with your Ethereum account:",
      account.address,
      "",
      "Sign in to HaPaPay to link verified social accounts to this wallet. This request does not move funds.",
      "",
      "URI: https://hapapay.example",
      "Version: 1",
      "Chain ID: 1",
      "Nonce: abcdefgh12345678",
      "Issued At: 2026-10-06T08:00:00.000Z",
      "Expiration Time: 2026-10-06T08:05:00.000Z",
    ].join("\n"));
    await assert.rejects(() => auth.createChallenge("not-a-wallet"), (error) => error instanceof InvalidWalletError);
    const session = await auth.verifyChallenge({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) });
    const read = auth.readSession(session.token)!;
    assert.equal(read.issuedAt, Date.parse("2026-10-06T08:00:00.000Z"), "a session knows when its signature was made");
    assert.equal(auth.isFresh(read), true);
  });

  it("counts a session as fresh for ten minutes after its signature", async () => {
    const account = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    let now = new Date("2026-10-06T08:00:00.000Z");
    const auth = new WalletAuthService({ domain: "hapapay.example", sessionSecret: "test-secret-with-at-least-32-characters", now: () => now });
    const challenge = await auth.createChallenge(account.address);
    const session = await auth.verifyChallenge({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) });
    now = new Date("2026-10-06T08:10:00.000Z");
    assert.equal(auth.isFresh(auth.readSession(session.token)!), true);
    now = new Date("2026-10-06T08:10:00.001Z");
    assert.equal(auth.isFresh(auth.readSession(session.token)!), false);
    await assert.rejects(
      () => auth.verifyChallenge({ address: account.address, challengeId: "missing", signature: "0x00" }),
      (error) => error instanceof SignInRejectedError,
    );
  });

  it("keeps one wallet signature valid for 30 days and never extends it", async () => {
    const account = privateKeyToAccount(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    let now = new Date("2026-10-04T10:00:00.000Z");
    const auth = new WalletAuthService({
      domain: "hapapay.example",
      sessionSecret: "test-secret-with-at-least-32-characters",
      now: () => now,
    });
    const challenge = await auth.createChallenge(account.address);
    const session = await auth.verifyChallenge({
      address: account.address,
      challengeId: challenge.id,
      signature: await account.signMessage({ message: challenge.message }),
    });

    assert.equal(WALLET_SESSION_SECONDS, 30 * 24 * 60 * 60);
    assert.equal(session.expiresAt, "2026-11-03T10:00:00.000Z");
    now = new Date("2026-10-05T10:00:01.000Z");
    assert.equal(auth.readSession(session.token)?.address, account.address, "a day later the desk is still signed in");
    now = new Date("2026-11-03T09:59:59.000Z");
    assert.equal(auth.readSession(session.token)?.address, account.address);
    now = new Date("2026-11-03T10:00:00.000Z");
    assert.equal(auth.readSession(session.token), undefined, "after 30 days the wallet signs again");
  });

  it("rejects a signature made by a different wallet", async () => {
    const expected = privateKeyToAccount(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const attacker = privateKeyToAccount(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    const auth = new WalletAuthService({
      domain: "hapapay.example",
      sessionSecret: "test-secret-with-at-least-32-characters",
    });
    const challenge = await auth.createChallenge(expected.address);
    const signature = await attacker.signMessage({ message: challenge.message });

    await assert.rejects(
      auth.verifyChallenge({ address: expected.address, challengeId: challenge.id, signature }),
      /signature does not match/,
    );
  });
});
