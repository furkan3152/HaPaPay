import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";
import { createChatDraft } from "../server/chat-service.js";
import { parseWithOpenRouter } from "../server/openrouter.js";

const message = "Send 7.25 USDC from my GitHub account to @nora on X";
const wallet = "0x3333333333333333333333333333333333333333" as const;
const reading = {
  kind: "send",
  amount: "7.25",
  asset: "USDC",
  recipients: [{ username: "nora", platform: "x" }],
  sourcePlatform: "github",
  note: "",
};
const intent = {
  kind: "send",
  amount: "7.25",
  token: "USDC",
  recipient: { platform: "x", username: "nora" },
  sourcePlatform: "github",
  status: "draft",
};

function setup(t: TestContext) {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only-openrouter-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
}

describe("OpenRouter request deadline", () => {
  it("accepts a structured draft and clears the deadline after success", async (t) => {
    setup(t);
    let signal: AbortSignal | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      assert.equal(init?.method, "POST");
      const request = JSON.parse(String(init?.body));
      assert.equal(request.response_format.type, "json_schema");
      assert.equal(request.response_format.json_schema.strict, true);
      assert.deepEqual(request.response_format.json_schema.schema.properties.kind.enum, ["send", "none"], "the model can say a message is not a payment");
      assert.equal(request.response_format.json_schema.schema.properties.recipients.type, "array", "the model reads every recipient");
      assert.deepEqual(request.response_format.json_schema.schema.required, ["kind", "amount", "asset", "recipients", "sourcePlatform", "note"]);
      assert.match(request.messages[0].content, /only a platform the message names/);
      assert.match(request.messages[0].content, /copied exactly as written/, "a note is copied, never written");
      assert.match(request.messages[0].content, /never convert currencies, add up or split/);
      return Response.json({ choices: [{ message: { content: JSON.stringify(reading) } }] });
    });

    const result = await createChatDraft(message, parseWithOpenRouter, () => wallet, "Arc Testnet");
    assert.equal(result.status, "ready_for_review");
    assert.equal(result.parser, "openrouter");
    assert.deepEqual(result.intent, intent);
    assert.equal("transactionHash" in result, false);
    assert.ok(signal);
    t.mock.timers.tick(8_000);
    assert.equal(signal.aborted, false);
  });

  it("aborts stalled response headers at eight seconds and returns the local draft", async (t) => {
    setup(t);
    let signal: AbortSignal | undefined;
    let parserError: unknown;
    t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      // An unresponsive transport must not keep the caller waiting after abort.
      return new Promise<Response>(() => {});
    });
    let settled = false;
    const pending = createChatDraft(message, async (text) => {
      try { return await parseWithOpenRouter(text); }
      catch (error) { parserError = error; throw error; }
    }, () => wallet).finally(() => { settled = true; });

    t.mock.timers.tick(7_999);
    await nextTurn();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(settled, true, "stalled OpenRouter headers must release the chat request at the deadline");
    const result = await pending;
    assert.equal(result.parser, "local_fallback");
    assert.equal(result.status, "ready_for_review");
    assert.equal(result.intent?.amount, "7.25");
    assert.equal(signal?.aborted, true);
    assert.ok(parserError instanceof Error);
    assert.equal(parserError.message, "OpenRouter request timed out");
  });

  it("uses one total deadline for delayed headers and a stalled JSON response body", async (t) => {
    setup(t);
    let signal: AbortSignal | undefined;
    let receiveHeaders!: (response: Response) => void;
    t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { receiveHeaders = resolve; });
    });
    let settled = false;
    const pending = createChatDraft(message, parseWithOpenRouter, () => wallet).finally(() => { settled = true; });

    t.mock.timers.tick(5_000);
    receiveHeaders(new Response(new ReadableStream()));
    await nextTurn();
    t.mock.timers.tick(2_999);
    await nextTurn();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(settled, true, "a stalled JSON body must release the chat request at the original deadline");
    const result = await pending;
    assert.equal(result.parser, "local_fallback");
    assert.equal(result.status, "ready_for_review");
    assert.equal(result.intent?.amount, "7.25");
    assert.equal(signal?.aborted, true);
  });

  for (const [label, response] of [
    ["HTTP error", () => new Response("upstream unavailable", { status: 503 })],
    ["invalid structured output", () => Response.json({ choices: [{ message: { content: '{"status":"sent"}' } }] })],
  ] as const) {
    it(`keeps local fallback and clears the deadline after ${label}`, async (t) => {
      setup(t);
      let signal: AbortSignal | undefined;
      t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return response();
      });
      const result = await createChatDraft(message, parseWithOpenRouter, () => wallet);
      assert.equal(result.parser, "local_fallback");
      assert.equal(result.intent?.amount, "7.25");
      assert.ok(signal);
      t.mock.timers.tick(8_000);
      assert.equal(signal.aborted, false);
    });
  }
});
