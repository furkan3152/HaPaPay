import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatDraft, HELP_REPLY, type RecipientExists, type SolanaChatDesk } from "../server/chat-service";
import { NO_SOL_SENDING } from "../src/domain/solana-assets";

/**
 * The chat audit of 2026-10-06: requests the desk misread, each with what it now does. Solana is on, the sender is the
 * session wallet 0x…a1, and Robinhood Chain transfers are switched on.
 */
const wallets: Record<string, `0x${string}`> = {
  "x:bob": "0x00000000000000000000000000000000000000b0",
  "discord:bob": "0x00000000000000000000000000000000000000b0",
  "x:alice": "0x00000000000000000000000000000000000000a0",
  "x:carol": "0x00000000000000000000000000000000000000c0",
  "x:dave": "0x00000000000000000000000000000000000000d0",
  "x:me": "0x00000000000000000000000000000000000000a1",
  "github:torvalds": "0x00000000000000000000000000000000000000e0",
};
const solanaAddresses: Record<string, string> = {
  "0x00000000000000000000000000000000000000b0": "BobSo1anaAddress1111111111111111111111111111",
  "0x00000000000000000000000000000000000000a0": "AliceSo1anaAddress11111111111111111111111111",
  "0x00000000000000000000000000000000000000d0": "DaveSo1anaAddress111111111111111111111111111",
  "0x00000000000000000000000000000000000000e0": "TorvSo1anaAddress111111111111111111111111111",
};
const resolve = (platform: string, username: string) => wallets[`${platform}:${username}`];

const solana: SolanaChatDesk = {
  transfers: { enabled: true },
  stocks: { enabled: true },
  vault: { enabled: true, platforms: ["github", "x", "farcaster", "discord", "telegram"] },
  addressOf: (platform, username) => solanaAddresses[wallets[`${platform}:${username}`] ?? ""],
  senderAddress: "SenderSo1anaAddress11111111111111111111111111",
};

type Reply = {
  status: string;
  message: string;
  suggestions?: string[];
  network?: string;
  intent?: { amount: string; recipient: { username: string; platform: string } };
  stockIntent?: { amount: string; asset: { symbol: string }; recipient: { username: string; platform: string } };
  solana?: { asset: { symbol: string }; mode: string; totalAmount: string; note?: string; payments: Array<{ recipient: { username: string; platform: string }; amount: string }> };
};

async function read(message: string, options: { answering?: string; exists?: RecipientExists } = {}) {
  return await createChatDraft(
    message,
    undefined,
    resolve,
    "Arc Mainnet",
    "robinhood-mainnet",
    true,
    { enabled: true, escrow: "0x0000000000000000000000000000000000000e5c", platforms: ["github", "x", "farcaster", "discord", "telegram"] },
    { enabled: true, platforms: ["github", "x", "farcaster", "discord", "telegram"] },
    { sender: wallets["x:me"], solana, recipientExists: options.exists, ...(options.answering ? { answering: { request: options.answering } } : {}) },
  ) as unknown as Reply;
}

/** The Solana payment a reply drafts: its asset, total and "username@platform=amount" for each person. */
async function drafted(message: string) {
  const reply = await read(message);
  assert.equal(reply.status, "solana_review", `${message} → ${reply.message}`);
  return { asset: reply.solana!.asset.symbol, total: reply.solana!.totalAmount, pays: reply.solana!.payments.map((payment) => `${payment.recipient.username}@${payment.recipient.platform}=${payment.amount}`), note: reply.solana!.note, mode: reply.solana!.mode };
}

async function asked(message: string, expected: string | RegExp) {
  const reply = await read(message);
  assert.equal(reply.status, "needs_clarification", `${message} → ${reply.status}`);
  if (typeof expected === "string") assert.equal(reply.message, expected, message);
  else assert.match(reply.message, expected, message);
  return reply;
}

describe("the chat audit of 2026-10-06", () => {
  it("reads everyday words as words, and a ticker only in capitals, as a cashtag or as its own symbol", async () => {
    await asked("send @bob 20 now on X", /^Name the asset after the amount/);
    await asked("send 1 coin to @bob on X", /^Name the asset after the amount/);
    await asked("send @bob 10 bro on X", /^Name the asset after the amount/);
    assert.deepEqual((await drafted("send twenty five USDC to @bob on X")).pays, ["bob@x=25"], "five is a number, not Five Below");
    assert.equal((await read("send 2 COIN to @bob on X")).stockIntent?.asset.symbol, "COIN", "Robinhood Chain, the main network, lists COIN");
    assert.equal((await drafted("send 2 COIN to @bob on X on Solana")).asset, "COINx");
  });

  it("reads a ticker as the stock it names before another xStock whose symbol it spells", async () => {
    assert.equal((await drafted("send 1 VRTX to @bob on X")).asset, "VRTXx", "VRTX is Vertex");
    assert.equal((await drafted("send 1 VRTx to @bob on X")).asset, "VRTx", "VRTx is Vertiv");
    assert.equal((await drafted("send 2 GDX to @bob on X")).asset, "GDXx");
  });

  it("never turns a dollar value of another asset into USDC", async () => {
    await asked("send $100 of TSLA to @bob on X", "Write the amount in TSLA, not dollars, for example: Send 2 TSLA to @toly on X.");
    await asked("send $5 worth of SOL to @bob on X", NO_SOL_SENDING);
    await asked("send 5 dollars worth of NVDA to @bob on X", /^Write the amount in NVDA, not dollars/);
  });

  it("refuses a second asset instead of dropping it, on every network", async () => {
    for (const message of ["send 5 usdc and usdg to @bob on X", "send 0.5 USDC and NVDA to @bob on X", "send 2 TSLA and USDC to @bob on X", "send 1 TSLAx and $20 to @bob on X"]) {
      await asked(message, "Send one asset at a time.");
    }
  });

  it("asks which amount is meant when a request names a total and a share", async () => {
    await asked("send 10 USDC to @alice and @bob on X, 5 each", /^This request names two amounts, 10 USDC and 5 each\./);
    await asked("send 2 USDG to @alice and @bob on X (1 each)", /^This request names two amounts, 2 USDG and 1 each\./);
    assert.deepEqual((await drafted("send 10 USDC to @alice and @bob on X, 10 in total")).pays, ["alice@x=5", "bob@x=5"]);
  });

  it("reads scale words, digits with a scale and hyphenated number words", async () => {
    const amounts: Array<[string, string]> = [
      ["send 5 thousand USDC to @bob on X", "5000"],
      ["@bob'a x'te 5 bin usdc gönder", "5000"],
      ["send 2 hundred dollars to @bob on X", "200"],
      ["send 2,5 bin USDC to @bob on X", "2500"],
      ["send twenty-five USDC to @bob on X", "25"],
      ["send ninety-nine dollars to @bob on X", "99"],
    ];
    for (const [message, amount] of amounts) assert.deepEqual((await drafted(message)).pays, [`bob@x=${amount}`], message);
    assert.equal((await read("send forty-two USDG to @bob on X")).stockIntent?.amount, "42", "USDG goes on Robinhood Chain");
  });

  it("pays every name a list joins, with or without the @", async () => {
    const both = await asked("send 5 USDC to @alice and bob on X", /^Should @alice and @bob each get 5 USDC/);
    assert.equal(both.suggestions?.length, 2);
    assert.deepEqual((await drafted("send 5 USDC each to @alice, bob and dave on X")).pays, ["alice@x=5", "bob@x=5", "dave@x=5"]);
  });

  it("never reads a joining word, or a word after for, as a person", async () => {
    for (const message of ["send 5 USDC to bob as well as alice on X", "send 5 USDC to bob plus alice on X", "send 5 USDC to bob and also alice on X", "send 5 USDC to @bob on X for coffee and @alice on X"]) {
      const reply = await asked(message, /^Should @bob and @alice each get 5 USDC \(10 USDC in total\)/);
      assert.deepEqual(reply.suggestions, ["Send 5 USDC each to @bob and @alice on X", "Split 5 USDC between @bob and @alice on X"], message);
    }
    assert.deepEqual((await drafted("X'te bob ve @alice'e 5'er usdc gönder")).pays, ["bob@x=5", "alice@x=5"]);
  });

  it("leaves out whoever a request says not to pay", async () => {
    assert.deepEqual((await drafted("send 5 USDC to @bob on X. Do not send to @alice")).pays, ["bob@x=5"]);
    assert.deepEqual((await drafted("send 5 USDC to @bob and not @alice on X")).pays, ["bob@x=5"]);
    assert.deepEqual((await drafted("send 5 USDC each to @bob and @dave on X except @alice")).pays, ["bob@x=5", "dave@x=5"]);
  });

  it("reads a profile link as the handle and platform it names", async () => {
    assert.deepEqual((await drafted("send 1 USDC to https://github.com/torvalds")).pays, ["torvalds@github=1"]);
    assert.deepEqual((await drafted("send 5 USDC to https://x.com/bob")).pays, ["bob@x=5"]);
    assert.deepEqual((await drafted("send 5 USDC to x.com/bob")).pays, ["bob@x=5"]);
  });

  it("keeps each person's own amount when someone in a Solana request has no Solana address", async () => {
    // TSLA also lives on Robinhood Chain, so the reply says carol can be paid there (it read "send to them or on
    // Robinhood Chain" before this was written down).
    const reply = await asked("send 1 TSLAx each to @bob and @carol on X", "@carol has not added a Solana address yet; you can pay them on Robinhood Chain instead. Pay @bob now?");
    assert.deepEqual(reply.suggestions, ["Send 1 TSLAx to @bob on X"]);
    assert.deepEqual((await asked("send 1 TSLAx to @bob and 2 TSLAx to @carol on X", /^@carol has not added/)).suggestions, ["Send 1 TSLAx to @bob on X"]);
  });

  it("never reads a noun after my, the or this as a handle", async () => {
    await asked("send 0.5 TSLAx to my brother on X", "Add who receives it and where, for example: Send 0.5 TSLAx to @toly on X.");
    await asked("send 10 USDC to my sister on GitHub", /^Add who receives it and where/);
    await asked("send 1 USDC to the team on X", /^Add who receives it and where/);
  });

  it("answers questions, even ones that carry an amount or an asset", async () => {
    for (const message of ["how do I send SOL?", "why did my 5 USDC payment fail", "what is the fee for sending 100 USDC?", "how much is 1 SOL?"]) {
      assert.equal((await read(message)).message, HELP_REPLY, message);
    }
    await asked("send SOL to @bob on X", NO_SOL_SENDING);
  });

  it("reads 25$ as dollars, 1 solana as SOL (which is not sent), and a negative amount as no amount", async () => {
    assert.deepEqual(await drafted("send 25$ to @bob on X"), { asset: "USDC", total: "25", pays: ["bob@x=25"], note: undefined, mode: "single" });
    await asked("send 1 solana to @bob on X", NO_SOL_SENDING);
    await asked("send 0.5 Solana to @bob on X", NO_SOL_SENDING);
    await asked("send -5 USDC to @bob on X", "Enter an amount greater than zero.");
  });

  it("refuses only the clause that asks for money or says not to send, never the payment around it", async () => {
    assert.deepEqual((await drafted("send 20 USDC to @bob on X, he'll pay me back")).pays, ["bob@x=20"]);
    assert.deepEqual((await drafted("send 5 USDC to @bob on X, he'll send it back to me")).pays, ["bob@x=5"]);
    assert.deepEqual((await drafted("@bob'a x'te 5 usdc gönder, sonra bana geri gönderecek")).pays, ["bob@x=5"]);
    for (const message of ["send 5 USDC to me", "@bob send 5 USDC to me", "send 5 USDC to myself", "kendime 5 usdc gönder", "@bob'dan 5 usdc iste"]) {
      await asked(message, /^HaPaPay sends from your own wallet; it cannot ask anyone for money\./);
    }
    assert.deepEqual((await drafted("send 20 USDC to @bob on X, don't send to alice")).pays, ["bob@x=20"]);
    assert.deepEqual((await drafted("send 5 USDC to @bob on X from @alice")).pays, ["bob@x=5"], "the sender's own name is not someone to pay");
    assert.equal((await drafted("send 5 USDC to @bob on X for tomorrow's lunch")).note, "for tomorrow's lunch");
    assert.deepEqual((await drafted("send 5 USDC to @bob on X - monthly rent")).pays, ["bob@x=5"]);
    await asked("send 5 USDC to @bob on X tomorrow", /cannot schedule or repeat a payment/);
  });

  it("says when a request names a network HaPaPay does not run", async () => {
    await asked("send 5 USDC to @bob on X on Ethereum", "HaPaPay sends on Solana, Arc and Robinhood Chain; Ethereum is not one of them. Write the request without it, or with one of those.");
    await asked("send 5 USDC to @bob on X on Base", /; Base is not one of them\./);
  });

  it("keeps the network a request named through the question it asks", async () => {
    const robinhood = await read("GitHub", { answering: "send 2 TSLA to @torvalds on Robinhood Chain", exists: async () => true });
    assert.equal(robinhood.status, "stock_review");
    assert.match(robinhood.message, /^Reading that as “Send 2 TSLA to @torvalds on GitHub on Robinhood Chain”/);
    assert.equal(robinhood.network, "Robinhood Chain");
    const arc = await read("GitHub", { answering: "send 5 USDC to @torvalds via Arc" });
    assert.equal(arc.status, "ready_for_review");
    assert.equal(arc.network, "Arc Mainnet");
    assert.deepEqual((await asked("send 5 USDC to @torvalds on GitHub on Arc tomorrow", /cannot schedule/)).suggestions, ["Send 5 USDC to @torvalds on GitHub on Arc"]);
  });

  it("never reads the sender's own platform as the recipient's", async () => {
    for (const message of ["telegramdan @torvalds'a 5 usdc gönder", "Telegram'dan @torvalds'a 5 usdc gönder"]) {
      const reply = await asked(message, /^Add which platform @torvalds is on/);
      assert.deepEqual(reply.suggestions, ["Send 5 USDC to @torvalds on GitHub"], message);
    }
  });
});

describe("SOL is not sent", () => {
  it("answers every way of asking to send SOL with what HaPaPay sends instead", async () => {
    // HaPaPay sends stablecoins and stocks, never SOL.
    for (const message of [
      "send 0.5 SOL to @bob on X", "Send 1 sol to @bob on X", "@bob'a x'te 1 sol gönder", "send 1 solana to @bob", "send half a SOL to @bob on X",
      "send $5 of SOL to @bob on X", "send SOL to @bob on X", "send 0.1 SOL to @bob on X on Solana", "send 0.1 SOL to @bob on X via Arc",
      "send 0.1 SOL to @bob on X on Robinhood Chain", "send 0.1 SOL to @newcomer on GitHub", "send 1 SOL each to @bob and @alice on X",
    ]) {
      const reply = await asked(message, NO_SOL_SENDING);
      assert.equal(reply.solana, undefined, message);
      assert.equal(reply.suggestions, undefined, message);
    }
    // Stablecoins and stocks are sent as before.
    assert.deepEqual((await drafted("send 5 USDC to @bob on X")).pays, ["bob@x=5"]);
    assert.equal((await drafted("send 2 TSLAx to @bob on X")).asset, "TSLAx");
    assert.equal((await read("send 5 USDG to @bob on X")).stockIntent?.asset.symbol, "USDG");
    // Solana as a network is still a network.
    assert.deepEqual((await drafted("send 5 USDC to @bob on X on Solana")).pays, ["bob@x=5"]);
  });
});

describe("amounts written the short way", () => {
  it("reads .5 and ,5 as 0.5, never as 5", async () => {
    // Audit, 2026-10-06: ".5 USDC" was offered back as "Send 5 USDC", ten times the amount.
    assert.deepEqual((await drafted("send .5 USDC to @bob on X")).pays, ["bob@x=0.5"]);
    assert.deepEqual((await drafted("send $.5 to @bob on X")).pays, ["bob@x=0.5"]);
    assert.equal((await read("send .5 USDG to @bob on X")).stockIntent?.amount, "0.5");
    assert.deepEqual((await drafted("@bob'a x'te ,5 usdc gönder")).pays, ["bob@x=0.5"]);
  });

  it("reads half a TSLAx as 0.5 TSLAx, and asks for one and a half", async () => {
    assert.deepEqual(await drafted("send half a TSLAx to @bob on X"), { asset: "TSLAx", total: "0.5", pays: ["bob@x=0.5"], note: undefined, mode: "single" });
    assert.deepEqual((await drafted("send half a USDC to @bob on X")).pays, ["bob@x=0.5"]);
    await asked("send one and a half TSLAx to @bob on X", /^Write the amount of TSLAx to send/);
    await asked("send two and half TSLAx to @bob on X", /^Write the amount of TSLAx to send/);
  });

  it("reads k and m after a dollar amount or before an asset, and nothing else", async () => {
    assert.deepEqual((await drafted("send 10k USDC to @bob on X")).pays, ["bob@x=10000"]);
    assert.deepEqual((await drafted("send $1.5k to @bob on X")).pays, ["bob@x=1500"]);
    assert.deepEqual((await drafted("send 2m USDC to @bob on X")).pays, ["bob@x=2000000"]);
    assert.deepEqual((await drafted("send 5 USDC to @bob on X in 5m")).pays, ["bob@x=5"], "five minutes is not an amount");
  });

  it("reads a dollar value in brackets after an amount of another asset as what it is worth", async () => {
    // Audit, 2026-10-06: "0.1 SOL ($20)" was answered that SOL is not on the token list.
    assert.deepEqual((await drafted("send 1 TSLAx ($400) to @bob on X")).pays, ["bob@x=1"]);
    assert.equal((await drafted("send 1 TSLAx (~$400) to @bob on X")).asset, "TSLAx");
    assert.equal((await drafted("send 1 TSLAx (400 USDC) to @bob on X")).asset, "TSLAx");
    assert.deepEqual((await drafted("send 5 USDC ($5) to @bob on X")).pays, ["bob@x=5"]);
    await asked("send 5 USDC ($6) to @bob on X", /^Write one amount per request/);
  });

  it("never works out a part of an amount", async () => {
    // Audit, 2026-10-06: "half of 10 USDC" drafted 10 USDC.
    for (const message of [
      "send half of 10 USDC to @bob on X", "send 50% of 10 USDC to @bob on X", "send a third of 30 USDC to @bob on X",
      "send 10 USDC to @bob on X, half now", "send 5x2 USDC to @bob on X", "@bob'a x'te 10 usdc'nin yarısını gönder", "@bob'a x'te %50'sini gönder 10 usdc",
    ]) {
      await asked(message, "Write the amount to send as one number, for example: Send 5 USDC to @toly on X.");
    }
    for (const message of ["send $5 x 2 to @bob on X", "send 5 USDC x 2 to @bob on X", "send 2 x 5 USDG to @bob on X"]) await asked(message, /^Write the amount to send as one number/);
    assert.deepEqual((await drafted("send 100 USDC to @bob on X for 2 x 50 tickets")).pays, ["bob@x=100"], "a product of other things is not the amount");
    await asked("send 5 USDC to @bob on X 2x", "HaPaPay sends each payment once. Send it, then write the request again for the next one.");
    assert.deepEqual((await drafted("send 10 USDC split in half between @alice and @bob on X")).pays, ["alice@x=5", "bob@x=5"]);
    assert.equal((await drafted("send 5 USDC to @bob on X for half of the pizza")).note, "for half of the pizza");
  });

  it("says the fee is added on top when a request takes it out of the amount", async () => {
    for (const message of ["send 10 USDC minus fees to @bob on X", "send 10 USDC to @bob on X fees included", "send 10 USDC to @bob on X after fees", "@bob'a x'te 10 usdc gönder komisyon dahil"]) {
      await asked(message, "The 1% fee is added on top, so the recipient gets exactly the amount you write. Write that amount, for example: Send 5 USDC to @toly on X.");
    }
    assert.deepEqual((await drafted("send 5 USDC to @bob on X after fees are paid by me")).pays, ["bob@x=5"]);
  });

  it("keeps a Turkish word whole, so its first letters are never a ticker", async () => {
    // Audit, 2026-10-06: "bahşiş" (a tip) was read as 10 BAH, and the request went to Arc.
    assert.deepEqual((await drafted("@bob'a x'te 5 usdc gönder, %10 bahşiş dahil")).pays, ["bob@x=5"]);
  });
});

describe("who a request pays", () => {
  it("never reads a wallet address as a handle", async () => {
    // Audit, 2026-10-06: a Solana address was lowercased and asked for its platform; an EVM one was offered a vault link.
    const answer = "HaPaPay pays people by their verified handle, not by wallet address. Write who receives it and where, for example: Send 5 USDC to @toly on X.";
    await asked("send 1 USDC to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", answer);
    await asked("send 5 USDC to 0x1234567890123456789012345678901234567890 on X", answer);
    await asked("pay 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM 2 USDC on Solana", answer);
    assert.equal((await read("send 5 USDC to @0xabc on X")).status, "solana_claim_review", "a handle written with @ is a handle");
  });

  it("says which assets it sends when a symbol is not listed", async () => {
    await asked("send 5 DOGE to @bob on X", "DOGE isn't on the verified token list. HaPaPay sends USDC, USDG, xStocks and Robinhood Chain Stock Tokens.");
  });

  it("lets an X link wait for the name while X refuses this server's lookups, and says so", async () => {
    // When X refuses every lookup, no X vault link could be funded, so the link waits for the X name instead of
    // the account.
    const reply = await read("send 1 USDC to @newcomer on X", { exists: async () => "unavailable" }) as Reply & { vaultLock?: string };
    assert.equal(reply.status, "solana_claim_review");
    assert.equal(reply.vaultLock, "name");
    assert.equal(reply.message, "@newcomer is not on HaPaPay yet. You can keep the USDC in the Solana vault for the X name @newcomer: whoever connects X to HaPaPay with that name claims it within the window you pick, 72 hours to 30 days, or you take it back after that. X is not answering account lookups right now, so it waits for the name instead of the account. Check how the name is spelled.");
    // GitHub refusing this server's key still gets no link: a GitHub link always waits for the account.
    const github = await read("send 1 USDC to @newcomer on GitHub", { exists: async () => "unavailable" });
    assert.equal(github.status, "needs_clarification");
    assert.equal(github.message, "GitHub is not answering account lookups for HaPaPay right now, so the money cannot wait in the vault for @newcomer. Try again later, or ask @newcomer to join HaPaPay and link GitHub so you can pay them directly.");
  });

  it("reads dc and tg as Discord and Telegram, and says how to pay someone there who has not joined", async () => {
    assert.deepEqual((await drafted("send 5 USDC to @bob on dc")).pays, ["bob@discord=5"]);
    assert.deepEqual((await drafted("@bob'a dc'de 5 usdc gönder")).pays, ["bob@discord=5"]);
    // "dc'den" and "tg'den" (from dc, from tg) name where @ahmet is when no other platform is written (2026-10-06).
    for (const [message, platform] of [["dc'den @ahmet'e 5 usdc gönder", "discord"], ["tg'den @ahmet_tg'ye 5 usdc gönder", "telegram"], ["send 5 USDC to @ahmet on dc", "discord"]] as const) {
      const reply = await read(message) as Reply & { vaultLock?: string; solana?: { recipient?: { platform: string } } };
      assert.equal(reply.status, "solana_claim_review", `${message} → ${reply.message}`);
      assert.equal(reply.solana?.recipient?.platform, platform, message);
      assert.equal(reply.vaultLock, "name", "a Discord or Telegram link waits for the name");
    }
    // "dcden" where @bob has linked Discord pays @bob there.
    assert.deepEqual((await drafted("dcden @bob'a 5 usdc gönder")).pays, ["bob@discord=5"]);
    assert.deepEqual((await drafted("send 5 usdc to @bob dc")).pays, ["bob@discord=5"]);
    // Only where a platform is written: "DC" in the rest of a request is a word, never Discord.
    for (const message of ["send 5 USDC to @bob for the trip to DC", "send 5 USDC to @bob, see you in DC", "send 5 USDC to @bob for DC tickets"]) {
      await asked(message, /^Add which platform @bob is on/);
    }
    await asked("send 5 USDC to my friend in Washington DC", /^Add who receives it and where/);
    const named = await read("send 5 USDC to @dc on X");
    assert.equal(named.status, "solana_claim_review", "a handle named dc is a handle; this one has not joined");
    assert.deepEqual((named as unknown as { solana: { recipient: unknown } }).solana.recipient, { platform: "x", username: "dc" });
  });

  it("names every platform when nothing narrows the choice, and offers the ones where the money can wait first", async () => {
    // The question offers every platform, not only "for example … on X", so the desk never seems to know X alone.
    const usdc = await asked("send 5 USDC to @ahmet", "Add which platform @ahmet is on (X, GitHub, Farcaster, Discord or Telegram), for example: Send 5 USDC to @ahmet on X.");
    assert.deepEqual(usdc.suggestions, ["Send 5 USDC to @ahmet on X", "Send 5 USDC to @ahmet on GitHub", "Send 5 USDC to @ahmet on Farcaster"]);
    for (const [message, example] of [
      ["send 2 TSLA to @ahmet", "Send 2 TSLA to @ahmet on X"],
      ["send 3 USDG to @ahmet", "Send 3 USDG to @ahmet on X"],
      ["1 NVDA'yi @ali @veli'ye gönder", "Send 1 NVDA to @ali and @veli on X"],
      ["split 2 TSLAx between @ali and @veli on solana", "Split 2 TSLAx between @ali and @veli on X"],
    ]) {
      const reply = await asked(message, /^Add which platform @\w+(?: and @\w+)? (?:is|are) on \(X, GitHub, Farcaster, Discord or Telegram\), for example: /);
      assert.equal(reply.message.split("for example: ")[1], `${example}.`, message);
      assert.equal(reply.suggestions?.length, 3, message);
    }
    // Where the person is verified, only that platform is offered, and it is the example.
    const verified = await asked("send 5 USDC to @torvalds", "Add which platform @torvalds is on, for example: Send 5 USDC to @torvalds on GitHub.");
    assert.deepEqual(verified.suggestions, ["Send 5 USDC to @torvalds on GitHub"]);
    // A platform the chips leave out is still a typed answer away.
    const discord = await read("discord", { answering: "send 5 USDC to @ahmet" });
    assert.match(discord.message, /^Reading that as “Send 5 USDC to @ahmet on Discord”\. @ahmet is not on HaPaPay yet\. You can keep the USDC in the Solana vault for the Discord name @ahmet:/);
  });

  it("offers no vault link to a handle the platform cannot have", async () => {
    const reply = await read("send 5 USDC to @averyveryverylonghandle on X", { exists: async (platform, username) => platform === "x" && username.length > 15 ? false : undefined });
    assert.equal(reply.message, "There is no X account named @averyveryverylonghandle. Check how the handle is spelled.");
  });
});
