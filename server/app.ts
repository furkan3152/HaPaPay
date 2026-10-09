import express, { type Request } from "express";
import { isIP } from "node:net";
import { createChatDraft, paymentBatchSchema, paymentIntentSchema, type SenderHoldings, type SolanaChatDesk, type UsdcClaimAvailability } from "./chat-service.js";
import { parseWithOpenRouter } from "./openrouter.js";
import { InvalidWalletError, SignInRejectedError, WALLET_SESSION_SECONDS, WalletAuthService } from "./wallet-auth.js";
import { InvalidOAuthReturnPathError, OAuthFlowStore } from "./oauth-flow-store.js";
import { DiscordOAuthProvider, GitHubOAuthProvider, ProviderAccessError, ProviderSetupError, TelegramLoginError, TelegramSignatureError, XOAuthProvider, verifyTelegramLogin } from "./social-providers.js";
import { IdentityConflictError, VerifiedIdentityService, type VerifiedSocialAccount } from "./verified-identity-service.js";
import { ARC_CONTRACT_VARIABLES, ARC_MAINNET, ARC_TESTNET, type ArcContractConfig, type ArcNetworkConfig } from "./arc-network.js";
import { paymentNetworkCatalog, resolvePaymentNetwork, PaymentNetworkSelectionError } from "../src/domain/payment-network.js";
import { buildArcUsdcTransfer } from "../src/domain/arc-transaction.js";
import { checkPaymentNote } from "../src/domain/payment-note.js";
import { routedApproveCall, routedPayCall } from "../src/domain/routed-payments.js";
import { verifyClaimEscrowContract, verifyIdentityRegistryContract } from "./readiness.js";
import { findArcMainnetDeployment, type ArcMainnetReader } from "./arc-mainnet-deployment.js";
import { receiptView, TRANSACTION_HASH, type ChainReceipt } from "./receipts.js";
import { ARC_IDENTITY_REGISTRY_ARTIFACT } from "../src/domain/arc-identity-registry-artifact.js";
import { ARC_IDENTITY_REGISTRY_REVISION } from "../src/domain/arc-identity-registry.js";
import type { IdentityStore } from "./identity-store";
import { platformName, type Platform } from "../src/domain/payment-intent.js";
import type { OfficialRecipientDirectory } from "./recipient-discovery.js";
import { VaultNameLockOffer } from "./vault-recipient.js";
import { FarcasterSignInError, type FarcasterAuthService } from "./farcaster-auth-service.js";
import { formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import helmet from "helmet";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { DuplicatePaymentError, type PaymentHistoryService } from "./payment-history-service.js";
import type { ClaimablePaymentService } from "./claimable-payment-service";
import type { ClaimRedemptionService } from "./claim-redemption-service";
import type { ClaimFundingService } from "./claim-funding-service";
import { stockTokenCatalog, type StockTokenMarketData } from "./stock-token-market.js";
import {
  isStockToken,
  normalizeStockAmount,
  STOCK_CHAINS,
  stockNetworkFor,
  tokenDecimals,
  transferAvailabilityFor,
  type StockNetworkId,
  type StockTransferAvailability,
} from "../src/domain/stock-tokens.js";
import { allowlistedRobinhoodAsset, ROBINHOOD_ASSET_ALLOWLISTS } from "../src/domain/robinhood-assets.js";
import {
  DuplicateStockTransferError,
  StockReceiptPendingError,
  StockTransferRejectedError,
  StockTransferUnavailableError,
  type StockTransferService,
} from "./stock-transfer-service.js";
import { DuplicateStockClaimError, StockClaimNotFoundError, StockEscrowOperatorError, type StockClaimService } from "./stock-claim-service.js";
import { STOCK_CLAIM_ESCROW_REVISION, type StockClaimAvailability } from "../src/domain/stock-claims.js";
import { sortPendingVaultLinks, type PendingVaultLinks } from "../src/domain/pending-claims.js";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact.js";
import { BURN_VAULT_ARTIFACT, FEE_FORWARDER_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../src/domain/fee-artifacts.js";
import {
  PLATFORM_FEE_BURN_SHARE_BPS,
  BURN_VAULT_REVISION,
  PLATFORM_FEE_BPS,
  FEE_FORWARDER_REVISION,
  PAY_ROUTER_REVISION,
  platformFee,
  platformFeePercent,
  type FeeSchedule,
} from "../src/domain/fees.js";
import { preparedFee } from "./stock-transfer-service.js";
import { registerSolanaRoutes, type SolanaDesk } from "./solana-routes.js";
import { registerSpRoutes, type SpDesk } from "./sp-routes.js";
import { registerAdminRoutes, type AdminDesk } from "./admin-routes.js";
import type { DeskFeature } from "../src/domain/desk-controls.js";
import { SOLANA_MAINNET, SOLANA_SIGNATURE_PATTERN } from "../src/domain/solana-chains.js";
import { z } from "zod";

/**
 * Privy's sign-in and wallet frames (one login for an EVM and a Solana wallet), WalletConnect's verify frames for
 * external wallets, and Cloudflare's bot check that Privy's sign-in shows. The same lists are in vercel.json, which
 * serves the pages.
 */
export const PRIVY_FRAMES = ["https://auth.privy.io", "https://verify.walletconnect.com", "https://verify.walletconnect.org", "https://challenges.cloudflare.com"];
/**
 * What the pages may connect to: Telegram's login result, Privy and WalletConnect, Solana mainnet's public RPC (the
 * browser reads a scaled token's multiplier itself, and wallets send through it), and the Arc and Robinhood Chain
 * RPCs that an embedded wallet sends EVM transactions through.
 */
export const CONNECT_SOURCES = [
  "'self'",
  "https://oauth.telegram.org",
  "https://auth.privy.io",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "wss://www.walletlink.org",
  "https://*.rpc.privy.systems",
  "https://explorer-api.walletconnect.com",
  "https://api.mainnet-beta.solana.com",
  "wss://api.mainnet-beta.solana.com",
  "https://*.solana-mainnet.quiknode.pro",
  "wss://*.solana-mainnet.quiknode.pro",
  "https://rpc.mainnet.arc.io",
  "https://rpc.mainnet.chain.robinhood.com",
];
export const FRAME_SOURCES = ["https://oauth.telegram.org", "https://t.me", ...PRIVY_FRAMES];

const paymentConfirmationSchema = z.object({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  amount: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  recipient: z.object({
    platform: z.enum(["github", "telegram", "x", "discord", "farcaster"]),
    username: z.string().min(1).max(64).transform((value) => value.replace(/^@/, "").toLowerCase()),
  }),
  sourcePlatform: z.enum(["github", "telegram", "x", "discord", "farcaster"]).optional(),
});

/** Every platform a vault link can wait on (`stock-claims.ts`), and whether it waits for the account or the name. */
const vaultPlatformSchema = z.enum(["github", "x", "farcaster", "discord", "telegram"]);
const vaultLockSchema = z.enum(["account", "name"]).optional();
const claimPreparationSchema = z.object({
  platform: vaultPlatformSchema,
  username: z.string().min(1).max(64),
  amount: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  expiryHours: z.number().int().min(24).max(24 * 30),
  lock: vaultLockSchema,
  sourcePlatform: z.enum(["github", "telegram", "x", "discord", "farcaster"]).optional(),
});
const claimFundingConfirmationSchema = z.object({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  paymentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  platform: vaultPlatformSchema,
  username: z.string().min(1).max(64),
  amount: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  lock: vaultLockSchema,
  sourcePlatform: z.enum(["github", "telegram", "x", "discord", "farcaster"]).optional(),
});

const socialPlatformSchema = z.enum(["github", "telegram", "x", "discord", "farcaster"]);
const stockTransferRequestSchema = z.object({
  network: z.enum(["robinhood-mainnet", "robinhood-testnet"]),
  token: z.object({ symbol: z.string().min(1).max(12), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
  amount: z.string().min(1).max(64),
  recipient: z.object({
    platform: socialPlatformSchema,
    username: z.string().min(1).max(64).transform((value) => value.replace(/^@/, "").toLowerCase()),
  }),
  sourcePlatform: socialPlatformSchema.optional(),
});
const stockTransferPreparationSchema = stockTransferRequestSchema.extend({
  expectedRecipientAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  note: z.string().max(1_000).optional(),
  /** Mainnet only: the sender confirms they may hold and transfer Robinhood Stock Tokens where they live. */
  eligibilityConfirmed: z.boolean().optional(),
});
const stockTransferBatchSchema = paymentBatchSchema.extend({
  network: z.enum(["robinhood-mainnet", "robinhood-testnet"]),
  token: z.object({ symbol: z.string().min(1).max(12), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
  /** Mainnet only: the sender confirms they may hold and transfer Robinhood Stock Tokens where they live. */
  eligibilityConfirmed: z.boolean().optional(),
});
const stockTransferConfirmationSchema = stockTransferRequestSchema.extend({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
const stockNetworkSchema = z.enum(["robinhood-mainnet", "robinhood-testnet"]);
/** Vault links wait for a GitHub, X or Farcaster account, or for a Discord, Telegram or X name (`vault-lock.ts`). */
const stockClaimRecipientSchema = z.object({
  platform: vaultPlatformSchema,
  username: z.string().min(1).max(64).transform((value) => value.replace(/^@/, "").toLowerCase()),
});
const stockClaimPreparationSchema = stockTransferRequestSchema.extend({
  recipient: stockClaimRecipientSchema,
  expiryHours: z.number().int().min(24).max(24 * 30),
  lock: vaultLockSchema,
  /** Mainnet only: the sender's statement, as for a direct transfer. */
  eligibilityConfirmed: z.boolean().optional(),
});
const stockClaimFundingSchema = stockTransferRequestSchema.extend({
  recipient: stockClaimRecipientSchema,
  lock: vaultLockSchema,
  escrow: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  paymentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
const stockClaimRedemptionSchema = z.object({ eligibilityConfirmed: z.boolean().optional() });
const stockEscrowRegistrationSchema = z.object({
  network: stockNetworkSchema,
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

/** The bundled allowlist entry (a Stock Token or USDG) for this exact ticker and address on this network. */
function allowlistedStockToken(network: StockNetworkId, token: { symbol: string; address: string }) {
  return allowlistedRobinhoodAsset(network, token);
}

const STOCK_TRANSFERS_UNCONFIGURED = "Stock-token transfers are not configured on this server.";
const STOCK_CLAIMS_UNCONFIGURED = "Stock claim links are not configured on this server.";

function sendStockTransferError(response: express.Response, error: unknown, fallback: string) {
  if (error instanceof StockTransferRejectedError) return void response.status(400).json({ error: error.message });
  // X did not answer the lookup for an account lock: the slip offers the sender the name lock instead.
  if (error instanceof VaultNameLockOffer) return void response.status(409).json({ error: error.message, lock: error.lock });
  if (error instanceof StockEscrowOperatorError) return void response.status(403).json({ error: error.message });
  if (error instanceof StockClaimNotFoundError) return void response.status(404).json({ error: error.message });
  if (error instanceof DuplicateStockTransferError || error instanceof DuplicateStockClaimError) return void response.status(409).json({ error: error.message });
  if (error instanceof StockReceiptPendingError) {
    response.setHeader("Retry-After", "5");
    return void response.status(503).json({ error: error.message, pending: true });
  }
  if (error instanceof StockTransferUnavailableError) return void response.status(503).json({ error: error.message });
  // Provider and database errors can carry endpoints or internals; the browser gets a fixed message.
  response.status(500).json({ error: fallback });
}

/**
 * The Arc payment and vault routes answer as the stock routes do: a refusal the person can act on (400), a receipt to
 * verify again (503 with `pending`), a recorded duplicate (409), or a fixed message, never a provider's or the
 * database's own text (audit, 2026-10-06).
 */
function sendArcError(response: express.Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) return void response.status(400).json({ error: fallback });
  if (error instanceof DuplicatePaymentError) return void response.status(409).json({ error: error.message });
  sendStockTransferError(response, error, fallback);
}

function cookieValue(header: string | undefined, name: string) {
  return header
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)
    ?.slice(1)
    .join("=");
}

/** Why a provider sign-in did not link, so the desk can say what to do instead of "could not be verified". */
export type LinkFailure = "session" | "denied" | "expired" | "taken" | "setup" | "access" | "failed";

function identityRedirect(returnTo: string, key: "linked" | "link_error", provider: string, reason?: LinkFailure) {
  return `${returnTo}?${new URLSearchParams({ [key]: provider, ...(reason ? { reason } : {}) }).toString()}`;
}

/** The numeric bot ID that starts a Telegram bot token; it is public (it names the bot), unlike the rest of the token. */
export function telegramBotId(token: string | undefined) {
  return /^(\d{5,20}):/.exec(token ?? "")?.[1];
}

/** The verified Arc fee contracts behind the configured escrow, for routed direct payments. */
export type ArcFeeDesk = {
  schedule: FeeSchedule;
  quote(payer: Address, units: bigint): Promise<{ fee: bigint; bps: bigint }>;
  usdcBalance(owner: Address): Promise<bigint>;
  /** Whether the payer's USDC allowance to the router already covers `total`, so only `pay` is left to sign. */
  approvalCovers?(owner: Address, total: bigint): Promise<boolean>;
  /** The USDC (six decimals) these calls may spend on gas, which Arc takes from the same balance (`arcGasReserve`). */
  gasReserve?(calls: { approvals: number; payments: number }): Promise<bigint>;
};

/**
 * Arc Mainnet's contract settings for the operator page: who deploys, the attestor addresses the contracts must name,
 * and a read-only Arc Mainnet reader to check a deployment before production switches to it. Addresses only.
 */
export type ArcMainnetSetup = {
  contracts: ArcContractConfig;
  live: boolean;
  problems: Partial<Record<"identityRegistry" | "claimEscrow", string>>;
  fees?: FeeSchedule;
  identityVerifier?: Address;
  claimVerifier?: Address;
  reader(): ArcMainnetReader;
};

const arcUsdcBalanceAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

export function createApp(dependencies: {
  auth: WalletAuthService;
  oauthFlows?: OAuthFlowStore;
  identities?: IdentityStore;
  identityStoreKind?: "memory" | "postgres" | "custom";
  github?: GitHubOAuthProvider;
  x?: XOAuthProvider;
  discord?: DiscordOAuthProvider;
  telegramBotToken?: string;
  telegramBotUsername?: string;
  /** Telegram's own answer on whether `telegramBotToken` is still the bot's token (`TelegramBotTokenCheck`). */
  telegramTokenCheck?: { refused(): Promise<boolean> };
  /** The site's own origin (APP_URL in production). Sessions, OAuth returns and Farcaster sign-ins all live there. */
  appOrigin?: string;
  network?: ArcNetworkConfig;
  farcaster?: Pick<FarcasterAuthService, "start" | "complete">;
  webRoot?: string;
  payments?: Pick<PaymentHistoryService, "confirm" | "list">;
  claims?: Pick<ClaimablePaymentService, "prepare">;
  redemptions?: Pick<ClaimRedemptionService, "details" | "prepareClaim" | "prepareRefund"> & Partial<Pick<ClaimRedemptionService, "pending">>;
  claimFundings?: Pick<ClaimFundingService, "confirm" | "metadata">;
  arcFees?: ArcFeeDesk;
  /** The USDC balance of a wallet on the Arc network this server runs, checked before a plain transfer without a fee. */
  arcUsdcBalance?: (owner: Address) => Promise<bigint>;
  /** The USDC (six decimals) a plain transfer may spend on gas, which Arc takes from the same balance (`arcGasReserve`). */
  arcTransferGas?: () => Promise<bigint>;
  /** Reads a receipt on the Arc network this server runs; null while it is not mined. */
  arcReceipts?: (input: { hash: Hex }) => Promise<ChainReceipt | null>;
  arcMainnetSetup?: ArcMainnetSetup;
  stocks?: Pick<StockTokenMarketData, "snapshot">;
  stockTransfers?: Pick<StockTransferService, "availability" | "prepare" | "confirm" | "list"> & Partial<Pick<StockTransferService, "readReceipt" | "prepareBatch" | "holding">>;
  stockClaims?: Pick<StockClaimService, "availability" | "feeSchedule" | "deployment" | "register" | "prepare" | "confirmFunding" | "details" | "prepareClaim" | "prepareRefund"> & Partial<Pick<StockClaimService, "pending">>;
  /** Which official non-user lookups have their optional keys. Booleans only; no value leaves the server. */
  recipientLookups?: { githubToken: boolean; xBearerToken: boolean };
  /** The platforms' official directories (GitHub, X, Farcaster), asked whether a handle exists before a vault link is offered. */
  recipientDirectory?: Pick<OfficialRecipientDirectory, "exists"> & Partial<Pick<OfficialRecipientDirectory, "refused">>;
  /** Which networks the server reads through a provider's RPC (and Solana's pages too). Booleans only. */
  rpcProviders?: { solana: boolean; solanaBrowser: boolean; arc: boolean; robinhood: boolean };
  /** Solana (since 2026-10-04, beside Robinhood Chain, the main network): transfers, the account's Solana address and the board. */
  solana?: SolanaDesk;
  /** The public Privy app ID the desk signs in with (one login, an EVM and a Solana wallet). Not a secret. */
  privyAppId?: string;
  /** SP, the points every network shares. */
  sp?: SpDesk;
  /** The admin panel: admin wallets, the audit log, the desk's pauses and notice. */
  admin?: AdminDesk;
  vercelIngress?: boolean;
  /** Outside Vercel, the proxies to trust for the client's address (see readTrustProxy); rate limits count by it. */
  trustProxy?: number | string;
}) {
  const app = express();
  const oauthFlows = dependencies.oauthFlows ?? new OAuthFlowStore();
  const identities = dependencies.identities ?? new VerifiedIdentityService();
  /** The wallet's verified accounts with the immutable provider IDs that vault links are locked to. */
  const verifiedAccounts = async (wallet: string) => {
    const profile = await identities.profile(wallet);
    return (await Promise.all(profile.accounts.map((account) => identities.account(wallet, account.platform))))
      .filter((account) => account !== undefined);
  };
  const network = dependencies.network ?? { ready: false as const, reason: "Arc mainnet RPC, chain ID, and ERC-20 USDC address are not configured." };
  const arcTestnetPaymentReady = network.ready && network.environment === "testnet"
    && network.chainId === ARC_TESTNET.chainId && network.chainIdHex === `0x${ARC_TESTNET.chainId.toString(16)}`;
  const arcMainnetPaymentReady = network.ready && network.environment === "mainnet"
    && network.chainId === ARC_MAINNET.chainId && network.chainIdHex === `0x${ARC_MAINNET.chainId.toString(16)}`;
  app.disable("x-powered-by");
  if (dependencies.trustProxy !== undefined && !dependencies.vercelIngress) app.set("trust proxy", dependencies.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://telegram.org", "https://challenges.cloudflare.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https://explorer-api.walletconnect.com"],
        connectSrc: [...CONNECT_SOURCES],
        frameSrc: [...FRAME_SOURCES],
        childSrc: [...PRIVY_FRAMES],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
  }));
  app.use(express.json({ limit: "16kb" }));
  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  function vercelClientIp(request: Request) {
    const value = request.headers["x-forwarded-for"];
    return typeof value === "string" && isIP(value) ? value : undefined;
  }
  const protectedIngress = (request: Request, response: express.Response, next: express.NextFunction) => {
    if (dependencies.vercelIngress && !vercelClientIp(request)) {
      return void response.status(503).json({ error: "Service temporarily unavailable." });
    }
    next();
  };
  const vercelKey = dependencies.vercelIngress
    ? { keyGenerator: (request: Request) => ipKeyGenerator(vercelClientIp(request)!, 56) }
    : {};

  const walletChallengeLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many wallet sign-in attempts. Try again in one minute." },
    ...vercelKey,
  });
  // A signature check per sign-in; more than this from one client is guessing, not signing in.
  const walletVerifyLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many wallet sign-in attempts. Try again in one minute." },
    ...vercelKey,
  });
  // Starting a provider sign-in writes a one-time state and, for Farcaster, opens a relay channel: bounded per client.
  const providerStartLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again in one minute." },
    ...vercelKey,
  });
  // The desk asks Farcaster's relay about a sign-in every 1.5 seconds while it waits.
  const farcasterPollLimit = rateLimit({
    windowMs: 60_000,
    limit: 90,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many Farcaster checks. Try again in one minute." },
    ...vercelKey,
  });
  // Which wallet a handle belongs to is public, but listing many handles one by one is not what a pay link does.
  const resolveLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many lookups. Try again in one minute." },
    ...vercelKey,
  });
  const chatDraftLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many payment draft requests. Try again in one minute." },
    ...vercelKey,
  });
  // Each stock-token preparation or confirmation reads Robinhood Chain, so it is bounded per client.
  const stockTransferLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many stock-token transfer requests. Try again in one minute." },
    ...vercelKey,
  });
  // A batch reads Arc once per person it pays, so preparing one is bounded per client.
  const paymentBatchLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many payment requests. Try again in one minute." },
    ...vercelKey,
  });
  // Claim links have their own budgets, so claim pages and escrow checks never use up a sender's transfer quota.
  const stockClaimLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many claim link requests. Try again in one minute." },
    ...vercelKey,
  });
  const stockClaimReadLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many claim page requests. Try again in one minute." },
    ...vercelKey,
  });
  // Every wallet flow polls its receipts through the server, about one request a second while a transaction mines.
  const receiptReadLimit = rateLimit({
    windowMs: 60_000,
    limit: 180,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many receipt checks. Try again in one minute." },
    ...vercelKey,
  });
  // Each Arc confirmation reads the chain (and, for a vault link, the platform's directory); a batch of ten confirms ten.
  const paymentConfirmLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many payment confirmations. Try again in one minute." },
    ...vercelKey,
  });
  // The pending claims list reads every listed link back from its escrow, so it has its own, smaller budget.
  const pendingClaimsLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many pending claim checks. Try again in one minute." },
    ...vercelKey,
  });
  // One Telegram answer per Connect; a hash that does not match can make the server ask Telegram about its own token.
  const telegramVerifyLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many Telegram sign-ins. Try again in one minute." },
    ...vercelKey,
  });
  // The operator page reads Arc Mainnet receipts while it deploys, about one request a second at most.
  const arcSetupReadLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many Arc Mainnet setup requests. Try again in one minute." },
    ...vercelKey,
  });
  // Arc vault links resolve GitHub and Farcaster handles from their official sources and X handles with a bearer token;
  // Discord and Telegram links, and X links while X cannot be asked, wait for the name (2026-10-06).
  const usdcClaimAvailability = (): UsdcClaimAvailability => dependencies.claims && network.ready
    ? { enabled: true, platforms: ["github", "farcaster", "x", "discord", "telegram"] }
    : { enabled: false, reason: network.ready ? "Arc vault links are not configured on this server" : undefined };
  const stockTransferAvailability = (network: StockNetworkId): StockTransferAvailability =>
    dependencies.stockTransfers?.availability(network) ?? { enabled: false, reason: STOCK_TRANSFERS_UNCONFIGURED };
  const stockClaimAvailability = async (network: StockNetworkId): Promise<StockClaimAvailability> =>
    dependencies.stockClaims ? dependencies.stockClaims.availability(network) : { enabled: false, reason: STOCK_CLAIMS_UNCONFIGURED };
  // The fee contracts behind the registered vault escrow: every payment on the network goes through their router.
  // Null until the operator registers an escrow; a registered one whose fee contracts cannot be verified throws.
  const stockFeeSchedule = async (network: StockNetworkId) =>
    dependencies.stockClaims ? (await dependencies.stockClaims.feeSchedule(network)) ?? null : null;
  /**
   * A feature an admin paused answers 503 with the admin's message. Only preparing new payments and new vault links is
   * paused; confirming a signed payment, claiming and refunding never are, so no one's funds wait on a pause.
   */
  async function refusePaused(response: express.Response, feature: DeskFeature) {
    const message = await dependencies.admin?.controls.paused(feature);
    if (!message) return false;
    response.status(503).json({ error: message, paused: feature });
    return true;
  }

  app.post("/api/auth/challenge", protectedIngress, walletChallengeLimit, async (request, response) => {
    try {
      response.json(await dependencies.auth.createChallenge(request.body?.address));
    } catch (error) {
      // A store that cannot be written answers with a fixed message, never its own text (audit, 2026-10-06).
      if (error instanceof InvalidWalletError) return void response.status(400).json({ error: error.message });
      response.status(503).json({ error: "The sign-in could not start right now. Try again in a moment." });
    }
  });

  app.post("/api/auth/verify", protectedIngress, walletVerifyLimit, async (request, response) => {
    try {
      const session = await dependencies.auth.verifyChallenge({
        address: request.body?.address,
        challengeId: request.body?.challengeId,
        signature: request.body?.signature,
      });
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      response.setHeader(
        "Set-Cookie",
        `hapapay_session=${session.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${WALLET_SESSION_SECONDS}${secure}`,
      );
      response.json({ authenticated: true, address: session.address, expiresAt: session.expiresAt });
    } catch (error) {
      if (error instanceof SignInRejectedError) return void response.status(401).json({ error: error.message });
      response.status(503).json({ error: "The sign-in could not be checked right now. Try again in a moment." });
    }
  });

  // Disconnect: the browser drops the session cookie. Linked accounts stay linked to the wallet. A JSON body is required,
  // so another site cannot sign a visitor out with a plain form post.
  app.post("/api/auth/logout", (request, response) => {
    if (!request.is("application/json")) return void response.status(415).json({ error: "Send the request as JSON." });
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    response.setHeader("Set-Cookie", `hapapay_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
    response.status(204).end();
  });

  app.get("/api/me", (request, response) => {
    const token = cookieValue(request.headers.cookie, "hapapay_session");
    const session = token ? dependencies.auth.readSession(token) : undefined;
    if (!session) {
      response.json({ authenticated: false });
      return;
    }
    response.json({ authenticated: true, address: session.address });
  });

  app.get("/api/providers", async (_request, response) => {
    response.json({
      // What an admin paused and the desk notice, so the desk says so before anyone signs.
      controls: dependencies.admin ? await dependencies.admin.controls.view() : { paused: {}, notice: null },
      // The desk opened on another host (a preview or deployment URL) moves itself here before a wallet signs,
      // because sign-ins return to this origin and a session cookie set elsewhere never reaches them.
      appOrigin: dependencies.appOrigin ?? null,
      privyAppId: dependencies.privyAppId ?? null,
      // The pages' Solana RPC: a QuickNode endpoint that allows only this site (its token is public by design).
      solanaRpcUrl: dependencies.solana?.config.browserRpcUrl ?? null,
      providers: [
        { id: "github", name: "GitHub", configured: Boolean(dependencies.github), method: "OAuth 2.0" },
        { id: "x", name: "X", configured: Boolean(dependencies.x), method: "OAuth 2.0 + PKCE" },
        { id: "telegram", name: "Telegram", configured: Boolean(telegramBotId(dependencies.telegramBotToken) && dependencies.telegramBotUsername), method: "Log in with Telegram", botUsername: dependencies.telegramBotUsername, botId: telegramBotId(dependencies.telegramBotToken) },
        { id: "discord", name: "Discord", configured: Boolean(dependencies.discord), method: "OAuth 2.0" },
        { id: "farcaster", name: "Farcaster", configured: Boolean(dependencies.farcaster), method: "Sign in with Farcaster" },
      ],
    });
  });

  app.get("/api/profile", async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) {
      response.status(401).json({ error: "Connect and sign with your wallet first." });
      return;
    }
    try {
      const [profile, solanaAddress] = await Promise.all([
        identities.profile(session.address),
        dependencies.solana ? dependencies.solana.addresses.solana(session.address) : undefined,
      ]);
      // A server that runs Solana says whether the account has a Solana address; one that does not, says nothing.
      response.json(dependencies.solana ? { ...profile, solanaAddress: solanaAddress ?? null } : profile);
    } catch {
      // A failed read removes nothing: the desk says the accounts are still linked and reads again.
      response.setHeader("Retry-After", "2");
      response.status(503).json({ error: "Your linked accounts could not be read just now. They are still linked; try again in a moment." });
    }
  });

  app.get("/api/network", (_request, response) => {
    // A provider RPC behind the server's Arc reads (ARC_MAINNET_RPC_URL) may carry a key, so it never leaves the server.
    const { serverRpcUrl: _provider, ...walletNetwork } = network.ready ? network : { ...network, serverRpcUrl: undefined };
    response.json({
      ...walletNetwork,
      claimablePaymentsReady: Boolean(dependencies.claims),
      claimRedemptionReady: Boolean(dependencies.redemptions),
      fees: dependencies.arcFees?.schedule ?? null,
      paymentNetworks: paymentNetworkCatalog(arcTestnetPaymentReady, arcMainnetPaymentReady),
    });
  });

  app.get("/api/stocks", async (request, response) => {
    const network = request.query.network ?? "robinhood-mainnet";
    if (network !== "robinhood-mainnet" && network !== "robinhood-testnet") {
      return void response.status(400).json({ error: "Unsupported stock-token network." });
    }
    // The verified allowlist is always served; indicative mainnet prices are optional and display-only.
    const snapshot = dependencies.stocks ? await dependencies.stocks.snapshot(network) : stockTokenCatalog(network);
    const fees = await stockFeeSchedule(network).catch(() => null);
    response.json({ ...snapshot, transfers: stockTransferAvailability(network), claims: await stockClaimAvailability(network), fees });
  });

  app.post("/api/stocks/transfers/prepare", protectedIngress, stockTransferLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.stockTransfers) return void response.status(503).json({ error: STOCK_TRANSFERS_UNCONFIGURED });
    if (await refusePaused(response, "robinhood.transfers")) return;
    const parsed = stockTransferPreparationSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid stock-token transfer request." });
    const input = parsed.data;
    const chain = STOCK_CHAINS[input.network];
    const token = allowlistedStockToken(input.network, input.token);
    if (!token) return void response.status(400).json({ error: `${input.token.symbol} is not on the verified ${chain.name} token list.` });
    const availability = transferAvailabilityFor(stockTransferAvailability(input.network), token);
    if (!availability.enabled) return void response.status(503).json({ error: availability.reason });
    const amount = normalizeStockAmount(input.amount, tokenDecimals(token));
    if (!amount) return void response.status(400).json({ error: `Enter a ${token.symbol} amount greater than zero with at most ${tokenDecimals(token)} decimals.` });
    if (!chain.testAssets && isStockToken(token) && input.eligibilityConfirmed !== true) {
      return void response.status(400).json({ error: "Confirm that you may hold and transfer Robinhood Stock Tokens before a mainnet transfer." });
    }
    try {
      const senderAccount = input.sourcePlatform ? await identities.account(session.address, input.sourcePlatform) : undefined;
      if (input.sourcePlatform && !senderAccount) {
        return void response.status(400).json({ error: `Link and verify your ${platformName(input.sourcePlatform)} account before sending from it.` });
      }
      const recipient = await identities.resolve(input.recipient.platform, input.recipient.username);
      if (!recipient) return void response.status(404).json({ error: "Recipient does not have a verified social identity." });
      if (recipient !== getAddress(input.expectedRecipientAddress.toLowerCase())) {
        return void response.status(409).json({ error: "Recipient identity changed after review. Review the transfer again." });
      }
      const fees = await stockFeeSchedule(input.network);
      const prepared = await dependencies.stockTransfers.prepare({ network: input.network, sender: session.address, recipient, token, amount, note: input.note, ...(fees ? { fees } : {}) });
      response.json({
        ...prepared,
        recipient: { platform: input.recipient.platform, username: input.recipient.username, address: recipient },
        senderIdentity: senderAccount ? { platform: senderAccount.platform, username: senderAccount.username } : undefined,
      });
    } catch (error) {
      sendStockTransferError(response, error, "The stock-token transfer could not be prepared. Try again.");
    }
  });

  app.post("/api/stocks/transfers/confirm", protectedIngress, stockTransferLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.stockTransfers) return void response.status(503).json({ error: STOCK_TRANSFERS_UNCONFIGURED });
    const parsed = stockTransferConfirmationSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid stock-token transfer confirmation." });
    const input = parsed.data;
    const token = allowlistedStockToken(input.network, input.token);
    if (!token) return void response.status(400).json({ error: `${input.token.symbol} is not on the verified ${STOCK_CHAINS[input.network].name} token list.` });
    try {
      const recipient = await identities.resolve(input.recipient.platform, input.recipient.username);
      if (!recipient) return void response.status(404).json({ error: "Recipient does not have a verified social identity." });
      // The transfer already moved: a source account unlinked since then only drops its label, never the record.
      const senderAccount = input.sourcePlatform ? await identities.account(session.address, input.sourcePlatform) : undefined;
      // The router behind the network's escrow shows the fee the transfer paid. Fee contracts that cannot be checked
      // right now are verified again later rather than recorded as no fee, which would lose the inviter's reward for
      // good (audit, 2026-10-06); a network without a registered escrow has no router and records no fee.
      let fees: Awaited<ReturnType<typeof stockFeeSchedule>>;
      try {
        fees = await stockFeeSchedule(input.network);
      } catch {
        throw new StockTransferUnavailableError(`${STOCK_CHAINS[input.network].name}'s fee contracts could not be checked just now. Verify the transfer again in a moment.`);
      }
      const transfer = await dependencies.stockTransfers.confirm({
        network: input.network,
        transactionHash: input.transactionHash,
        sender: session.address,
        recipient,
        token,
        amount: input.amount,
        platform: input.recipient.platform,
        username: input.recipient.username,
        sourcePlatform: senderAccount?.platform,
        sourceUsername: senderAccount?.username,
        ...(fees ? { router: getAddress(fees.router) } : {}),
      });
      response.status(201).json(transfer);
    } catch (error) {
      sendStockTransferError(response, error, "The stock-token receipt could not be verified. Try again.");
    }
  });

  // Several people, one token: the same checks as one transfer for everyone, then one approval and one `pay` each.
  app.post("/api/stocks/transfers/prepare-batch", protectedIngress, stockTransferLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    const transfers = dependencies.stockTransfers;
    if (!transfers?.prepareBatch) return void response.status(503).json({ error: STOCK_TRANSFERS_UNCONFIGURED });
    if (await refusePaused(response, "robinhood.transfers")) return;
    const parsed = stockTransferBatchSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid token payments." });
    const input = parsed.data;
    const chain = STOCK_CHAINS[input.network];
    const token = allowlistedStockToken(input.network, input.token);
    if (!token) return void response.status(400).json({ error: `${input.token.symbol} is not on the verified ${chain.name} token list.` });
    const availability = transferAvailabilityFor(stockTransferAvailability(input.network), token);
    if (!availability.enabled) return void response.status(503).json({ error: availability.reason });
    if (!chain.testAssets && isStockToken(token) && input.eligibilityConfirmed !== true) {
      return void response.status(400).json({ error: "Confirm that you may hold and transfer Robinhood Stock Tokens before a mainnet transfer." });
    }
    try {
      const senderAccount = input.sourcePlatform ? await identities.account(session.address, input.sourcePlatform) : undefined;
      if (input.sourcePlatform && !senderAccount) {
        return void response.status(400).json({ error: `Link and verify your ${platformName(input.sourcePlatform)} account before sending from it.` });
      }
      const people = await resolveBatch(input.recipients);
      if ("status" in people) return void response.status(people.status).json({ error: people.error });
      const fees = await stockFeeSchedule(input.network);
      if (!fees) return void response.status(503).json({ error: `Payments to several people run through the ${chain.name} fee router, which this server does not run yet.` });
      const prepared = await transfers.prepareBatch({
        network: input.network,
        sender: session.address,
        token,
        payments: people.map(({ recipient, amount }) => ({ recipient, amount })),
        fees,
        note: input.note,
      });
      response.json({
        ...prepared,
        payments: prepared.payments.map((payment, index) => ({ ...payment, recipient: { platform: people[index].platform, username: people[index].username, address: payment.recipient } })),
        senderIdentity: senderAccount ? { platform: senderAccount.platform, username: senderAccount.username } : undefined,
      });
    } catch (error) {
      sendStockTransferError(response, error, "The token payments could not be prepared. Try again.");
    }
  });

  /**
   * Everyone in a reviewed batch resolved again, each once: a wallet that is still the one the review showed. The
   * reply names whoever cannot be paid, so the sender knows whom to remove or review again.
   */
  async function resolveBatch(recipients: Array<{ platform: Platform; username: string; amount: string; expectedRecipientAddress: string }>) {
    const seen = new Set<string>();
    const people: Array<{ platform: Platform; username: string; amount: string; recipient: Address }> = [];
    for (const person of recipients) {
      const name = `@${person.username} on ${platformName(person.platform)}`;
      const key = `${person.platform}:${person.username}`;
      if (seen.has(key)) return { status: 400, error: `${name} is in this request twice. Review it again.` };
      seen.add(key);
      const recipient = await identities.resolve(person.platform, person.username);
      if (!recipient) return { status: 404, error: `${name} does not have a verified social identity.` };
      if (recipient !== getAddress(person.expectedRecipientAddress.toLowerCase())) return { status: 409, error: `${name} changed after review. Review the payments again.` };
      people.push({ platform: person.platform, username: person.username, amount: person.amount, recipient });
    }
    return people;
  }

  app.get("/api/stocks/transfers", async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.stockTransfers) return void response.status(503).json({ error: STOCK_TRANSFERS_UNCONFIGURED });
    try {
      response.json({ transfers: await dependencies.stockTransfers.list(session.address) });
    } catch (error) {
      sendStockTransferError(response, error, "Stock-token activity could not be loaded. Try again.");
    }
  });

  // Operator view of the claim escrow on each Robinhood network: addresses and missing settings only.
  app.get("/api/stocks/escrow", async (_request, response) => {
    if (!dependencies.stockClaims) return void response.status(503).json({ error: STOCK_CLAIMS_UNCONFIGURED });
    try {
      const networks = await Promise.all((["robinhood-testnet", "robinhood-mainnet"] as const).map((network) => dependencies.stockClaims!.deployment(network)));
      response.json({
        contract: {
          name: STOCK_CLAIM_ESCROW_ARTIFACT.contractName,
          securityRevision: STOCK_CLAIM_ESCROW_REVISION.toString(),
          runtimeCodeHash: STOCK_CLAIM_ESCROW_ARTIFACT.runtimeCodeHash,
        },
        // The escrow charges the fee through these; the operator page deploys them first.
        feeContracts: {
          router: { name: PAY_ROUTER_ARTIFACT.contractName, securityRevision: PAY_ROUTER_REVISION.toString(), runtimeCodeHash: PAY_ROUTER_ARTIFACT.runtimeCodeHash },
          burnVault: { name: BURN_VAULT_ARTIFACT.contractName, securityRevision: BURN_VAULT_REVISION.toString(), runtimeCodeHash: BURN_VAULT_ARTIFACT.runtimeCodeHash },
          feeBps: Number(PLATFORM_FEE_BPS),
          burnShareBps: Number(PLATFORM_FEE_BURN_SHARE_BPS),
        },
        networks,
      });
    } catch (error) {
      sendStockTransferError(response, error, "The claim escrow status could not be loaded. Try again.");
    }
  });

  app.post("/api/stocks/escrow/register", protectedIngress, stockClaimLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.stockClaims) return void response.status(503).json({ error: STOCK_CLAIMS_UNCONFIGURED });
    const parsed = stockEscrowRegistrationSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid escrow registration." });
    try {
      response.status(201).json(await dependencies.stockClaims.register({ ...parsed.data, wallet: session.address }));
    } catch (error) {
      sendStockTransferError(response, error, "The claim escrow could not be registered. Try again.");
    }
  });

  app.post("/api/stocks/claims/prepare", protectedIngress, stockClaimLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.stockClaims) return void response.status(503).json({ error: STOCK_CLAIMS_UNCONFIGURED });
    if (await refusePaused(response, "robinhood.vault")) return;
    const parsed = stockClaimPreparationSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid stock claim link request." });
    const input = parsed.data;
    const chain = STOCK_CHAINS[input.network];
    const token = allowlistedStockToken(input.network, input.token);
    if (!token) return void response.status(400).json({ error: `${input.token.symbol} is not on the verified ${chain.name} token list.` });
    if (!normalizeStockAmount(input.amount, tokenDecimals(token))) {
      return void response.status(400).json({ error: `Enter a ${token.symbol} amount greater than zero with at most ${tokenDecimals(token)} decimals.` });
    }
    if (!chain.testAssets && isStockToken(token) && input.eligibilityConfirmed !== true) {
      return void response.status(400).json({ error: "Confirm that you may hold and transfer Robinhood Stock Tokens before a mainnet claim link." });
    }
    try {
      const senderAccount = input.sourcePlatform ? await identities.account(session.address, input.sourcePlatform) : undefined;
      if (input.sourcePlatform && !senderAccount) {
        return void response.status(400).json({ error: `Link and verify your ${platformName(input.sourcePlatform)} account before sending from it.` });
      }
      const prepared = await dependencies.stockClaims.prepare({
        network: input.network,
        payer: session.address,
        token,
        amount: input.amount,
        platform: input.recipient.platform,
        username: input.recipient.username,
        expiryHours: input.expiryHours,
        lock: input.lock,
      });
      response.json({ ...prepared, senderIdentity: senderAccount ? { platform: senderAccount.platform, username: senderAccount.username } : undefined });
    } catch (error) {
      sendStockTransferError(response, error, "The claim link could not be prepared. Try again.");
    }
  });

  app.post("/api/stocks/claims/confirm-funding", protectedIngress, stockClaimLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.stockClaims) return void response.status(503).json({ error: STOCK_CLAIMS_UNCONFIGURED });
    const parsed = stockClaimFundingSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid claim link confirmation." });
    const input = parsed.data;
    const token = allowlistedStockToken(input.network, input.token);
    if (!token) return void response.status(400).json({ error: `${input.token.symbol} is not on the verified ${STOCK_CHAINS[input.network].name} token list.` });
    try {
      // The link is already funded: a source account unlinked since then only drops its label, never the record.
      const senderAccount = input.sourcePlatform ? await identities.account(session.address, input.sourcePlatform) : undefined;
      const record = await dependencies.stockClaims.confirmFunding({
        network: input.network,
        escrow: input.escrow,
        paymentId: input.paymentId,
        transactionHash: input.transactionHash,
        payer: session.address,
        token,
        amount: input.amount,
        platform: input.recipient.platform,
        username: input.recipient.username,
        lock: input.lock,
        sourceIdentity: senderAccount ? { platform: senderAccount.platform, username: senderAccount.username } : undefined,
      });
      response.status(201).json(record);
    } catch (error) {
      sendStockTransferError(response, error, "The escrow receipt could not be verified. Try again.");
    }
  });

  app.get("/api/stocks/claims/:network/:paymentId", protectedIngress, stockClaimReadLimit, async (request, response) => {
    if (!dependencies.stockClaims) return void response.status(503).json({ error: STOCK_CLAIMS_UNCONFIGURED });
    const network = stockNetworkSchema.safeParse(request.params.network);
    if (!network.success) return void response.status(404).json({ error: "This claim link was not found." });
    try {
      response.json(await dependencies.stockClaims.details(network.data, String(request.params.paymentId)));
    } catch (error) {
      sendStockTransferError(response, error, "The claim link could not be loaded. Try again.");
    }
  });

  app.post("/api/stocks/claims/:network/:paymentId/prepare-claim", protectedIngress, stockClaimLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.stockClaims) return void response.status(503).json({ error: STOCK_CLAIMS_UNCONFIGURED });
    const network = stockNetworkSchema.safeParse(request.params.network);
    if (!network.success) return void response.status(404).json({ error: "This claim link was not found." });
    const body = stockClaimRedemptionSchema.safeParse(request.body ?? {});
    if (!body.success) return void response.status(400).json({ error: "Invalid claim request." });
    try {
      // Mainnet Stock Token claims need the recipient's statement; the service checks it against the payment's token.
      response.json(await dependencies.stockClaims.prepareClaim({
        network: network.data,
        paymentId: String(request.params.paymentId),
        wallet: session.address,
        accounts: await verifiedAccounts(session.address),
        eligibilityConfirmed: body.data.eligibilityConfirmed,
      }));
    } catch (error) {
      sendStockTransferError(response, error, "The claim could not be prepared. Try again.");
    }
  });

  app.post("/api/stocks/claims/:network/:paymentId/prepare-refund", protectedIngress, stockClaimLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.stockClaims) return void response.status(503).json({ error: STOCK_CLAIMS_UNCONFIGURED });
    const network = stockNetworkSchema.safeParse(request.params.network);
    if (!network.success) return void response.status(404).json({ error: "This claim link was not found." });
    try {
      response.json(await dependencies.stockClaims.prepareRefund({ network: network.data, paymentId: String(request.params.paymentId), wallet: session.address }));
    } catch (error) {
      sendStockTransferError(response, error, "The refund could not be prepared. Try again.");
    }
  });

  app.get("/api/resolve/:platform/:username", protectedIngress, resolveLimit, async (request, response) => {
    const platform = String(request.params.platform) as Platform;
    if (!["github", "x", "telegram", "discord", "farcaster"].includes(platform)) {
      return void response.status(400).json({ error: "Unsupported identity provider." });
    }
    const username = String(request.params.username).trim().replace(/^@/, "").toLowerCase();
    if (!username || username.length > 64 || username.startsWith("#")) return void response.status(400).json({ error: "Invalid social username." });
    let address: Address | undefined;
    try {
      address = await identities.resolve(platform, username);
    } catch {
      return void response.status(503).json({ error: "The account could not be checked right now. Try again in a moment." });
    }
    if (!address) return void response.status(404).json({ error: "No OAuth-verified identity was found." });
    response.setHeader("Cache-Control", "no-store");
    response.json({ platform, username, address });
  });

  app.delete("/api/identity/:platform", async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    const platform = request.params.platform as Platform;
    if (!["github", "x", "telegram", "discord", "farcaster"].includes(platform)) {
      return void response.status(400).json({ error: "Unsupported identity provider." });
    }
    const profile = await identities.unlink(session.address, platform);
    if (!profile) return void response.status(404).json({ error: "No verified account exists for this provider." });
    response.json(profile);
  });

  // Arc Mainnet setup for the operator page: what to deploy and with which constructor arguments, and whether the
  // running server already verifies it. Addresses and variable names only; no key leaves the server.
  app.get("/api/arc/mainnet-setup", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const setup = dependencies.arcMainnetSetup;
    if (!setup) return void response.status(503).json({ error: "Arc Mainnet setup is not available on this server." });
    let forwarder: { address: Address; balance: string } | undefined;
    if (setup.fees?.sink === "forwarder") {
      try {
        const balance = await setup.reader().readContract({ address: ARC_MAINNET.usdcAddress, abi: arcUsdcBalanceAbi, functionName: "balanceOf", args: [setup.fees.burnVault] });
        if (typeof balance === "bigint") forwarder = { address: setup.fees.burnVault, balance: formatUnits(balance, 6) };
      } catch {}
    }
    response.json({
      chain: { chainId: ARC_MAINNET.chainId, chainName: ARC_MAINNET.chainName, explorerUrl: ARC_MAINNET.explorerUrl, usdc: ARC_MAINNET.usdcAddress },
      live: setup.live,
      runningNetwork: network.environment ?? "unselected",
      operator: setup.contracts.operator ?? null,
      identityVerifier: setup.identityVerifier ?? null,
      claimVerifier: setup.claimVerifier ?? null,
      setup: setup.contracts.setup,
      variables: ARC_CONTRACT_VARIABLES.mainnet,
      configured: {
        registry: setup.contracts.registryAddress ?? null,
        escrow: setup.contracts.escrowAddress ?? null,
      },
      problems: setup.problems,
      fees: setup.fees ?? null,
      forwarder: forwarder ?? null,
      contracts: {
        registry: { name: "ArcIdentityRegistry", securityRevision: ARC_IDENTITY_REGISTRY_REVISION.toString(), runtimeCodeHash: ARC_IDENTITY_REGISTRY_ARTIFACT.runtimeCodeHash },
        escrow: { name: "StockClaimEscrow", securityRevision: STOCK_CLAIM_ESCROW_REVISION.toString(), runtimeCodeHash: STOCK_CLAIM_ESCROW_ARTIFACT.runtimeCodeHash },
        router: { name: "HaPaPayRouter", securityRevision: PAY_ROUTER_REVISION.toString(), runtimeCodeHash: PAY_ROUTER_ARTIFACT.runtimeCodeHash },
        forwarder: { name: "HaPaPayFeeForwarder", securityRevision: FEE_FORWARDER_REVISION.toString(), runtimeCodeHash: FEE_FORWARDER_ARTIFACT.runtimeCodeHash },
        feeBps: Number(PLATFORM_FEE_BPS),
      },
    });
  });

  // A read-only check of an Arc Mainnet deployment, from the operator's session, before the operator switches the
  // server to it: the same checks the server runs at startup, against Arc Mainnet.
  app.post("/api/arc/mainnet-setup/verify", protectedIngress, stockClaimLimit, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    const setup = dependencies.arcMainnetSetup;
    if (!setup) return void response.status(503).json({ error: "Arc Mainnet setup is not available on this server." });
    const operator = setup.contracts.operator;
    if (!operator || getAddress(session.address) !== operator) return void response.status(403).json({ error: "Only the operator wallet set on this server can check an Arc Mainnet deployment." });
    if (!setup.identityVerifier || !setup.claimVerifier) {
      return void response.status(409).json({ error: `Set ${ARC_CONTRACT_VARIABLES.mainnet.identityAttestor} and ${ARC_CONTRACT_VARIABLES.mainnet.claimAttestor} first, then redeploy the site.` });
    }
    let registry: Address;
    let escrow: Address;
    try {
      registry = getAddress(String(request.body?.registry ?? ""));
      escrow = getAddress(String(request.body?.escrow ?? ""));
    } catch {
      return void response.status(400).json({ error: "Enter the registry and escrow contract addresses." });
    }
    const reader = setup.reader();
    const problems: Partial<Record<"registry" | "escrow", string>> = {};
    let fees: FeeSchedule | undefined;
    try {
      await verifyIdentityRegistryContract({ registry, identityVerifier: setup.identityVerifier, owner: operator }, reader);
    } catch (error) {
      problems.registry = error instanceof Error ? error.message : "The registry could not be verified.";
    }
    try {
      fees = (await verifyClaimEscrowContract({ escrow, claimVerifier: setup.claimVerifier, operator, chainName: ARC_MAINNET.chainName }, reader)).fees;
    } catch (error) {
      problems.escrow = error instanceof Error ? error.message : "The escrow could not be verified.";
    }
    if (problems.registry || problems.escrow) return void response.status(422).json({ ok: false, problems });
    response.json({
      ok: true,
      fees,
      variables: {
        [ARC_CONTRACT_VARIABLES.mainnet.registry]: registry,
        [ARC_CONTRACT_VARIABLES.mainnet.escrow]: escrow,
        ARC_NETWORK_MODE: "mainnet",
      },
    });
  });

  /** The Arc Mainnet setup and reader for the operator's own session, or the response it has already been sent. */
  function arcSetupForOperator(request: Request, response: express.Response) {
    response.setHeader("Cache-Control", "no-store");
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    const setup = dependencies.arcMainnetSetup;
    if (!setup) return void response.status(503).json({ error: "Arc Mainnet setup is not available on this server." });
    const operator = setup.contracts.operator;
    if (!operator || getAddress(session.address) !== operator) return void response.status(403).json({ error: "Only the operator wallet set on this server can read its Arc Mainnet deployment." });
    return { setup, operator };
  }

  // The operator's Arc Mainnet contracts already on chain, so the page resumes an interrupted deployment.
  app.get("/api/arc/mainnet-setup/deployment", protectedIngress, arcSetupReadLimit, async (request, response) => {
    const allowed = arcSetupForOperator(request, response);
    if (!allowed) return;
    try {
      const deployment = await findArcMainnetDeployment(allowed.setup.reader(), {
        operator: allowed.operator,
        identityVerifier: allowed.setup.identityVerifier,
        claimVerifier: allowed.setup.claimVerifier,
      });
      response.json({ deployment });
    } catch {
      response.status(503).json({ error: "Arc Mainnet could not be read right now. Try again shortly." });
    }
  });

  // A deployment receipt read from Arc Mainnet by the server, so the page never depends on how a wallet reports it.
  app.get("/api/arc/mainnet-setup/receipt/:hash", protectedIngress, arcSetupReadLimit, async (request, response) => {
    const allowed = arcSetupForOperator(request, response);
    if (!allowed) return;
    const hash = String(request.params.hash ?? "");
    if (!TRANSACTION_HASH.test(hash)) return void response.status(400).json({ error: "Enter a transaction hash." });
    try {
      const receipt = await allowed.setup.reader().getTransactionReceipt({ hash: hash as `0x${string}` });
      if (receipt && getAddress(receipt.from) !== allowed.operator) return void response.status(403).json({ error: "That transaction was not sent by the operator wallet." });
      response.json({ receipt: receiptView(receipt) });
    } catch {
      response.status(503).json({ error: "Arc Mainnet could not be read right now. Try again shortly." });
    }
  });

  // Every wallet flow waits on its receipts through these reads of the server's own RPC, so a wallet app that never
  // reports a receipt cannot stall a payment. Each answers only for transactions the session wallet sent.
  app.get("/api/receipts/:chain/:hash", protectedIngress, receiptReadLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    const { chain } = request.params;
    if (chain === "solana") {
      const signature = String(request.params.hash ?? "");
      if (!SOLANA_SIGNATURE_PATTERN.test(signature)) return void response.status(400).json({ error: "Enter a transaction signature." });
      if (!dependencies.solana) return void response.status(503).json({ error: "This server does not read Solana right now." });
      // With the prepared lastValidBlockHeight, a transaction that can no longer land answers `expired`.
      const lastValidBlockHeight = typeof request.query.lastValidBlockHeight === "string" && /^\d{1,20}$/.test(request.query.lastValidBlockHeight) ? BigInt(request.query.lastValidBlockHeight) : undefined;
      try {
        const status = await dependencies.solana.transfers.status(signature);
        if (!status && lastValidBlockHeight !== undefined && await dependencies.solana.transfers.expired?.(signature, lastValidBlockHeight)) return void response.json({ receipt: null, expired: true });
        return void response.json({ receipt: status ? { status: status.status, blockNumber: `0x${status.slot.toString(16)}` } : null });
      } catch {
        return void response.status(503).json({ error: "The transaction could not be read right now. Try again shortly." });
      }
    }
    const hash = String(request.params.hash ?? "") as Hex;
    if (!TRANSACTION_HASH.test(hash)) return void response.status(400).json({ error: "Enter a transaction hash." });
    const read = chain === "arc"
      ? network.ready && dependencies.arcReceipts ? () => dependencies.arcReceipts!({ hash }) : undefined
      : chain === "robinhood-mainnet" || chain === "robinhood-testnet"
        ? dependencies.stockTransfers?.readReceipt ? () => dependencies.stockTransfers!.readReceipt!(chain, hash) : undefined
        : null;
    if (read === null) return void response.status(400).json({ error: "Unsupported network." });
    if (!read) return void response.status(503).json({ error: "This server does not read receipts on that network right now." });
    try {
      const receipt = await read();
      if (receipt && getAddress(receipt.from) !== getAddress(session.address)) {
        return void response.status(403).json({ error: "That transaction was not sent by your wallet." });
      }
      response.json({ receipt: receiptView(receipt) });
    } catch {
      response.status(503).json({ error: "The receipt could not be read right now. Try again shortly." });
    }
  });

  app.post("/api/payment/prepare", protectedIngress, paymentBatchLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (await refusePaused(response, "arc.payments")) return;
    let networkId;
    try {
      networkId = resolvePaymentNetwork(request.body?.networkPreference, arcTestnetPaymentReady, arcMainnetPaymentReady);
    } catch (error) {
      if (error instanceof PaymentNetworkSelectionError) return void response.status(error.status).json({ error: error.message });
      throw error;
    }
    if (!network.ready) return void response.status(503).json({ error: network.reason });
    try {
      const intent = paymentIntentSchema.parse(request.body);
      const note = checkPaymentNote(intent.note);
      if (!note.ok) throw new StockTransferRejectedError(note.error);
      const senderAccount = intent.sourcePlatform ? await identities.account(session.address, intent.sourcePlatform) : undefined;
      if (intent.sourcePlatform && !senderAccount) {
        const label = platformName(intent.sourcePlatform);
        throw new StockTransferRejectedError(`Link and verify your ${label} account before sending from it.`);
      }
      if (!isAddress(String(request.body?.expectedRecipientAddress ?? ""))) throw new StockTransferRejectedError("Review the payment again.");
      const expectedRecipient = getAddress(request.body.expectedRecipientAddress);
      const recipient = await identities.resolve(intent.recipient.platform, intent.recipient.username);
      if (!recipient) return void response.status(404).json({ error: "Recipient does not have a verified social identity." });
      if (recipient !== expectedRecipient) {
        return void response.status(409).json({ error: "Recipient identity changed after review. Review the payment again." });
      }
      const base = {
        networkId,
        chainId: network.chainId,
        chainIdHex: network.chainIdHex,
        rpcUrl: network.rpcUrl,
        explorerUrl: network.explorerUrl,
        senderIdentity: senderAccount ? { platform: senderAccount.platform, username: senderAccount.username } : undefined,
      };
      const fees = dependencies.arcFees;
      if (!fees) {
        // Mainnet never runs fee-free: without verified fee contracts behind its escrow, Arc Mainnet payments wait.
        if (network.environment === "mainnet") {
          return void response.status(503).json({ error: "Arc Mainnet payments start once the operator's vault escrow and fee contracts are verified." });
        }
        if (note.note) throw new StockTransferRejectedError("A note rides on the fee router's payment, which this network does not run here.");
        if (dependencies.arcUsdcBalance) {
          const units = parseUnits(intent.amount, 6);
          let balance: bigint;
          try {
            balance = await dependencies.arcUsdcBalance(getAddress(session.address));
          } catch {
            return void response.status(503).json({ error: `${network.chainName ?? "Arc"} is not reachable right now. Try again shortly.` });
          }
          // Gas comes out of the same USDC; a gas price that cannot be read reserves nothing rather than refusing.
          const gas = await dependencies.arcTransferGas?.().catch(() => 0n) ?? 0n;
          if (balance < units + gas) {
            return void response.status(400).json({ error: gas > 0n
              ? `Your wallet needs ${formatUnits(units + gas, 6)} USDC: the amount and about ${formatUnits(gas, 6)} USDC for gas, which Arc takes in USDC.`
              : `Your wallet needs ${formatUnits(units, 6)} USDC.` });
          }
        }
        const transaction = buildArcUsdcTransfer({ usdc: network.usdcAddress, recipient, amount: intent.amount });
        return void response.json({ ...base, transaction: { ...transaction, from: session.address } });
      }
      // Through the fee router: the recipient gets exactly the amount and the sender also pays the router's fee.
      if (recipient === getAddress(session.address)) throw new StockTransferRejectedError("That handle belongs to your own wallet. Pick someone else to pay.");
      const prepared = await priceArcPayments(session.address, [{ recipient, amount: intent.amount }], note.note, fees, network.usdcAddress);
      if (prepared.status !== undefined) return void response.status(prepared.status).json({ error: prepared.error });
      const [payment] = prepared.payments;
      response.json({
        ...base,
        ...(note.note ? { note: note.note } : {}),
        fee: payment.fee,
        paymentRef: payment.paymentRef,
        transactions: [...(prepared.approval ? [prepared.approval] : []), payment.transaction],
      });
    } catch (error) {
      sendArcError(response, error, "The payment could not be prepared. Review it again.");
    }
  });

  // Several people, USDC on Arc: everyone resolved again as in one payment, then one approval and one `pay` each.
  app.post("/api/payment/prepare-batch", protectedIngress, paymentBatchLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (await refusePaused(response, "arc.payments")) return;
    let networkId;
    try {
      networkId = resolvePaymentNetwork(request.body?.networkPreference, arcTestnetPaymentReady, arcMainnetPaymentReady);
    } catch (error) {
      if (error instanceof PaymentNetworkSelectionError) return void response.status(error.status).json({ error: error.message });
      throw error;
    }
    if (!network.ready) return void response.status(503).json({ error: network.reason });
    const parsed = paymentBatchSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "Invalid payments." });
    const input = parsed.data;
    const note = checkPaymentNote(input.note);
    if (!note.ok) return void response.status(400).json({ error: note.error });
    if (input.recipients.some(({ amount }) => !/^\d+(?:\.\d{1,6})?$/.test(amount) || !/[1-9]/.test(amount))) {
      return void response.status(400).json({ error: "Each amount must be greater than zero, with at most six decimals." });
    }
    const fees = dependencies.arcFees;
    if (!fees) return void response.status(503).json({ error: `Payments to several people run through the ${network.chainName ?? "Arc"} fee router, which this server does not run yet.` });
    try {
      const senderAccount = input.sourcePlatform ? await identities.account(session.address, input.sourcePlatform) : undefined;
      if (input.sourcePlatform && !senderAccount) {
        return void response.status(400).json({ error: `Link and verify your ${platformName(input.sourcePlatform)} account before sending from it.` });
      }
      const people = await resolveBatch(input.recipients);
      if ("status" in people) return void response.status(people.status).json({ error: people.error });
      const own = people.find(({ recipient }) => recipient === getAddress(session.address));
      if (own) return void response.status(400).json({ error: `@${own.username} on ${platformName(own.platform)} is your own wallet. Remove it and review again.` });
      const prepared = await priceArcPayments(session.address, people, note.note, fees, network.usdcAddress);
      if (prepared.status !== undefined) return void response.status(prepared.status).json({ error: prepared.error });
      response.json({
        networkId,
        chainId: network.chainId,
        chainIdHex: network.chainIdHex,
        rpcUrl: network.rpcUrl,
        explorerUrl: network.explorerUrl,
        senderIdentity: senderAccount ? { platform: senderAccount.platform, username: senderAccount.username } : undefined,
        ...(note.note ? { note: note.note } : {}),
        ...prepared,
        payments: prepared.payments.map((payment, index) => ({ ...payment, recipient: { platform: people[index].platform, username: people[index].username, address: payment.recipient.address } })),
      });
    } catch (error) {
      sendArcError(response, error, "The payments could not be prepared. Review them again.");
    }
  });

  /**
   * USDC payments through Arc's fee router from the session wallet: the router's fee for this sender on each, a
   * balance for all of them, at most one approval of the whole total (none when an earlier one already covers it),
   * and one `pay` per person with the note after its arguments.
   */
  async function priceArcPayments(sender: string, people: Array<{ recipient: Address; amount: string }>, note: string | undefined, fees: ArcFeeDesk, usdc: Address) {
    const wallet = getAddress(sender);
    const items = people.map(({ recipient, amount }) => ({ recipient, units: parseUnits(amount, 6) }));
    let bps: bigint;
    let balance: bigint;
    try {
      bps = (await fees.quote(wallet, items[0].units)).bps;
      balance = await fees.usdcBalance(wallet);
    } catch (error) {
      return { status: 503, error: error instanceof StockTransferUnavailableError ? error.message : `${network.chainName ?? "Arc"} is not reachable right now. Try again shortly.` };
    }
    const priced = items.map((item) => ({ ...item, quote: { fee: platformFee(item.units, bps), bps } }));
    const total = priced.reduce((sum, item) => sum + item.units + item.quote.fee, 0n);
    const router = fees.schedule.router;
    // An approval left from an attempt whose later signatures never came already covers these payments.
    const approved = await fees.approvalCovers?.(wallet, total) ?? false;
    // Gas comes out of the same USDC; a gas price that cannot be read reserves nothing rather than refusing.
    const gas = await fees.gasReserve?.({ approvals: approved ? 0 : 1, payments: items.length }).catch(() => 0n) ?? 0n;
    if (balance < total + gas) {
      const what = `the ${items.length > 1 ? "amounts" : "amount"} plus the ${platformFeePercent(Number(bps))} fee`;
      return { status: 400, error: gas > 0n
        ? `Your wallet needs ${formatUnits(total + gas, 6)} USDC: ${what} and about ${formatUnits(gas, 6)} USDC for gas, which Arc takes in USDC.`
        : `Your wallet needs ${formatUnits(total, 6)} USDC, ${what}.` };
    }
    return {
      feeBps: Number(bps),
      totalUnits: total.toString(),
      totalAmount: formatUnits(total, 6),
      ...(approved ? {} : { approval: { ...routedApproveCall({ token: usdc, router, units: total }), purpose: "approve" as const, from: wallet, value: "0x0" as const } }),
      payments: priced.map((item) => {
        const paymentRef = `0x${randomBytes(32).toString("hex")}` as const;
        return {
          recipient: { address: item.recipient },
          amount: formatUnits(item.units, 6),
          units: item.units.toString(),
          fee: preparedFee(fees.schedule, item.quote, item.units, 6),
          paymentRef,
          transaction: { ...routedPayCall({ token: usdc, router, recipient: item.recipient, units: item.units, paymentRef, note }), purpose: "pay" as const, from: wallet, value: "0x0" as const },
        };
      }),
    };
  }

  app.post("/api/claims/prepare", protectedIngress, stockClaimLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (await refusePaused(response, "arc.vault")) return;
    let networkId;
    try {
      networkId = resolvePaymentNetwork(request.body?.networkPreference, arcTestnetPaymentReady, arcMainnetPaymentReady);
    } catch (error) {
      if (error instanceof PaymentNetworkSelectionError) return void response.status(error.status).json({ error: error.message });
      throw error;
    }
    if (!network.ready) return void response.status(503).json({ error: network.reason });
    if (!dependencies.claims) return void response.status(503).json({ error: "Claimable payments are not configured." });
    try {
      const input = claimPreparationSchema.parse(request.body);
      const senderAccount = input.sourcePlatform ? await identities.account(session.address, input.sourcePlatform) : undefined;
      if (input.sourcePlatform && !senderAccount) {
        const label = platformName(input.sourcePlatform);
        throw new StockTransferRejectedError(`Link and verify your ${label} account before sending from it.`);
      }
      const prepared = await dependencies.claims.prepare({ ...input, payer: getAddress(session.address) });
      response.json({
        chainId: network.chainId,
        chainIdHex: network.chainIdHex,
        rpcUrl: network.rpcUrl,
        explorerUrl: network.explorerUrl,
        ...prepared,
        networkId,
        senderIdentity: senderAccount ? { platform: senderAccount.platform, username: senderAccount.username } : undefined,
        transactions: prepared.transactions.map((transaction) => ({ ...transaction, from: session.address })),
      });
    } catch (error) {
      sendArcError(response, error, "The vault link could not be prepared. Review it again.");
    }
  });

  // The vault links the session wallet can act on, on Arc and on Robinhood Chain mainnet: links sent to its verified
  // accounts or their names (so they appear as soon as an account is linked) and links it funded. Every link
  // is read back from its escrow; a network that cannot be read is named in `unavailable` and contributes nothing.
  app.get("/api/claims/pending", protectedIngress, pendingClaimsLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    let accounts: Awaited<ReturnType<typeof verifiedAccounts>>;
    try {
      accounts = await verifiedAccounts(session.address);
    } catch {
      return void response.status(503).json({ error: "Your accounts could not be read right now. Try again shortly." });
    }
    response.json(await pendingLinks(session.address, accounts));
  });

  /** The vault links a wallet can act on now, on every network; a network that cannot be read is named, never guessed. */
  async function pendingLinks(wallet: Address, accounts: VerifiedSocialAccount[]) {
    const links: PendingVaultLinks = { incoming: [], outgoing: [], unavailable: [] };
    const sources = [
      ...(dependencies.redemptions?.pending ? [{
        name: network.chainName ?? "Arc",
        read: () => dependencies.redemptions!.pending!({ wallet, accounts }),
      }] : []),
      ...(dependencies.stockClaims?.pending ? [{
        name: STOCK_CHAINS["robinhood-mainnet"].name,
        read: () => dependencies.stockClaims!.pending!({ network: "robinhood-mainnet", wallet, accounts }),
      }] : []),
      ...(dependencies.solana?.vault ? [{
        name: SOLANA_MAINNET.name,
        read: async () => dependencies.solana!.vault!.pending({ wallet, solanaAddress: await dependencies.solana!.addresses.solana(wallet), accounts }),
      }] : []),
    ];
    await Promise.all(sources.map(async (source) => {
      try {
        const { incoming, outgoing } = await source.read();
        links.incoming.push(...incoming);
        links.outgoing.push(...outgoing);
      } catch {
        links.unavailable.push(source.name);
      }
    }));
    return sortPendingVaultLinks(links);
  }

  app.get("/api/claims/:paymentId", protectedIngress, stockClaimReadLimit, async (request, response) => {
    if (!dependencies.redemptions) return void response.status(503).json({ error: "Claim redemption is not configured." });
    try {
      response.setHeader("Cache-Control", "no-store");
      const details = await dependencies.redemptions.details(String(request.params.paymentId));
      const metadata = await dependencies.claimFundings?.metadata(String(request.params.paymentId));
      response.json({
        ...details,
        ...(metadata ? { recipient: metadata.recipient, sourceIdentity: metadata.sourceIdentity } : {}),
      });
    } catch (error) {
      // The escrow no longer holds a link this server recorded: it was claimed, or refunded after its window. The
      // page says so from the record instead of "unavailable".
      const settled = error instanceof StockClaimNotFoundError && error.message === "Claimable payment is unavailable."
        ? await dependencies.claimFundings?.metadata(String(request.params.paymentId)).catch(() => undefined)
        : undefined;
      // A settled link names nobody: its page only says it was claimed or refunded, so a claimed link never shows the
      // recipient's handle beside the payer's wallet.
      if (settled) {
        return void response.json({
          paymentId: settled.paymentId,
          payer: settled.payer,
          amount: settled.amount,
          expiresAt: settled.expiresAt,
          status: "settled",
        });
      }
      sendArcError(response, error, "The vault link could not be read just now. Try again in a moment.");
    }
  });

  app.post("/api/claims/confirm-funding", protectedIngress, stockClaimLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.claimFundings) return void response.status(503).json({ error: "Claim funding verification is not configured." });
    try {
      const input = claimFundingConfirmationSchema.parse(request.body);
      // The link is already funded: a source account unlinked since then only drops its label, never the record.
      const sourceAccount = input.sourcePlatform ? await identities.account(session.address, input.sourcePlatform) : undefined;
      const record = await dependencies.claimFundings.confirm({
        ...input,
        payer: session.address,
        sourceIdentity: sourceAccount ? { platform: sourceAccount.platform, username: sourceAccount.username } : undefined,
      });
      response.status(201).json(record);
    } catch (error) {
      sendArcError(response, error, "The vault funding could not be verified just now. Verify it again in a moment.");
    }
  });

  app.post("/api/claims/:paymentId/prepare-claim", protectedIngress, stockClaimLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!network.ready) return void response.status(503).json({ error: network.reason });
    if (!dependencies.redemptions) return void response.status(503).json({ error: "Claim redemption is not configured." });
    try {
      const prepared = await dependencies.redemptions.prepareClaim(session.address, await verifiedAccounts(session.address), String(request.params.paymentId));
      response.json({ chainIdHex: network.chainIdHex, rpcUrl: network.rpcUrl, explorerUrl: network.explorerUrl, ...prepared });
    } catch (error) {
      sendArcError(response, error, "The claim could not be prepared just now. Try again in a moment.");
    }
  });

  app.post("/api/claims/:paymentId/prepare-refund", protectedIngress, stockClaimLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!network.ready) return void response.status(503).json({ error: network.reason });
    if (!dependencies.redemptions) return void response.status(503).json({ error: "Claim redemption is not configured." });
    try {
      const prepared = await dependencies.redemptions.prepareRefund(session.address, String(request.params.paymentId));
      response.json({ chainIdHex: network.chainIdHex, rpcUrl: network.rpcUrl, explorerUrl: network.explorerUrl, ...prepared });
    } catch (error) {
      sendArcError(response, error, "The refund could not be prepared just now. Try again in a moment.");
    }
  });

  app.post("/api/payments/confirm", protectedIngress, paymentConfirmLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.payments) return void response.status(503).json({ error: "Arc payment history is not configured." });
    try {
      const input = paymentConfirmationSchema.parse(request.body);
      const recipient = await identities.resolve(input.recipient.platform, input.recipient.username);
      if (!recipient) return void response.status(404).json({ error: "Recipient does not have a verified social identity." });
      // The payment already moved: a source account unlinked since then only drops its label, never the record.
      const senderAccount = input.sourcePlatform ? await identities.account(session.address, input.sourcePlatform) : undefined;
      const payment = await dependencies.payments.confirm({
        transactionHash: input.transactionHash,
        sender: session.address,
        recipient,
        platform: input.recipient.platform,
        username: input.recipient.username,
        amount: input.amount,
        sourcePlatform: senderAccount?.platform,
        sourceUsername: senderAccount?.username,
      });
      response.status(201).json(payment);
    } catch (error) {
      sendArcError(response, error, "The Arc receipt could not be verified just now. Verify it again in a moment.");
    }
  });

  app.get("/api/payments", async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.payments) return void response.status(503).json({ error: "Arc payment history is not configured." });
    response.setHeader("Cache-Control", "no-store");
    response.json({ payments: await dependencies.payments.list(session.address) });
  });

  // A failed start answers in JSON: a bad return path is the browser's to fix, anything else is a fixed 500.
  function sendOAuthStartError(response: express.Response, error: unknown) {
    if (error instanceof InvalidOAuthReturnPathError) return void response.status(400).json({ error: error.message });
    response.status(500).json({ error: "The provider connection could not be started. Try again." });
  }

  app.get("/api/oauth/github/start", protectedIngress, providerStartLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.github) return void response.status(503).json({ error: "GitHub OAuth keys are not configured." });
    try {
      const flow = await oauthFlows.create({ wallet: session.address, provider: "github", returnTo: typeof request.query.returnTo === "string" ? request.query.returnTo : undefined });
      response.json({ authorizationUrl: dependencies.github.authorizationUrl(flow.state) });
    } catch (error) {
      sendOAuthStartError(response, error);
    }
  });

  /**
   * A provider sign-in coming back: the account is linked to the wallet session that started it, or the desk is sent
   * back with the reason it was not (the session ended or belongs to another wallet, the person cancelled, the sign-in
   * expired or was used, the account is already linked to another wallet, the provider refused this site's own OAuth
   * settings or its read of the account, or the provider did not confirm it).
   */
  async function finishProviderLink(
    request: Request,
    response: express.Response,
    provider: "github" | "x" | "discord",
    verify: ((code: string, flow: { codeVerifier?: string }) => Promise<Omit<VerifiedSocialAccount, "verifiedAt">>) | undefined,
  ) {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    const { state, code, error } = request.query;
    if (!session) return void response.redirect(identityRedirect("/", "link_error", provider, "session"));
    let flow: Awaited<ReturnType<typeof oauthFlows.consume>>;
    try {
      if (!verify || typeof state !== "string") throw new Error("No sign-in state.");
      flow = await oauthFlows.consume({ state, wallet: session.address, provider });
    } catch (failure) {
      const otherWallet = failure instanceof Error && /different wallet/.test(failure.message);
      return void response.redirect(identityRedirect("/", "link_error", provider, typeof error === "string" ? "denied" : otherWallet ? "session" : "expired"));
    }
    if (typeof error === "string" || typeof code !== "string") return void response.redirect(identityRedirect(flow.returnTo, "link_error", provider, typeof error === "string" ? "denied" : "failed"));
    let account: Omit<VerifiedSocialAccount, "verifiedAt">;
    try {
      account = await verify(code, flow);
    } catch (failure) {
      const reason = failure instanceof ProviderSetupError ? "setup" : failure instanceof ProviderAccessError ? "access" : "failed";
      return void response.redirect(identityRedirect(flow.returnTo, "link_error", provider, reason));
    }
    try {
      await identities.link(session.address, { ...account, verifiedAt: new Date().toISOString() });
      response.redirect(identityRedirect(flow.returnTo, "linked", provider));
    } catch (failure) {
      const taken = failure instanceof IdentityConflictError;
      response.redirect(identityRedirect(flow.returnTo, "link_error", provider, taken ? "taken" : "failed"));
    }
  }

  app.get("/api/oauth/github/callback", (request, response) => finishProviderLink(request, response, "github",
    dependencies.github && ((code) => dependencies.github!.verifyCallback(code))));

  app.get("/api/oauth/x/start", protectedIngress, providerStartLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.x) return void response.status(503).json({ error: "X OAuth keys are not configured." });
    try {
      const flow = await oauthFlows.create({ wallet: session.address, provider: "x", returnTo: typeof request.query.returnTo === "string" ? request.query.returnTo : undefined });
      response.json({ authorizationUrl: dependencies.x.authorizationUrl(flow.state, flow.codeVerifier!) });
    } catch (error) {
      sendOAuthStartError(response, error);
    }
  });

  app.get("/api/oauth/x/callback", (request, response) => finishProviderLink(request, response, "x",
    dependencies.x && ((code, flow) => dependencies.x!.verifyCallback(code, flow.codeVerifier!))));

  app.post("/api/oauth/telegram/verify", protectedIngress, telegramVerifyLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.telegramBotToken) return void response.status(503).json({ error: "Telegram bot token is not configured." });
    try {
      const account = verifyTelegramLogin(request.body, dependencies.telegramBotToken);
      response.json(await identities.link(session.address, { ...account, verifiedAt: new Date().toISOString() }));
    } catch (error) {
      // Every signature fails when Telegram no longer accepts the site's bot token: that is a site setting, not the person.
      if (error instanceof TelegramSignatureError && await dependencies.telegramTokenCheck?.refused()) {
        return void response.status(503).json({ error: "Telegram refused HaPaPay's bot token, so nothing was linked.", reason: "setup" });
      }
      if (error instanceof TelegramSignatureError || error instanceof TelegramLoginError) return void response.status(401).json({ error: error.message });
      if (error instanceof IdentityConflictError) return void response.status(409).json({ error: error.message, reason: "taken" });
      // A store failure answers with a fixed message, never its own text (audit, 2026-10-06).
      response.status(503).json({ error: "The Telegram account could not be linked just now. Try again in a moment." });
    }
  });

  app.get("/api/oauth/discord/start", protectedIngress, providerStartLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.discord) return void response.status(503).json({ error: "Discord OAuth keys are not configured." });
    try {
      const flow = await oauthFlows.create({ wallet: session.address, provider: "discord", returnTo: typeof request.query.returnTo === "string" ? request.query.returnTo : undefined });
      response.json({ authorizationUrl: dependencies.discord.authorizationUrl(flow.state) });
    } catch (error) {
      sendOAuthStartError(response, error);
    }
  });

  app.get("/api/oauth/discord/callback", (request, response) => finishProviderLink(request, response, "discord",
    dependencies.discord && ((code) => dependencies.discord!.verifyCallback(code))));

  app.post("/api/oauth/farcaster/start", protectedIngress, providerStartLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.farcaster) return void response.status(503).json({ error: "Sign in with Farcaster is not configured." });
    try {
      response.json(await dependencies.farcaster.start(session.address));
    } catch (error) {
      response.status(502).json({ error: error instanceof FarcasterSignInError ? error.message : "Farcaster sign-in could not start right now. Try again in a moment." });
    }
  });

  app.post("/api/oauth/farcaster/complete", protectedIngress, farcasterPollLimit, async (request, response) => {
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    if (!session) return void response.status(401).json({ error: "Connect and sign with your wallet first." });
    if (!dependencies.farcaster) return void response.status(503).json({ error: "Sign in with Farcaster is not configured." });
    if (typeof request.body?.requestId !== "string") return void response.status(400).json({ error: "Farcaster request ID is required." });
    try {
      const result = await dependencies.farcaster.complete(session.address, request.body.requestId);
      if (result.state === "pending") return void response.status(202).json(result);
      const profile = await identities.link(session.address, { ...result.account, verifiedAt: new Date().toISOString() });
      response.json({ ...result, profile });
    } catch (error) {
      if (error instanceof FarcasterSignInError) return void response.status(error.status).json({ error: error.message });
      if (error instanceof IdentityConflictError) return void response.status(409).json({ error: error.message, reason: "taken" });
      response.status(503).json({ error: "The Farcaster account could not be linked just now. Try again in a moment." });
    }
  });

  app.post("/api/chat", protectedIngress, chatDraftLimit, async (request, response) => {
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    if (!message || message.length > 500) {
      response.status(400).json({ error: "Message must contain 1–500 characters." });
      return;
    }

    // Each request runs where its asset lives: USDC on this server's Arc network, Robinhood Chain tokens on mainnet.
    const stockNetwork = stockNetworkFor(request.body?.networkPreference);
    const answering = typeof request.body?.answering?.request === "string" && request.body.answering.request.length <= 500
      ? { request: request.body.answering.request as string }
      : undefined;
    const session = readRequestSession(request.headers.cookie, dependencies.auth);
    const solana = dependencies.solana;
    // Solana: its switches, whether its vault takes links, and the Solana addresses accounts added.
    const solanaDesk: SolanaChatDesk | undefined = solana ? {
      transfers: solana.config.transfers,
      stocks: solana.config.stocks,
      vault: solana.vault ? await solana.vault.availability().catch(() => ({ enabled: false })) : { enabled: false },
      addressOf: async (platform, username) => {
        const wallet = await identities.resolve(platform, username);
        return wallet ? solana.addresses.solana(wallet) : undefined;
      },
      senderAddress: session ? await solana.addresses.solana(session.address).catch(() => undefined) : undefined,
    } : undefined;
    // What the signed-in sender's own wallets hold, read on chain only to choose the network of a request that names
    // none. Nobody else's balance is read, and preparation checks the balance again.
    const holdings: SenderHoldings | undefined = session ? {
      solana: async (asset) => solanaDesk?.senderAddress && solana?.transfers.holding ? solana.transfers.holding(solanaDesk.senderAddress, asset) : undefined,
      evm: async (chain, symbol) => {
        if (chain === "arc") return symbol === "USDC" && dependencies.arcFees ? formatUnits(await dependencies.arcFees.usdcBalance(session.address), 6) : undefined;
        const token = ROBINHOOD_ASSET_ALLOWLISTS[stockNetwork].tokens.find((entry) => entry.symbol === symbol);
        return token && dependencies.stockTransfers?.holding ? dependencies.stockTransfers.holding(stockNetwork, token, session.address) : undefined;
      },
    } : undefined;
    // A handle the platform's official directory does not know is never offered a vault link.
    const directory = dependencies.recipientDirectory;
    const recipientExists = directory ? (platform: Platform, username: string) => directory.exists(platform, username) : undefined;
    const result = await createChatDraft(
      message,
      process.env.OPENROUTER_API_KEY ? parseWithOpenRouter : undefined,
      (platform, username) => identities.resolve(platform, username),
      network.ready ? network.chainName ?? "Arc" : network.chainName ?? "Arc — configuration pending",
      stockNetwork,
      stockTransferAvailability(stockNetwork),
      await stockClaimAvailability(stockNetwork),
      usdcClaimAvailability(),
      { answering, sender: session?.address, solana: solanaDesk, recipientExists, holdings },
    );
    response.json(result);
  });

  const routeLimit = ({ perMinute, message }: { perMinute: number; message: string }) =>
    rateLimit({ windowMs: 60_000, limit: perMinute, standardHeaders: "draft-8", legacyHeaders: false, message: { error: message }, ...vercelKey });
  const session = (request: Request) => readRequestSession(request.headers.cookie, dependencies.auth);
  registerSolanaRoutes(app, {
    solana: dependencies.solana,
    identities,
    session,
    freshSession: (current) => current.issuedAt !== undefined && dependencies.auth.isFresh({ ...current, expiresAt: 0, issuedAt: current.issuedAt }),
    protectedIngress,
    limit: routeLimit,
    verifiedAccounts,
    paused: async (feature) => dependencies.admin?.controls.paused(feature),
  });
  registerSpRoutes(app, {
    sp: dependencies.sp, session, protectedIngress, limit: routeLimit,
    solanaAddress: dependencies.solana ? (wallet) => dependencies.solana!.addresses.solana(wallet) : undefined,
  });
  registerAdminRoutes(app, {
    admin: dependencies.admin,
    sp: dependencies.sp,
    identities,
    session,
    protectedIngress,
    limit: routeLimit,
    solanaAddress: dependencies.solana ? (wallet) => dependencies.solana!.addresses.solana(wallet) : undefined,
    walletForSolana: dependencies.solana ? (address) => dependencies.solana!.addresses.walletForSolana(address) : undefined,
    accountPayments: async (wallet) => {
      const [arc, robinhood, solana] = await Promise.all([
        dependencies.payments ? dependencies.payments.list(wallet).catch(() => null) : null,
        dependencies.stockTransfers ? dependencies.stockTransfers.list(wallet).catch(() => null) : null,
        dependencies.solana ? dependencies.solana.transfers.list(wallet).catch(() => null) : null,
      ]);
      return { arc: arc ?? [], robinhood: robinhood ?? [], solana: solana ?? [] };
    },
    pendingLinks: async (wallet) => pendingLinks(wallet, await verifiedAccounts(wallet)),
  });

  app.get("/api/health", async (_request, response) => {
    const stockNetworks = ["robinhood-testnet", "robinhood-mainnet"] as const;
    const stockClaims = await Promise.all(stockNetworks.map(async (stockNetwork) =>
      [stockNetwork, (await stockClaimAvailability(stockNetwork)).enabled ? "escrow_verified" : "disabled"] as const));
    response.json({
      status: "ok",
      network: network.environment ?? "unselected",
      networkStatus: network.ready ? "configured" : "pending_configuration",
      chainId: network.ready ? network.chainId : undefined,
      identityStore: dependencies.identityStoreKind ?? (dependencies.identities ? "custom" : "memory"),
      paymentHistory: dependencies.payments ? "receipt_verified" : network.ready ? "pending_service_configuration" : "pending_network_configuration",
      claimablePayments: dependencies.claims ? "configured" : "pending_escrow_configuration",
      claimRedemption: dependencies.redemptions ? "oauth_attested" : "pending_attestor_configuration",
      claimFundingHistory: dependencies.claimFundings ? "receipt_verified" : "pending_escrow_configuration",
      stockTransfers: Object.fromEntries(stockNetworks.map((stockNetwork) =>
        [stockNetwork, stockTransferAvailability(stockNetwork).enabled ? "receipt_verified" : "disabled"])),
      tokenTransfers: Object.fromEntries(stockNetworks.map((stockNetwork) =>
        [stockNetwork, stockTransferAvailability(stockNetwork).tokens?.enabled ? "receipt_verified" : "disabled"])),
      stockClaims: Object.fromEntries(stockClaims),
      solana: dependencies.solana
        ? { transfers: dependencies.solana.config.transfers.enabled ? "receipt_verified" : "disabled", stocks: dependencies.solana.config.stocks.enabled ? "receipt_verified" : "disabled" }
        : { transfers: "pending_configuration", stocks: "pending_configuration" },
      rpc: {
        solana: dependencies.rpcProviders?.solana ? "provider" : "public",
        solanaBrowser: dependencies.rpcProviders?.solanaBrowser ? "provider" : "public_refuses_browsers",
        arc: dependencies.rpcProviders?.arc ? "provider" : "public",
        robinhood: dependencies.rpcProviders?.robinhood ? "provider" : "public",
      },
      // "refused_by_x": X answered 401, 402 or 403 to a lookup in the last ten minutes, so X vault links are paused.
      recipientLookup: {
        github: await dependencies.recipientDirectory?.refused?.("github").catch(() => false) ? "refused_by_github" : dependencies.recipientLookups?.githubToken ? "token" : "public_rate_limited",
        x: !dependencies.recipientLookups?.xBearerToken ? "missing_bearer_token" : await dependencies.recipientDirectory?.refused?.("x").catch(() => false) ? "refused_by_x" : "configured",
        farcaster: "fname_registry",
      },
      // SP keeps its ledger in the database whenever the site does; admin says whether an admin wallet is set.
      sp: dependencies.sp ? "ledger" : "off",
      admin: dependencies.admin?.auth.configured ? "configured" : "no_admin_wallet",
    });
  });

  if (dependencies.webRoot) {
    app.use(express.static(dependencies.webRoot, { index: false }));
    app.get("/{*path}", (request, response, next) => {
      if (request.path.startsWith("/api/")) return void next();
      response.sendFile("index.html", { root: dependencies.webRoot });
    });
  }

  return app;
}

function readRequestSession(cookie: string | undefined, auth: WalletAuthService) {
  const token = cookieValue(cookie, "hapapay_session");
  return token ? auth.readSession(token) : undefined;
}
