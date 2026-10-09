import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatDraft, HELP_REPLY } from "../server/chat-service";

/** The complete requests a clarification offers, which only some replies carry. */
const suggestionsOf = (result: object) => (result as { suggestions?: string[] }).suggestions;

describe("chat API seam", () => {
  it("resolves a social recipient but never sends funds", async () => {
    const result = await createChatDraft(
      "Telegram'daki @deniz'e 8,75 USDC gönder",
      async () => ({
        kind: "send",
        amount: "8.75",
        token: "USDC",
        recipient: { platform: "telegram", username: "deniz" },
        status: "draft",
      }),
      () => "0x8A7E4E1b6f1CA842A9B84E5cB18A46Edf2cEb789",
      "Arc Testnet",
    );

    assert.equal(result.status, "ready_for_review");
    assert.equal(result.resolvedAddress, "0x8A7E4E1b6f1CA842A9B84E5cB18A46Edf2cEb789");
    assert.equal(result.intent.amount, "8.75");
    assert.equal(result.network, "Arc Testnet");
    assert.equal("transactionHash" in result, false);
  });

  it("asks for clarification instead of guessing an unknown identity", async () => {
    const result = await createChatDraft("X'teki @unknown'a 3 USDC gönder");
    assert.equal(result.status, "needs_clarification");
  });

  it("uses the verified identity directory instead of a built-in username list", async () => {
    const result = await createChatDraft(
      "X'teki @nora'ya 4 USDC gönder",
      async () => ({
        kind: "send",
        amount: "4",
        token: "USDC",
        recipient: { platform: "x", username: "nora" },
        status: "draft",
      }),
      (platform, username) => platform === "x" && username === "nora"
        ? "0x3333333333333333333333333333333333333333"
        : undefined,
    );
    assert.equal(result.status, "ready_for_review");
    assert.equal(result.resolvedAddress, "0x3333333333333333333333333333333333333333");
  });

  it("falls back to the local Turkish parser when the configured AI parser is unavailable", async () => {
    const result = await createChatDraft(
      "GitHub hesabımdan X'teki @nora'ya 7,25 USDC gönder",
      async () => { throw new Error("OpenRouter is temporarily unavailable"); },
      (platform, username) => platform === "x" && username === "nora"
        ? "0x3333333333333333333333333333333333333333"
        : undefined,
      "Arc Testnet",
    );

    assert.equal(result.status, "ready_for_review");
    assert.equal(result.intent.amount, "7.25");
    assert.equal(result.intent.sourcePlatform, "github");
    assert.equal(result.parser, "local_fallback");
  });

  it("falls back to the local English parser and returns English review copy", async () => {
    const result = await createChatDraft(
      "Send 7.25 USDC from my GitHub account to @nora on X",
      async () => { throw new Error("OpenRouter is temporarily unavailable"); },
      (platform, username) => platform === "x" && username === "nora"
        ? "0x3333333333333333333333333333333333333333"
        : undefined,
      "Arc Testnet",
    );

    assert.equal(result.status, "ready_for_review");
    assert.equal(result.intent.amount, "7.25");
    assert.equal(result.intent.sourcePlatform, "github");
    assert.equal(result.message, "Recipient matched to one verified wallet. Review the details before signing.");
    assert.equal(result.parser, "local_fallback");
  });
});

describe("request understanding", () => {
  const nora = (platform: string, username: string) => platform === "x" && username === "nora"
    ? "0x3333333333333333333333333333333333333333" as const
    : undefined;
  const model = (amount: string, platform: string, username: string, extra: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const parse = async (message: string) => {
      calls.push(message);
      return { kind: "send", amount, asset: "USDC", recipients: [{ username, platform }], sourcePlatform: "unstated", note: "", ...extra };
    };
    return { calls, parse };
  };

  it("answers a greeting with the example request and a question with what the desk does, never a draft", async () => {
    const { calls, parse } = model("0", "telegram", "none");
    for (const message of ["hello there", "thanks!", "ok"]) {
      const result = await createChatDraft(message, parse, nora, "Arc Testnet");
      assert.equal(result.status, "needs_clarification", message);
      assert.equal("intent" in result, false, message);
      assert.equal(result.message, "Write an amount, an asset and who receives it, for example: Send 2 NVDA to @toly on X.");
    }
    // "how does HaPaPay work" names neither an asset nor a payee: the product's name is never read as @work.
    for (const message of ["what can you do?", "I want to learn more", "how do I use this on GitHub?", "bir şey sorabilir miyim?", "how does HaPaPay work", "what is HaPaPay?", "HaPaPay nedir", "hapapay nasıl kullanılır", "Ha Pa Pay", "HaPaPay"]) {
      const result = await createChatDraft(message, parse, nora, "Arc Testnet");
      assert.equal(result.status, "needs_clarification", message);
      assert.equal("intent" in result, false, message);
      assert.equal(result.message, HELP_REPLY, message);
      assert.doesNotMatch(result.message, /@work/, message);
    }
    assert.deepEqual(calls, [], "a message with no amount never reaches the model");
    // The product's name inside a real request changes nothing, and a handle that looks like it is still a person.
    const named = await createChatDraft("send 4 USDC to @nora on X with HaPaPay", parse, nora, "Arc Testnet");
    assert.equal(named.status, "ready_for_review", named.message);
    const handle = await createChatDraft("send 3 USDC to @hapapay on X", parse, nora, "Arc Testnet");
    assert.notEqual(handle.message, HELP_REPLY, "a handle named hapapay is a person, not the product");
  });

  it("refuses a zero amount from the parser or the model", async () => {
    for (const parse of [undefined, model("0", "x", "nora").parse]) {
      const result = await createChatDraft("Send 0 USDC to @nora on X", parse, nora, "Arc Testnet");
      assert.equal(result.status, "needs_clarification");
      assert.equal("intent" in result, false);
      assert.equal(result.message, "Enter an amount greater than zero, for example: Send 5 USDC to @nora on X.");
    }
  });

  it("keeps a model draft only when the message states its handle, platform and amount", async () => {
    for (const [label, amount, platform, username] of [
      ["an amount the message does not state", "50", "x", "nora"],
      ["a handle the message does not name", "5", "x", "bob"],
      ["a platform the message does not name", "5", "telegram", "nora"],
    ] as const) {
      const result = await createChatDraft("Send 5 USDC to @nora on X", model(amount, platform, username).parse, nora, "Arc Testnet");
      assert.equal(result.parser, "local_fallback", label);
      assert.equal(result.status, "ready_for_review", label);
      assert.deepEqual(result.intent?.recipient, { platform: "x", username: "nora" }, label);
      assert.equal(result.intent?.amount, "5", label);
    }
    const guessedPlatform = await createChatDraft("send 5 usdc to nora", model("5", "x", "nora").parse, nora, "Arc Testnet");
    assert.equal(guessedPlatform.status, "needs_clarification");
    assert.equal("intent" in guessedPlatform, false);
    assert.equal(guessedPlatform.message, "Add which platform @nora is on, for example: Send 5 USDC to @nora on X.");
    const declined = await createChatDraft("Send 5 USDC to @nora on X", async () => ({ kind: "none", amount: "", asset: "", recipients: [], sourcePlatform: "unstated", note: "" }), nora, "Arc Testnet");
    assert.equal(declined.parser, "local_fallback");
    assert.equal(declined.status, "ready_for_review");
  });

  it("reads amounts in words and handles without the @, and takes the sender's account only from the message", async () => {
    const torvalds = (platform: string, username: string) => platform === "github" && username === "torvalds"
      ? "0x4444444444444444444444444444444444444444" as const
      : undefined;
    const words = await createChatDraft("send fifty dollars to torvalds on github", model("50.00", "github", "torvalds").parse, torvalds, "Arc Testnet");
    assert.equal(words.status, "ready_for_review");
    assert.equal(words.parser, "openrouter");
    assert.deepEqual(words.intent, { kind: "send", amount: "50", token: "USDC", recipient: { platform: "github", username: "torvalds" }, status: "draft", sourcePlatform: undefined });

    const guessedSource = await createChatDraft("Send 5 USDC to @nora on X", model("5", "x", "nora", { sourcePlatform: "github" }).parse, nora, "Arc Testnet");
    assert.equal(guessedSource.parser, "openrouter");
    assert.equal(guessedSource.intent?.sourcePlatform, undefined, "the model cannot pick the sender's account");
    const statedSource = await createChatDraft("GitHub hesabımdan X'teki @nora'ya 7,25 USDC gönder", model("7.25", "x", "nora").parse, nora, "Arc Testnet");
    assert.equal(statedSource.intent?.sourcePlatform, "github");

    const local = await createChatDraft("can you pay nora 5 usdc on x", undefined, nora, "Arc Testnet");
    assert.equal(local.status, "ready_for_review");
    assert.equal(local.parser, "local");
    assert.deepEqual(local.intent?.recipient, { platform: "x", username: "nora" });
  });

  it("never turns another asset into a USDC draft", async () => {
    const { calls, parse } = model("5", "github", "octocat");
    const cases: Array<[string, string]> = [
      ["send octocat usdg 5 on github", "Write the amount before USDG, for example: Send 5 USDG to @octocat on GitHub."],
      ["send 5 dollars worth of NVDA to bob on x", "Write the amount in NVDA, not dollars, for example: Send 2 NVDA to @bob on X."],
      ["send 5 usdc and usdg to bob on x", "Send one asset at a time: either USDC or a single listed token."],
      // Audit, 2026-10-06: the list now names what Solana carries too.
      ["send 5 eth to octocat on github", "HaPaPay sends USDC, USDG, xStocks and Robinhood Chain Stock Tokens, for example: Send 5 USDC to @octocat on GitHub."],
      ["send 2 shares of nvidia to bob on x", "Stock Tokens move in token units, not shares. Write it as “Send 2 NVDA to @bob on X” and the review shows the share equivalent."],
      ["send 5 eur to bob on x", "HaPaPay sends USDC, USDG, xStocks and Robinhood Chain Stock Tokens, for example: Send 5 USDC to @bob on X."],
    ];
    for (const [message, expected] of cases) {
      const result = await createChatDraft(message, parse, nora, "Arc Testnet");
      assert.equal(result.status, "needs_clarification", message);
      assert.equal("intent" in result, false, message);
      assert.equal(result.message, expected, message);
    }
    assert.deepEqual(calls, [], "requests naming another asset never reach the USDC model");
    const farcasterName = await createChatDraft("Send 5 USDC to @dwr.eth on Farcaster", undefined, () => "0x5555555555555555555555555555555555555555", "Arc Testnet");
    assert.equal(farcasterName.status, "ready_for_review", "a .eth name is a handle, not ether");
  });

  it("asks for exactly the part that is missing", async () => {
    const cases: Array<[string, string]> = [
      ["send 5 to bob on x", "Name the asset after the amount, for example: Send 5 USDC to @bob on X."],
      ["send usdc to bob on x", "Add an amount, for example: Send 5 USDC to @bob on X."],
      ["send 5 usdc", "Add who receives it and where, for example: Send 5 USDC to @toly on X."],
      ["send fifty to torvalds on github in dollars", "Write the amount in digits, for example: Send 50 USDC to @torvalds on GitHub."],
      ["send 5.1234567 usdc to bob on x", "USDC has six decimal places. Write at most six digits after the point, for example: Send 5 USDC to @bob on X."],
      ["x'teki bülent'e 5 usdc gönder", "Write the recipient's handle as their profile shows it, in Latin letters, digits, \"_\", \".\" or \"-\", for example: Send 5 USDC to @toly on X."],
    ];
    for (const [message, expected] of cases) {
      const result = await createChatDraft(message, undefined, nora, "Arc Testnet");
      assert.equal(result.status, "needs_clarification", message);
      assert.equal(result.message, expected, message);
    }
  });
});

describe("requests read the way people write them", () => {
  const people = new Set(["github:octocat", "x:bob", "farcaster:dwr", "telegram:alice", "discord:carol"]);
  const verified = (platform: string, username: string) => people.has(`${platform}:${username}`)
    ? "0x2222222222222222222222222222222222222222" as const
    : undefined;
  const transfers = { enabled: true, tokens: { enabled: true } };

  it("reads dollars, number words, Turkish endings and terse word orders without a model", async () => {
    const cases: Array<[string, string, string, string]> = [
      ["send $5 to octocat on github", "5", "github", "octocat"],
      ["pay bob on x $5", "5", "x", "bob"],
      ["send 20 dollars to carol on discord", "20", "discord", "carol"],
      ["pay @octocat 12 bucks on github", "12", "github", "octocat"],
      ["@bob 5$ x", "5", "x", "bob"],
      ["github'daki octocat'e 5 dolar yolla", "5", "github", "octocat"],
      ["octocat githubda 5 usdc atar mısın", "5", "github", "octocat"],
      ["alice telegramda 20 dolar gönder", "20", "telegram", "alice"],
      ["send five usdc to bob on X", "5", "x", "bob"],
      ["beş usdc gönder bob x", "5", "x", "bob"],
      ["x'teki bob'a yirmi beş dolar gönder", "25", "x", "bob"],
      ["x'te bob'a iki bin beş yüz usdc gönder", "2500", "x", "bob"],
      ["send a hundred usdc to bob on x", "100", "x", "bob"],
      ["5 usdc yolla x bob", "5", "x", "bob"],
      ["send 1.000,50 usdc to bob on x", "1000.5", "x", "bob"],
      ["send 0,500 usdc to bob on x", "0.5", "x", "bob"],
    ];
    for (const [message, amount, platform, username] of cases) {
      const result = await createChatDraft(message, undefined, verified, "Arc Mainnet");
      assert.equal(result.status, "ready_for_review", message);
      assert.equal(result.parser, "local", message);
      assert.deepEqual([result.intent?.amount, result.intent?.recipient.platform, result.intent?.recipient.username], [amount, platform, username], message);
    }
  });

  it("asks which amount a thousands separator means, and never lets the model pick", async () => {
    const calls: string[] = [];
    const model = async (message: string) => {
      calls.push(message);
      return { kind: "send", amount: "1000", token: "USDC", recipient: { platform: "github", username: "octocat" }, status: "draft" };
    };
    const usdc = await createChatDraft("send 1,000 usdc to octocat on github", model, verified, "Arc Mainnet");
    assert.equal(usdc.status, "needs_clarification");
    assert.equal(usdc.message, "“1,000” can mean 1000 or 1 USDC. Write the amount without a thousands separator, for example: Send 1000 USDC to @octocat on GitHub.");
    assert.deepEqual(suggestionsOf(usdc), ["Send 1000 USDC to @octocat on GitHub", "Send 1 USDC to @octocat on GitHub"]);
    assert.deepEqual(calls, []);
    const stock = await createChatDraft("send 2.500 nvda to bob on x", undefined, verified, "Arc Mainnet", "robinhood-mainnet", transfers);
    assert.equal(stock.status, "needs_clarification");
    assert.deepEqual(suggestionsOf(stock), ["Send 2500 NVDA to @bob on X", "Send 2.5 NVDA to @bob on X"]);
  });

  it("offers the ticker for a company name, and the platforms where a handle is verified", async () => {
    const company = await createChatDraft("octocat'e github'da 3 apple hissesi gönder", undefined, verified, "Arc Mainnet", "robinhood-mainnet", transfers);
    assert.equal(company.status, "needs_clarification");
    assert.deepEqual(suggestionsOf(company), ["Send 3 AAPL to @octocat on GitHub"]);
    for (const [message, suggestion] of [
      ["send 2 tesla to bob on x", "Send 2 TSLA to @bob on X"],
      ["send 2 nvidia tokens to bob on x", "Send 2 NVDA to @bob on X"],
      ["send 2 google to bob on x", "Send 2 GOOGL to @bob on X"],
    ]) {
      const result = await createChatDraft(message, undefined, verified, "Arc Mainnet", "robinhood-mainnet", transfers);
      assert.deepEqual(suggestionsOf(result), [suggestion], message);
    }
    const handleOnly = await createChatDraft("send 5 usdc to bob", undefined, verified, "Arc Mainnet");
    assert.equal(handleOnly.message, "Add which platform @bob is on, for example: Send 5 USDC to @bob on X.");
    assert.deepEqual(suggestionsOf(handleOnly), ["Send 5 USDC to @bob on X"]);
    // The only platform named, written as where it comes from, is where @bob is.
    const fromX = await createChatDraft("bob'a x'ten 2 nvda gönder", undefined, () => undefined, "Arc Mainnet", "robinhood-mainnet", transfers) as { stockIntent?: { recipient: unknown } };
    assert.deepEqual(fromX.stockIntent?.recipient, { platform: "x", username: "bob" });
    const ten = await createChatDraft("bob'a x'te on usdc gönder", undefined, verified, "Arc Mainnet");
    assert.deepEqual(suggestionsOf(ten), ["Send 10 USDC to @bob on X"]);
    const asset = await createChatDraft("bob x 5", undefined, verified, "Arc Mainnet", "robinhood-mainnet", transfers);
    assert.deepEqual(suggestionsOf(asset), ["Send 5 USDC to @bob on X", "Send 5 USDG to @bob on X"]);
  });

  it("offers the Arc vault to a GitHub, X or Farcaster account that has not joined", async () => {
    const vault = await createChatDraft("send 5 usdc to newcomer on github", undefined, verified, "Arc Mainnet", "robinhood-mainnet", transfers, { enabled: false }, { enabled: true, platforms: ["github", "x", "farcaster"] });
    assert.equal(vault.status, "claim_review");
    assert.equal(vault.message, "@newcomer is not on HaPaPay yet. You can keep the USDC in the Arc Mainnet vault; they claim it with their official GitHub account within the window you pick, 72 hours to 30 days, or you take it back after that.");
    assert.deepEqual(vault.intent?.recipient, { platform: "github", username: "newcomer" });
    // A Telegram link waits for the Telegram name.
    const telegram = await createChatDraft("send 5 usdc to newcomer on telegram", undefined, verified, "Arc Mainnet", "robinhood-mainnet", transfers, { enabled: false }, { enabled: true, platforms: ["github", "x", "farcaster", "discord", "telegram"] }) as { status: string; message: string; vaultLock?: string };
    assert.equal(telegram.status, "claim_review");
    assert.equal(telegram.vaultLock, "name");
    assert.equal(telegram.message, "@newcomer is not on HaPaPay yet. You can keep the USDC in the Arc Mainnet vault for the Telegram name @newcomer: whoever connects Telegram to HaPaPay with that name claims it within the window you pick, 72 hours to 30 days, or you take it back after that. Check how the name is spelled.");
    const impossible = await createChatDraft("send 5 usdc to bob on telegram", undefined, () => undefined, "Arc Mainnet", "robinhood-mainnet", transfers, { enabled: false }, { enabled: true, platforms: ["github", "x", "farcaster", "discord", "telegram"] });
    assert.equal(impossible.message, "No Telegram account can be named @bob. Check how the handle is spelled.", "Telegram names have at least four characters");
    const closed = await createChatDraft("send 5 usdc to newcomer on x", undefined, verified, "Arc Mainnet");
    assert.equal(closed.status, "needs_clarification");
    assert.equal(closed.message, "@newcomer has not linked X to HaPaPay yet. The Arc Mainnet vault is not open. Send @newcomer your invite link from the SP tab; once they sign in and link X, send it again and it goes straight to them.");
    const noLookups = await createChatDraft("send 5 usdc to newcomer on x", undefined, verified, "Arc Mainnet", "robinhood-mainnet", transfers, { enabled: false }, { enabled: true, platforms: ["github", "farcaster"] });
    assert.match(noLookups.message, /^@newcomer has not linked X to HaPaPay yet\. This server cannot look X accounts up, so the money cannot wait in the vault for @newcomer yet\./);
  });

  it("offers no vault link to a handle the platform's directory does not know, on any network", async () => {
    // A mistyped handle is looked up before the vault is offered, not only when the link is prepared.
    const asked: string[] = [];
    const recipientExists = async (platform: string, username: string) => {
      asked.push(`${platform}:${username}`);
      return username === "nosuchuser" ? false : username === "unreachable" ? undefined : true;
    };
    const vaults = [{ enabled: true, escrow: "0x00000000000000000000000000000000000000e1", platforms: ["github", "x", "farcaster"] }, { enabled: true, platforms: ["github", "x", "farcaster"] }] as const;
    const solana = { transfers: { enabled: true }, stocks: { enabled: true }, vault: { enabled: true, platforms: ["github", "x", "farcaster"] as const }, addressOf: () => undefined };
    const ask = (message: string, onSolana = false) => createChatDraft(message, undefined, verified, "Arc Mainnet", "robinhood-mainnet", transfers, vaults[0] as never, vaults[1] as never, { recipientExists, ...(onSolana ? { solana } : {}) });
    for (const [message, onSolana] of [["send 5 usdc to @nosuchuser on github", false], ["send 1 nvda to @nosuchuser on github", false], ["send 5 usdc to @nosuchuser on github", true], ["send 2 TSLAx to @nosuchuser on github", true]] as const) {
      const result = await ask(message, onSolana);
      assert.equal(result.status, "needs_clarification", message);
      assert.equal(result.message, "There is no GitHub account named @nosuchuser. Check how the handle is spelled.", message);
    }
    for (const [message, onSolana, status] of [["send 5 usdc to @unreachable on x", false, "claim_review"], ["send 1 nvda to @newcomer on farcaster", false, "stock_claim_review"], ["send 5 usdc to @unreachable on github", true, "solana_claim_review"]] as const) {
      assert.equal((await ask(message, onSolana)).status, status, `${message}: a directory that cannot answer leaves the vault offer as it was`);
    }
    assert.ok(asked.includes("github:nosuchuser") && asked.includes("x:unreachable") && asked.includes("farcaster:newcomer"));
    const joined = await ask("send 4 usdc to @bob on x");
    assert.equal(joined.status, "ready_for_review");
    assert.ok(!asked.includes("x:bob"), "a verified recipient is never looked up");
  });
});

describe("requests the desk reads but never drafts", () => {
  const verified = () => "0x2222222222222222222222222222222222222222" as const;

  it("never turns asking for money, saying no, cancelling, a repeated payment or a later payment into a draft", async () => {
    const calls: string[] = [];
    const model = async (message: string) => {
      calls.push(message);
      return { kind: "send", amount: "5", token: "USDC", recipient: { platform: "x", username: "bob" }, status: "draft" };
    };
    const asks = "HaPaPay sends from your own wallet; it cannot ask anyone for money. To get paid, verify an account under Identities and share its payment link.";
    const cases: Array<[string, string]> = [
      ["request 5 usdc from @bob on x", asks],
      ["get 5 usdc from bob on x", asks],
      ["@bob on x owes me 5 usdc", asks],
      ["pay me 5 usdc", asks],
      ["send 5 usdc to myself on x", asks],
      ["bob'dan 5 usdc iste x", asks],
      ["bana 5 usdc atar mısın", asks],
      ["how do i receive usdc", asks],
      ["don't send 5 usdc to @bob on x", "Okay, nothing will be sent. Write a new request whenever you want to pay someone."],
      ["@bob'a x'te 5 usdc gönderme", "Okay, nothing will be sent. Write a new request whenever you want to pay someone."],
      ["cancel my 5 usdc payment to @bob on x", "A sent payment is final on chain and cannot be cancelled. Nothing is sent before you sign it in your wallet, and a vault link that nobody claims comes back to you when its window closes."],
      ["send 5 usdc to everyone on x", "Name everyone who receives it, for example: Send 5 USDC each to @toly and @carol on X."],
      ["split 10 usdc with @bob on x", "Name everyone who shares it, for example: Split 10 USDC between @bob and @carol on X."],
      ["send 5 usdc to @bob on x twice", "HaPaPay sends each payment once. Send it, then write the request again for the next one."],
      ["send 5 usdc to bob on x and 3 usdc to alice on telegram", "Write one amount per request. Several people share one request when each gets the same amount, for example: Send 5 USDC each to @toly and @carol on X."],
    ];
    for (const [message, expected] of cases) {
      const result = await createChatDraft(message, model, verified, "Arc Mainnet");
      assert.equal(result.status, "needs_clarification", message);
      assert.equal(result.message, expected, message);
      assert.equal(result.intent, undefined, message);
    }
    assert.deepEqual(calls, [], "none of these reach the model");
    const later = await createChatDraft("send 5 usdc to @bob on x every week", model, verified, "Arc Mainnet");
    assert.equal(later.message, "HaPaPay sends right away; it cannot schedule or repeat a payment. Send it when you want it to arrive.");
    assert.deepEqual(suggestionsOf(later), ["Send 5 USDC to @bob on X"], "the payment itself can still be sent now");
    for (const message of ["I want to send 5 usdc to bob on x", "send 5 usdc to bob on x per his request", "send 5 usdc to bob on x and tell him thanks", "5 usdc gönder @fatma x"]) {
      assert.notEqual((await createChatDraft(message, undefined, verified, "Arc Mainnet")).status, "needs_clarification", message);
    }
  });
});


describe("several people, notes, and questions asked only when something is missing", () => {
  const wallets: Record<string, `0x${string}`> = {
    "x:a": "0x1111111111111111111111111111111111111111",
    "x:b": "0x2222222222222222222222222222222222222222",
    "x:c": "0x3333333333333333333333333333333333333333",
    "github:a": "0x1111111111111111111111111111111111111111",
    "x:bob": "0x4444444444444444444444444444444444444444",
    "x:alice": "0x5555555555555555555555555555555555555555",
  };
  const resolve = (platform: string, username: string) => wallets[`${platform}:${username}`];
  const transfers = { enabled: true, tokens: { enabled: true } };
  const vault = { enabled: true, platforms: ["github", "x", "farcaster"] as const };
  const ask = (message: string, context: { answering?: { request: string }; sender?: string } = {}, parse?: (message: string) => Promise<unknown>) =>
    createChatDraft(message, parse, resolve, "Arc Mainnet", "robinhood-mainnet", transfers, { enabled: false }, vault, context);
  type Batch = { mode: string; asset: { symbol: string }; payments: Array<{ recipient: { platform: string; username: string }; resolvedAddress: string; amount: string; units: string }>; totalAmount: string; note?: string };
  const batchOf = (result: object) => {
    assert.equal((result as { status: string }).status, "batch_review", (result as { message?: string }).message);
    return (result as { batch: Batch }).batch;
  };
  const paid = (batch: Batch) => batch.payments.map(({ recipient, amount }) => `${recipient.platform}:${recipient.username}=${amount}`);
  const questionOf = (result: object) => (result as { question?: { kind: string; request: string } }).question;

  it("pays everyone an amount stated for each, and splits an amount stated for all, without asking", async () => {
    for (const [message, expected, total] of [
      ["Send 1 NVDA each to @a, @b and @c on X", ["x:a=1", "x:b=1", "x:c=1"], "3"],
      ["@a @b @c'ye x'te 1'er NVDA gönder", ["x:a=1", "x:b=1", "x:c=1"], "3"],
      ["x'te @a ve @b'ye birer NVDA gönder", ["x:a=1", "x:b=1"], "2"],
      ["@a ve @b'ye x'te 5'er usdc yolla", ["x:a=5", "x:b=5"], "10"],
      ["send 2 usdc to everyone: @a @b on x", ["x:a=2", "x:b=2"], "4"],
      ["Split 1 NVDA between @a, @b and @c on X", ["x:a=0.333333333333333334", "x:b=0.333333333333333333", "x:c=0.333333333333333333"], "1"],
      ["x'te @a, @b ve @c'ye toplam 10 usdc gönder", ["x:a=3.333334", "x:b=3.333333", "x:c=3.333333"], "10"],
      ["divide 10 usdc among @a and @b on x", ["x:a=5", "x:b=5"], "10"],
      ["send 10 usdc to bob and alice on x equally", ["x:bob=5", "x:alice=5"], "10"],
    ] as const) {
      const batch = batchOf(await ask(message));
      assert.deepEqual(paid(batch), expected, message);
      assert.equal(batch.totalAmount, total, message);
    }
    const usdc = batchOf(await ask("Send 2 USDC each to @a and @b on X"));
    assert.deepEqual(usdc.asset, { type: "usdc", symbol: "USDC", decimals: 6 });
    assert.deepEqual(usdc.payments.map(({ resolvedAddress, units }) => [resolvedAddress, units]), [[wallets["x:a"], "2000000"], [wallets["x:b"], "2000000"]]);
  });

  it("pays each person the amount written next to them, in either order and in Turkish", async () => {
    // "10 USDC to @a and 5 USDC to @b" is one request with an amount for each person.
    for (const [message, expected, total] of [
      ["Send 10 USDC to @a and 5 USDC to @b on X", ["x:a=10", "x:b=5"], "15"],
      ["send 10 usdc to @a, 5 usdc to @b and 2.5 usdc to @c on x", ["x:a=10", "x:b=5", "x:c=2.5"], "17.5"],
      ["pay @a 10 USDC and @b 5 USDC on X", ["x:a=10", "x:b=5"], "15"],
      ["@a'ya 10 USDC, @b'ye 5 USDC gönder x'te", ["x:a=10", "x:b=5"], "15"],
      ["x'te @a'ya 10, @b'ye 5 usdc gönder", ["x:a=10", "x:b=5"], "15"],
      ["send $10 to @a and $5 to @b on x", ["x:a=10", "x:b=5"], "15"],
      ["Send 1 NVDA to @a and 2 NVDA to @b on X", ["x:a=1", "x:b=2"], "3"],
      ["Send 10 USDC to @a and 10 USDC to @b on X", ["x:a=10", "x:b=10"], "20"],
    ] as const) {
      const batch = batchOf(await ask(message));
      assert.equal(batch.mode, "listed", message);
      assert.deepEqual(paid(batch), expected, message);
      assert.equal(batch.totalAmount, total, message);
    }
    const noted = batchOf(await ask("send 10 USDC to @a and 5 USDC to @b on X, note: lunch"));
    assert.equal(noted.note, "lunch");
    assert.deepEqual(noted.payments.map(({ units }) => units), ["10000000", "5000000"]);
    // One amount still means each or split, and the desk still asks which when the request says neither.
    assert.equal(batchOf(await ask("Send 10 USDC each to @a and @b on X")).mode, "each");
    assert.equal(questionOf(await ask("Send 10 USDC to @a and @b on X"))?.kind, "amount_mode");
  });

  it("refuses a listed request that mixes assets, names none, or writes an amount that cannot be paid", async () => {
    for (const [message, reply] of [
      ["send 10 USDC to @a and 2 NVDA to @b on X", "Send one asset at a time."],
      ["send 10 USDC to @a and 2 SOL to @b on X", "HaPaPay does not send SOL. It sends stablecoins (USDC and USDG) and stocks (xStocks on Solana, Stock Tokens on Robinhood Chain). Keep a little SOL in your wallet for Solana's network fees."],
      ["send 1 ETH to @a and 2 ETH to @b on X", "ETH isn't sent here. Send one listed asset to everyone, for example USDC."],
      ["send 10 to @a and 5 to @b on X", "Name the asset after each amount, for example: Send 10 USDC to @a and 5 USDC to @b on X."],
      ["send 10 USDC to @a and 0 USDC to @b on X", "Enter an amount greater than zero for @b."],
      ["send 1,000 USDC to @a and 5 USDC to @b on X", "“1,000” for @a can mean 1000 or 1 USDC. Write it without a thousands separator."],
      ["send 10 USDC to @a and 5.1234567 USDC to @b on X", "USDC has 6 decimal places. Write at most 6 digits after the point for @b."],
    ] as const) {
      const result = await ask(message);
      assert.equal(result.status, "needs_clarification", message);
      assert.equal(result.message, reply, message);
    }
  });

  it("asks a listed request's platform with complete requests, and offers the payable part with each person's amount", async () => {
    const asked = await ask("send 10 USDC to @a and 5 USDC to @b");
    assert.equal(questionOf(asked)?.kind, "platform");
    assert.deepEqual(suggestionsOf(asked), ["Send 10 USDC to @a and 5 USDC to @b on X"]);
    const read = batchOf(await ask("Send 10 USDC to @a and 5 USDC to @b on X"));
    assert.deepEqual(paid(read), ["x:a=10", "x:b=5"], "the offered request reads back the same way");
    const unpaid = await ask("send 10 USDC to @a, 5 USDC to @b and 3 USDC to @newcomer on X");
    assert.match(unpaid.message, /@newcomer has no verified X account on HaPaPay\./);
    assert.deepEqual(suggestionsOf(unpaid), ["Send 10 USDC to @a and 5 USDC to @b on X", "Send 3 USDC to @newcomer on X"]);
  });

  it("asks each or split only when the request says neither, and reads a short typed answer", async () => {
    const asked = await ask("Send 1 NVDA to @a @b @c on X");
    assert.equal(asked.status, "needs_clarification");
    assert.equal(asked.message, "Should @a, @b and @c each get 1 NVDA (3 NVDA in total), or should 1 NVDA be split between them?");
    assert.deepEqual(suggestionsOf(asked), ["Send 1 NVDA each to @a, @b and @c on X", "Split 1 NVDA between @a, @b and @c on X"]);
    assert.equal(questionOf(asked)?.kind, "amount_mode");
    const request = questionOf(asked)!.request;
    for (const [answer, mode] of [["each", "each"], ["her birine", "each"], ["1'er", "each"], ["the first", "each"], ["split it", "split"], ["toplam", "split"], ["eşit böl", "split"], ["2", "split"]] as const) {
      const result = await ask(answer, { answering: { request } });
      assert.equal(batchOf(result).mode, mode, answer);
      assert.match(result.message, /^Reading that as “(?:Send 1 NVDA each to|Split 1 NVDA between) @a, @b and @c on X”\./, answer);
    }
    const unclear = await ask("evet", { answering: { request } });
    assert.equal(unclear.message, `I could not tell which one you meant. ${asked.message}`);
    const fresh = await ask("Send 2 USDC to @bob on X", { answering: { request } });
    assert.equal(fresh.status, "ready_for_review", "a request of its own is read as new");
    for (const conflict of ["send 1 nvda each to @a and @b on x in total", "@a ve @b'ye x'te 1'er nvda paylaştır"]) {
      assert.equal(questionOf(await ask(conflict))?.kind, "amount_mode", conflict);
    }
  });

  it("asks the platform first, offering where everyone is verified, and a typed platform answers it", async () => {
    const asked = await ask("1 NVDA'yi @a @b @c'ye gönder");
    assert.equal(asked.message, "Add which platform @a, @b and @c are on, for example: Send 1 NVDA to @a, @b and @c on X.");
    assert.deepEqual(suggestionsOf(asked), ["Send 1 NVDA to @a, @b and @c on X"]);
    assert.equal(questionOf(asked)?.kind, "platform");
    const answered = await ask("x'te", { answering: { request: questionOf(asked)!.request } });
    assert.equal(answered.message, "Reading that as “Send 1 NVDA to @a, @b and @c on X”. Should @a, @b and @c each get 1 NVDA (3 NVDA in total), or should 1 NVDA be split between them?");
    const telegram = await ask("on telegram", { answering: { request: questionOf(asked)!.request } });
    assert.match(telegram.message, /^Reading that as “Send 1 NVDA to @a, @b and @c on Telegram”\./, "a platform nobody offered is still the sender's answer");
    const single = await ask("send 5 usdc to bob");
    assert.equal(questionOf(single)?.kind, "platform", "one person's missing platform is a question too");
    const x = await ask("X", { answering: { request: questionOf(single)!.request } });
    assert.equal(x.status, "ready_for_review");
    assert.equal(x.message, "Reading that as “Send 5 USDC to @bob on X”. Recipient matched to one verified wallet. Review the details before signing.");
    const perPerson = batchOf(await ask("Send 2 USDC each to @a on X and @a on GitHub"));
    assert.deepEqual(paid(perPerson), ["x:a=2", "github:a=2"], "one handle on two platforms is two accounts");
  });

  it("names who cannot be paid directly and offers the rest, with vault links where they work", async () => {
    const asked = await ask("Send 3 USDC each to @a, @d and @e on X");
    assert.equal(asked.message, "@d and @e have no verified X accounts on HaPaPay. Pay @a now? @d and @e can each get their part in the vault until they join, with a request of their own.");
    assert.deepEqual(suggestionsOf(asked), ["Send 3 USDC to @a on X", "Send 3 USDC to @d on X", "Send 3 USDC to @e on X"]);
    const yes = await ask("evet", { answering: { request: questionOf(asked)!.request } });
    assert.equal(yes.status, "ready_for_review");
    const vaulted = await ask("3", { answering: { request: questionOf(asked)!.request } });
    assert.equal(vaulted.status, "claim_review", "the third offer is @e's vault link");
    const split = await ask("Split 10 USDC between @a, @b and @d on X");
    assert.deepEqual(suggestionsOf(split), ["Split 6.666667 USDC between @a and @b on X", "Send 3.333333 USDC to @d on X"], "everyone keeps the part they would have had");
    const own = await createChatDraft("send 1 usdc each to @a and @b on x", undefined, resolve, "Arc Mainnet", "robinhood-mainnet", transfers, { enabled: false }, vault, { sender: wallets["x:a"] });
    assert.equal(own.message, "@a is your own wallet. Pay @b now?");
    const same = batchOf(await ask("Send 1 USDC each to @a on X and @a on GitHub"));
    assert.equal(same.payments.length, 2);
    assert.match((await ask("Send 1 USDC each to @a on X and @a on GitHub")).message, /@a on X and @a on GitHub are the same wallet, so it is paid twice\./);
    assert.equal((await ask(`send 1 usdc each to ${Array.from({ length: 11 }, (_, index) => `@p${index}`).join(" ")} on x`)).message, "One request pays at most 10 people. Split the list into smaller requests.");
    assert.equal((await ask("split 0.000001 usdc between @a and @b on x")).message, "0.000001 USDC is too small to split between 2 people. Send a larger amount, or the same amount to each.");
  });

  it("reads a note after a marker, in quotes, or as a closing phrase, and keeps it in every request it offers", async () => {
    for (const [message, note] of [
      ["Send 5 USDC to @bob on X note: thanks for dinner!", "thanks for dinner!"],
      ["Send 5 USDC to @bob on X, memo: rent", "rent"],
      ["@bob'a x'te 5 usdc gönder açıklama: kira", "kira"],
      ["Send 5 USDC to @bob on X \"for the pizza\"", "for the pizza"],
      ["Send 5 USDC to @bob on X for dinner", "for dinner"],
      ["@bob'a x'te 5 usdc gönder, yemek için", "yemek için"],
      ["yemek için @bob'a x'te 5 usdc gönder", "yemek için"],
    ] as const) {
      const result = await ask(message);
      assert.equal(result.status, "ready_for_review", message);
      assert.equal((result as { note?: string }).note, note, message);
    }
    for (const plain of ["Send 5 USDC to @bob on X", "send 5 usdc to bob on x per his request", "Send 5 USDC to @bob on X for me"]) {
      assert.equal((await ask(plain) as { note?: string }).note, undefined, plain);
    }
    assert.equal((await ask("Send 5 USDC to @bob on X for tomorrow")).message, "HaPaPay sends right away; it cannot schedule or repeat a payment. Send it when you want it to arrive.", "a closing phrase never hides a later payment");
    const batch = batchOf(await ask("send 10 usdc each to @a @b on x note: thanks for the dinner!"));
    assert.equal(batch.note, "thanks for the dinner!");
    const asked = await ask("Send 1 NVDA to @a @b on X note: gift");
    assert.deepEqual(suggestionsOf(asked), ["Send 1 NVDA each to @a and @b on X, note: gift", "Split 1 NVDA between @a and @b on X, note: gift"]);
    assert.equal(batchOf(await ask("each", { answering: { request: questionOf(asked)!.request } })).note, "gift");
    assert.deepEqual(suggestionsOf(await ask("send 5 usdc to bob note: hi")), ["Send 5 USDC to @bob on X, note: hi"]);
    assert.equal((await ask("Send 5 USDC to @newcomer on X note: welcome")).message, "@newcomer is not on HaPaPay yet. You can keep the USDC in the Arc Mainnet vault; they claim it with their official X account within the window you pick, 72 hours to 30 days, or you take it back after that. A note rides only on a direct payment, so this vault link carries none.");
    assert.equal((await ask(`Send 5 USDC to @bob on X note: ${"x".repeat(141)}`)).message, "A note can be at most 140 characters.");
    assert.equal((await ask("Send 5 USDC to @bob on X note: rent\u202Edue")).message, "A note cannot contain hidden or control characters.");
  });

  it("lets the AI reader find people and a note only where the message writes them", async () => {
    const reading = (extra: Record<string, unknown>) => async () => ({ kind: "send", amount: "5", asset: "USDC", recipients: [], sourcePlatform: "unstated", note: "", ...extra });
    const thanks = await ask("pay bob 5 usdc on x thanks a lot", {}, reading({ recipients: [{ username: "bob", platform: "x" }], note: "thanks a lot" }));
    assert.equal(thanks.parser, "openrouter");
    assert.equal((thanks as { note?: string }).note, "thanks a lot");
    const invented = await ask("pay bob 5 usdc on x", {}, reading({ recipients: [{ username: "bob", platform: "x" }], note: "happy birthday" }));
    assert.equal((invented as { note?: string }).note, undefined, "a note the message does not write is dropped");
    const tokens = await ask("send 2 nvda on x: bob; alice", {}, reading({ amount: "2", asset: "NVDA", recipients: [{ username: "bob", platform: "x" }, { username: "alice", platform: "x" }] }));
    assert.equal(tokens.parser, "openrouter");
    assert.equal(tokens.message, "Reading that as “Send 2 NVDA to @bob and @alice on X”. Should @bob and @alice each get 2 NVDA (4 NVDA in total), or should 2 NVDA be split between them?");
    for (const [label, extra] of [
      ["a handle the message does not write", { amount: "2", asset: "NVDA", recipients: [{ username: "bob", platform: "x" }, { username: "carol", platform: "x" }] }],
      ["a platform the message does not name", { amount: "2", asset: "NVDA", recipients: [{ username: "bob", platform: "github" }, { username: "alice", platform: "github" }] }],
      ["another amount", { amount: "20", asset: "NVDA", recipients: [{ username: "bob", platform: "x" }, { username: "alice", platform: "x" }] }],
      ["another asset", { amount: "2", asset: "TSLA", recipients: [{ username: "bob", platform: "x" }, { username: "alice", platform: "x" }] }],
    ] as const) {
      const result = await ask("send 2 nvda on x: bob; alice", {}, reading(extra));
      assert.notEqual(result.parser, "openrouter", label);
      assert.equal(result.message, "Add who receives it and where, for example: Send 2 NVDA to @toly on X.", label);
    }
  });
});
