import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatDraft, type SenderHoldings, type SolanaChatDesk, type UsdcClaimAvailability } from "../server/chat-service";
import type { StockClaimAvailability } from "../src/domain/stock-claims";
import { readNetworkWords, readSolanaAmount } from "../src/domain/solana-intent";
import { NO_SOL_SENDING } from "../src/domain/solana-assets";

const wallets: Record<string, `0x${string}`> = {
  "x:bob": "0x00000000000000000000000000000000000000b0",
  "x:dave": "0x00000000000000000000000000000000000000d0",
  "x:carol": "0x00000000000000000000000000000000000000c0",
  "x:me": "0x00000000000000000000000000000000000000a1",
};
const solanaAddresses: Record<string, string> = {
  "x:bob": "BobSo1anaAddress1111111111111111111111111111",
  "x:dave": "DaveSo1anaAddress111111111111111111111111111",
};
const resolve = (platform: string, username: string) => wallets[`${platform}:${username}`];

function desk(overrides: Partial<SolanaChatDesk> = {}): SolanaChatDesk {
  return {
    transfers: { enabled: true },
    stocks: { enabled: true },
    vault: { enabled: true, platforms: ["github", "x", "farcaster", "discord", "telegram"] },
    addressOf: (platform, username) => solanaAddresses[`${platform}:${username}`],
    senderAddress: "SenderSo1anaAddress11111111111111111111111111",
    ...overrides,
  };
}

/** The desk's answer as the server reads it, with Solana on, from the session wallet 0x…a1. */
async function read(message: string, options: {
  solana?: SolanaChatDesk | null;
  answering?: string;
  ai?: (message: string) => Promise<unknown>;
  stockTransfers?: boolean;
  stockClaims?: StockClaimAvailability;
  usdcClaims?: UsdcClaimAvailability;
  holdings?: SenderHoldings;
  signedOut?: boolean;
} = {}) {
  const result = await createChatDraft(
    message,
    options.ai,
    resolve,
    "Arc Mainnet",
    "robinhood-mainnet",
    options.stockTransfers ?? true,
    options.stockClaims ?? { enabled: false },
    options.usdcClaims ?? { enabled: false },
    {
      sender: options.signedOut ? undefined : wallets["x:me"],
      solana: options.solana === null ? undefined : options.solana ?? desk(options.signedOut ? { senderAddress: undefined } : {}),
      holdings: options.holdings,
      ...(options.answering ? { answering: { request: options.answering } } : {}),
    },
  );
  return result as typeof result & { solana?: { asset: { symbol: string; mint?: string; decimals: number; scaled?: boolean }; mode: string; payments: Array<{ recipient: { platform: string; username: string }; address: string; amount: string }>; totalAmount: string; note?: string; recipient?: { username: string }; amount?: string }; question?: { request: string; choices: string[] } };
}

describe("network words", () => {
  it("finds Solana, Arc and Robinhood Chain in English and Turkish and takes them out of the request", () => {
    assert.deepEqual(readNetworkWords("Send 5 USDC to @bob on X on Solana"), { networks: ["solana"], text: "Send 5 USDC to @bob on X" });
    assert.deepEqual(readNetworkWords("Solana'da @bob'a 5 usdc gönder").networks, ["solana"]);
    assert.deepEqual(readNetworkWords("solana ağında bob'a 5 usdc at").text, "bob'a 5 usdc at");
    assert.deepEqual(readNetworkWords("Arc üzerinden @bob'a 5 USDC").networks, ["arc"]);
    assert.deepEqual(readNetworkWords("Send 2 TSLA to @bob on X via Robinhood Chain").networks, ["robinhood"]);
    assert.deepEqual(readNetworkWords("Send 5 USDC to @solana on X").networks, [], "a handle is not a network");
    assert.deepEqual(readNetworkWords("Send 1 SOL to @bob on X").networks, [], "SOL is an asset");
    assert.deepEqual(readNetworkWords("search the archive").networks, []);
  });

  it("reads one amount of one listed Solana asset, and SOL only to say it is not sent", () => {
    // HaPaPay sends stablecoins and stocks, not SOL.
    assert.deepEqual(readSolanaAmount("Send 0.5 SOL to @bob"), { status: "invalid", message: NO_SOL_SENDING, final: true });
    assert.deepEqual(readSolanaAmount("send 0.5 sol to bob"), { status: "invalid", message: NO_SOL_SENDING, final: true });
    assert.deepEqual(readSolanaAmount("Send five SOL to @bob"), { status: "invalid", message: NO_SOL_SENDING, final: true });
    assert.deepEqual(readSolanaAmount("Send 0.5 USDG to @bob").status, "found");
    assert.equal((readSolanaAmount("Send 2 TSLAx to @bob") as { asset: { symbol: string } }).asset.symbol, "TSLAx");
    assert.equal((readSolanaAmount("Send 2 TSLA to @bob") as { asset: { symbol: string } }).asset.symbol, "TSLAx");
    assert.equal((readSolanaAmount("Send $5 to @bob") as { asset: { symbol: string } }).asset.symbol, "USDC");
    assert.equal((readSolanaAmount("Send five USDC to @bob") as { amount: string }).amount, "5");
    assert.match((readSolanaAmount("Send 0.0000001 USDC to @bob") as { message: string }).message, /6 decimal places/);
    assert.match((readSolanaAmount("Send 1 TSLAx and 2 USDC to @bob") as { message: string }).message, /one asset at a time/);
    assert.equal(readSolanaAmount("hello there").status, "none");
  });
});

describe("Solana as the main network in the chat", () => {
  it("sends xStocks written with their x on Solana, where they live, and never SOL", async () => {
    const sol = await read("Send 0.5 SOL to @bob on X");
    assert.equal(sol.status, "needs_clarification");
    assert.equal(sol.message, NO_SOL_SENDING);
    const usdg = await read("Send 0.5 USDG to @bob on X on Solana");
    assert.deepEqual(usdg.solana!.payments, [{ recipient: { platform: "x", username: "bob" }, address: solanaAddresses["x:bob"], amount: "0.5" }]);
    assert.equal(usdg.solana!.asset.decimals, 6);
    const stock = await read("Send 2 TSLAx to @bob on X");
    assert.equal(stock.status, "solana_review");
    assert.equal(stock.solana!.asset.symbol, "TSLAx");
    assert.equal(stock.solana!.asset.scaled, true);
  });

  it("sends USDC on Solana when the sender and the recipient both have Solana addresses, and says how to use Arc", async () => {
    const result = await read("Send 5 USDC to @bob on X");
    assert.equal(result.status, "solana_review");
    assert.match(result.message, /write “on Arc” to send it there instead/);
  });

  it("keeps USDC on Arc for a recipient without a Solana address, or a sender without one", async () => {
    assert.equal((await read("Send 5 USDC to @carol on X")).status, "ready_for_review");
    assert.equal((await read("Send 5 USDC to @bob on X", { solana: desk({ senderAddress: undefined }) })).status, "ready_for_review");
  });

  it("follows the network the request names, in English or Turkish", async () => {
    assert.equal((await read("Send 5 USDC to @bob on X on Arc")).status, "ready_for_review");
    const turkish = await read("X'te @bob'a solana üzerinden 5 USDC gönder");
    assert.equal(turkish.status, "solana_review");
    assert.equal(turkish.solana!.payments[0].address, solanaAddresses["x:bob"]);
    const viaSolana = await read("Send 5 USDC to bob on X via Solana");
    assert.equal(viaSolana.status, "solana_review", "the network word is never read as a handle");
  });

  it("says what a named network does not carry instead of moving it elsewhere", async () => {
    assert.match((await read("Send 1 TSLAx to @bob on X on Arc")).message, /TSLAx moves only on Solana/);
    assert.equal((await read("Send 1 SOL to @bob on X on Arc")).message, NO_SOL_SENDING);
    assert.match((await read("Send 5 USDC to @bob on X on Robinhood")).message, /Robinhood Chain carries Stock Tokens and USDG here/);
    assert.match((await read("Send 5 USDC to @bob on X on Solana and Arc")).message, /Name one network/);
    assert.match((await read("Send 5 USDC to @carol on X on Solana")).message, /@carol has not added a Solana address/);
    // A Stock Token with no xStock is named, not asked for again.
    assert.equal((await read("Send 1 COST to @bob on X on Solana")).message, "COST moves only on Robinhood Chain. Write the request without “on Solana”.");
    assert.match((await read("Solana'da @bob'a x'te 1 COST gönder")).message, /^COST moves only on Robinhood Chain/);
    // Arc carries USDC only, so no Stock Token written "on Arc" is drafted on Robinhood Chain, two-letter tickers included.
    for (const request of ["Send 2 BB to @bob on X on Arc", "Send 2 $NU to @bob on X via Arc", "send 2 cost to @bob on x on arc",
      "Send 2 BB to @bob and 3 BB to @dave on X on Arc", "Send 2 nvda to @bob and 3 nvda to @dave on X on Arc"]) {
      assert.match((await read(request)).message, /^Arc carries USDC here/, request);
    }
    // A ticker Solana lists is never told it moves only on Robinhood Chain, even with a Turkish ending on it.
    assert.equal((await read("Send 2 TSLA to @bob on X on Robinhood Chain")).status, "stock_review");
    assert.match((await read("Solana'da @bob'a x'te 1 AAPLı gönder")).message, /^Add the amount and the asset/);
    // "sats" are satoshis, not the SATS Stock Token.
    assert.match((await read("Send 1000 sats to @bob on X on Solana")).message, /^Add the amount and the asset/);
    assert.match((await read("send 5000 sats to @bob on X")).message, /^Name the asset after the amount/);
  });

  it("leaves words that only look like tickers in a request that names its own asset", async () => {
    assert.equal((await read("Send 5 USDC to @bob on X on Solana to cover the COST of lunch")).status, "solana_review");
    assert.equal((await read("send 2 cost to @bob on x on robinhood chain for 3 uber rides")).status, "stock_review");
    assert.equal((await read("Send 5 USDC to @bob on X on Arc, he lives in UTC -3")).status, "ready_for_review");
    // An amount in dollars for each person stays USDC on Arc, whatever else reads as a ticker.
    for (const request of ["Send $10 to @bob and $5 to @dave on X via Arc for apt 3F", "@bob $10, @dave $5 on X on Arc, two PR reviews",
      "Send 10 dolars to @bob and 5 dolars to @dave on X via Arc for apt 3F", "Send $10 to @bob and 5 to @dave on X on Arc for seat 14F",
      "Arc üzerinden @bob'a 10, @dave'e 5 dolar x'te gönder, daire 3F için"]) {
      assert.equal((await read(request)).status, "batch_review", request);
    }
    // Otherwise a Robinhood Chain ticker written "on Arc" is never drafted there, beside a dollar figure too.
    for (const request of ["Send $10 to @bob on X via Arc for apt 3F", "Send 2 $NU to @bob on X on Arc for the $5 lunch"]) {
      assert.match((await read(request)).message, /^Arc carries USDC here/, request);
    }
  });

  it("sends on the network written in the request, with the reason last, as the README says", async () => {
    assert.equal((await read("Send 5 USDC to @bob on X on Arc for rent")).status, "ready_for_review");
    assert.equal((await read("Arc üzerinden @bob'a x'te 5 USDC gönder, kira için")).status, "ready_for_review");
    const solana = await read("Solana'da @bob'a x'te 2 TSLA gönder, kira için");
    assert.equal(solana.status, "solana_review");
    assert.equal(solana.solana!.note, "kira için");
  });

  it("keeps the network a request names when the AI reader finds who it pays", async () => {
    const reading = (extra: Record<string, unknown>) => async () => ({ kind: "send", amount: "5", asset: "USDC", recipients: [], sourcePlatform: "unstated", note: "", ...extra });
    const arc = await read("send 5 usdc on x: bob; dave via Arc", { ai: reading({ recipients: [{ username: "bob", platform: "x" }, { username: "dave", platform: "x" }] }) });
    assert.match(arc.message, /^Reading that as “Send 5 USDC to @bob and @dave on X on Arc”/);
    const each = await read("each", { answering: arc.question!.request, ai: reading({}) });
    assert.equal(each.status, "batch_review");
    const nvda = await read("send 2 NVDA on x: bob on Robinhood Chain", { ai: reading({ amount: "2", asset: "NVDA", recipients: [{ username: "bob", platform: "x" }] }) });
    assert.match(nvda.message, /^Reading that as “Send 2 NVDA to @bob on X on Robinhood Chain”/);
    assert.equal(nvda.status, "stock_review");
    // A note that names a network does not take the written one away.
    const noted = await read("send 2 NVDA on x: bob on Robinhood Chain, note: Solana meetup", { ai: reading({ amount: "2", asset: "NVDA", recipients: [{ username: "bob", platform: "x" }] }) });
    assert.equal(noted.status, "stock_review");
    const asked = await read("Send 5 USDC to @bob and @dave on X via Arc, note: Arc meetup");
    assert.equal((await read("each", { answering: asked.question!.request })).status, "batch_review");
  });

  it("sends a ticker as Robinhood's Stock Token on the main network, and as Solana's xStock when written so", async () => {
    // Robinhood Chain is the main network for Stock Tokens.
    assert.equal((await read("Send 2 TSLA to @bob on X")).status, "stock_review");
    assert.equal((await read("Send 2 TSLAx to @bob on X")).status, "solana_review");
    assert.equal((await read("Send 2 TSLA to @bob on X on Solana")).status, "solana_review");
    const off = desk({ stocks: { enabled: false, reason: "xStocks transfers on Solana are turned off on this server." } });
    assert.equal((await read("Send 2 TSLA to @bob on X", { solana: off })).status, "stock_review");
    assert.match((await read("Send 2 TSLAx to @bob on X", { solana: off })).message, /xStocks transfers on Solana are turned off/);
  });

  it("offers Robinhood's ticker for shares or a company name, the main network's, and the xStock only for a stock Robinhood Chain does not list", async () => {
    // Robinhood Chain is the main network, so "2 apple shares" is offered as AAPL, not AAPLx.
    const shares = await read("send 2 apple shares to @bob on X");
    assert.match(shares.message, /^Stock Tokens move in token units, not shares\. Write it as “Send 2 AAPL to @bob on X”/);
    assert.deepEqual((shares as { suggestions?: string[] }).suggestions, ["Send 2 AAPL to @bob on X"]);
    const company = await read("send 2 nvidia to @bob on X");
    assert.equal(company.message, "Stock Tokens go by their ticker: NVIDIA is NVDA. Write it as “Send 2 NVDA to @bob on X”.");
    assert.equal((await read("send 2 ABNB to @bob on X")).status, "solana_review", "Robinhood Chain does not list ABNB; Solana carries ABNBx");
    const named = await read("send 2 apple shares on Robinhood Chain to @bob on X");
    assert.match(named.message, /^Stock Tokens move in token units, not shares\. Write it as “Send 2 AAPL to @bob on X”/);
    const off = await read("send 2 apple shares to @bob on X", { solana: desk({ stocks: { enabled: false, reason: "off" } }) });
    assert.match(off.message, /^Stock Tokens move in token units/, "with xStocks off, Robinhood's ticker stays");
    const unaddressed = await read("send apple shares to someone");
    assert.doesNotMatch(unaddressed.message, /Robinhood/);
    assert.equal((unaddressed as { suggestions?: string[] }).suggestions, undefined, "an incomplete request is shown, not offered");
  });

  it("pays several people in one Solana review, each or split, and asks when it cannot tell", async () => {
    const each = await read("Send 5 USDC each to @bob and @dave on X");
    assert.equal(each.status, "solana_review");
    assert.equal(each.solana!.mode, "each");
    assert.equal(each.solana!.totalAmount, "10");
    const split = await read("Split 9 USDC between @bob and @dave on X");
    assert.deepEqual(split.solana!.payments.map(({ amount }) => amount), ["4.5", "4.5"]);
    const asked = await read("Send 5 USDC to @bob and @dave on X on Solana");
    assert.equal(asked.status, "needs_clarification");
    assert.deepEqual(asked.question!.choices, ["Send 5 USDC each to @bob and @dave on X on Solana", "Split 5 USDC between @bob and @dave on X on Solana"]);
    const answered = await read("each", { answering: asked.question!.request });
    assert.equal(answered.status, "solana_review");
    assert.equal(answered.solana!.totalAmount, "10");
  });

  it("pays each person the amount written for them in one Solana review, and never turns one asset into another", async () => {
    // Different amounts per person in one request.
    const paidOn = (result: Awaited<ReturnType<typeof read>>) => result.solana!.payments.map(({ recipient, amount }) => `${recipient.username}=${amount}`);
    for (const [message, expected, total] of [
      ["Send 10 USDC to @bob and 5 USDC to @dave on X", ["bob=10", "dave=5"], "15"],
      ["Send 1 USDG to @bob and 0.5 USDG to @dave on X on Solana", ["bob=1", "dave=0.5"], "1.5"],
      ["@bob'a 2 TSLAx, @dave'e 1 TSLAx gönder x'te", ["bob=2", "dave=1"], "3"],
    ] as const) {
      const result = await read(message);
      assert.equal(result.status, "solana_review", `${message}: ${result.message}`);
      assert.equal(result.solana!.mode, "listed", message);
      assert.deepEqual(paidOn(result), expected, message);
      assert.equal(result.solana!.totalAmount, total, message);
    }
    assert.equal((await read("send 10 USDC to @bob and 2 TSLAx to @dave on X")).message, "Send one asset at a time.");
    assert.equal((await read("send 1 TSLAx to @bob and 0.000000001 TSLAx to @dave on X")).message, "TSLAx has 8 decimal places. Write at most 8 digits after the point for @dave.");
    assert.equal((await read("send 10 USDC to @bob and 2 SOL to @dave on X")).message, NO_SOL_SENDING);
    // Someone without a Solana address: USDC goes on Arc, each with their own amount, as before for one amount.
    const arc = await read("Send 10 USDC to @bob and 5 USDC to @carol on X");
    assert.equal(arc.status, "batch_review", arc.message);
  });

  it("asks the platform with choices that keep saying Solana", async () => {
    const asked = await read("Send 5 USDC to @bob on Solana");
    assert.equal(asked.status, "needs_clarification");
    assert.ok(asked.question!.choices.includes("Send 5 USDC to @bob on X on Solana"));
    assert.deepEqual(suggestionsOf(asked), ["Send 5 USDC to @bob on X on Solana"], "the platform where @bob is verified is offered");
    const answered = await read("X", { answering: asked.question!.request });
    assert.equal(answered.status, "solana_review");
  });

  it("offers a Solana vault link to an account that has not joined, for tokens and never for SOL", async () => {
    const link = await read("Send 5 USDC to @newbie on GitHub on Solana");
    assert.equal(link.status, "solana_claim_review");
    assert.deepEqual([link.solana!.recipient!.username, link.solana!.amount], ["newbie", "5"]);
    // HaPaPay sends no SOL, so no vault link holds it.
    const sol = await read("Send 0.001 SOL to @newbie on GitHub");
    assert.equal(sol.status, "needs_clarification");
    assert.equal(sol.message, NO_SOL_SENDING);
    const stock = await read("Send 1 TSLAx to @newbie on GitHub");
    assert.equal(stock.status, "solana_claim_review", stock.message);
    assert.match(stock.message, /keep the TSLAx in the Solana vault/);
    // Discord cannot be looked up before the person joins, so the link waits for the Discord name (2026-10-06).
    const discord = await read("discord üzerinde @newcomer 1 usdc gönder");
    assert.equal(discord.status, "solana_claim_review", discord.message);
    assert.match(discord.message, /for the Discord name @newcomer: whoever connects Discord to HaPaPay with that name claims it/);
    assert.equal((discord as { vaultLock?: string }).vaultLock, "name");

  });

  it("carries the note and leaves the sender's own wallet out", async () => {
    const noted = await read("Send 5 USDC to @bob on X on Solana, note: lunch");
    assert.equal(noted.solana!.note, "lunch");
    assert.match((await read("Send 1 TSLAx to @me on X")).message, /your own wallet/);
  });

  it("leaves everything as it was on a server that does not run Solana", async () => {
    assert.equal((await read("Send 5 TSLAx to @bob on X", { solana: null })).message, "TSLAx moves only on Solana, which this server does not run. It sends USDC on Arc and Stock Tokens and USDG on Robinhood Chain.");
    assert.equal((await read("Send 5 SOL to @bob on X", { solana: null })).message, NO_SOL_SENDING);
    assert.equal((await read("Send 5 USDC to @bob on X", { solana: null })).status, "ready_for_review");
  });
});

function suggestionsOf(result: object) {
  return (result as { suggestions?: string[] }).suggestions;
}

describe("the network the sender's wallet holds the asset on", () => {
  /** Balances as a wallet shows them, by network and symbol, and every read asked for; a missing entry cannot be read. */
  function holdings(held: Record<string, string | Promise<string>>, reads: string[] = [], waitMs?: number): SenderHoldings {
    return {
      solana: async (asset) => { reads.push(`solana:${asset.symbol}`); return held[`solana:${asset.symbol}`]; },
      evm: async (network, symbol) => { reads.push(`${network}:${symbol}`); return held[`${network}:${symbol}`]; },
      ...(waitMs ? { waitMs } : {}),
    };
  }
  const vault: StockClaimAvailability = { enabled: true, escrow: "0x0000000000000000000000000000000000000e5c", platforms: ["github", "x", "farcaster", "discord", "telegram"] };
  const stockOf = (result: object) => (result as { stockIntent?: { asset: { symbol: string }; amount: string } }).stockIntent;

  it("sends a ticker on Robinhood Chain, the main network, and on Solana only when the wallet holds it there alone", async () => {
    // The sender's wallets choose the network, and Robinhood Chain is the main one.
    const home = await read("Send 2 NVDA to @bob on X", { holdings: holdings({ "solana:NVDAx": "10", "robinhood:NVDA": "5" }) });
    assert.equal(home.status, "stock_review");
    assert.equal(stockOf(home)?.asset.symbol, "NVDA");
    assert.equal(stockOf(home)?.amount, "2");
    assert.doesNotMatch(home.message, /your wallet holds/i, "nothing to say when the main network holds enough");
    const kept = await read("Send 2 NVDA to @bob on X", { holdings: holdings({ "solana:NVDAx": "10", "robinhood:NVDA": "1" }) });
    assert.equal(kept.status, "solana_review");
    assert.equal(kept.solana!.asset.symbol, "NVDAx");
    assert.match(kept.message, /It goes on Solana: your wallet holds 10 NVDAx on Solana and 1 NVDA on Robinhood Chain\. Write “on Robinhood Chain” to send NVDA there instead\.$/);
    assert.equal(kept.message.match(/It goes on Solana/g)?.length, 1, "said once");
    // Enough means the amount and the 1% fee on top.
    const exact = await read("Send 2 NVDA to @bob on X", { holdings: holdings({ "solana:NVDAx": "2.02", "robinhood:NVDA": "2.02" }) });
    assert.equal(exact.status, "stock_review", "2.02 NVDA can pay 2 NVDA and its fee");
    const short = await read("Send 2 NVDA to @bob on X", { holdings: holdings({ "solana:NVDAx": "2.02", "robinhood:NVDA": "2.019999" }) });
    assert.equal(short.status, "solana_review");
    const neither = await read("Send 2 NVDA to @bob on X", { holdings: holdings({ "solana:NVDAx": "2", "robinhood:NVDA": "2.019999" }) });
    assert.equal(neither.status, "stock_review");
    assert.match(neither.message, /Your wallet holds 2\.019999 NVDA on Robinhood Chain and 2 NVDAx on Solana, less than this payment and its 1% fee on either\.$/);
  });

  it("sends USDG on Robinhood Chain, and USDC on Solana or on Arc where the wallet holds it", async () => {
    const usdc = await read("Send 25 USDC to @bob on X", { holdings: holdings({ "solana:USDC": "0", "arc:USDC": "100.5" }) });
    assert.equal(usdc.status, "ready_for_review");
    assert.equal(usdc.intent?.amount, "25");
    assert.match(usdc.message, /It goes on Arc Mainnet: your wallet holds 100\.5 USDC on Arc Mainnet and 0 USDC on Solana\./);
    const usdg = await read("Send 5 USDG to @bob on X", { holdings: holdings({ "solana:USDG": "50", "robinhood:USDG": "50" }) });
    assert.equal(usdg.status, "stock_review");
    assert.equal(stockOf(usdg)?.asset.symbol, "USDG");
    const usdgOnSolana = await read("Send 5 USDG to @bob on X", { holdings: holdings({ "solana:USDG": "50", "robinhood:USDG": "1" }) });
    assert.equal(usdgOnSolana.status, "solana_review");
    assert.match(usdgOnSolana.message, /It goes on Solana: your wallet holds 50 USDG on Solana and 1 USDG on Robinhood Chain\./);
    // Long balances are cut to six decimals, never rounded up.
    const long = await read("Send 25 USDC to @bob on X", { holdings: holdings({ "solana:USDC": "0.000001", "arc:USDC": "100.123456789" }) });
    assert.match(long.message, /holds 100\.123456 USDC on Arc Mainnet and 0\.000001 USDC on Solana/);
  });

  it("sends a vault link and a payment to several people on Robinhood Chain too, but only when it can pay everyone", async () => {
    const link = await read("Send 2 NVDA to @newbie on GitHub", { stockClaims: vault, holdings: holdings({ "solana:NVDAx": "0", "robinhood:NVDA": "5" }) });
    assert.equal(link.status, "stock_claim_review");
    assert.match(link.message, /Robinhood Chain vault/);
    const keptLink = await read("Send 2 NVDA to @newbie on GitHub", { stockClaims: vault, holdings: holdings({ "solana:NVDAx": "9", "robinhood:NVDA": "0" }) });
    assert.equal(keptLink.status, "solana_claim_review");
    assert.match(keptLink.message, /Solana vault.*It goes on Solana: your wallet holds 9 NVDAx on Solana and 0 NVDA on Robinhood Chain/);
    const noVault = await read("Send 2 NVDA to @newbie on GitHub", { holdings: holdings({ "solana:NVDAx": "0", "robinhood:NVDA": "5" }) });
    assert.equal(noVault.status, "solana_claim_review", "without a Robinhood Chain vault the link stays on Solana");
    const batch = await read("Send 1 NVDA each to @bob and @dave on X", { holdings: holdings({ "solana:NVDAx": "0", "robinhood:NVDA": "5" }) });
    assert.equal(batch.status, "batch_review");
    const keptBatch = await read("Send 1 NVDA each to @bob and @dave on X", { holdings: holdings({ "solana:NVDAx": "9", "robinhood:NVDA": "0" }) });
    assert.equal(keptBatch.status, "solana_review");
    assert.match(keptBatch.message, /It goes on Solana: your wallet holds 9 NVDAx on Solana and 0 NVDA on Robinhood Chain/);
    const off = await read("Send 2 NVDA to @bob on X", { stockTransfers: false, holdings: holdings({ "solana:NVDAx": "0", "robinhood:NVDA": "5" }) });
    assert.equal(off.status, "solana_review", "Stock Token transfers that are off never take a request");
  });

  it("reads no balance when the request names a network, the asset lives only on Solana, or nobody is signed in", async () => {
    const reads: string[] = [];
    const held = holdings({ "solana:NVDAx": "0", "robinhood:NVDA": "5", "solana:SOL": "0" }, reads);
    assert.equal((await read("Send 2 NVDA to @bob on X on Solana", { holdings: held })).status, "solana_review", "a named network is followed");
    assert.equal((await read("Send 2 NVDAx to @bob on X", { holdings: held })).status, "solana_review", "an xStock written with its x lives on Solana");
    assert.equal((await read("Send 0.5 SOL to @bob on X", { holdings: held })).message, NO_SOL_SENDING);
    assert.equal((await read("Send 2 NVDA to @bob on X on Robinhood Chain", { holdings: held })).status, "stock_review");
    assert.deepEqual(reads, []);
    const signedOut = await read("Send 2 NVDA to @bob on X", { signedOut: true, holdings: held });
    assert.equal(signedOut.status, "stock_review", "a visitor's ticker goes on the main network");
    assert.deepEqual(reads, [], "a visitor's request reads nothing");
  });

  it("goes on the main network when a balance cannot be read in time", async () => {
    const started = Date.now();
    const slow = await read("Send 2 NVDA to @bob on X", { holdings: holdings({ "solana:NVDAx": new Promise<string>(() => undefined), "robinhood:NVDA": "0" }, [], 30) });
    assert.equal(slow.status, "stock_review");
    assert.doesNotMatch(slow.message, /your wallet holds/i);
    assert.ok(Date.now() - started < 2_000, "the reply does not wait on a slow RPC");
    const unknownHome = await read("Send 2 NVDA to @bob on X", { holdings: holdings({ "solana:NVDAx": "9" }) });
    assert.equal(unknownHome.status, "stock_review");
    const garbled = await read("Send 2 NVDA to @bob on X", { holdings: holdings({ "solana:NVDAx": "9", "robinhood:NVDA": "5e3" }) });
    assert.equal(garbled.status, "stock_review", "only a plain decimal is a balance");
    const failing: SenderHoldings = { solana: async () => { throw new Error("rpc down"); }, evm: async () => "0" };
    assert.equal((await read("Send 2 NVDA to @bob on X", { holdings: failing })).status, "stock_review");
  });

  it("says when the wallet holds the asset only on Solana but someone it pays has no Solana address", async () => {
    const one = await read("Send 2 NVDA to @carol on X", { holdings: holdings({ "solana:NVDAx": "9", "robinhood:NVDA": "0" }) });
    assert.equal(one.status, "stock_review");
    assert.match(one.message, /Your wallet holds 9 NVDAx on Solana but 0 NVDA on Robinhood Chain; @carol has not added a Solana address yet, so this goes on Robinhood Chain\.$/);
    const several = await read("Send 1 NVDA each to @bob and @carol on X", { holdings: holdings({ "solana:NVDAx": "9", "robinhood:NVDA": "0" }) });
    assert.equal(several.status, "batch_review");
    assert.match(several.message, /@carol has not added a Solana address yet, so this goes on Robinhood Chain\.$/);
    const enough = await read("Send 2 NVDA to @carol on X", { holdings: holdings({ "solana:NVDAx": "9", "robinhood:NVDA": "5" }) });
    assert.doesNotMatch(enough.message, /your wallet holds/i, "nothing to say when the network it goes on holds enough");
  });
});
