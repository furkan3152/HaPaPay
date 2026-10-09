import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPair, getAddressFromPublicKey, getBase58Decoder, signBytes } from "@solana/kit";
import { getAddress } from "viem";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { WalletAuthService } from "../server/wallet-auth";
import { AccountAddressService, AddressTakenError, MemoryAccountAddressRepository, WalletConsentError } from "../server/account-address-service";
import { readSolanaAttestorKey, readSolanaConfig, verifySolanaSignature } from "../server/solana-network";

const walletA = getAddress("0x00000000000000000000000000000000000000a1");
const walletB = getAddress("0x00000000000000000000000000000000000000b2");

async function solanaWallet() {
  const keys = await generateKeyPair();
  const address = await getAddressFromPublicKey(keys.publicKey);
  return { address, sign: async (message: string) => getBase58Decoder().decode(await signBytes(keys.privateKey, new TextEncoder().encode(message))) };
}

describe("a Solana address on a HaPaPay account", () => {
  it("is added only with that Solana wallet's signature of a one-time message naming the account and the address", async () => {
    let now = new Date("2026-10-04T12:00:00Z");
    const service = new AccountAddressService({ domain: "hapapay.example", repository: new MemoryAccountAddressRepository(), now: () => now });
    const solana = await solanaWallet();
    const challenge = await service.createSolanaChallenge(walletA, solana.address);
    assert.match(challenge.message, /^hapapay\.example wants to add a Solana address to your HaPaPay wallet\n\nWallet: 0x0{38}[aA]1\nSolana address: /);
    assert.match(challenge.message, /This request does not move funds\.$/);
    const other = await solanaWallet();
    await assert.rejects(async () => service.verifySolana(walletA, { challengeId: challenge.id, signature: await other.sign(challenge.message), freshSession: true }), /does not match/);
    const second = await service.createSolanaChallenge(walletA, solana.address);
    await assert.rejects(async () => service.verifySolana(walletB, { challengeId: second.id, signature: await solana.sign(second.message), freshSession: true }), /different wallet/);
    const third = await service.createSolanaChallenge(walletA, solana.address);
    assert.deepEqual(await service.verifySolana(walletA, { challengeId: third.id, signature: await solana.sign(third.message), freshSession: true }), { address: solana.address });
    assert.equal(await service.solana(walletA), solana.address);
    assert.equal(await service.walletForSolana(solana.address), walletA);
    await assert.rejects(async () => service.verifySolana(walletA, { challengeId: third.id, signature: await solana.sign(third.message), freshSession: true }), /already used/);
    const late = await service.createSolanaChallenge(walletA, solana.address);
    now = new Date(now.getTime() + 6 * 60_000);
    await assert.rejects(async () => service.verifySolana(walletA, { challengeId: late.id, signature: await solana.sign(late.message), freshSession: true }), /expired/);
  });

  it("belongs to one account at a time, and an account can replace or remove its own", async () => {
    const service = new AccountAddressService({ domain: "hapapay.example", repository: new MemoryAccountAddressRepository() });
    const first = await solanaWallet();
    const add = async (wallet: typeof walletA, solana: Awaited<ReturnType<typeof solanaWallet>>) => {
      const challenge = await service.createSolanaChallenge(wallet, solana.address);
      return await service.verifySolana(wallet, { challengeId: challenge.id, signature: await solana.sign(challenge.message), freshSession: true });
    };
    await add(walletA, first);
    await assert.rejects(() => add(walletB, first), (error) => error instanceof AddressTakenError);
    const second = await solanaWallet();
    await add(walletA, second);
    assert.equal(await service.solana(walletA), second.address);
    assert.equal(await service.walletForSolana(first.address), undefined, "the replaced address is free again");
    await service.removeSolana(walletA);
    assert.equal(await service.solana(walletA), undefined);
  });
});

describe("changing where Solana payments reach an account", () => {
  it("needs the account wallet's own signature of the same message once the sign-in is older than ten minutes", async () => {
    // Audit, 2026-10-06: a copied session alone could point the account's Solana payments and vault claims elsewhere.
    const owner = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const stranger = privateKeyToAccount("0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    const service = new AccountAddressService({ domain: "hapapay.example", repository: new MemoryAccountAddressRepository() });
    const solana = await solanaWallet();
    const attempt = async (walletSignature?: (message: string) => Promise<string>) => {
      const challenge = await service.createSolanaChallenge(owner.address, solana.address);
      return service.verifySolana(owner.address, {
        challengeId: challenge.id,
        signature: await solana.sign(challenge.message),
        ...(walletSignature ? { walletSignature: await walletSignature(challenge.message) } : {}),
      });
    };
    await assert.rejects(() => attempt(), (error) => error instanceof WalletConsentError);
    await assert.rejects(() => attempt((message) => stranger.signMessage({ message })), (error) => error instanceof WalletConsentError);
    await assert.rejects(() => attempt(async () => "0x1234"), (error) => error instanceof WalletConsentError);
    assert.equal(await service.solana(owner.address), undefined, "nothing changed without the wallet's consent");
    assert.deepEqual(await attempt((message) => owner.signMessage({ message })), { address: solana.address });
    assert.equal(await service.solana(owner.address), solana.address);
  });
});

describe("POST /api/auth/solana/challenge and /verify", () => {
  it("ask a sign-in older than ten minutes for the wallet's signature too, and answer 403 without it", async () => {
    const owner = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    let now = new Date("2026-10-06T08:00:00.000Z");
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "solana-consent-secret-with-32-characters", now: () => now });
    const addresses = new AccountAddressService({ domain: "127.0.0.1", repository: new MemoryAccountAddressRepository(), now: () => now });
    const app = createApp({ auth, solana: { addresses } as never });
    const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = (path: string, body: unknown, cookie?: string) => fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      const challenge = await (await post("/api/auth/challenge", { address: owner.address })).json() as { id: string; message: string };
      const login = await post("/api/auth/verify", { address: owner.address, challengeId: challenge.id, signature: await owner.signMessage({ message: challenge.message }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const solana = await solanaWallet();
      const add = async (withWallet: boolean) => {
        const asked = await (await post("/api/auth/solana/challenge", { address: solana.address }, cookie)).json() as { id: string; message: string; walletSignature: boolean };
        const walletSignature = withWallet ? await owner.signMessage({ message: asked.message }) : undefined;
        return { asked, response: await post("/api/auth/solana/verify", { challengeId: asked.id, signature: await solana.sign(asked.message), ...(walletSignature ? { walletSignature } : {}) }, cookie) };
      };
      const atSignIn = await add(false);
      assert.equal(atSignIn.asked.walletSignature, false, "the sign-in itself adds its Solana wallet without a second prompt");
      assert.equal(atSignIn.response.status, 200);
      now = new Date("2026-10-06T09:00:00.000Z");
      const later = await add(false);
      assert.equal(later.asked.walletSignature, true);
      assert.equal(later.response.status, 403);
      assert.equal((await later.response.json() as { walletSignature?: boolean }).walletSignature, true);
      assert.equal((await add(true)).response.status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Solana settings", () => {
  it("needs a treasury for payments, keeps xStocks off until enabled, and names bad values without echoing them", () => {
    const none = readSolanaConfig({});
    assert.equal(none.transfers.enabled, false);
    assert.match(none.transfers.reason!, /treasury is not set/);
    assert.equal(none.stocks.enabled, false);
    const treasury = "Ffa3VtJ6RZ7c5HNbQ3vKVgWfV7FRqUxMHgH4pHBqcGEF";
    const ready = readSolanaConfig({ SOLANA_TREASURY_ADDRESS: treasury, SOLANA_STOCK_TRANSFERS: "enabled" });
    assert.deepEqual([ready.transfers.enabled, ready.stocks.enabled, ready.treasury], [true, true, treasury]);
    assert.equal(readSolanaConfig({ SOLANA_TREASURY_ADDRESS: treasury, SOLANA_TRANSFERS: "disabled" }).transfers.enabled, false);
    const bad = readSolanaConfig({ SOLANA_RPC_URL: "http://user:secret@rpc.example", SOLANA_TREASURY_ADDRESS: "not-an-address", SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY: "nope" });
    assert.deepEqual(bad.problems, ["SOLANA_RPC_URL must be an https URL without credentials in it.", "SOLANA_TREASURY_ADDRESS is not a Solana address.", "SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY is not a Solana key."]);
    assert.ok(!JSON.stringify(bad).includes("secret"));
  });

  it("reads an attestor key from a keypair file array, a 64-byte or a 32-byte base58 secret, and signs verifiably", async () => {
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const fromSeed = readSolanaAttestorKey(getBase58Decoder().decode(seed))!;
    const publicBytes = await import("@solana/kit").then(({ getAddressEncoder }) => getAddressEncoder().encode(fromSeed.publicKey as never));
    const full = Uint8Array.from([...seed, ...publicBytes]);
    assert.equal(readSolanaAttestorKey(getBase58Decoder().decode(full))!.publicKey, fromSeed.publicKey);
    assert.equal(readSolanaAttestorKey(JSON.stringify([...full]))!.publicKey, fromSeed.publicKey);
    assert.throws(() => readSolanaAttestorKey(JSON.stringify([...seed, ...seed])), /public half does not match/);
    const message = new TextEncoder().encode("claim");
    assert.equal(verifySolanaSignature(fromSeed.publicKey, message, fromSeed.sign(message)), true);
    assert.equal(verifySolanaSignature(fromSeed.publicKey, new TextEncoder().encode("other"), fromSeed.sign(message)), false);
  });
});
