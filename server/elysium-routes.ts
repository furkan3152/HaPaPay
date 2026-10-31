import type express from "express";
import type { Address } from "viem";
import { z } from "zod";
import { isElysiumNetworkId, type ElysiumNetworkId } from "../src/domain/elysium.js";
import type { Platform } from "../src/domain/payment-intent.js";
import type { AdminDesk } from "./admin-routes.js";
import { ElysiumRequestError, type ElysiumService } from "./elysium-service.js";

type Middleware = (request: express.Request, response: express.Response, next: express.NextFunction) => void;
type RouteContext = {
  elysium?: ElysiumService;
  admin?: AdminDesk;
  session(request: express.Request): { address: Address } | undefined;
  protectedIngress: Middleware;
  limit(options: { perMinute: number; message: string }): Middleware;
  /** Whether an admin paused Elysium payments from the admin panel. */
  paused?(): Promise<{ message: string } | undefined>;
};

const platformSchema = z.enum(["github", "x", "telegram", "discord", "farcaster"]);
const networkSchema = z.string().refine(isElysiumNetworkId, "Choose Elysium Testnet or Elysium mainnet.").transform((value) => value as ElysiumNetworkId);
const prepareSchema = z.object({
  network: networkSchema,
  platform: platformSchema,
  username: z.string().trim().min(1).max(64).regex(/^@?[A-Za-z0-9_.-]{1,64}$/, "Write the handle, for example @alice."),
  amount: z.string().trim().min(1).max(40),
  note: z.string().max(400).optional(),
});
const batchSchema = z.object({
  network: networkSchema,
  recipients: z.array(z.object({
    platform: platformSchema,
    username: z.string().trim().min(1).max(65).regex(/^@?[A-Za-z0-9_.-]{1,64}$/, "Write each handle, for example @alice."),
    amount: z.string().trim().min(1).max(40),
  })).min(1).max(10),
  note: z.string().max(400).optional(),
});
const confirmBatchSchema = z.object({
  network: networkSchema,
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "That is not a transaction hash."),
  recipients: z.array(z.object({ platform: platformSchema, username: z.string().trim().min(1).max(65) })).min(1).max(10),
});
const confirmSchema = z.object({
  network: networkSchema,
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "That is not a transaction hash."),
  platform: platformSchema,
  username: z.string().trim().min(1).max(65),
});

/**
 * Elysium on ElysaPay. Anyone reads which networks are open, live chain stats and Hyperliquid's markets; a signed-in
 * wallet prepares and confirms HYPE payments to verified handles; an admin inspects contracts before registering
 * them and records the deployments and mints they signed in their own wallet into the audit log.
 */
export function registerElysiumRoutes(app: express.Express, context: RouteContext) {
  const readLimit = context.limit({ perMinute: 120, message: "Too many Elysium requests. Try again in one minute." });
  const writeLimit = context.limit({ perMinute: 20, message: "Too many Elysium payments. Try again in one minute." });
  const unavailable = (response: express.Response) => response.status(503).json({ error: "Elysium is not available on this server right now." });
  const failed = (response: express.Response, error: unknown) => {
    if (error instanceof ElysiumRequestError) return void response.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError) return void response.status(400).json({ error: error.issues[0]?.message ?? "The request is not valid." });
    response.status(503).json({ error: "Elysium could not be read right now. Try again shortly." });
  };
  const network = (request: express.Request) => {
    const value = String(request.params.network ?? "");
    if (!isElysiumNetworkId(value)) throw new ElysiumRequestError("Choose Elysium Testnet or Elysium mainnet.", 404);
    return value;
  };

  app.get("/api/elysium", readLimit, async (_request, response) => {
    if (!context.elysium) return void unavailable(response);
    try {
      const pause = await context.paused?.();
      response.json({ networks: await context.elysium.views(), paused: pause ?? null });
    } catch (error) {
      failed(response, error);
    }
  });

  app.get("/api/elysium/stats/:network", readLimit, async (request, response) => {
    if (!context.elysium) return void unavailable(response);
    try {
      response.json(await context.elysium.stats(network(request)));
    } catch (error) {
      failed(response, error);
    }
  });

  app.get("/api/elysium/blocks/:network", readLimit, async (request, response) => {
    if (!context.elysium) return void unavailable(response);
    try {
      response.json({ blocks: await context.elysium.blocks(network(request)) });
    } catch (error) {
      failed(response, error);
    }
  });

  // A payment's public receipt: anyone with the link sees who paid which handle how much, as the chain already shows.
  app.get("/api/elysium/receipts/:network/:hash", readLimit, async (request, response) => {
    if (!context.elysium) return void unavailable(response);
    try {
      const payments = await context.elysium.receipt(network(request), String(request.params.hash));
      if (!payments.length) return void response.status(404).json({ error: "No ElysaPay payment is recorded for this transaction." });
      response.json({ payments });
    } catch (error) {
      failed(response, error);
    }
  });

  app.post("/api/elysium/payments/prepare-batch", context.protectedIngress, writeLimit, async (request, response) => {
    if (!context.elysium) return void unavailable(response);
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    try {
      const pause = await context.paused?.();
      if (pause) return void response.status(503).json({ error: pause.message });
      const body = batchSchema.parse(request.body ?? {});
      response.json(await context.elysium.prepareBatch({ ...body, recipients: body.recipients.map((entry) => ({ ...entry, platform: entry.platform as Platform })), sender: session.address }));
    } catch (error) {
      failed(response, error);
    }
  });

  app.post("/api/elysium/payments/confirm-batch", context.protectedIngress, writeLimit, async (request, response) => {
    if (!context.elysium) return void unavailable(response);
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    try {
      const body = confirmBatchSchema.parse(request.body ?? {});
      response.json(await context.elysium.confirmBatch({ ...body, recipients: body.recipients.map((entry) => ({ ...entry, platform: entry.platform as Platform })), sender: session.address }));
    } catch (error) {
      failed(response, error);
    }
  });

  app.get("/api/elysium/markets", readLimit, async (_request, response) => {
    if (!context.elysium) return void unavailable(response);
    try {
      response.json({ source: "Hyperliquid", markets: await context.elysium.markets() });
    } catch (error) {
      failed(response, error);
    }
  });

  app.post("/api/elysium/payments/prepare", context.protectedIngress, writeLimit, async (request, response) => {
    if (!context.elysium) return void unavailable(response);
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    try {
      const pause = await context.paused?.();
      if (pause) return void response.status(503).json({ error: pause.message });
      const body = prepareSchema.parse(request.body ?? {});
      response.json(await context.elysium.preparePayment({ ...body, platform: body.platform as Platform, sender: session.address }));
    } catch (error) {
      failed(response, error);
    }
  });

  app.post("/api/elysium/payments/confirm", context.protectedIngress, writeLimit, async (request, response) => {
    if (!context.elysium) return void unavailable(response);
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    try {
      const body = confirmSchema.parse(request.body ?? {});
      response.json(await context.elysium.confirmPayment({ ...body, platform: body.platform as Platform, sender: session.address }));
    } catch (error) {
      failed(response, error);
    }
  });

  app.get("/api/elysium/payments", context.protectedIngress, readLimit, async (request, response) => {
    if (!context.elysium) return void unavailable(response);
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    try {
      response.json({ payments: await context.elysium.history(session.address) });
    } catch (error) {
      failed(response, error);
    }
  });

  // ---- Admin ----

  const admin = (request: express.Request, response: express.Response) => {
    const session = context.session(request);
    if (!context.admin?.auth.configured) return void response.status(503).json({ error: "No admin wallet is set on this server (ADMIN_WALLET_ADDRESSES)." });
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!context.admin.auth.isAdmin(session.address)) return void response.status(403).json({ error: "This wallet is not an admin of ElysaPay." });
    if (!context.elysium) return void unavailable(response);
    return { wallet: session.address, desk: context.admin, elysium: context.elysium };
  };

  app.get("/api/admin/elysium", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    try {
      const [networks, payments] = await Promise.all([allowed.elysium.views(), allowed.elysium.history(undefined, 200)]);
      const totals = Object.fromEntries(networks.map((view) => {
        const rows = payments.filter((payment) => payment.network === view.id);
        const sum = (field: "amount" | "fee") => rows.reduce((total, row) => total + Number(row[field]), 0);
        return [view.id, { payments: rows.length, volume: sum("amount"), fees: sum("fee"), payers: new Set(rows.map((row) => row.payer)).size }];
      }));
      response.json({ networks, payments: payments.slice(0, 50), totals });
    } catch (error) {
      failed(response, error);
    }
  });

  /** Reads a contract before it is registered, so the admin sees what the signed change would register. */
  app.post("/api/admin/elysium/inspect", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    try {
      const body = z.object({ network: networkSchema, kind: z.enum(["router", "token", "pass"]), address: z.string().trim() }).parse(request.body ?? {});
      response.json(await allowed.elysium.inspectContract(body.network, body.kind, body.address, (address) => allowed.desk.auth.isAdmin(address)));
    } catch (error) {
      failed(response, error);
    }
  });

  /**
   * A deployment, mint or contract setting the admin signed in their own wallet, written to the audit log once its
   * receipt shows this admin sent it. The chain transaction is the signature; nothing is sent from the server.
   */
  app.post("/api/admin/elysium/record", context.protectedIngress, readLimit, async (request, response) => {
    const allowed = admin(request, response);
    if (!allowed) return;
    try {
      const body = z.object({ network: networkSchema, hash: z.string(), label: z.string().trim().min(1).max(200) }).parse(request.body ?? {});
      const read = await allowed.elysium.readAdminTransaction(body.network, body.hash, allowed.wallet);
      if (read.status === "pending") return void response.json(read);
      const recorded = await allowed.desk.audit.record({ actor: allowed.wallet, action: "elysium.tx", target: read.contractAddress ?? read.to ?? undefined, details: { network: body.network, label: body.label, ...read } });
      response.json({ ...read, audit: recorded.id });
    } catch (error) {
      failed(response, error);
    }
  });
}
