import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forgetUnrecordedFunding, rememberUnrecordedFunding, retryUnrecordedFundings } from "../src/domain/unrecorded-fundings";

/**
 * Audit, 2026-10-06: a vault link whose funding landed but whose record did not reach the server before its tab
 * closed appeared in nobody's Claims, and its payment ID was shown nowhere. Each funding's record request is now kept
 * in the browser from the moment the wallet sends it, and sent again after the next sign-in until the server has it.
 */
function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial ? [["hapapay:unrecorded-fundings:v1", initial]] : []);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    entries: () => JSON.parse(values.get("hapapay:unrecorded-fundings:v1") ?? "[]") as Array<{ transaction: string; attempts: number }>,
  };
}

const WALLET = "0x00000000000000000000000000000000000000A1";
const NOW = Date.parse("2026-10-06T12:00:00Z");
const funding = (transaction: string, wallet = WALLET) => ({ url: "/api/solana/claims/confirm" as const, body: { signature: transaction, paymentId: `0x${"ab".repeat(32)}` }, wallet, transaction });

describe("vault fundings kept until they are recorded", () => {
  it("keeps one entry per transaction and forgets it once recorded", () => {
    const storage = memoryStorage();
    rememberUnrecordedFunding(funding("sig-1"), storage, NOW);
    rememberUnrecordedFunding(funding("sig-1"), storage, NOW);
    rememberUnrecordedFunding(funding("sig-2"), storage, NOW);
    assert.deepEqual(storage.entries().map((entry) => entry.transaction), ["sig-1", "sig-2"]);
    forgetUnrecordedFunding("sig-1", storage);
    assert.deepEqual(storage.entries().map((entry) => entry.transaction), ["sig-2"]);
  });

  it("sends this wallet's fundings again: recorded or already recorded is forgotten, never landed is dropped", async () => {
    const storage = memoryStorage();
    for (const transaction of ["recorded", "already", "dropped", "outage", "refused"]) rememberUnrecordedFunding(funding(transaction), storage, NOW);
    rememberUnrecordedFunding(funding("other-wallet", "0x00000000000000000000000000000000000000b2"), storage, NOW);
    const answers: Record<string, number> = { recorded: 201, already: 409, dropped: 410, outage: 503, refused: 400 };
    const sent: string[] = [];
    const recorded = await retryUnrecordedFundings(WALLET.toLowerCase(), async (url, body) => {
      assert.equal(url, "/api/solana/claims/confirm");
      sent.push(String(body.signature));
      return { status: answers[String(body.signature)] };
    }, storage, NOW + 60_000);
    assert.equal(recorded, 2);
    assert.deepEqual(sent, ["recorded", "already", "dropped", "outage", "refused"], "only the signed-in wallet's fundings are sent");
    assert.deepEqual(storage.entries().map((entry) => [entry.transaction, entry.attempts]), [["outage", 0], ["refused", 1], ["other-wallet", 0]],
      "an outage is not counted against a funding; a refusal is");
  });

  it("does not count a lost connection, a missing session or a rate limit, and gives up after ten refusals or a month", async () => {
    const storage = memoryStorage();
    rememberUnrecordedFunding(funding("offline"), storage, NOW);
    rememberUnrecordedFunding(funding("signed-out"), storage, NOW);
    rememberUnrecordedFunding(funding("busy"), storage, NOW);
    rememberUnrecordedFunding(funding("refused"), storage, NOW);
    const send = async (_url: string, body: Record<string, unknown>) => {
      if (body.signature === "offline") throw new TypeError("Failed to fetch");
      return { status: body.signature === "signed-out" ? 401 : body.signature === "busy" ? 429 : 400 };
    };
    for (let round = 0; round < 10; round++) await retryUnrecordedFundings(WALLET, send, storage, NOW + round);
    assert.deepEqual(storage.entries().map((entry) => [entry.transaction, entry.attempts]), [["offline", 0], ["signed-out", 0], ["busy", 0], ["refused", 10]]);
    await retryUnrecordedFundings(WALLET, send, storage, NOW + 11);
    assert.deepEqual(storage.entries().map((entry) => entry.transaction), ["offline", "signed-out", "busy"], "ten refusals give a funding up");
    await retryUnrecordedFundings(WALLET, async () => ({ status: 503 }), storage, NOW + 32 * 24 * 60 * 60_000);
    assert.deepEqual(storage.entries(), [], "a month later nothing is kept");
  });

  it("keeps a funding saved meanwhile and does not bring back one recorded meanwhile", async () => {
    const storage = memoryStorage();
    rememberUnrecordedFunding(funding("slow"), storage, NOW);
    rememberUnrecordedFunding(funding("recorded-by-the-slip"), storage, NOW);
    await retryUnrecordedFundings(WALLET, async (_url, body) => {
      if (body.signature === "slow") {
        // While this answer is on its way, the slip records its own funding and another one is sent.
        forgetUnrecordedFunding("recorded-by-the-slip", storage);
        rememberUnrecordedFunding(funding("new"), storage, NOW);
      }
      return { status: 503 };
    }, storage, NOW);
    assert.deepEqual(storage.entries().map((entry) => entry.transaction), ["slow", "new"]);
  });

  it("works, keeping nothing, where storage is unavailable or broken", async () => {
    const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };
    rememberUnrecordedFunding(funding("sig"), broken, NOW);
    forgetUnrecordedFunding("sig", broken);
    assert.equal(await retryUnrecordedFundings(WALLET, async () => ({ status: 201 }), broken, NOW), 0);
    assert.equal(await retryUnrecordedFundings(WALLET, async () => ({ status: 201 }), memoryStorage("not json"), NOW), 0);
    assert.equal(await retryUnrecordedFundings(WALLET, async () => ({ status: 201 }), undefined, NOW), 0);
  });
});
