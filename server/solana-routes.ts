import type express from "express";
import { isAddress } from "@solana/kit";
import { z } from "zod";
import type { Address } from "viem";
import { checkPaymentNote } from "../src/domain/payment-note.js";
import { platformName, type Platform } from "../src/domain/payment-intent.js";
import { isSolanaStock, NO_SOL_SENDING, SOLANA_SOL } from "../src/domain/solana-assets.js";
import { SOLANA_MAINNET } from "../src/domain/solana-chains.js";
import { allowlistedSolanaAsset, SOLANA_ASSETS, SOLANA_XSTOCKS_VERIFIED_ON } from "../src/domain/solana-stocks.js";
import { SOLANA_FEE_BPS } from "../src/domain/solana-amounts.js";
import { PAYMENT_BATCH_MAX_RECIPIENTS } from "../src/domain/routed-payments.js";
import { AddressTakenError, WalletConsentError, type AccountAddressService } from "./account-address-service.js";
import type { IdentityStore } from "./identity-store.js";
import type { SolanaConfig } from "./solana-network.js";
import type { SolanaMarketData } from "./solana-market.js";
import { DuplicateSolanaTransferError, SolanaTransactionExpiredError, SolanaTransferError, SolanaUnavailableError, type SolanaTransferService } from "./solana-transfer-service.js";
import { DuplicateSolanaClaimError, SolanaClaimNotFoundError, SolanaVaultOperatorError, type SolanaVaultService } from "./solana-vault-service.js";
import type { VerifiedSocialAccount } from "./verified-identity-service.js";
import { VaultNameLockOffer } from "./vault-recipient.js";
import { isStockClaimPlatform, STOCK_CLAIM_WINDOW_HOURS, type StockClaimPlatform } from "../src/domain/stock-claims.js";
import type { DeskFeature } from "../src/domain/desk-controls.js";

export type SolanaDesk = {
  config: SolanaConfig;
  transfers: Pick<SolanaTransferService, "availability" | "prepare" | "confirm" | "list" | "status" | "treasury"> & Partial<Pick<SolanaTransferService, "holding" | "holdings" | "expired">>;
  addresses: AccountAddressService;
  market?: Pick<SolanaMarketData, "snapshot">;
  vault?: Pick<SolanaVaultService, "status" | "availability" | "register" | "retire" | "prepare" | "confirmFunding" | "details" | "prepareClaim" | "prepareRefund" | "pending">;
};

type Middleware = (request: express.Request, response: express.Response, next: express.NextFunction) => void;
type RouteContext = {
  solana?: SolanaDesk;
  identities: IdentityStore;
  session(request: express.Request): { address: Address; issuedAt?: number } | undefined;
  /** Whether the session's wallet signature is recent enough to stand for its consent (`FRESH_SESSION_MS`). */
  freshSession?(session: { address: Address; issuedAt?: number }): boolean;
  protectedIngress: Middleware;
  limit(options: { perMinute: number; message: string }): Middleware;
  /** The session wallet's verified social accounts, read from the identity store. */
  verifiedAccounts(wallet: Address): Promise<VerifiedSocialAccount[]>;
  /** The admin's message while a feature is paused. Only new payments and new links are paused. */
  paused?(feature: DeskFeature): Promise<string | undefined>;
};

const platformSchema = z.enum(["github", "telegram", "x", "discord", "farcaster"]);
const solanaAddressSchema = z.string().refine((value) => isAddress(value), "Not a Solana address.");
const assetSchema = z.object({ symbol: z.string().min(1).max(16), mint: z.string().min(32).max(44).optional() });
const recipientSchema = z.object({
  platform: platformSchema,
  username: z.string().min(1).max(64).transform((value) => value.replace(/^@/, "").toLowerCase()),
  amount: z.string().regex(/^\d+(?:\.\d{1,9})?$/),
});
const prepareSchema = z.object({
  asset: assetSchema,
  recipients: z.array(recipientSchema.extend({ expectedRecipientAddress: solanaAddressSchema })).min(1).max(PAYMENT_BATCH_MAX_RECIPIENTS),
  sourcePlatform: platformSchema.optional(),
  note: z.string().max(1_000).optional(),
  /** xStocks only: the sender confirms they may hold and transfer them where they live, as for Stock Tokens. */
  eligibilityConfirmed: z.boolean().optional(),
});
/** The prepared transaction's last valid block height, so a confirm can tell a dropped transaction apart. */
const lastValidBlockHeightSchema = z.string().regex(/^\d{1,20}$/).optional();
const confirmSchema = z.object({
  signature: z.string().min(64).max(88),
  asset: assetSchema,
  recipients: z.array(recipientSchema.extend({ units: z.string().regex(/^\d{1,30}$/) })).min(1).max(PAYMENT_BATCH_MAX_RECIPIENTS),
  sourcePlatform: platformSchema.optional(),
  note: z.string().max(1_000).optional(),
  lastValidBlockHeight: lastValidBlockHeightSchema,
});

/** The asset a request names, only if it is on the bundled Solana list with the same symbol and mint. */
function listedAsset(input: z.infer<typeof assetSchema>) {
  return allowlistedSolanaAsset({ symbol: input.symbol, mint: input.mint });
}

/**
 * The asset a confirmation records: a listed one, or SOL, which is no longer prepared but
 * whose transfers prepared before then are still recorded, because what already moved is never refused a record.
 */
function recordedAsset(input: z.infer<typeof assetSchema>) {
  return listedAsset(input) ?? (input.symbol === "SOL" && !input.mint ? SOLANA_SOL : undefined);
}

/** Why a prepared Solana transaction cannot carry this asset: SOL is not sent, anything else is not on the list. */
function unlistedAsset(input: z.infer<typeof assetSchema>) {
  return input.symbol.toUpperCase() === "SOL" ? NO_SOL_SENDING : "This asset is not on HaPaPay's Solana list.";
}

const vaultRecipientSchema = z.object({
  platform: z.string().refine(isStockClaimPlatform, "Vault links go to GitHub, X, Farcaster, Discord or Telegram accounts."),
  username: z.string().min(1).max(64).transform((value) => value.replace(/^@/, "").toLowerCase()),
});
/** Whether the reviewed link waits for the recipient's account or for their name (`vault-lock.ts`). */
const vaultLockSchema = z.enum(["account", "name"]).optional();
const vaultPrepareSchema = z.object({
  asset: assetSchema,
  amount: z.string().regex(/^\d+(?:\.\d{1,9})?$/),
  recipient: vaultRecipientSchema,
  lock: vaultLockSchema,
  expiryHours: z.number().int().min(STOCK_CLAIM_WINDOW_HOURS.min).max(STOCK_CLAIM_WINDOW_HOURS.max),
  sourcePlatform: platformSchema.optional(),
  eligibilityConfirmed: z.boolean().optional(),
});
const vaultConfirmSchema = z.object({
  signature: z.string().min(64).max(88),
  paymentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  programId: solanaAddressSchema,
  asset: assetSchema,
  amount: z.string().regex(/^\d+(?:\.\d{1,9})?$/),
  units: z.string().regex(/^\d{1,30}$/),
  recipient: vaultRecipientSchema,
  lock: vaultLockSchema,
  sourcePlatform: platformSchema.optional(),
  lastValidBlockHeight: lastValidBlockHeightSchema,
});

function failure(response: express.Response, error: unknown, fallback: string) {
  if (error instanceof SolanaTransactionExpiredError) return void response.status(410).json({ error: error.message, expired: true });
  if (error instanceof SolanaTransferError || error instanceof AddressTakenError) return void response.status(400).json({ error: error.message });
  if (error instanceof SolanaVaultOperatorError) return void response.status(403).json({ error: error.message });
  if (error instanceof SolanaClaimNotFoundError) return void response.status(404).json({ error: error.message });
  // X did not answer the lookup for an account lock: the slip offers the sender the name lock instead.
  if (error instanceof VaultNameLockOffer) return void response.status(409).json({ error: error.message, lock: error.lock });
  if (error instanceof DuplicateSolanaTransferError || error instanceof DuplicateSolanaClaimError) return void response.status(409).json({ error: error.message });
  if (error instanceof SolanaUnavailableError) return void response.status(503).json({ error: error.message });
  // The amount checks shared with the browser throw plain errors written for the person. Anything else is a database's
  // or a library's text, which can name hosts or endpoints, so it is never shown (audit, 2026-10-06).
  if (error instanceof Error && /^This (?:token's balance multiplier cannot be read|amount is too large for a scaled token)\.$/.test(error.message)) {
    return void response.status(400).json({ error: error.message });
  }
  response.status(503).json({ error: `${fallback} Try again in a moment.` });
}

/**
 * Solana's routes. Linking a
 * Solana address to the session's account, preparing unsigned transfers from a review, recording them from the chain,
 * and the board. Everything that moves value needs the wallet session; the server never signs or sends a transaction.
 */
export function registerSolanaRoutes(app: express.Express, context: RouteContext) {
  const { identities } = context;
  const solana = context.solana;
  const addressLimit = context.limit({ perMinute: 10, message: "Too many Solana address requests. Try again in one minute." });
  const transferLimit = context.limit({ perMinute: 30, message: "Too many Solana transfer requests. Try again in one minute." });
  const unavailable = (response: express.Response) => response.status(503).json({ error: "Solana is not available on this server right now." });

  app.get("/api/solana", (_request, response) => {
    if (!solana) return void response.json({ network: SOLANA_MAINNET.id, name: SOLANA_MAINNET.name, ready: false, reason: "Solana is not configured on this server." });
    const { config } = solana;
    response.json({
      network: SOLANA_MAINNET.id,
      name: SOLANA_MAINNET.name,
      ready: config.transfers.enabled || config.stocks.enabled,
      explorerUrl: SOLANA_MAINNET.explorerUrl,
      rpcUrl: SOLANA_MAINNET.rpcUrl,
      treasury: config.treasury ?? null,
      feeBps: Number(SOLANA_FEE_BPS),
      transfers: config.transfers,
      stocks: config.stocks,
    });
  });

  app.get("/api/solana/assets", async (_request, response) => {
    const snapshot = solana?.market ? await solana.market.snapshot() : { status: "unavailable" as const, source: "Jupiter", quotes: {} as Record<string, number> };
    response.json({
      network: SOLANA_MAINNET.id,
      verifiedOn: SOLANA_XSTOCKS_VERIFIED_ON,
      prices: { status: snapshot.status, asOf: "asOf" in snapshot ? snapshot.asOf : undefined, source: snapshot.source },
      quotes: snapshot.quotes,
      transfers: solana?.config.transfers ?? { enabled: false, reason: "Solana is not configured on this server." },
      stocks: solana?.config.stocks ?? { enabled: false, reason: "Solana is not configured on this server." },
      count: SOLANA_ASSETS.length,
    });
  });

  app.post("/api/auth/solana/challenge", context.protectedIngress, addressLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana) return void unavailable(response);
    const parsed = z.object({ address: solanaAddressSchema }).safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Enter a Solana address." });
    try {
      const owner = await solana.addresses.walletForSolana(parsed.data.address);
      if (owner && owner !== session.address) return void response.status(409).json({ error: "This Solana address is already added to another HaPaPay wallet." });
      const challenge = await solana.addresses.createSolanaChallenge(session.address, parsed.data.address);
      // A sign-in older than ten minutes also signs this message with the account's wallet.
      response.json({ ...challenge, walletSignature: !context.freshSession?.(session) });
    } catch (error) {
      failure(response, error, "The Solana address could not be checked.");
    }
  });

  app.post("/api/auth/solana/verify", context.protectedIngress, addressLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana) return void unavailable(response);
    const parsed = z.object({
      challengeId: z.string().min(1).max(64),
      signature: z.string().min(64).max(128),
      walletSignature: z.string().max(200).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Sign the Solana message first." });
    try {
      response.json(await solana.addresses.verifySolana(session.address, { ...parsed.data, freshSession: Boolean(context.freshSession?.(session)) }));
    } catch (error) {
      if (error instanceof AddressTakenError) return void response.status(409).json({ error: error.message });
      if (error instanceof WalletConsentError) return void response.status(403).json({ error: error.message, walletSignature: true });
      // The challenge's own refusals are written for the person; a store or library failure is not shown.
      const known = error instanceof Error && /^(?:Challenge (?:was not found|expired|belongs)|The Solana signature does not match)/.test(error.message);
      response.status(known ? 400 : 503).json({ error: known ? (error as Error).message : "The Solana signature could not be checked right now. Try again in a moment." });
    }
  });

  app.delete("/api/auth/solana", async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana) return void unavailable(response);
    await solana.addresses.removeSolana(session.address);
    response.status(204).end();
  });

  /** A recipient's account and its Solana address, read again from the database for every preparation and record. */
  async function recipientOnSolana(platform: Platform, username: string): Promise<{ ok: false; error: string } | { ok: true; wallet: Address; address: string }> {
    const wallet = await identities.resolve(platform, username);
    if (!wallet) return { ok: false, error: `@${username} on ${platformName(platform)} does not have a verified social identity.` };
    const address = await solana!.addresses.solana(wallet);
    if (!address) return { ok: false, error: `@${username} on ${platformName(platform)} has not added a Solana address to HaPaPay yet.` };
    return { ok: true, wallet, address };
  }

  async function sourceAccount(wallet: Address, platform: Platform | undefined) {
    if (!platform) return undefined;
    const account = await identities.account(wallet, platform);
    if (!account) throw new SolanaTransferError(`Link and verify your ${platformName(platform)} account before sending from it.`);
    return { platform: account.platform, username: account.username };
  }

  /** For a record of what already moved: a source account unlinked since then only drops its label, never the record. */
  async function recordedSource(wallet: Address, platform: Platform | undefined) {
    if (!platform) return undefined;
    const account = await identities.account(wallet, platform);
    return account ? { platform: account.platform, username: account.username } : undefined;
  }

  app.post("/api/solana/transfers/prepare", context.protectedIngress, transferLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana) return void unavailable(response);
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid Solana payment." });
    const input = parsed.data;
    const asset = listedAsset(input.asset);
    if (!asset) return void response.status(400).json({ error: unlistedAsset(input.asset) });
    const feature = isSolanaStock(asset) ? "solana.stocks" : "solana.transfers";
    const pause = await context.paused?.(feature);
    if (pause) return void response.status(503).json({ error: pause, paused: feature });
    if (isSolanaStock(asset) && input.eligibilityConfirmed !== true) {
      return void response.status(400).json({ error: "Confirm the xStocks eligibility statement before signing." });
    }
    const note = checkPaymentNote(input.note);
    if (!note.ok) return void response.status(400).json({ error: note.error });
    try {
      const sender = await solana.addresses.solana(session.address);
      if (!sender) return void response.status(400).json({ error: "Add a Solana address to your wallet before sending on Solana." });
      await sourceAccount(session.address, input.sourcePlatform);
      const seen = new Set<string>();
      const payments = [];
      for (const recipient of input.recipients) {
        const key = `${recipient.platform}:${recipient.username}`;
        if (seen.has(key)) return void response.status(400).json({ error: `@${recipient.username} on ${platformName(recipient.platform)} is in this request twice. Review it again.` });
        seen.add(key);
        const resolved = await recipientOnSolana(recipient.platform, recipient.username);
        if (!resolved.ok) return void response.status(404).json({ error: resolved.error });
        if (resolved.wallet === session.address) return void response.status(400).json({ error: `@${recipient.username} on ${platformName(recipient.platform)} is your own wallet. Remove it and review again.` });
        if (resolved.address !== recipient.expectedRecipientAddress) {
          return void response.status(409).json({ error: `@${recipient.username} on ${platformName(recipient.platform)} changed their Solana address after review. Review the payment again.` });
        }
        payments.push({ recipient: resolved.address, amount: recipient.amount, label: `@${recipient.username}` });
      }
      response.json(await solana.transfers.prepare({ sender, asset, payments, note: note.note }));
    } catch (error) {
      failure(response, error, "The Solana payment could not be prepared.");
    }
  });

  app.post("/api/solana/transfers/confirm", context.protectedIngress, transferLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana) return void unavailable(response);
    const parsed = confirmSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid Solana receipt." });
    const input = parsed.data;
    const asset = recordedAsset(input.asset);
    if (!asset) return void response.status(400).json({ error: "This asset is not on HaPaPay's Solana list." });
    const note = checkPaymentNote(input.note);
    if (!note.ok) return void response.status(400).json({ error: note.error });
    try {
      const senderAddress = await solana.addresses.solana(session.address);
      if (!senderAddress) return void response.status(400).json({ error: "Add a Solana address to your wallet before sending on Solana." });
      const source = await recordedSource(session.address, input.sourcePlatform);
      const payments = [];
      for (const recipient of input.recipients) {
        const resolved = await recipientOnSolana(recipient.platform, recipient.username);
        if (!resolved.ok) return void response.status(404).json({ error: resolved.error });
        payments.push({ recipientWallet: resolved.wallet, recipientAddress: resolved.address, platform: recipient.platform, username: recipient.username, amount: recipient.amount, units: recipient.units });
      }
      const records = await solana.transfers.confirm({
        signature: input.signature, asset, sender: { wallet: session.address, address: senderAddress }, payments, note: note.note, source,
        lastValidBlockHeight: input.lastValidBlockHeight ? BigInt(input.lastValidBlockHeight) : undefined,
      });
      response.status(201).json({ recorded: records.length, signature: input.signature });
    } catch (error) {
      failure(response, error, "The Solana transaction could not be verified.");
    }
  });

  app.get("/api/solana/transfers", async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana) return void response.json({ transfers: [] });
    try {
      response.json({ transfers: await solana.transfers.list(session.address) });
    } catch {
      response.status(503).json({ error: "Solana activity could not be read right now." });
    }
  });

  // What the session account's own Solana address holds, as a wallet shows it. Only the account's own address is read; nobody else's balance.
  const holdingsLimit = context.limit({ perMinute: 20, message: "Too many Solana balance reads. Try again in one minute." });
  app.get("/api/solana/holdings", holdingsLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana?.transfers.holdings) return void unavailable(response);
    try {
      const owner = await solana.addresses.solana(session.address);
      if (!owner) return void response.json({ address: null, sol: "0", tokens: [] });
      const holdings = await solana.transfers.holdings(owner);
      if (!holdings) return void response.status(503).json({ error: "Solana could not be read just now. Try again in a moment.", address: owner });
      response.json({ address: owner, ...holdings });
    } catch {
      response.status(503).json({ error: "Your Solana address could not be read just now. Try again in a moment." });
    }
  });

  const vaultLimit = context.limit({ perMinute: 30, message: "Too many Solana vault requests. Try again in one minute." });
  const vaultUnavailable = (response: express.Response) => response.status(503).json({ error: "Vault links are not available on Solana on this server." });

  // The operator page's view of the Solana vault: the pinned build, the settings it must carry, and its state.
  app.get("/api/solana/vault", async (_request, response) => {
    if (!solana?.vault) return void vaultUnavailable(response);
    try {
      response.json(await solana.vault.status());
    } catch (error) {
      failure(response, error, "The Solana vault status could not be loaded.");
    }
  });

  app.post("/api/solana/vault/register", context.protectedIngress, vaultLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana?.vault) return void vaultUnavailable(response);
    const parsed = z.object({ programId: solanaAddressSchema }).safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Enter the vault program's address." });
    try {
      const operatorAddress = await solana.addresses.solana(session.address);
      response.status(201).json(await solana.vault.register({ programId: parsed.data.programId, operatorAddress }));
    } catch (error) {
      failure(response, error, "The Solana vault program could not be registered.");
    }
  });

  // The first step before the operator closes the program: no new links; links already sent stay claimable.
  app.post("/api/solana/vault/retire", context.protectedIngress, vaultLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana?.vault) return void vaultUnavailable(response);
    try {
      response.json(await solana.vault.retire({ operatorAddress: await solana.addresses.solana(session.address) }));
    } catch (error) {
      failure(response, error, "New vault links could not be stopped.");
    }
  });

  app.post("/api/solana/claims/prepare", context.protectedIngress, vaultLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana?.vault) return void vaultUnavailable(response);
    const pause = await context.paused?.("solana.vault");
    if (pause) return void response.status(503).json({ error: pause, paused: "solana.vault" });
    const parsed = vaultPrepareSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid Solana vault link request." });
    const input = parsed.data;
    const asset = listedAsset(input.asset);
    if (!asset) return void response.status(400).json({ error: unlistedAsset(input.asset) });
    if (isSolanaStock(asset) && input.eligibilityConfirmed !== true) {
      return void response.status(400).json({ error: "Confirm the xStocks eligibility statement before signing." });
    }
    try {
      const payer = await solana.addresses.solana(session.address);
      if (!payer) return void response.status(400).json({ error: "Add a Solana address to your wallet before sending on Solana." });
      const sender = await sourceAccount(session.address, input.sourcePlatform);
      const prepared = await solana.vault.prepare({ payer, asset, amount: input.amount, platform: input.recipient.platform as StockClaimPlatform, username: input.recipient.username, expiryHours: input.expiryHours, lock: input.lock });
      response.json({ ...prepared, ...(sender ? { senderIdentity: sender } : {}) });
    } catch (error) {
      failure(response, error, "The Solana vault link could not be prepared.");
    }
  });

  app.post("/api/solana/claims/confirm", context.protectedIngress, vaultLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana?.vault) return void vaultUnavailable(response);
    const parsed = vaultConfirmSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid Solana vault link confirmation." });
    const input = parsed.data;
    const asset = recordedAsset(input.asset);
    if (!asset) return void response.status(400).json({ error: "This asset is not on HaPaPay's Solana list." });
    try {
      const payerAddress = await solana.addresses.solana(session.address);
      if (!payerAddress) return void response.status(400).json({ error: "Add a Solana address to your wallet before sending on Solana." });
      const source = await recordedSource(session.address, input.sourcePlatform);
      response.status(201).json(await solana.vault.confirmFunding({
        signature: input.signature,
        paymentId: input.paymentId,
        programId: input.programId,
        payerWallet: session.address,
        payerAddress,
        asset,
        amount: input.amount,
        units: input.units,
        platform: input.recipient.platform as StockClaimPlatform,
        username: input.recipient.username,
        lock: input.lock,
        source,
        lastValidBlockHeight: input.lastValidBlockHeight ? BigInt(input.lastValidBlockHeight) : undefined,
      }));
    } catch (error) {
      failure(response, error, "The Solana vault link could not be verified.");
    }
  });

  app.get("/api/solana/claims/:paymentId", context.protectedIngress, vaultLimit, async (request, response) => {
    if (!solana?.vault) return void vaultUnavailable(response);
    try {
      response.json(await solana.vault.details(String(request.params.paymentId)));
    } catch (error) {
      failure(response, error, "The Solana claim link could not be loaded.");
    }
  });

  app.post("/api/solana/claims/:paymentId/prepare-claim", context.protectedIngress, vaultLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana?.vault) return void vaultUnavailable(response);
    const body = z.object({ eligibilityConfirmed: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!body.success) return void response.status(400).json({ error: "Invalid claim request." });
    try {
      response.json(await solana.vault.prepareClaim({
        paymentId: String(request.params.paymentId),
        wallet: await solana.addresses.solana(session.address),
        accounts: await context.verifiedAccounts(session.address),
        eligibilityConfirmed: body.data.eligibilityConfirmed,
      }));
    } catch (error) {
      failure(response, error, "The claim could not be prepared.");
    }
  });

  app.post("/api/solana/claims/:paymentId/prepare-refund", context.protectedIngress, vaultLimit, async (request, response) => {
    const session = context.session(request);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!solana?.vault) return void vaultUnavailable(response);
    try {
      response.json(await solana.vault.prepareRefund({ paymentId: String(request.params.paymentId), wallet: await solana.addresses.solana(session.address) }));
    } catch (error) {
      failure(response, error, "The refund could not be prepared.");
    }
  });
}
