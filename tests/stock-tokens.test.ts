import assert from "node:assert/strict";
import { payRouterAbi } from "../src/domain/fees";
import { describe, it } from "node:test";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { erc20TransferAbi } from "../src/domain/arc-transaction";
import { ROBINHOOD_STOCK_TOKENS, ROBINHOOD_STOCK_TOKENS_VERIFIED_ON, ROBINHOOD_TESTNET_STOCK_TOKENS, STOCK_TOKEN_ALLOWLISTS } from "../src/domain/robinhood-stock-tokens";
import {
  companyMention,
  matchesStockReview,
  normalizeStockAmount,
  parseStockTransferRequest,
  ROBINHOOD_CHAIN,
  ROBINHOOD_TESTNET,
  shareEquivalent,
  stockNetworkFor,
  stockTokenExplorerUrl,
  stockTokenPrice,
  stockTokenUnits,
  stockTokenValue,
  type PreparedStockTransfer,
} from "../src/domain/stock-tokens";

const mainnet = { network: "robinhood-mainnet" as const, tokens: ROBINHOOD_STOCK_TOKENS };
const testnet = { network: "robinhood-testnet" as const, tokens: ROBINHOOD_TESTNET_STOCK_TOKENS };
const known = new Set(Object.values(STOCK_TOKEN_ALLOWLISTS).flatMap(({ tokens }) => tokens.map((token) => token.symbol)));
import { parsePaymentIntent } from "../src/domain/payment-intent";
import { createChatDraft } from "../server/chat-service";
import { KNOWN_ROBINHOOD_SYMBOLS, ROBINHOOD_ASSET_ALLOWLISTS, ROBINHOOD_USDG } from "../src/domain/robinhood-assets";

const verified = (platform: string, username: string) => platform === "x" && username === "selin"
  ? "0x3333333333333333333333333333333333333333" as const
  : undefined;

describe("verified stock-token allowlist", () => {
  it("contains unique, checksummed Robinhood Chain listings from a dated verification", () => {
    assert.ok(ROBINHOOD_STOCK_TOKENS.length >= 100);
    assert.match(ROBINHOOD_STOCK_TOKENS_VERIFIED_ON, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Set(ROBINHOOD_STOCK_TOKENS.map((token) => token.symbol)).size, ROBINHOOD_STOCK_TOKENS.length);
    assert.equal(new Set(ROBINHOOD_STOCK_TOKENS.map((token) => token.address)).size, ROBINHOOD_STOCK_TOKENS.length);
    for (const token of ROBINHOOD_STOCK_TOKENS) {
      assert.match(token.symbol, /^[A-Z]{1,6}$/);
      assert.equal(token.address, getAddress(token.address));
      assert.ok(token.name && !/Robinhood Token/.test(token.name), `${token.symbol} keeps a clean display name`);
      assert.ok(token.kind === "stock" || token.kind === "etf");
    }
    const bySymbol = new Map(ROBINHOOD_STOCK_TOKENS.map((token) => [token.symbol, token]));
    assert.equal(bySymbol.get("NVDA")?.address, "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
    assert.equal(bySymbol.get("AAPL")?.address, "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9");
    assert.equal(bySymbol.get("SPY")?.kind, "etf");
    assert.equal(bySymbol.get("TSLA")?.kind, "stock");
  });

  it("keeps the Robinhood Chain Testnet faucet tokens separate from mainnet assets", () => {
    assert.deepEqual(ROBINHOOD_TESTNET_STOCK_TOKENS.map((token) => token.symbol), ["AMD", "AMZN", "NFLX", "PLTR", "TSLA"]);
    const testnetTsla = ROBINHOOD_TESTNET_STOCK_TOKENS.find((token) => token.symbol === "TSLA")!;
    const mainnetTsla = ROBINHOOD_STOCK_TOKENS.find((token) => token.symbol === "TSLA")!;
    assert.equal(testnetTsla.address, "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E");
    assert.notEqual(testnetTsla.address, mainnetTsla.address, "a testnet address is never a mainnet asset");
    for (const token of ROBINHOOD_TESTNET_STOCK_TOKENS) assert.equal(token.address, getAddress(token.address));
    assert.equal(STOCK_TOKEN_ALLOWLISTS["robinhood-testnet"].tokens, ROBINHOOD_TESTNET_STOCK_TOKENS);
    assert.equal(stockNetworkFor("robinhood-testnet"), "robinhood-testnet");
    for (const preference of [undefined, "robinhood-mainnet", "arc-testnet", "auto", "robinhood-testnet ", 46630]) {
      assert.equal(stockNetworkFor(preference), "robinhood-mainnet");
    }
    assert.equal(stockTokenExplorerUrl(testnetTsla.address, ROBINHOOD_TESTNET.id), `https://explorer.testnet.chain.robinhood.com/token/${testnetTsla.address}`);
    assert.equal(stockTokenExplorerUrl(mainnetTsla.address, ROBINHOOD_CHAIN.id), `https://robinhoodchain.blockscout.com/token/${mainnetTsla.address}`);
  });
});

describe("stock-token amounts", () => {
  it("uses 18-decimal token units and never the six-decimal USDC conversion", () => {
    assert.equal(stockTokenUnits("2"), 2_000_000_000_000_000_000n);
    assert.equal(stockTokenUnits("1,5"), 1_500_000_000_000_000_000n);
    assert.equal(stockTokenUnits("0.000000000000000001"), 1n);
    assert.equal(normalizeStockAmount("0.50"), "0.5");
    for (const invalid of ["0", "0.0", "-1", "1e3", "1.0000000000000000001", "", "abc"]) {
      assert.equal(normalizeStockAmount(invalid), undefined, invalid);
      assert.throws(() => stockTokenUnits(invalid));
    }
  });

  it("derives display-only share, price, and value figures without floating point", () => {
    assert.equal(shareEquivalent("2", "1.000775159164630595"), "2.0015");
    assert.equal(shareEquivalent("1", "4.000000000000000000"), "4.0000");
    assert.equal(stockTokenPrice("339.77", "339.84", "1.000566080061092436"), "340.00");
    assert.equal(stockTokenPrice("10", "9", "1"), undefined, "an inverted book is not priced");
    assert.equal(stockTokenValue("1.5", "340.00"), "510.00");
    assert.equal(stockTokenValue("0.333333333333333333", "3.00"), "1.00");
  });
});

describe("stock transfer requests", () => {
  it("reads English, Turkish, lowercase, and cashtag stock requests into a Robinhood Chain draft", () => {
    const cases: Array<[string, string, string, string | undefined]> = [
      ["Send 2 NVDA to @selin on X", "NVDA", "2", undefined],
      ["X'teki @selin'e 1,5 TSLA gönder", "TSLA", "1.5", undefined],
      ["send 3 spy to @selin on x", "SPY", "3", undefined],
      ["Send 0.25 $AAPL from my GitHub account to @selin on X", "AAPL", "0.25", "github"],
    ];
    for (const [message, symbol, amount, sourcePlatform] of cases) {
      const result = parseStockTransferRequest(message, mainnet, known);
      assert.equal(result.status, "parsed", message);
      if (result.status !== "parsed") continue;
      const token = ROBINHOOD_STOCK_TOKENS.find((candidate) => candidate.symbol === symbol)!;
      assert.deepEqual(result.intent, {
        kind: "send",
        asset: { type: "stock-token", kind: token.kind, symbol, name: token.name, address: token.address, chainId: ROBINHOOD_CHAIN.id, decimals: 18 },
        amount,
        recipient: { platform: "x", username: "selin" },
        sourcePlatform,
        status: "draft",
      });
    }
  });

  it("leaves USDC requests to the existing USDC parser", () => {
    for (const message of ["Send 25 USDC to @selin on X", "GitHub hesabımdan X'teki @selin'e 25 USDC gönder", "Send 5 USDC to @nora on X now"]) {
      assert.deepEqual(parseStockTransferRequest(message, mainnet, known), { status: "none" }, message);
    }
    assert.equal(parsePaymentIntent("Send 25 USDC to @selin on X").amount, "25");
  });

  it("asks for clarification instead of guessing an asset, amount, share count, or recipient", () => {
    const cases: Array<[string, RegExp]> = [
      ["Send 5 ETH to @selin on X", /ETH isn't on the verified token list/],
      ["Send 2 NVDX to @selin on X", /NVDX isn't on the verified token list/],
      ["Send $AAPL to @selin on X", /Add an amount/],
      ["Send 2 shares of NVDA to @selin on X", /token units, not shares/],
      ["@selin'e 2 NVDA hissesi gönder X", /token units, not shares/],
      ["Send 2 NVDA and 3 AAPL to @selin on X", /one token at a time/],
      ["Send 2 NVDA and 5 USDC to @selin on X", /one asset at a time/],
      ["Send 2 NVDA to selin", /^Add which platform @selin is on, for example: Send 2 NVDA to @selin on X\.$/],
      ["Send 2 NVDA to @selin", /^Add which platform @selin is on/],
      ["Send 2 NVDA on X", /^Add who receives it and where/],
      ["Send 2 NVDA from my GitHub account to @selin", /^Add which platform @selin is on/],
    ];
    for (const [message, expected] of cases) {
      const result = parseStockTransferRequest(message, mainnet, known);
      assert.equal(result.status, "invalid", message);
      if (result.status === "invalid") assert.match(result.message, expected, message);
    }
  });

  it("uses testnet faucet tokens only when Robinhood Testnet is selected", () => {
    const parsed = parseStockTransferRequest("Send 5 TSLA to @selin on X", testnet, known);
    assert.equal(parsed.status, "parsed");
    if (parsed.status === "parsed") {
      assert.equal(parsed.intent.asset.address, "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E");
      assert.equal(parsed.intent.asset.chainId, ROBINHOOD_TESTNET.id);
    }
    for (const message of ["Send 2 NVDA to @selin on X", "send 2 nvda to @selin on x", "Send 2 $SPY to @selin on X"]) {
      const result = parseStockTransferRequest(message, testnet, known);
      assert.equal(result.status, "invalid", message);
      if (result.status === "invalid") assert.match(result.message, /has no test token on Robinhood Chain Testnet\. Available here: AMD, AMZN, NFLX, PLTR, TSLA\./, message);
    }
    const unknown = parseStockTransferRequest("Send 5 ETH to @selin on X", testnet, known);
    assert.equal(unknown.status, "invalid");
    if (unknown.status === "invalid") assert.match(unknown.message, /ETH isn't on the verified token list.*Available here: AMD/);
    const main = parseStockTransferRequest("Send 5 TSLA to @selin on X", mainnet, known);
    assert.equal(main.status === "parsed" && main.intent.asset.chainId, ROBINHOOD_CHAIN.id);
  });

  it("reads USDG in six-decimal units and keeps share wording to Stock Tokens", () => {
    const assets = { network: "robinhood-mainnet" as const, tokens: ROBINHOOD_ASSET_ALLOWLISTS["robinhood-mainnet"].tokens };
    const parsed = parseStockTransferRequest("Send 25.5 USDG to @selin on X", assets, KNOWN_ROBINHOOD_SYMBOLS);
    assert.equal(parsed.status, "parsed");
    if (parsed.status === "parsed") {
      assert.deepEqual(parsed.intent.asset, { type: "stock-token", kind: "cash", symbol: "USDG", name: "Global Dollar", address: ROBINHOOD_USDG.address, chainId: ROBINHOOD_CHAIN.id, decimals: 6 });
      assert.equal(parsed.intent.amount, "25.5");
      assert.equal(stockTokenUnits(parsed.intent.amount, parsed.intent.asset.decimals), 25_500_000n);
    }
    assert.equal(parseStockTransferRequest("send 3 usdg to @selin on x", assets, KNOWN_ROBINHOOD_SYMBOLS).status, "parsed", "lowercase ticker");
    const precise = parseStockTransferRequest("Send 1.1234567 USDG to @selin on X", assets, KNOWN_ROBINHOOD_SYMBOLS);
    assert.equal(precise.status === "invalid" && precise.message, "Enter an amount greater than zero with at most 6 decimals.");
    const onTestnet = parseStockTransferRequest("Send 5 USDG to @selin on X", { network: "robinhood-testnet", tokens: ROBINHOOD_ASSET_ALLOWLISTS["robinhood-testnet"].tokens }, KNOWN_ROBINHOOD_SYMBOLS);
    assert.equal(onTestnet.status === "invalid" && onTestnet.message, "USDG has no test token on Robinhood Chain Testnet. Available here: AMD, AMZN, NFLX, PLTR, TSLA.");
    assert.equal(parseStockTransferRequest("Send 5 USDG and 1 NVDA to @selin on X", assets, KNOWN_ROBINHOOD_SYMBOLS).status, "invalid", "one token at a time");
    assert.equal(normalizeStockAmount("0.000001", 6), "0.000001");
    assert.equal(normalizeStockAmount("0.0000001", 6), undefined);
    assert.equal(normalizeStockAmount("1", 0), undefined, "no zero-decimal assets");
  });

  it("reads a recipient written without the @ and a platform named anywhere in the request", () => {
    const assets = { network: "robinhood-mainnet" as const, tokens: ROBINHOOD_ASSET_ALLOWLISTS["robinhood-mainnet"].tokens };
    const cases: Array<[string, string, string, string, string]> = [
      ["can you pay octocat 5 usdg on github", "USDG", "5", "octocat", "github"],
      ["please send bob 2 nvda on x", "NVDA", "2", "bob", "x"],
      ["5 usdg to octocat on github", "USDG", "5", "octocat", "github"],
      ["octocat on github 5 usdg", "USDG", "5", "octocat", "github"],
      ["give carol 1.5 TSLA on Farcaster", "TSLA", "1.5", "carol", "farcaster"],
      ["GitHub'daki octocat'a 3 NVDA gönder", "NVDA", "3", "octocat", "github"],
    ];
    for (const [message, symbol, amount, username, platform] of cases) {
      const result = parseStockTransferRequest(message, assets, KNOWN_ROBINHOOD_SYMBOLS);
      assert.equal(result.status, "parsed", message);
      if (result.status !== "parsed") continue;
      assert.equal(result.intent.asset.symbol, symbol, message);
      assert.equal(result.intent.amount, amount, message);
      assert.deepEqual(result.intent.recipient, { platform, username }, message);
      assert.equal(result.intent.sourcePlatform, undefined, message);
    }
    const zero = parseStockTransferRequest("pay octocat 0 usdg on github", assets, KNOWN_ROBINHOOD_SYMBOLS);
    assert.equal(zero.status === "invalid" && zero.message, "Enter an amount greater than zero with at most 6 decimals.");
  });

  it("does not read common lowercase words as tickers", () => {
    assert.deepEqual(parseStockTransferRequest("send 10 now to @selin on X", mainnet, known), { status: "none" });
    assert.equal(parseStockTransferRequest("Send 10 NOW to @selin on X", mainnet, known).status, "parsed");
  });

  it("reads amounts in words before a ticker, and asks about a thousands separator instead of guessing", () => {
    const assets = { network: "robinhood-mainnet" as const, tokens: ROBINHOOD_ASSET_ALLOWLISTS["robinhood-mainnet"].tokens };
    for (const [message, amount] of [["send two NVDA to bob on X", "2"], ["send ten usdg to bob on x", "10"], ["bob'a x'te üç $TSLA gönder", "3"]] as const) {
      const result = parseStockTransferRequest(message, assets, KNOWN_ROBINHOOD_SYMBOLS);
      assert.equal(result.status === "parsed" && result.intent.amount, amount, message);
    }
    assert.deepEqual(parseStockTransferRequest("send 1,000 usdg to bob on x", assets, KNOWN_ROBINHOOD_SYMBOLS), {
      status: "invalid",
      message: "“1,000” can mean 1000 or 1. Write the amount without a thousands separator, for example: Send 1000 USDG to @bob on X.",
      suggestions: ["Send 1000 USDG to @bob on X", "Send 1 USDG to @bob on X"],
    });
    const decimal = parseStockTransferRequest("send 1.000,5 usdg to bob on x", assets, KNOWN_ROBINHOOD_SYMBOLS);
    assert.equal(decimal.status === "parsed" && decimal.intent.amount, "1000.5");
  });

  it("offers the ticker for a company named instead of it, only as a suggestion", () => {
    assert.deepEqual(companyMention("send 3 apple to octocat on github", ROBINHOOD_STOCK_TOKENS)?.token.symbol, "AAPL");
    assert.deepEqual(companyMention("2 shares of microsoft", ROBINHOOD_STOCK_TOKENS), { token: ROBINHOOD_STOCK_TOKENS.find((token) => token.symbol === "MSFT"), amount: "2" });
    assert.equal(companyMention("tesla hissesi gönder", ROBINHOOD_STOCK_TOKENS)?.token.symbol, "TSLA");
    assert.equal(companyMention("@bob'a 2 tane apple gönder", ROBINHOOD_STOCK_TOKENS)?.amount, "2");
    assert.equal(companyMention("send 5 usdc to apple on x", ROBINHOOD_STOCK_TOKENS), undefined, "a handle is not a company");
    assert.equal(companyMention("applied 3 times", ROBINHOOD_STOCK_TOKENS), undefined);
    assert.deepEqual(parseStockTransferRequest("send 2 facebook to bob on x", mainnet, known), {
      status: "invalid",
      message: "Stock Tokens go by their ticker: Meta Platforms is META. Write it as “Send 2 META to @bob on X”.",
      suggestions: ["Send 2 META to @bob on X"],
      // What the request says, so a desk that lists the same stock on another network can offer that symbol instead.
      ticker: { symbol: "META", name: "Meta Platforms", shares: false, amount: "2", username: "bob", platform: "x" },
    });
    const noRecipient = parseStockTransferRequest("send 2 nvidia", mainnet, known);
    assert.equal(noRecipient.status === "invalid" && noRecipient.suggestions, undefined, "a suggestion always names who and where");
  });
});

describe("prepared stock-transfer check before the wallet opens", () => {
  const TSLA = ROBINHOOD_TESTNET_STOCK_TOKENS.find((token) => token.symbol === "TSLA")!;
  const sender = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
  const recipient = "0x3333333333333333333333333333333333333333";
  const units = "2500000000000000000";
  const prepared = (overrides: Record<string, unknown> = {}, transaction: Record<string, unknown> = {}) => ({
    networkId: "robinhood-testnet" as const,
    chainId: 46630,
    chainIdHex: "0xb626" as const,
    chainName: "Robinhood Chain Testnet",
    token: { symbol: "TSLA", name: "Tesla", address: TSLA.address, decimals: 18 },
    amount: "2.5",
    units,
    balance: "10",
    transaction: {
      from: sender as `0x${string}`,
      to: TSLA.address,
      data: encodeFunctionData({ abi: erc20TransferAbi, functionName: "transfer", args: [recipient, 2_500_000_000_000_000_000n] }),
      value: "0x0",
      ...transaction,
    },
    ...overrides,
  });
  const review = { network: "robinhood-testnet" as const, token: TSLA.address, sender: sender.toLowerCase(), recipient, units };

  it("accepts only the exact reviewed ERC-20 transfer", () => {
    assert.equal(matchesStockReview(prepared(), review), true);
    const tampered: Array<[string, ReturnType<typeof prepared>]> = [
      ["other network", prepared({ networkId: "robinhood-mainnet", chainId: 4663, chainIdHex: "0x1237" })],
      ["other chain id", prepared({ chainId: 1 })],
      ["other token", prepared({}, { to: ROBINHOOD_TESTNET_STOCK_TOKENS[0].address })],
      ["other sender", prepared({}, { from: "0x2222222222222222222222222222222222222222" })],
      ["native value", prepared({}, { value: "0x1" })],
      ["other recipient", prepared({}, { data: encodeFunctionData({ abi: erc20TransferAbi, functionName: "transfer", args: ["0x4444444444444444444444444444444444444444", 2_500_000_000_000_000_000n] }) })],
      ["other amount", prepared({}, { data: encodeFunctionData({ abi: erc20TransferAbi, functionName: "transfer", args: [recipient, 25n] }) })],
      ["different units label", prepared({ units: "1" })],
      ["not a transfer", prepared({}, { data: "0x095ea7b3" })],
    ];
    for (const [label, candidate] of tampered) assert.equal(matchesStockReview(candidate, review), false, label);
  });

  it("through the fee router accepts only an approval of the amount plus at most 1%, then pay of the reviewed transfer", () => {
    const router = "0x5555555555555555555555555555555555555555" as const;
    const paymentRef = `0x${"cd".repeat(32)}` as const;
    const fee = { router, feeBps: 100, units: "25000000000000000", amount: "0.025", burnShare: "12500000000000000", treasuryShare: "12500000000000000", totalUnits: "2525000000000000000", totalAmount: "2.525" };
    const approve = (spender: `0x${string}`, amount: bigint) => encodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]), functionName: "approve", args: [spender, amount] });
    const pay = (to: `0x${string}`, amount: bigint, ref: `0x${string}` = paymentRef) => encodeFunctionData({ abi: payRouterAbi, functionName: "pay", args: [TSLA.address, to, amount, ref] });
    const routed = (overrides: { fee?: typeof fee; approveData?: `0x${string}`; payData?: `0x${string}`; payTo?: `0x${string}`; extra?: boolean } = {}): PreparedStockTransfer => ({
      ...prepared({ transaction: undefined }),
      transaction: undefined,
      fee: overrides.fee ?? fee,
      paymentRef,
      transactions: [
        { purpose: "approve", from: sender, to: TSLA.address, value: "0x0", data: overrides.approveData ?? approve(router, 2_525_000_000_000_000_000n) },
        { purpose: "pay", from: sender, to: overrides.payTo ?? router, value: "0x0", data: overrides.payData ?? pay(recipient, 2_500_000_000_000_000_000n) },
        ...(overrides.extra ? [{ purpose: "pay" as const, from: sender as `0x${string}`, to: router, value: "0x0", data: pay(recipient, 1n) }] : []),
      ],
    });
    assert.equal(matchesStockReview(routed(), review), true);
    const tampered: Array<[string, PreparedStockTransfer]> = [
      ["approval without the fee", routed({ approveData: approve(router, 2_500_000_000_000_000_000n) })],
      ["unlimited approval", routed({ approveData: approve(router, 2n ** 256n - 1n) })],
      ["approval to another spender", routed({ approveData: approve(recipient, 2_525_000_000_000_000_000n) })],
      ["pay sent elsewhere", routed({ payTo: recipient })],
      ["pay to another recipient", routed({ payData: pay("0x4444444444444444444444444444444444444444", 2_500_000_000_000_000_000n) })],
      ["pay of another amount", routed({ payData: pay(recipient, 25n) })],
      ["pay with another reference", routed({ payData: pay(recipient, 2_500_000_000_000_000_000n, `0x${"ee".repeat(32)}`) })],
      ["fee above 1%", routed({ fee: { ...fee, units: "50000000000000000", totalUnits: "2550000000000000000", burnShare: "25000000000000000", treasuryShare: "25000000000000000" }, approveData: approve(router, 2_550_000_000_000_000_000n) })],
      ["a third call", routed({ extra: true })],
      ["a plain transfer beside the fee", { ...routed(), transaction: prepared().transaction }],
    ];
    for (const [label, candidate] of tampered) assert.equal(matchesStockReview(candidate, review), false, label);
  });
});

describe("stock drafts in the chat API seam", () => {
  it("returns a locked stock review with exact token units and never consults the USDC AI parser", async () => {
    let aiCalls = 0;
    const result = await createChatDraft(
      "Send 2 NVDA to @selin on X",
      async () => { aiCalls++; return { kind: "send", amount: "2", token: "USDC", recipient: { platform: "x", username: "selin" }, status: "draft" }; },
      verified,
      "Arc Testnet",
    );
    assert.equal(aiCalls, 0);
    assert.equal(result.status, "stock_review");
    if (result.status !== "stock_review") return;
    assert.equal(result.stockIntent.asset.symbol, "NVDA");
    assert.equal(result.stockNetwork, "robinhood-mainnet");
    assert.equal(result.units, "2000000000000000000");
    assert.equal(result.chainId, 4663);
    assert.equal(result.transferEnabled, false);
    assert.match(result.message, /Robinhood Chain stock transfers are off on this server, so this stays a draft/);
    assert.equal("intent" in result, false, "a stock draft never uses the USDC intent field");
    assert.equal("transaction" in result, false);
  });

  it("drafts testnet faucet tokens on Robinhood Chain Testnet and explains mainnet-only tickers", async () => {
    const draft = await createChatDraft("Send 1,5 TSLA to @selin on X", undefined, verified, "Arc Testnet", "robinhood-testnet", true);
    assert.equal(draft.status, "stock_review");
    if (draft.status === "stock_review") {
      assert.equal(draft.transferEnabled, true);
      assert.match(draft.message, /Check the transfer below, then sign it in your wallet/);
      assert.equal("transaction" in draft, false, "a draft is never a prepared transaction");
      assert.equal(draft.stockNetwork, "robinhood-testnet");
      assert.equal(draft.chainId, 46630);
      assert.equal(draft.network, "Robinhood Chain Testnet");
      assert.equal(draft.stockIntent.asset.address, "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E");
      assert.equal(draft.units, "1500000000000000000");
    }
    let aiCalls = 0;
    const unavailable = await createChatDraft("send 2 nvda to @selin on x", async () => { aiCalls++; return {}; }, verified, "Arc Testnet", "robinhood-testnet");
    assert.equal(aiCalls, 0, "a mainnet ticker on testnet never falls through to the USDC AI parser");
    assert.equal(unavailable.status, "needs_clarification");
    assert.match(unavailable.message, /NVDA has no test token/);
  });

  it("keeps unverified stock recipients and unknown assets out of the USDC claim flow", async () => {
    const unknownRecipient = await createChatDraft("Send 2 NVDA to @octocat on GitHub", undefined, verified);
    assert.equal(unknownRecipient.status, "needs_clarification");
    assert.equal("intent" in unknownRecipient, false);
    assert.match(unknownRecipient.message, /^@octocat has not linked GitHub to HaPaPay yet\./);

    let aiCalls = 0;
    const unknownAsset = await createChatDraft("Send 5 ETH to @selin on X", async () => { aiCalls++; return {}; }, verified);
    assert.equal(aiCalls, 0);
    assert.equal(unknownAsset.status, "needs_clarification");
  });
});
