import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { readSolanaConfig } from "../server/solana-network";
import type { SolanaDesk } from "../server/solana-routes";
import { MemorySolanaTransferRepository, SolanaTransactionExpiredError, SolanaTransferError, SolanaTransferService } from "../server/solana-transfer-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { SOLANA_USDC } from "../src/domain/solana-assets";
import { SOLANA_MAINNET } from "../src/domain/solana-chains";
import { SOLANA_TRANSACTION_EXPIRED, solanaReceiptSource, TransactionExpiredError, waitForTransactionReceipt } from "../src/domain/transaction-receipt";

/**
 * Audit, 2026-10-06: a Solana transaction the network dropped (its blockhash ran out before it landed) left its slip on
 * "Verify again" for good, saying Solana had the transaction, and its payments could not be signed again. Once every
 * block its blockhash allowed is final without it, the server now says it expired and nothing moved.
 */
const SENDER_SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const RECIPIENT_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const signature = () => getBase58Decoder().decode(Uint8Array.from(randomBytes(64)));

/** A Solana RPC that has never seen the transaction and whose finalized block height is `height`. */
function rpc(options: { status?: unknown; height?: bigint; heightFails?: boolean } = {}) {
  const call = <T>(value: () => T) => ({ send: async () => value() });
  return {
    getGenesisHash: () => call(() => SOLANA_MAINNET.genesisHash),
    getSignatureStatuses: () => call(() => ({ value: [options.status ?? null] })),
    getBlockHeight: (config: { commitment: string }) => call(() => {
      assert.equal(config.commitment, "finalized", "only final blocks can prove a transaction never landed");
      if (options.heightFails) throw new Error("HTTP error (429): Too Many Requests");
      return options.height ?? 1_000n;
    }),
    getTransaction: () => call(() => null),
  };
}

const config = readSolanaConfig({ SOLANA_RPC_URL: "https://localhost.invalid/", SOLANA_TREASURY_ADDRESS: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH" });
const service = (options?: Parameters<typeof rpc>[0]) => new SolanaTransferService({ config, rpc: rpc(options) as never, repository: new MemorySolanaTransferRepository(), confirmAttempts: 1, confirmRetryMs: 0 });

describe("Solana transactions that can no longer land", () => {
  it("are expired only once a final block is past their last valid height and Solana has no status for them", async () => {
    const sent = signature();
    assert.equal(await service().expired(sent, 999n), true);
    assert.equal(await service().expired(sent, 1_000n), false, "its last valid block is not final yet");
    assert.equal(await service({ status: { slot: 5n, confirmationStatus: "processed", err: null } }).expired(sent, 999n), false, "Solana has seen it");
    assert.equal(await service({ heightFails: true }).expired(sent, 999n), false, "a failed read never says expired");
    assert.equal(await service().expired("not-a-signature", 999n), false);
  });

  it("are answered as expired by a confirm that names the prepared last valid height, and as not confirmed yet otherwise", async () => {
    const input = {
      signature: signature(), asset: SOLANA_USDC, sender: { wallet: RECIPIENT, address: SENDER_SOL },
      payments: [{ recipientWallet: RECIPIENT, recipientAddress: RECIPIENT_SOL, platform: "x", username: "nora", amount: "1", units: "1000000" }],
    };
    await assert.rejects(() => service().confirm({ ...input, lastValidBlockHeight: 999n }), (error) => error instanceof SolanaTransactionExpiredError && error.message === SOLANA_TRANSACTION_EXPIRED);
    await assert.rejects(() => service().confirm(input), (error) => error instanceof SolanaTransferError && /not confirmed this transaction yet/.test(error.message));
  });

  it("end the browser's wait with an expired error instead of a pending one", async () => {
    const asked: string[] = [];
    const answer = (body: unknown, status = 200) => async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    };
    await assert.rejects(
      () => waitForTransactionReceipt(solanaReceiptSource("sig", "999", answer({ receipt: null, expired: true }) as typeof fetch), { attempts: 3, intervalMs: 1 }),
      (error) => error instanceof TransactionExpiredError && error.message === SOLANA_TRANSACTION_EXPIRED,
    );
    assert.equal(asked[0], "/api/receipts/solana/sig?lastValidBlockHeight=999");
    assert.deepEqual(await solanaReceiptSource("sig", undefined, answer({ receipt: { status: "0x1", blockNumber: "0x2a" } }) as typeof fetch)(), { status: "0x1", blockNumber: "0x2a" });
    assert.equal(asked.at(-1), "/api/receipts/solana/sig");
    assert.equal(await solanaReceiptSource("sig", "1e9", answer({ receipt: null }) as typeof fetch)(), null);
    assert.equal(asked.at(-1), "/api/receipts/solana/sig", "only a block height is passed on");
    assert.equal(await solanaReceiptSource("sig", "999", answer({ error: "down" }, 503) as typeof fetch)(), null, "an outage counts as not landed yet");
    assert.equal(await solanaReceiptSource("sig", "999", (async () => { throw new TypeError("offline"); }) as typeof fetch)(), null);
  });

  describe("over HTTP", () => {
    let server: Server;
    let origin: string;
    let cookie: string;

    before(async () => {
      const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "solana-dropped-transactions-secret-32ch" });
      const identities = new VerifiedIdentityService();
      identities.link(RECIPIENT, { platform: "x", providerUserId: "x-22", username: "nora", verifiedAt: "2026-10-06T10:00:00.000Z" });
      const solana = {
        config,
        transfers: service(),
        addresses: { solana: async (wallet: string) => getAddress(wallet) === RECIPIENT ? RECIPIENT_SOL : SENDER_SOL },
      } as unknown as SolanaDesk;
      const app = createApp({ auth, identities, solana });
      server = await new Promise<Server>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      origin = `http://127.0.0.1:${address.port}`;
      const wallet = privateKeyToAccount(generatePrivateKey());
      const challenge = await (await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address }) })).json() as { id: string; message: string };
      const verify = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address, challengeId: challenge.id, signature: await wallet.signMessage({ message: challenge.message }) }) });
      cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0];
    });

    after(async () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

    it("answers a confirm for a transaction that can no longer land with 410 and expired", async () => {
      const confirm = (extra: Record<string, unknown>) => fetch(`${origin}/api/solana/transfers/confirm`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ signature: signature(), asset: { symbol: "USDC", mint: SOLANA_USDC.mint }, recipients: [{ platform: "x", username: "nora", amount: "1", units: "1000000" }], ...extra }),
      });
      const expired = await confirm({ lastValidBlockHeight: "999" });
      assert.equal(expired.status, 410);
      assert.deepEqual(await expired.json(), { error: SOLANA_TRANSACTION_EXPIRED, expired: true });
      const waiting = await confirm({});
      assert.equal(waiting.status, 400);
      assert.match((await waiting.json() as { error: string }).error, /not confirmed this transaction yet/);
      assert.equal((await confirm({ lastValidBlockHeight: "soon" })).status, 400, "a last valid height is digits only");
    });

    it("answers a receipt read with expired once the transaction can no longer land", async () => {
      const sent = signature();
      const read = async (query: string) => (await fetch(`${origin}/api/receipts/solana/${sent}${query}`, { headers: { Cookie: cookie } })).json();
      assert.deepEqual(await read("?lastValidBlockHeight=999"), { receipt: null, expired: true });
      assert.deepEqual(await read("?lastValidBlockHeight=5000"), { receipt: null });
      assert.deepEqual(await read(""), { receipt: null });
      assert.deepEqual(await read("?lastValidBlockHeight=-1"), { receipt: null });
    });
  });
});
