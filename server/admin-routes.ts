import type express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { DESK_FEATURE_KEYS, DESK_NOTICE_MAX_LENGTH, PAUSE_MESSAGE_MAX_LENGTH, type DeskFeature } from "../src/domain/desk-controls.js";
import type { PendingVaultLinks } from "../src/domain/pending-claims.js";
import { isTenths, roundSp, SP_ADJUST_LIMIT, validateSpRules, type SpEntryKind } from "../src/domain/sp.js";
import type { Platform } from "../src/domain/payment-intent.js";
import { AdminRefusedError, isAdminAction, type AdminAction, type AdminAuditRepository, type AdminAuthService, type AdminSettingsRepository } from "./admin-service.js";
import type { AdminRecords } from "./admin-records.js";
import type { DeskControls } from "./desk-controls.js";
import type { IdentityStore } from "./identity-store.js";
import type { SpActivity } from "./sp-activity.js";
import { SP_ADJUST_ERROR, SP_KINDS, SpRequestError, ledgerCursor, type SpService } from "./sp-service.js";
import { ReferralPayoutError, type ReferralPayouts } from "./referral-payouts.js";

/** The admin panel on this server: who may use it, where changes are recorded, and the desk's switches. */
export type AdminDesk = {
  auth: AdminAuthService;
  audit: AdminAuditRepository;
  controls: DeskControls;
  /** Reads across every account; only with the database. */
  records?: AdminRecords;
  /** Where the daily SP check keeps its place and its last result. */
  settings?: AdminSettingsRepository;
  /** Vercel Cron's secret (`CRON_SECRET`): the daily SP check runs only for a request that carries it. */
  cronSecret?: string;
  database: "postgres" | "memory";
  /** Invite rewards in USDC: who is owed what, and payouts prepared for an admin's Solana wallet and checked on chain. */
  payouts?: ReferralPayouts;
};

type Middleware = (request: express.Request, response: express.Response, next: express.NextFunction) => void;
type RouteContext = {
  admin?: AdminDesk;
  sp?: { service: SpService; activity: Pick<SpActivity, "syncAccount"> };
  identities: IdentityStore;
  session(request: express.Request): { address: Address } | undefined;
  protectedIngress: Middleware;
  limit(options: { perMinute: number; message: string }): Middleware;
  solanaAddress?(wallet: Address): Promise<string | undefined>;
  walletForSolana?(address: string): Promise<Address | undefined>;
  /** Payments the account sent and received, as the desk lists them, per network. */
  accountPayments?(wallet: Address): Promise<Record<string, unknown[]>>;
  /** Vault links the account can claim or refund now, read back from each chain. */
  pendingLinks?(wallet: Address): Promise<PendingVaultLinks>;
};


const addressSchema = z.string().trim().refine((value) => isAddress(value, { strict: false }), "Enter a wallet address.").transform((value) => getAddress(value));
const reasonSchema = z.string().trim().min(3, "Give a reason of 3 to 300 characters.").max(300, "Give a reason of 3 to 300 characters.");

/**
 * Each change's payload, checked before it is signed and again when it comes back, so the wallet signs exactly what
 * runs. Transforms are deterministic: the same input always hashes the same.
 */
const PAYLOADS = {
  "sp.rules": z.object({ rules: z.unknown(), note: z.string().trim().max(300).default("") }).transform((value, refine) => {
    const checked = validateSpRules(value.rules);
    if ("error" in checked) {
      refine.addIssue({ code: z.ZodIssueCode.custom, message: checked.error });
      return z.NEVER;
    }
    return { rules: checked.rules, note: value.note };
  }),
  "sp.adjust": z.object({
    account: addressSchema,
    amount: z.number().refine((value) => isTenths(value) && value !== 0 && Math.abs(value) <= SP_ADJUST_LIMIT, SP_ADJUST_ERROR).transform(roundSp),
    reason: reasonSchema,
  }),
  "sp.reverse": z.object({ entryId: z.string().regex(/^\d{1,18}$/, "Enter the SP entry number."), reason: reasonSchema }),
  "sp.freeze": z.object({ account: addressSchema, frozen: z.boolean(), reason: reasonSchema }),
  "sp.sync": z.object({ account: addressSchema.optional(), after: z.string().max(64).optional() }),
  "switches.set": z.object({
    key: z.enum(DESK_FEATURE_KEYS as [DeskFeature, ...DeskFeature[]]),
    paused: z.boolean(),
    message: z.string().trim().max(PAUSE_MESSAGE_MAX_LENGTH).default(""),
  }),
  "notice.set": z.object({ text: z.string().trim().max(DESK_NOTICE_MAX_LENGTH).default(""), tone: z.enum(["info", "warning"]).default("info") }),
} satisfies Record<AdminAction, z.ZodType>;

function checkedPayload(action: AdminAction, input: unknown): Record<string, unknown> {
  const parsed = PAYLOADS[action].safeParse(input ?? {});
  if (!parsed.success) throw new SpRequestError(parsed.error.issues[0]?.message ?? "The change is not valid.");
  return parsed.data as Record<string, unknown>;
}

const SYNC_BATCH = 100;
const SYNC_BUDGET_MS = 25_000;
const CRON_BUDGET_MS = 45_000;
const LAST_SYNC_KEY = "sp.sync.last";
const SYNC_CURSOR_KEY = "sp.sync.cursor";
export type SpSyncRun = { at: string; synced: number; awarded: number; next: string | null; by: string };

/**
 * Awards missing SP for every account, a batch at a time, until the time budget runs out; `next` continues where it
 * stopped. An account that cannot be read now (a chain down) is left for the next run; nothing is written for it.
 */
async function syncEveryone(sp: { service: SpService; activity: Pick<SpActivity, "syncAccount"> }, desk: AdminDesk, start: string | undefined, budgetMs: number) {
  const started = Date.now();
  let after = start;
  let synced = 0;
  let awarded = 0;
  for (;;) {
    const page = desk.records ? await desk.records.accounts(after, SYNC_BATCH) : await sp.service.repository.accounts(after, SYNC_BATCH);
    for (const wallet of page.wallets) {
      awarded = roundSp(awarded + (await sp.activity.syncAccount(wallet, { links: "now" }).catch(() => ({ awarded: 0 }))).awarded);
      synced++;
    }
    after = page.next ?? undefined;
    if (!page.next || Date.now() - started > budgetMs) return { synced, awarded, next: page.next };
  }
}

const sameSecret = (given: string | undefined, expected: string) => {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return typeof given === "string" && timingSafeEqual(digest(given), digest(expected));
};

/**
 * The admin panel's API. An admin's
 * wallet session reads; every change is signed by that wallet for that change only and written to the audit log
 * before it runs, so nothing changes without a record of who approved it.
 */
export function registerAdminRoutes(app: express.Express, context: RouteContext) {
  const readLimit = context.limit({ perMinute: 120, message: "Too many admin requests. Try again in one minute." });
  const writeLimit = context.limit({ perMinute: 20, message: "Too many admin changes. Try again in one minute." });

  /** The session's wallet when it is an admin's; otherwise the answer is sent and nothing is returned. */
  const admin = (request: express.Request, response: express.Response) => {
    const session = context.session(request);
    if (!context.admin?.auth.configured) return void response.status(503).json({ error: "No admin wallet is set on this server (ADMIN_WALLET_ADDRESSES)." });
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!context.admin.auth.isAdmin(session.address)) return void response.status(403).json({ error: "This wallet is not an admin of HaPaPay." });
    if (!context.sp) return void response.status(503).json({ error: "SP is not available on this server right now." });
    return { wallet: session.address, desk: context.admin, sp: context.sp };
  };
  const failed = (response: express.Response, error: unknown) => {
    if (error instanceof SpRequestError || error instanceof AdminRefusedError || error instanceof ReferralPayoutError) return void response.status(400).json({ error: error.message });
    response.status(503).json({ error: "That could not be read right now. Try again shortly." });
  };

  app.get("/api/admin/me", context.protectedIngress, readLimit, (request, response) => {
    const session = context.session(request);
    response.json({
      configured: Boolean(context.admin?.auth.configured),
      wallet: session?.address ?? null,
      admin: Boolean(session && context.admin?.auth.isAdmin(session.address)),
    });
  });

  app.get("/api/admin/overview", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    try {
      const now = new Date();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const [totals, rules, leaderboard, ledger, audit, controls, counts, lastSync] = await Promise.all([
        allowed.sp.service.repository.totals(today),
        allowed.sp.service.rules(),
        allowed.sp.service.repository.leaderboard(10),
        allowed.sp.service.repository.ledger({ limit: 15, includeZero: true }),
        allowed.desk.audit.list({ limit: 10 }),
        allowed.desk.controls.view(),
        allowed.desk.records?.counts() ?? Promise.resolve(null),
        allowed.desk.settings?.get<SpSyncRun>(LAST_SYNC_KEY).catch(() => undefined) ?? Promise.resolve(undefined),
      ]);
      response.json({
        sp: totals, rules, leaderboard, ledger, audit, controls, counts, database: allowed.desk.database,
        lastSync: lastSync?.value ?? null, dailySync: Boolean(allowed.desk.cronSecret),
      });
    } catch (error) {
      failed(response, error);
    }
  });

  // An account by wallet, by `platform:handle`, or by its Solana address.
  app.get("/api/admin/accounts/:query", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    try {
      const wallet = await findAccount(String(request.params.query ?? "").trim());
      if (!wallet) return void response.status(404).json({ error: "No HaPaPay account matches that." });
      const profile = await context.identities.profile(wallet);
      const referrals = allowed.sp.service.referrals;
      const [accounts, solanaAddress, summary, flags, ledger, payments, links, invitedBy, invitees, invites] = await Promise.all([
        Promise.all(profile.accounts.map((account) => context.identities.account(wallet, account.platform))),
        context.solanaAddress?.(wallet).catch(() => undefined),
        allowed.sp.service.summary(wallet),
        allowed.sp.service.repository.flags(wallet),
        allowed.sp.service.repository.ledger({ account: wallet, limit: 50, includeZero: true }),
        context.accountPayments?.(wallet).catch(() => null) ?? Promise.resolve(null),
        context.pendingLinks?.(wallet).catch(() => null) ?? Promise.resolve(null),
        referrals?.referrerOf(wallet) ?? Promise.resolve(undefined),
        referrals?.invitees(wallet, 50) ?? Promise.resolve([]),
        allowed.sp.service.referralSummary(wallet),
      ]);
      response.json({
        wallet,
        accounts: accounts.filter((account) => account !== undefined).map((account) => ({ platform: account.platform, username: account.username, providerUserId: account.providerUserId, verifiedAt: account.verifiedAt })),
        solanaAddress: solanaAddress ?? null,
        sp: summary,
        flags: flags ?? null,
        ledger,
        payments,
        links,
        referral: invites ? { ...invites, invitedBy: invitedBy ? { wallet: invitedBy.referrer, since: invitedBy.createdAt } : null, invitees: invitees.map((invitee) => ({ wallet: invitee.invitee, since: invitee.createdAt })) } : null,
      });
    } catch (error) {
      failed(response, error);
    }
  });

  // Invites: what inviters earned and were paid, who is owed, and the payouts made.
  app.get("/api/admin/referrals", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    const referrals = allowed.sp.service.referrals;
    if (!referrals || !allowed.desk.payouts) return void response.status(503).json({ error: "Invites are not available on this server right now." });
    try {
      const [totals, owed, batches, rules] = await Promise.all([
        referrals.totals(),
        allowed.desk.payouts.owed(50),
        allowed.desk.payouts.recent(20),
        allowed.sp.service.rules(),
      ]);
      response.json({
        totals: { invites: totals.invites, earned: totals.earned.toString(), paid: totals.paid.toString(), owed: (totals.earned - totals.paid).toString() },
        owed, batches, rules: rules.rules.referral,
      });
    } catch (error) {
      failed(response, error);
    }
  });

  // A payout for the Solana wallet the admin connected: the server prepares it, the wallet signs and sends it.
  app.post("/api/admin/referrals/payouts", context.protectedIngress, writeLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    if (!allowed.desk.payouts) return void response.status(503).json({ error: "Invites are not available on this server right now." });
    const payer = typeof request.body?.payer === "string" ? request.body.payer.trim() : "";
    try {
      response.json(await allowed.desk.payouts.prepare({ payer, admin: allowed.wallet }));
    } catch (error) {
      failed(response, error);
    }
  });

  // The payout is recorded only from its transaction on Solana, after the audit log keeps the admin and the signature.
  app.post("/api/admin/referrals/payouts/:batch", context.protectedIngress, writeLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    if (!allowed.desk.payouts) return void response.status(503).json({ error: "Invites are not available on this server right now." });
    const signature = typeof request.body?.signature === "string" && request.body.signature.trim() ? request.body.signature.trim() : undefined;
    try {
      // The payout service writes the audit row itself, before it records the payout.
      const state = await allowed.desk.payouts.confirm({ batch: String(request.params.batch), signature, admin: allowed.wallet });
      response.json({ status: state.status, signature: state.signature ?? null, payouts: state.payouts });
    } catch (error) {
      failed(response, error);
    }
  });

  async function findAccount(query: string): Promise<Address | undefined> {
    if (isAddress(query, { strict: false })) return getAddress(query);
    const handle = query.match(/^(github|x|telegram|discord|farcaster):@?([A-Za-z0-9_.-]{1,64})$/i);
    if (handle) {
      const wallet = await context.identities.resolve(handle[1].toLowerCase() as Platform, handle[2].toLowerCase());
      return wallet ? getAddress(wallet) : undefined;
    }
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(query)) return context.walletForSolana?.(query);
    return undefined;
  }

  app.get("/api/admin/sp/ledger", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    const query = request.query;
    const account = typeof query.account === "string" && isAddress(query.account, { strict: false }) ? getAddress(query.account) : undefined;
    const kind = typeof query.kind === "string" && (SP_KINDS as readonly string[]).includes(query.kind) ? query.kind as SpEntryKind : undefined;
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    try {
      const rows = await allowed.sp.service.repository.ledger({
        limit: limit + 1, account, kind, before: typeof query.before === "string" ? query.before : undefined, includeZero: query.zero === "1",
      });
      response.json({ rows: rows.slice(0, limit), next: rows.length > limit ? ledgerCursor(rows[limit - 1]) : null });
    } catch (error) {
      failed(response, error);
    }
  });

  app.get("/api/admin/sp/rules", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    try {
      const [current, history] = await Promise.all([allowed.sp.service.rules(), allowed.sp.service.repository.rulesHistory(50)]);
      response.json({ current, history });
    } catch (error) {
      failed(response, error);
    }
  });

  app.get("/api/admin/sp/leaderboard", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    try {
      response.json({ leaderboard: await allowed.sp.service.repository.leaderboard(Math.min(500, Math.max(1, Number(request.query.limit) || 100))) });
    } catch (error) {
      failed(response, error);
    }
  });

  app.get("/api/admin/activity", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    if (!allowed.desk.records) return void response.status(503).json({ error: "Activity across accounts is read from the database, which this server does not use." });
    const query = request.query;
    try {
      const rows = await allowed.desk.records.activity({
        kind: query.kind === "vault_link" ? "vault_link" : "payment",
        limit: Math.min(200, Math.max(1, Number(query.limit) || 50)),
        before: typeof query.before === "string" ? query.before : undefined,
        wallet: typeof query.wallet === "string" && isAddress(query.wallet, { strict: false }) ? getAddress(query.wallet) : undefined,
      });
      const last = rows.at(-1);
      response.json({ rows, next: last ? `${last.confirmedAt}|${last.id}` : null });
    } catch (error) {
      failed(response, error);
    }
  });

  app.get("/api/admin/audit", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    const before = typeof request.query.before === "string" && /^\d{1,18}$/.test(request.query.before) ? request.query.before : undefined;
    try {
      const entries = await allowed.desk.audit.list({ limit: 50, before, action: typeof request.query.action === "string" ? request.query.action.slice(0, 40) : undefined });
      response.json({ entries, next: entries.length === 50 ? entries[entries.length - 1].id : null });
    } catch (error) {
      failed(response, error);
    }
  });

  // A copy of the append-only tables, a page at a time; the panel joins the pages into one file.
  app.get("/api/admin/export/:table", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    const before = typeof request.query.before === "string" ? request.query.before : undefined;
    try {
      switch (request.params.table) {
        case "sp-ledger": {
          const rows = await allowed.sp.service.repository.ledger({ limit: 501, before, includeZero: true });
          return void response.json({ rows: rows.slice(0, 500), next: rows.length > 500 ? ledgerCursor(rows[499]) : null });
        }
        case "sp-rules":
          return void response.json({ rows: await allowed.sp.service.repository.rulesHistory(10_000), next: null });
        case "audit": {
          const rows = await allowed.desk.audit.list({ limit: 500, before: before && /^\d{1,18}$/.test(before) ? before : undefined });
          return void response.json({ rows, next: rows.length === 500 ? rows[rows.length - 1].id : null });
        }
        default:
          return void response.status(404).json({ error: "Export sp-ledger, sp-rules or audit." });
      }
    } catch (error) {
      failed(response, error);
    }
  });

  // Vercel Cron, once a day: every account's missing SP, so nobody has to open the desk for theirs. It carries
  // CRON_SECRET; without the secret set, or with another one, nothing runs. A long run continues the next day.
  app.get("/api/cron/sp-sync", async (request, response) => {
    const desk = context.admin;
    if (!desk?.cronSecret || !context.sp) return void response.status(404).json({ error: "Not found." });
    if (!sameSecret(request.headers.authorization, `Bearer ${desk.cronSecret}`)) return void response.status(401).json({ error: "Unauthorized." });
    try {
      const cursor = await desk.settings?.get<string | null>(SYNC_CURSOR_KEY).catch(() => undefined);
      const run = await syncEveryone(context.sp, desk, cursor?.value ?? undefined, CRON_BUDGET_MS);
      await desk.settings?.set(SYNC_CURSOR_KEY, run.next, "cron");
      await desk.settings?.set<SpSyncRun>(LAST_SYNC_KEY, { at: new Date().toISOString(), ...run, by: "cron" }, "cron");
      response.json(run);
    } catch {
      response.status(503).json({ error: "The SP check could not finish. It runs again tomorrow." });
    }
  });

  app.post("/api/admin/challenge", context.protectedIngress, writeLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    const action = request.body?.action;
    if (!isAdminAction(action)) return void response.status(400).json({ error: "Unknown admin change." });
    try {
      const payload = checkedPayload(action, request.body?.payload);
      response.json({ ...await allowed.desk.auth.challenge({ address: allowed.wallet, action, payload }), payload });
    } catch (error) {
      failed(response, error);
    }
  });

  app.post("/api/admin/actions", context.protectedIngress, writeLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    const action = request.body?.action;
    if (!isAdminAction(action)) return void response.status(400).json({ error: "Unknown admin change." });
    const challengeId = typeof request.body?.challengeId === "string" ? request.body.challengeId : "";
    const signature = typeof request.body?.signature === "string" && /^0x[0-9a-fA-F]{130,}$/.test(request.body.signature) ? request.body.signature as Hex : undefined;
    if (!challengeId || !signature) return void response.status(400).json({ error: "Sign the change with your wallet first." });
    let payload: Record<string, unknown>;
    let proof: { message: string; signature: Hex };
    try {
      payload = checkedPayload(action, request.body?.payload);
      proof = await allowed.desk.auth.verify({ address: allowed.wallet, challengeId, signature, action, payload });
    } catch (error) {
      if (error instanceof SpRequestError || error instanceof AdminRefusedError) return void response.status(error instanceof AdminRefusedError ? 403 : 400).json({ error: error.message });
      return void response.status(503).json({ error: "The approval could not be checked right now. Nothing changed." });
    }
    const target = typeof payload.account === "string" ? payload.account : typeof payload.entryId === "string" ? payload.entryId : typeof payload.key === "string" ? payload.key : undefined;
    let recorded;
    try {
      // The record comes first: a change that cannot be recorded does not run.
      recorded = await allowed.desk.audit.record({ actor: allowed.wallet, action, target, details: { payload, message: proof.message, signature: proof.signature } });
    } catch {
      return void response.status(503).json({ error: "The audit log could not be written, so nothing changed. Try again." });
    }
    try {
      const result = await run(action, payload, allowed.wallet, allowed.sp, allowed.desk);
      response.json({ ok: true, audit: recorded.id, result });
    } catch (error) {
      const message = error instanceof SpRequestError ? error.message : "The change could not be made right now.";
      await allowed.desk.audit.record({ actor: allowed.wallet, action: `${action}.failed`, target, details: { audit: recorded.id, error: message } }).catch(() => undefined);
      response.status(error instanceof SpRequestError ? 400 : 503).json({ error: `${message} The approval is in the audit log as #${recorded.id}.` });
    }
  });

  async function run(action: AdminAction, payload: Record<string, unknown>, actor: Address, sp: NonNullable<RouteContext["sp"]>, desk: AdminDesk) {
    switch (action) {
      case "sp.rules":
        return sp.service.saveRules({ actor, rules: payload.rules, note: String(payload.note ?? "") });
      case "sp.adjust":
        return sp.service.adjust({ actor, account: payload.account as Address, amount: payload.amount as number, reason: String(payload.reason) });
      case "sp.reverse":
        return sp.service.reverse({ actor, entryId: String(payload.entryId), reason: String(payload.reason) });
      case "sp.freeze":
        return sp.service.setFrozen({ actor, account: payload.account as Address, frozen: payload.frozen === true, reason: String(payload.reason) });
      case "sp.sync": {
        if (payload.account) return { synced: 1, ...await sp.activity.syncAccount(payload.account as string, { links: "now" }), next: null };
        const run = await syncEveryone(sp, desk, typeof payload.after === "string" ? payload.after : undefined, SYNC_BUDGET_MS);
        await desk.settings?.set<SpSyncRun>(LAST_SYNC_KEY, { at: new Date().toISOString(), ...run, by: actor }, actor).catch(() => undefined);
        return run;
      }
      case "switches.set":
        return desk.controls.setPause({ feature: payload.key as DeskFeature, paused: payload.paused === true, message: String(payload.message ?? ""), actor });
      case "notice.set":
        return desk.controls.setNotice({ text: String(payload.text ?? ""), tone: payload.tone === "warning" ? "warning" : "info", actor });
    }
  }
}
