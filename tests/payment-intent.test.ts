import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { numberReadings, numberWordsBefore, parsePaymentIntent, parseSocialRecipient, parseSocialRecipients, statedUsdcAmounts } from "../src/domain/payment-intent";

describe("payment intent seam", () => {
  it("turns a Turkish cross-platform request into a reviewable USDC draft", () => {
    assert.deepEqual(
      parsePaymentIntent("GitHub hesabımdan X'teki @selin'e 25 USDC gönder"),
      {
      kind: "send",
      amount: "25",
      token: "USDC",
      recipient: { platform: "x", username: "selin" },
      sourcePlatform: "github",
      status: "draft",
      },
    );
  });

  it("turns an English cross-platform request into the same reviewable USDC draft", () => {
    assert.deepEqual(
      parsePaymentIntent("Send 4.5 USDC from my GitHub account to @nora on X"),
      {
        kind: "send",
        amount: "4.5",
        token: "USDC",
        recipient: { platform: "x", username: "nora" },
        sourcePlatform: "github",
        status: "draft",
      },
    );
  });

  it("keeps the recipient platform before the handle when a source platform follows it", () => {
    assert.deepEqual(
      parsePaymentIntent("Send 5 USDC to X @nora from my GitHub account"),
      {
        kind: "send",
        amount: "5",
        token: "USDC",
        recipient: { platform: "x", username: "nora" },
        sourcePlatform: "github",
        status: "draft",
      },
    );
  });

  it("does not treat a platform name inside the exact handle as a source platform", () => {
    for (const username of ["github", "discordfan"]) {
      assert.deepEqual(
        parsePaymentIntent(`Send 5 USDC to @${username} on X`),
        {
          kind: "send",
          amount: "5",
          token: "USDC",
          recipient: { platform: "x", username },
          sourcePlatform: undefined,
          status: "draft",
        },
      );
    }
  });

  it("uses later alias occurrences after ignoring a platform-shaped handle", () => {
    assert.deepEqual(
      parsePaymentIntent("Send 5 USDC from my GitHub account to @x on X"),
      {
        kind: "send",
        amount: "5",
        token: "USDC",
        recipient: { platform: "x", username: "x" },
        sourcePlatform: "github",
        status: "draft",
      },
    );

    assert.deepEqual(
      parsePaymentIntent("Send 5 USDC to @github on GitHub"),
      {
        kind: "send",
        amount: "5",
        token: "USDC",
        recipient: { platform: "github", username: "github" },
        sourcePlatform: undefined,
        status: "draft",
      },
    );
  });
});

describe("recipients written the way people write them", () => {
  it("finds a handle written without the @ in common English and Turkish phrasings", () => {
    const cases: Array<[string, string, string]> = [
      ["can you pay octocat 5 usdc on github", "octocat", "github"],
      ["Send 5 USDC to bob on X", "bob", "x"],
      ["send 5 usdc to my friend bob on x", "bob", "x"],
      ["give carol 2.5 USDC on Farcaster", "carol", "farcaster"],
      ["tip alice 3 usdc on warpcast", "alice", "farcaster"],
      ["Send 5 USDC to GitHub user octocat", "octocat", "github"],
      ["octocat'a githubda 3 usdc gönder", "octocat", "github"],
      ["GitHub'daki octocat adlı kullanıcıya 5 usdc gönder", "octocat", "github"],
      ["send fifty dollars to torvalds on github", "torvalds", "github"],
    ];
    for (const [message, username, platform] of cases) {
      assert.deepEqual(parseSocialRecipient(message), { username, recipientPlatform: platform, sourcePlatform: undefined }, message);
    }
    assert.deepEqual(parsePaymentIntent("can you pay octocat 5 usdc on github"), {
      kind: "send",
      amount: "5",
      token: "USDC",
      recipient: { platform: "github", username: "octocat" },
      sourcePlatform: undefined,
      status: "draft",
    });
  });

  it("does not read pronouns, amounts, assets, platforms or email addresses as a handle", () => {
    for (const message of ["send 5 usdc to me on x", "send 5 usdc on x", "Send 2 NVDA on X", "pay 5 usdg to github", "send it on x", "send 5 usdc to bob@example.com on x"]) {
      assert.deepEqual(parseSocialRecipient(message), {}, message);
    }
    assert.equal(parseSocialRecipient("Send 5 USDC to @nora.").username, "nora", "a full stop ends the handle");
    assert.equal(parseSocialRecipient("Send 5 USDC to @dwr.eth on Farcaster").username, "dwr.eth");
  });

  it("takes the platform only from the recipient's side, never from the sender's own account", () => {
    assert.deepEqual(parseSocialRecipient("Send 5 USDC from my GitHub account to @nora"), { username: "nora", recipientPlatform: undefined, sourcePlatform: "github" });
    assert.deepEqual(parseSocialRecipient("X hesabımdan @selin'e 2 NVDA gönder"), { username: "selin", recipientPlatform: undefined, sourcePlatform: "x" });
    // The only platform a request names, written as where the payment comes from, is where the recipient is, so the
    // parser reads "@jack'e x'ten 10 dolar yolla" as @jack on X.
    assert.deepEqual(parseSocialRecipient("X'ten @selin'e 2 NVDA gönder"), { username: "selin", recipientPlatform: "x", sourcePlatform: undefined });
    assert.deepEqual(parseSocialRecipient("dc'den @ali_123'e 5 usdc gönder"), { username: "ali_123", recipientPlatform: "discord", sourcePlatform: undefined });
    assert.deepEqual(parseSocialRecipient("send 5 usdc to @bob from github"), { username: "bob", recipientPlatform: "github", sourcePlatform: undefined });
    assert.deepEqual(parseSocialRecipient("x'ten @selin'e github'da 2 NVDA gönder"), { username: "selin", recipientPlatform: "github", sourcePlatform: "x" });
    assert.deepEqual(parseSocialRecipient("Send 5 USDC to @nora on X and tell her on Telegram"), { username: "nora", recipientPlatform: "x", sourcePlatform: undefined });
    assert.throws(() => parsePaymentIntent("Send 5 USDC from my GitHub account to @nora"));
  });
});

describe("amounts written the way people write them", () => {
  it("reads both decimal marks and thousands separators, and keeps both readings when a number is ambiguous", () => {
    const cases: Array<[string, string[]]> = [
      ["5", ["5"]], ["007.50", ["7.5"]], ["8,75", ["8.75"]], ["1,000.50", ["1000.5"]], ["1.000,50", ["1000.5"]],
      ["1.000.000", ["1000000"]], ["0,500", ["0.5"]], ["1,000", ["1", "1000"]], ["2.500", ["2.5", "2500"]], ["1.2.3", []],
    ];
    for (const [token, readings] of cases) assert.deepEqual(numberReadings(token), readings, token);
  });

  it("finds the USDC amount next to USDC, dollars or $, in digits or in words", () => {
    const amounts = (message: string) => statedUsdcAmounts(message).map(({ readings }) => readings.join("|"));
    assert.deepEqual(amounts("send $5 to bob"), ["5"]);
    assert.deepEqual(amounts("send 5$ to bob"), ["5"]);
    assert.deepEqual(amounts("20 dollars to carol"), ["20"]);
    assert.deepEqual(amounts("bob'a 50 dolar gönder"), ["50"]);
    assert.deepEqual(amounts("12 bucks"), ["12"]);
    assert.deepEqual(amounts("send twenty five usdc"), ["25"]);
    assert.deepEqual(amounts("yirmi beş dolar"), ["25"]);
    assert.deepEqual(amounts("send 1,000 usdc"), ["1|1000"]);
    assert.deepEqual(amounts("5 usdc to bob and 3 usdc to alice"), ["5", "3"]);
    assert.deepEqual(amounts("bob'a on usdc gönder"), [], "a lone on is the English word");
    assert.equal(numberWordsBefore("send a hundred ", 15), 100);
  });

  it("reads Turkish place endings, verbs and terse word orders, and never a handle from inside a word", () => {
    const cases: Array<[string, string, string]> = [
      ["octocat githubda 5 usdc atar mısın", "octocat", "github"],
      ["alice telegramda 20 dolar gönder", "alice", "telegram"],
      ["bob x'te 5 usdc gönder", "bob", "x"],
      ["beş usdc gönder bob x", "bob", "x"],
      ["5 usdc yolla x bob", "bob", "x"],
      ["bob x 5 usdc", "bob", "x"],
      ["send 5 usdc to bob in telegram", "bob", "telegram"],
    ];
    for (const [message, username, platform] of cases) {
      assert.deepEqual(parseSocialRecipient(message), { username, recipientPlatform: platform, sourcePlatform: undefined }, message);
    }
    assert.equal(parseSocialRecipient("bob x'ten 5 usdc gönder").recipientPlatform, undefined, "the ablative names the sender's account");
    assert.deepEqual(parseSocialRecipient("pay lütfi 5 usdc on x"), {}, "lütfi is a name, not the handle l");
    assert.deepEqual(parseSocialRecipient("x'teki bülent'e 5 usdc gönder"), {});
    assert.equal(parseSocialRecipient("Send 5 USDC to @bülent on X").username, undefined);
    assert.deepEqual(parsePaymentIntent("github'daki octocat'e 5 dolar yolla"), {
      kind: "send", amount: "5", token: "USDC", recipient: { platform: "github", username: "octocat" }, sourcePlatform: undefined, status: "draft",
    });
    assert.throws(() => parsePaymentIntent("send 1,000 usdc to bob on x"), "an ambiguous amount is never drafted");
  });
});

describe("everyone a request pays", () => {
  const read = (input: string) => parseSocialRecipients(input, ["nvda", "usdc"]).recipients.map(({ username, platform }) => `${username}:${platform ?? "?"}`);
  it("finds every @handle, lists without the @, and the platform written for each or for all", () => {
    assert.deepEqual(read("1 NVDA'yi @a @b @c'ye gönder"), ["a:?", "b:?", "c:?"]);
    assert.deepEqual(read("Send 1 NVDA to @a @b @c on X"), ["a:x", "b:x", "c:x"]);
    assert.deepEqual(read("send 5 usdc to alice, bob and carol on telegram"), ["alice:telegram", "bob:telegram", "carol:telegram"]);
    assert.deepEqual(read("send 5 usdc to bob, alice on x"), ["bob:x", "alice:x"]);
    assert.deepEqual(read("x'te bob ve alice'e 5 usdc gönder"), ["bob:x", "alice:x"]);
    assert.deepEqual(read("Send 2 USDC each to @a on X and @b on GitHub"), ["a:x", "b:github"]);
    assert.deepEqual(read("X'teki @a ve GitHub'daki @b'ye 3'er USDC"), ["a:x", "b:github"]);
    assert.deepEqual(read("send 5 usdc to @a, @a and @b on x"), ["a:x", "b:x"], "a handle named twice counts once");
    assert.deepEqual(read("send 1 usdc each to @a on x and @a on github"), ["a:x", "a:github"], "on two platforms it is two accounts");
    assert.deepEqual(read("send 5 usdc to bob on x and tell him thanks"), ["bob:x"]);
    assert.deepEqual(read("send 5 usdc to bob, he earned it"), ["bob:?"]);
    assert.deepEqual(read("send 5 usdc to bob and 3 usdc to alice on telegram"), ["bob:telegram"]);
    assert.deepEqual(read("mail bob@example.com 5 usdc"), [], "an email address is not a handle");
    assert.deepEqual(parseSocialRecipients("from my GitHub account send 5 USDC to @a and @b on X").sourcePlatform, "github");
  });
});
