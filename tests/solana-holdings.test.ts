import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { readSolanaConfig } from "../server/solana-network";
import type { SolanaDesk } from "../server/solana-routes";
import { MemorySolanaTransferRepository, SolanaTransferService, type SolanaHoldings } from "../server/solana-transfer-service";
import { SOLANA_MAINNET } from "../src/domain/solana-chains";
import { WalletAuthService } from "../server/wallet-auth";

const PRIVY_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

async function signIn(origin: string, key = generatePrivateKey()) {
  const wallet = privateKeyToAccount(key);
  const challenge = await (await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address }) })).json() as { id: string; message: string };
  const verify = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address, challengeId: challenge.id, signature: await wallet.signMessage({ message: challenge.message }) }) });
  return { address: getAddress(wallet.address), cookie: (verify.headers.get("set-cookie") ?? "").split(";")[0] };
}

/**
 * What an account's own Solana address holds, including a wallet Privy made for it, so tokens paid there are never
 * out of view. The desk reads it for the session's own account only, as a wallet shows it.
 */
describe("GET /api/solana/holdings", () => {
  let server: Server;
  let origin: string;
  const solanaOf = new Map<string, string>();
  const read: string[] = [];
  let answer: SolanaHoldings | undefined = { sol: "0", tokens: [{ symbol: "GOOGLx", name: "Alphabet", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", amount: "0.25" }] };

  before(async () => {
    const solana = {
      config: readSolanaConfig({ SOLANA_RPC_URL: "https://localhost.invalid/", SOLANA_TREASURY_ADDRESS: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH" }),
      transfers: { holdings: async (owner: string) => { read.push(owner); return answer; } },
      addresses: { solana: async (wallet: string) => solanaOf.get(getAddress(wallet)) },
    } as unknown as SolanaDesk;
    const app = createApp({ auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "solana-holdings-test-secret-32-characters" }), solana });
    server = await new Promise<Server>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  it("needs the wallet session", async () => {
    assert.equal((await fetch(`${origin}/api/solana/holdings`)).status, 401);
  });

  it("reads the session account's own Solana address and nothing else", async () => {
    const session = await signIn(origin);
    solanaOf.set(session.address, PRIVY_WALLET);
    const response = await fetch(`${origin}/api/solana/holdings`, { headers: { Cookie: session.cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { address: PRIVY_WALLET, sol: "0", tokens: [{ symbol: "GOOGLx", name: "Alphabet", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", amount: "0.25" }] });
    assert.deepEqual(read, [PRIVY_WALLET]);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("answers an account without a Solana address without reading Solana, and says when Solana cannot be read", async () => {
    read.length = 0;
    const fresh = await signIn(origin);
    assert.deepEqual(await (await fetch(`${origin}/api/solana/holdings`, { headers: { Cookie: fresh.cookie } })).json(), { address: null, sol: "0", tokens: [] });
    assert.deepEqual(read, []);
    solanaOf.set(fresh.address, PRIVY_WALLET);
    answer = undefined;
    const down = await fetch(`${origin}/api/solana/holdings`, { headers: { Cookie: fresh.cookie } });
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { error: "Solana could not be read just now. Try again in a moment.", address: PRIVY_WALLET });
  });
});

describe("SolanaTransferService.holdings", () => {
  it("keeps an xStock whose multiplier cannot be read, so an address that holds it never reads as empty", async () => {
    // Audit, 2026-10-06: a failed mint read dropped the only token, the address read as empty, and the desk replaced it.
    const call = <T>(value: T | (() => T)) => ({ send: async () => (typeof value === "function" ? (value as () => T)() : value) });
    const rpc = {
      getGenesisHash: () => call(SOLANA_MAINNET.genesisHash),
      getBalance: () => call({ value: 0n }),
      getTokenAccountsByOwner: (_owner: string, filter: { programId: string }) => call({
        value: filter.programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
          ? [{ account: { data: { parsed: { info: { mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", tokenAmount: { amount: "1234567" } } } } } }]
          : [],
      }),
      getAccountInfo: () => call(() => { throw new Error("HTTP error (429): Too Many Requests"); }),
    };
    const service = new SolanaTransferService({
      config: readSolanaConfig({ SOLANA_TREASURY_ADDRESS: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH" }),
      rpc: rpc as never,
      repository: new MemorySolanaTransferRepository(),
    });
    assert.deepEqual(await service.holdings(PRIVY_WALLET), { sol: "0", tokens: [{ symbol: "GOOGLx", name: "Alphabet", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", amount: "0.01234567" }] });
  });
});
