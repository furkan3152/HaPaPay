import type express from "express";
import type { Address } from "viem";
import { z } from "zod";
import { REFERRAL_PAYOUT_MINIMUM_UNITS } from "../src/domain/referrals.js";
import type { SpActivity } from "./sp-activity.js";
import { SpRequestError, type SpService } from "./sp-service.js";

/** SP on this server: the ledger and its rules, and what finds activity to award. */
export type SpDesk = { service: SpService; activity: Pick<SpActivity, "syncAccount" | "reportClaim" | "joinWithCode"> };

type Middleware = (request: express.Request, response: express.Response, next: express.NextFunction) => void;
type RouteContext = {
  sp?: SpDesk;
  session(request: express.Request): { address: Address } | undefined;
  protectedIngress: Middleware;
  limit(options: { perMinute: number; message: string }): Middleware;
  /** The account's Solana address, where invite rewards are paid. */
  solanaAddress?(wallet: Address): Promise<string | undefined>;
};

const claimReportSchema = z.object({
  network: z.enum(["solana", "arc", "robinhood"]),
  paymentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** The claim transaction on Arc or Robinhood Chain, whose receipt names the claimer. */
  transaction: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});

const HISTORY_PAGE = 20;

/**
 * SP, HaPaPay's points. The rules are public; an account reads its own balance and
 * history, and reading them first awards anything it did that has not earned yet, so the balance is never behind.
 */
export function registerSpRoutes(app: express.Express, context: RouteContext) {
  const readLimit = context.limit({ perMinute: 60, message: "Too many SP requests. Try again in one minute." });
  const claimLimit = context.limit({ perMinute: 20, message: "Too many claim reports. Try again in one minute." });
  const joinLimit = context.limit({ perMinute: 10, message: "Too many invite codes. Try again in one minute." });
  const unavailable = (response: express.Response) => response.status(503).json({ error: "SP is not available on this server right now." });

  app.get("/api/sp/rules", async (_request, response) => {
    if (!context.sp) return void unavailable(response);
    try {
      const { version, rules, createdAt } = await context.sp.service.rules();
      response.json({ version, rules, since: createdAt });
    } catch {
      response.status(503).json({ error: "The SP rules could not be read right now. Try again shortly." });
    }
  });

  app.get("/api/sp", context.protectedIngress, readLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!context.sp) return void unavailable(response);
    let sync: { awarded: number; pending: number; failed?: boolean } = { awarded: 0, pending: 0 };
    try {
      sync = await context.sp.activity.syncAccount(session.address);
    } catch {
      // Nothing is lost: what did not earn now earns at the next read. The balance below is the ledger's.
      sync = { awarded: 0, pending: 0, failed: true };
    }
    try {
      const [summary, history] = await Promise.all([
        context.sp.service.summary(session.address),
        context.sp.service.history(session.address, HISTORY_PAGE),
      ]);
      response.json({ ...summary, awarded: sync.awarded, pending: sync.pending, synced: !sync.failed, entries: history.entries, next: history.next });
    } catch {
      response.status(503).json({ error: "Your SP could not be read right now. Try again shortly." });
    }
  });

  app.get("/api/sp/history", context.protectedIngress, readLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!context.sp) return void unavailable(response);
    const before = typeof request.query.before === "string" && request.query.before.length <= 80 ? request.query.before : undefined;
    try {
      response.json(await context.sp.service.history(session.address, HISTORY_PAGE, before));
    } catch {
      response.status(503).json({ error: "Your SP history could not be read right now. Try again shortly." });
    }
  });

  // Invites: the account's code and link, who joined with it, and what they earned it.
  app.get("/api/sp/referral", context.protectedIngress, readLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!context.sp?.service.referrals) return void response.status(503).json({ error: "Invites are not available on this server right now." });
    try {
      const [summary, rules, solanaAddress] = await Promise.all([
        context.sp.service.referralSummary(session.address),
        context.sp.service.rules(),
        context.solanaAddress?.(session.address).catch(() => undefined),
      ]);
      response.json({ ...summary, solanaAddress: solanaAddress ?? null, minimumPayout: REFERRAL_PAYOUT_MINIMUM_UNITS.toString(), rules: rules.rules.referral });
    } catch {
      response.status(503).json({ error: "Your invites could not be read right now. Try again shortly." });
    }
  });

  // The desk sends the code of the link it was opened with, once the wallet is verified; the server decides.
  app.post("/api/sp/referral", context.protectedIngress, joinLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!context.sp?.service.referrals) return void response.status(503).json({ error: "Invites are not available on this server right now." });
    const parsed = z.object({ code: z.string().max(32) }).safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Send the invite code." });
    try {
      response.json({ status: await context.sp.activity.joinWithCode(session.address, parsed.data.code) });
    } catch (error) {
      if (error instanceof SpRequestError) return void response.status(400).json({ error: error.message });
      response.status(503).json({ error: "The invite could not be checked right now. The desk tries again the next time you open it." });
    }
  });

  // The desk reports a vault link it just claimed; the chain decides who claimed it, so a report can only help.
  app.post("/api/sp/claims", context.protectedIngress, claimLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!context.sp) return void unavailable(response);
    const parsed = claimReportSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Send the network and the vault link's payment ID." });
    try {
      const report = await context.sp.activity.reportClaim(session.address, parsed.data);
      const summary = await context.sp.service.summary(session.address);
      response.json({ ...report, balance: summary.balance });
    } catch (error) {
      if (error instanceof SpRequestError) return void response.status(400).json({ error: error.message });
      response.status(503).json({ error: "The claim could not be checked right now. It is checked again the next time your SP is read." });
    }
  });
}
