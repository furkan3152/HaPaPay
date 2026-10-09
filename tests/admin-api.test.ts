import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { AdminAuthService, MemoryAdminAuditRepository, MemoryAdminSettingsRepository, payloadHash, readAdminWallets } from "../server/admin-service";
import { DeskControls } from "../server/desk-controls";
import { SpActivity } from "../server/sp-activity";
import { MemorySpRepository, SpService } from "../server/sp-service";
import { MemoryPaymentRepository } from "../server/payment-history-service";
import { MemoryReferralStore } from "../server/referral-store";
import { ReferralPayouts } from "../server/referral-payouts";
import type { SolanaRpc } from "../server/solana-network";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { REFERRAL_CODE_PATTERN } from "../src/domain/referrals";
import { DEFAULT_SP_RULES } from "../src/domain/sp";
import type { ReferralSummary } from "../src/referral-desk";

const admin = privateKeyToAccount(generatePrivateKey());
const member = privateKeyToAccount(generatePrivateKey());

/** The Solana addresses of the test's accounts, where invite rewards would be paid. */
const SOLANA_ADDRESSES = new Map<string, string>([[member.address, "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2"]]);

function setup() {
  const auth = new WalletAuthService({ domain: "localhost", sessionSecret: "admin-api-test-secret-at-least-32-characters" });
  const identities = new VerifiedIdentityService();
  const repository = new MemorySpRepository();
  const referrals = new MemoryReferralStore();
  const service = new SpService({ repository, referrals, rulesCacheMs: 0 });
  const payments = new MemoryPaymentRepository();
  const activity = new SpActivity({ sp: service, identities, sources: { arc: { payments } } });
  const audit = new MemoryAdminAuditRepository();
  const controls = new DeskControls(new MemoryAdminSettingsRepository(), 0);
  // Solana is only read for the payouts' status here; preparing and recording a payout is tested in referral-payouts.
  const rpc = { getBlockHeight: () => ({ send: async () => 100n }) } as unknown as SolanaRpc;
  const payouts = new ReferralPayouts({
    store: referrals,
    rpc,
    solana: { onMainnet: async () => undefined, computePrice: async () => 0n },
    solanaAddress: async (wallet) => SOLANA_ADDRESSES.get(wallet),
    frozen: async () => false,
  });
  const app = createApp({
    auth,
    identities,
    sp: { service, activity },
    admin: { auth: new AdminAuthService({ domain: "localhost", wallets: [admin.address] }), audit, controls, database: "memory", payouts },
  });
  return { app, repository, referrals, service, audit, payments, identities };
}

async function listen(app: ReturnType<typeof createApp>) {
  return new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
}

function origin(listener: Server) {
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function signIn(base: string, account: ReturnType<typeof privateKeyToAccount>) {
  const challenge = await (await fetch(`${base}/api/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  })).json() as { id: string; message: string };
  const login = await fetch(`${base}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) }),
  });
  return login.headers.get("set-cookie")?.split(";")[0] ?? "";
}

const json = (cookie: string, body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

/** The admin panel's API: reads with a session, every change signed and recorded first. */
describe("admin API", () => {
  it("lets only admin wallets read, and says why to everyone else", async () => {
    const { app } = setup();
    const server = await listen(app);
    try {
      const base = origin(server);
      assert.deepEqual(await (await fetch(`${base}/api/admin/me`)).json(), { configured: true, wallet: null, admin: false });
      assert.equal((await fetch(`${base}/api/admin/overview`)).status, 401);
      const memberCookie = await signIn(base, member);
      assert.equal((await fetch(`${base}/api/admin/overview`, { headers: { Cookie: memberCookie } })).status, 403);
      assert.equal((await fetch(`${base}/api/admin/challenge`, json(memberCookie, { action: "notice.set", payload: { text: "Hi" } }))).status, 403);
      const adminCookie = await signIn(base, admin);
      assert.deepEqual(await (await fetch(`${base}/api/admin/me`, { headers: { Cookie: adminCookie } })).json(), { configured: true, wallet: admin.address, admin: true });
      const overview = await (await fetch(`${base}/api/admin/overview`, { headers: { Cookie: adminCookie } })).json();
      assert.equal(overview.database, "memory");
      assert.equal(overview.rules.version, 1);
      assert.deepEqual(overview.controls, { paused: {}, notice: null });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("runs a change only with the admin's signature over that exact change, once, and records it before it runs", async () => {
    const { app, repository, audit } = setup();
    const server = await listen(app);
    try {
      const base = origin(server);
      const cookie = await signIn(base, admin);
      const payload = { account: member.address.toLowerCase(), amount: 12.5, reason: "Launch gift" };
      const challenge = await (await fetch(`${base}/api/admin/challenge`, json(cookie, { action: "sp.adjust", payload }))).json() as { id: string; message: string; payload: Record<string, unknown> };
      assert.match(challenge.message, /localhost admin change/);
      assert.match(challenge.message, new RegExp(`Account: ${member.address}`), "the wallet shows the checksummed account");
      assert.match(challenge.message, /SP: \+12\.5/);
      assert.match(challenge.message, /Reason: Launch gift/);
      assert.match(challenge.message, new RegExp(`Payload: ${payloadHash(challenge.payload)}`));
      const signature = await admin.signMessage({ message: challenge.message });

      // The same signature over a different amount changes nothing.
      const tampered = await fetch(`${base}/api/admin/actions`, json(cookie, { action: "sp.adjust", payload: { ...payload, amount: 125 }, challengeId: challenge.id, signature }));
      assert.equal(tampered.status, 403);
      assert.equal(await repository.balance(member.address), 0);

      // The tampered try used up the approval: it is one-time, so the admin signs again.
      const again = await (await fetch(`${base}/api/admin/challenge`, json(cookie, { action: "sp.adjust", payload }))).json() as { id: string; message: string };
      const done = await fetch(`${base}/api/admin/actions`, json(cookie, { action: "sp.adjust", payload, challengeId: again.id, signature: await admin.signMessage({ message: again.message }) }));
      assert.equal(done.status, 200);
      assert.equal(await repository.balance(member.address), 12.5);
      const replay = await fetch(`${base}/api/admin/actions`, json(cookie, { action: "sp.adjust", payload, challengeId: again.id, signature: await admin.signMessage({ message: again.message }) }));
      assert.equal(replay.status, 403, "an approval runs once");
      assert.equal(await repository.balance(member.address), 12.5);

      // Another wallet's signature over the admin's message is refused.
      const third = await (await fetch(`${base}/api/admin/challenge`, json(cookie, { action: "sp.adjust", payload }))).json() as { id: string; message: string };
      const forged = await fetch(`${base}/api/admin/actions`, json(cookie, { action: "sp.adjust", payload, challengeId: third.id, signature: await member.signMessage({ message: third.message }) }));
      assert.equal(forged.status, 403);

      const [recorded] = await audit.list({ limit: 10 });
      assert.equal(recorded.action, "sp.adjust");
      assert.equal(recorded.actor, admin.address);
      assert.equal(recorded.target, member.address);
      assert.equal((recorded.details as { signature: string }).signature.length > 100, true, "the signature is kept as proof");
      assert.equal((await audit.list({ limit: 10 })).length, 1, "refused tries change nothing and are not recorded as changes");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses invalid changes before anything is signed", async () => {
    const { app } = setup();
    const server = await listen(app);
    try {
      const base = origin(server);
      const cookie = await signIn(base, admin);
      const refuse = async (action: string, payload: unknown, message: RegExp) => {
        const response = await fetch(`${base}/api/admin/challenge`, json(cookie, { action, payload }));
        assert.equal(response.status, 400, action);
        assert.match((await response.json() as { error: string }).error, message);
      };
      await refuse("sp.adjust", { account: member.address, amount: 0, reason: "Nothing" }, /not zero/);
      await refuse("sp.adjust", { account: member.address, amount: 1.25, reason: "Too fine" }, /at most one decimal/);
      await refuse("sp.adjust", { account: "0x123", amount: 5, reason: "Bad" }, /wallet address/);
      await refuse("sp.reverse", { entryId: "abc", reason: "Bad" }, /entry number/);
      await refuse("sp.rules", { rules: { ...DEFAULT_SP_RULES, dailyCap: -5 } }, /dailyCap/);
      await refuse("switches.set", { key: "everything", paused: true }, /./);
      await refuse("drop.tables", {}, /Unknown admin change/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("pauses new payments with the admin's message, shows it on the desk, and never pauses claims", async () => {
    const { app } = setup();
    const server = await listen(app);
    try {
      const base = origin(server);
      const cookie = await signIn(base, admin);
      const change = async (action: string, payload: Record<string, unknown>) => {
        const challenge = await (await fetch(`${base}/api/admin/challenge`, json(cookie, { action, payload }))).json() as { id: string; message: string };
        const response = await fetch(`${base}/api/admin/actions`, json(cookie, { action, payload, challengeId: challenge.id, signature: await admin.signMessage({ message: challenge.message }) }));
        assert.equal(response.status, 200, `${action}: ${await response.clone().text()}`);
        return response.json();
      };
      await change("switches.set", { key: "arc.payments", paused: true, message: "Arc upgrade <b>tonight</b>" });
      await change("notice.set", { text: "Arc payments are paused for an upgrade.", tone: "warning" });
      const providers = await (await fetch(`${base}/api/providers`)).json() as { controls: { paused: Record<string, { message: string }>; notice: { text: string; tone: string } } };
      assert.equal(providers.controls.paused["arc.payments"].message, "Arc upgrade b tonight /b", "no markup reaches the desk");
      assert.equal(providers.controls.notice.tone, "warning");
      const paused = await fetch(`${base}/api/payment/prepare`, json(cookie, { networkPreference: "arc-mainnet" }));
      assert.equal(paused.status, 503);
      assert.deepEqual(await paused.json(), { error: "Arc upgrade b tonight /b", paused: "arc.payments" });
      // Claims and refunds are never paused: the claim route answers on its own terms, not with the pause.
      const claim = await fetch(`${base}/api/claims/${"0x" + "ab".repeat(32)}/prepare-claim`, json(cookie, {}));
      assert.notEqual((await claim.json() as { paused?: string }).paused, "arc.payments");
      await change("switches.set", { key: "arc.payments", paused: false });
      const resumed = await (await fetch(`${base}/api/payment/prepare`, json(cookie, { networkPreference: "arc-mainnet" }))).json() as { paused?: string };
      assert.equal(resumed.paused, undefined, "running again: the route answers on its own terms");
      assert.deepEqual((await (await fetch(`${base}/api/providers`)).json() as { controls: unknown }).controls, { paused: {}, notice: { text: "Arc payments are paused for an upgrade.", tone: "warning", since: (await (await fetch(`${base}/api/providers`)).json() as { controls: { notice: { since: string } } }).controls.notice.since } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reads accounts, the ledger and the exports, and saves new rules as a new version", async () => {
    const { app, payments, service } = setup();
    await payments.save({ chainId: 5042, transactionHash: `0x${"11".repeat(32)}`, sender: member.address, recipient: admin.address, platform: "github", username: "admin", amount: "25", feeUnits: "250000", blockNumber: 1n, confirmedAt: "2026-10-05T08:00:00.000Z" });
    const server = await listen(app);
    try {
      const base = origin(server);
      const memberCookie = await signIn(base, member);
      const mine = await (await fetch(`${base}/api/sp`, { headers: { Cookie: memberCookie } })).json() as { balance: number; awarded: number; entries: unknown[] };
      assert.equal(mine.balance, 25 + 10);
      assert.equal(mine.awarded, 25 + 10);
      assert.equal(mine.entries.length, 2);
      assert.equal((await fetch(`${base}/api/sp`)).status, 401);
      assert.equal((await (await fetch(`${base}/api/sp/rules`)).json() as { version: number }).version, 1, "the rules are public");

      const cookie = await signIn(base, admin);
      const account = await (await fetch(`${base}/api/admin/accounts/${member.address}`, { headers: { Cookie: cookie } })).json() as { sp: { balance: number }; ledger: unknown[] };
      assert.equal(account.sp.balance, 35);
      assert.equal(account.ledger.length, 2);
      assert.equal((await fetch(`${base}/api/admin/accounts/github:nobody`, { headers: { Cookie: cookie } })).status, 404);
      const ledger = await (await fetch(`${base}/api/admin/sp/ledger?zero=1`, { headers: { Cookie: cookie } })).json() as { rows: unknown[] };
      assert.equal(ledger.rows.length, 2);
      const exported = await (await fetch(`${base}/api/admin/export/sp-ledger`, { headers: { Cookie: cookie } })).json() as { rows: unknown[]; next: null };
      assert.equal(exported.rows.length, 2);
      assert.equal(exported.next, null);

      const rules = { ...DEFAULT_SP_RULES, perDollar: 1.5 };
      const challenge = await (await fetch(`${base}/api/admin/challenge`, json(cookie, { action: "sp.rules", payload: { rules, note: "More for dollars" } }))).json() as { id: string; message: string };
      const saved = await (await fetch(`${base}/api/admin/actions`, json(cookie, { action: "sp.rules", payload: { rules, note: "More for dollars" }, challengeId: challenge.id, signature: await admin.signMessage({ message: challenge.message }) }))).json() as { result: { version: number } };
      assert.equal(saved.result.version, 2);
      assert.equal((await service.rules()).rules.perDollar, 1.5);
      const history = await (await fetch(`${base}/api/admin/sp/rules`, { headers: { Cookie: cookie } })).json() as { history: Array<{ version: number }> };
      assert.deepEqual(history.history.map((version) => version.version), [2, 1]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("gives each account an invite link, joins a new account once, and shows the inviter's rewards to it and to admins", async () => {
    const { app, payments } = setup();
    const invitee = privateKeyToAccount(generatePrivateKey());
    const paidBefore = privateKeyToAccount(generatePrivateKey());
    const server = await listen(app);
    try {
      const base = origin(server);
      assert.equal((await fetch(`${base}/api/sp/referral`)).status, 401);
      const read = async (cookie: string) => await (await fetch(`${base}/api/sp/referral`, { headers: { Cookie: cookie } })).json() as ReferralSummary;
      const join = async (cookie: string, code: unknown) => {
        const answer = await fetch(`${base}/api/sp/referral`, json(cookie, { code }));
        return answer.ok ? (await answer.json() as { status: string }).status : answer.status;
      };
      const memberCookie = await signIn(base, member);
      const mine = await read(memberCookie);
      assert.match(mine.code, REFERRAL_CODE_PATTERN);
      assert.deepEqual({ ...mine, code: "" }, {
        code: "", invited: 0, joined: false, sp: 0, fees: { earned: "0", paid: "0", owed: "0" }, solanaAddress: null, minimumPayout: "1000000", rules: DEFAULT_SP_RULES.referral,
      });
      assert.equal((await read(memberCookie)).code, mine.code, "an account keeps its code");

      const inviteeCookie = await signIn(base, invitee);
      assert.equal(await join(inviteeCookie, 12345678), 400);
      assert.equal(await join(inviteeCookie, "ZZZZZZZZ"), "unknown");
      assert.equal(await join(memberCookie, mine.code), "self");
      assert.equal(await join(inviteeCookie, ` ${mine.code.toLowerCase()} `), "joined", "a code reads in any case");
      assert.equal(await join(inviteeCookie, mine.code), "already");
      const theirs = await read(inviteeCookie);
      assert.equal(theirs.joined, true);
      assert.equal(await join(memberCookie, theirs.code), "cycle", "nobody joins with the code of someone they invited");
      await payments.save({ chainId: 5042, transactionHash: `0x${"31".repeat(32)}`, sender: paidBefore.address, recipient: admin.address, platform: "github", username: "admin", amount: "5", feeUnits: "50000", blockNumber: 1n, confirmedAt: "2026-10-05T08:00:00.000Z" });
      assert.equal(await join(await signIn(base, paidBefore), mine.code), "not_new", "only an account that has not paid anyone yet joins");

      // The invited account pays $200 to someone else through the router (its receipt showed the $2 fee): it earns 200 SP
      // and 10 for a first payment. Its inviter earns 15% of that SP and half of the fee in USDC (0.5% of $200).
      await payments.save({ chainId: 5042, transactionHash: `0x${"32".repeat(32)}`, sender: invitee.address, recipient: admin.address, platform: "github", username: "admin", amount: "200", feeUnits: "2000000", blockNumber: 2n, confirmedAt: new Date().toISOString() });
      const earned = await (await fetch(`${base}/api/sp`, { headers: { Cookie: inviteeCookie } })).json() as { balance: number };
      assert.equal(earned.balance, 210);
      const inviter = await read(memberCookie);
      assert.equal(inviter.invited, 1);
      assert.equal(inviter.sp, 31.5);
      assert.deepEqual(inviter.fees, { earned: "1000000", paid: "0", owed: "1000000" });
      const ledger = await (await fetch(`${base}/api/sp`, { headers: { Cookie: memberCookie } })).json() as { balance: number; entries: Array<{ kind: string; amount: number }> };
      assert.equal(ledger.balance, 31.5);
      assert.deepEqual(ledger.entries.map((entry) => [entry.kind, entry.amount]).sort(), [["referral", 1.5], ["referral", 30]]);

      const cookie = await signIn(base, admin);
      assert.equal((await fetch(`${base}/api/admin/referrals`, { headers: { Cookie: memberCookie } })).status, 403);
      const view = async (wallet: string) => await (await fetch(`${base}/api/admin/accounts/${wallet}`, { headers: { Cookie: cookie } })).json() as {
        referral: { code: string; invited: number; invitedBy: { wallet: string } | null; invitees: Array<{ wallet: string }> };
      };
      assert.equal((await view(invitee.address)).referral.invitedBy?.wallet, member.address);
      const inviterAccount = await view(member.address);
      assert.equal(inviterAccount.referral.invitedBy, null);
      assert.deepEqual(inviterAccount.referral.invitees.map((entry) => entry.wallet), [invitee.address]);
      const overview = await (await fetch(`${base}/api/admin/referrals`, { headers: { Cookie: cookie } })).json() as {
        totals: unknown; owed: unknown[]; batches: unknown[]; rules: unknown;
      };
      assert.deepEqual(overview.totals, { invites: 1, earned: "1000000", paid: "0", owed: "1000000" });
      assert.deepEqual(overview.owed, [{ referrer: member.address, owed: "1000000", address: SOLANA_ADDRESSES.get(member.address), frozen: false }]);
      assert.deepEqual(overview.batches, []);
      assert.deepEqual(overview.rules, DEFAULT_SP_RULES.referral);
      const refused = await fetch(`${base}/api/admin/referrals/payouts`, json(cookie, { payer: "not-a-solana-wallet" }));
      assert.equal(refused.status, 400);
      assert.match((await refused.json() as { error: string }).error, /Connect the Solana wallet that pays/);
      const missing = await fetch(`${base}/api/admin/referrals/payouts/0123456789abcdef`, json(cookie, {}));
      assert.equal(missing.status, 400);
      assert.match((await missing.json() as { error: string }).error, /not found/);
      assert.equal((await fetch(`${base}/api/admin/referrals/payouts`, json(memberCookie, { payer: SOLANA_ADDRESSES.get(member.address) }))).status, 403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("runs the daily SP check only for Vercel Cron's secret, and keeps its result for the panel", async () => {
    const auth = new WalletAuthService({ domain: "localhost", sessionSecret: "admin-api-test-secret-at-least-32-characters" });
    const identities = new VerifiedIdentityService();
    const repository = new MemorySpRepository();
    const service = new SpService({ repository, rulesCacheMs: 0 });
    const payments = new MemoryPaymentRepository();
    await payments.save({ chainId: 5042, transactionHash: `0x${"22".repeat(32)}`, sender: member.address, recipient: admin.address, platform: "github", username: "admin", amount: "10", feeUnits: "100000", blockNumber: 1n, confirmedAt: "2026-10-05T08:00:00.000Z" });
    // In memory the run covers accounts the ledger knows; seed one so the member is among them.
    await service.adjust({ actor: admin.address, account: member.address, amount: 0.5, reason: "Seed" });
    const settings = new MemoryAdminSettingsRepository();
    const make = (cronSecret?: string) => createApp({
      auth,
      identities,
      sp: { service, activity: new SpActivity({ sp: service, identities, sources: { arc: { payments } } }) },
      admin: { auth: new AdminAuthService({ domain: "localhost", wallets: [admin.address] }), audit: new MemoryAdminAuditRepository(), controls: new DeskControls(settings, 0), settings, cronSecret, database: "memory" },
    });
    const off = await listen(make());
    const on = await listen(make("cron-secret-value-with-enough-length"));
    try {
      assert.equal((await fetch(`${origin(off)}/api/cron/sp-sync`, { headers: { Authorization: "Bearer anything" } })).status, 404, "no secret, no route");
      assert.equal((await fetch(`${origin(on)}/api/cron/sp-sync`)).status, 401);
      assert.equal((await fetch(`${origin(on)}/api/cron/sp-sync`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
      assert.equal(await repository.balance(member.address), 0.5);
      const run = await fetch(`${origin(on)}/api/cron/sp-sync`, { headers: { Authorization: "Bearer cron-secret-value-with-enough-length" } });
      assert.equal(run.status, 200);
      assert.deepEqual(await run.json(), { synced: 1, awarded: 10 + 10, next: null });
      assert.equal(await repository.balance(member.address), 20.5);
      const last = await settings.get<{ by: string; synced: number }>("sp.sync.last");
      assert.equal(last?.value.by, "cron");
      assert.equal(last?.value.synced, 1);
    } finally {
      await new Promise<void>((resolve) => off.close(() => resolve()));
      await new Promise<void>((resolve) => on.close(() => resolve()));
    }
  });

  it("reads admin wallets from the environment, with the operator wallets", () => {
    const wallets = readAdminWallets({ ADMIN_WALLET_ADDRESSES: `${admin.address.toLowerCase()}, ${member.address}`, ROBINHOOD_OPERATOR_ADDRESS: admin.address });
    assert.deepEqual(wallets, { wallets: [admin.address, member.address], problems: [] });
    assert.deepEqual(readAdminWallets({ ADMIN_WALLET_ADDRESSES: "not-a-wallet" }).problems, ["ADMIN_WALLET_ADDRESSES must be wallet addresses separated by commas."]);
  });
});
