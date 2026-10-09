import { Component, FormEvent, lazy, Suspense, useEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { receiptSource, waitForTransactionReceipt } from "./domain/transaction-receipt";
import { forgetUnrecordedFunding, rememberUnrecordedFunding, retryUnrecordedFundings } from "./domain/unrecorded-fundings";
import { walletRpcTransaction } from "./domain/arc-transaction";
import { arcWalletChain, type ArcNetworkId } from "./domain/arc-chains";
import { isArcNetworkId, matchesArcBatch, matchesArcClaimAction, matchesArcClaimFunding, matchesArcPayment } from "./domain/arc-review";
import { checkPaymentNote } from "./domain/payment-note";
import { BatchSlip, type BatchRow, type BatchRowState } from "./components/BatchSlip";
import { CopyButton } from "./components/CopyButton";
import { NoteField } from "./components/NoteField";
import { paymentNetworkCatalog, type PaymentNetworkCatalogEntry } from "./domain/payment-network";
import QRCode from "qrcode";
import { PaymentActivity } from "./components/PaymentActivity";
import type { PaymentHistoryItem } from "./domain/payment-activity";
import { createWalletSessionController, type WalletSessionSnapshot } from "./domain/wallet-session-controller";
import { BrandMark } from "./components/BrandMark";
import { EmptyMark, PendingMark, VerifiedMark } from "./components/StatusMarks";
import { DotBurst } from "./components/DotBurst";
import { DotMorph } from "./components/DotMorph";
import { HomePage, type HomeStatus } from "./components/HomePage";
import { DecodeText } from "./components/DecodeText";
import { DotText } from "./components/DotText";
import { DotArrow, DotIcon } from "./components/DotIcon";
import { ProviderIcon } from "./components/ProviderIcon";
import { PaymentConversation, SlipStatus } from "./components/PaymentConversation";
import { StockTile, StockTokenList, formatUsd } from "./components/StockTokenList";
import { PendingClaims, type PendingClaimAction } from "./components/PendingClaims";
import { emptyPaymentConversation, paymentConversationReducer } from "./domain/payment-conversation";
import { platformName, type Platform } from "./domain/payment-intent";
import { ROBINHOOD_ASSET_ALLOWLISTS } from "./domain/robinhood-assets";
import { STOCK_CHAINS, isStockToken, matchesStockBatch, matchesStockReview, shareEquivalent, stockTokenCatalog, stockTokenExplorerUrl, stockTokenValue, transferAvailabilityFor, type PreparedStockBatch, type PreparedStockTransfer, type StockNetworkId, type StockTokenKind, type StockTokenQuote, type StockTokenSnapshot, type StockTransferIntent } from "./domain/stock-tokens";
import { STOCK_CLAIM_WINDOW_CHOICES, STOCK_CLAIM_WINDOW_HOURS, STOCK_ESCROW_OPERATOR_PATH, isStockClaimPlatform, matchesStockClaimAction, matchesStockClaimFunding, parseStockClaimPath, type PreparedStockClaimAction, type PreparedStockClaimFunding, type StockClaimDetails, type StockClaimPlatform, settledLink } from "./domain/stock-claims";
import type { VaultLock } from "./domain/vault-lock";
import type { PendingVaultLink, PendingVaultLinks, SolanaPendingVaultLink } from "./domain/pending-claims";
import { SOLANA_MAINNET, parseSolanaClaimPath } from "./domain/solana-chains";
import { SOLANA_XSTOCK_COUNT } from "./domain/solana-stock-count";
import { pageSolanaRpcUrl, setPageSolanaRpc } from "./solana-rpc";
import type { SolanaReview } from "./components/SolanaPaymentSlip";
import type { SolanaVaultReview } from "./components/SolanaVaultSlip";
import type { SolanaWalletHandle } from "./wallet/solana-wallet";
import { platformFee, platformFeePercent, type FeeSchedule } from "./domain/fees";
import { formatUnits, parseUnits } from "viem";
import { evmProvider, onPrivyChange, privyControls, setActiveEvmProvider, whenPrivyReady } from "./wallet/wallet-bridge";
import { SpPanel, type SpSummary } from "./components/SpPanel";
import { SpMark } from "./components/SpMark";
import { formatSp, type SpEntry, type SpRules } from "./domain/sp";
import { SP_EVENT, reportSpClaim, retrySpClaimReports } from "./sp-desk";
import { joinWithPendingInvite, readReferral, type ReferralSummary } from "./referral-desk";
import { DESK_FEATURES, isDeskFeature, type DeskControlsView, type DeskFeature, type DeskPause } from "./domain/desk-controls";

// The operator console carries the escrow's creation code, so it loads only on its own page.
const StockEscrowOperator = lazy(() => import("./components/StockEscrowOperator"));
// The documentation is long reading, so it loads only on /docs.
const DocsPage = lazy(() => import("./components/DocsPage"));
// Solana's slips, claim page and board carry the Solana libraries, so they load when the desk first needs them.
const SolanaPaymentSlip = lazy(() => import("./components/SolanaPaymentSlip"));
const SolanaVaultSlip = lazy(() => import("./components/SolanaVaultSlip"));
const SolanaClaimSlip = lazy(() => import("./components/SolanaClaimSlip"));
const SolanaStockBoard = lazy(() => import("./components/SolanaStockBoard"));
const SolanaOperator = lazy(() => import("./components/SolanaOperator"));
// One sign-in for every network (Privy). A desk page starts fetching its chunk as it opens, alongside
// /api/providers, and mounts it once the server names a Privy app; the lazy component reuses that download.
const loadPrivyBridge = () => import("./wallet/PrivyBridge");
const PrivyBridge = lazy(loadPrivyBridge);
// The admin panel loads only on its own page.
const AdminPage = lazy(() => import("./components/AdminPage"));
const ADMIN_PATH = /^\/admin\/?$/;
/** What a claim page says first. A link that turns out to be settled clears it: there is nothing left to verify for. */
const ARC_CLAIM_REPLY = "Verify your wallet and connect the official social account named in the payment. A claim is never prepared without an identity match.";
const VAULT_CLAIM_REPLY = "Verify your wallet and connect the account this claim link waits for (GitHub, X, Farcaster, Discord or Telegram) through its official sign-in. A claim is never signed without that match.";
/** The lock a chat review names: a link waits for the recipient's name only when the review says so. */
const vaultLockOf = (value: unknown): VaultLock => value === "name" ? "name" : "account";
const quietClaimReply = (current: string) => current === ARC_CLAIM_REPLY || current === VAULT_CLAIM_REPLY ? "" : current;
const DOCS_PATH = /^\/docs(?:\/[a-z0-9-]+)?\/?$/;
/** The payment desk. "/" is the home page; identity sign-ins started on the desk return to "/" and reopen the desk here. */
const DESK_PATH = "/app";
/** How long a Connect pressed before the sign-in has loaded waits for it before saying it did not load. */
const PRIVY_READY_TIMEOUT_MS = 30_000;
/** How long Privy is waited for when a browser wallet is here to sign in instead. */
const PRIVY_FALLBACK_MS = 10_000;
/** The desk's dot grid and the lens that lights it around the pointer, in pixels. */
const DESK_DOT = 18;
const DESK_LENS = 280;

/** A lazy page whose chunk fails to load (a dropped request, or a release replaced it) shows a retry, not a blank app. */
class ChunkBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type Draft = {
  status: "ready_for_review";
  message: string;
  intent: { kind: "send"; amount: string; token: "USDC"; recipient: { platform: string; username: string }; sourcePlatform?: string; status: "draft" };
  resolvedAddress: string;
  network: string;
  parser: string;
  /** The Arc network this server ran when the draft was reviewed; the prepared payment must name the same one. */
  arcNetwork?: ArcNetworkId;
  /** The note the payment carries on chain; the sender can change or clear it until the wallet opens. */
  note?: string;
};
/** A reviewed USDC vault link on Arc for someone who has not joined yet. */
/** A reviewed Arc vault link; `lock` says whether it waits for the recipient's account or for their name. */
type ClaimDraft = { intent: Draft["intent"]; arcNetwork?: ArcNetworkId; expiryHours: number; lock: VaultLock };
/** A reviewed stock-token transfer. The wallet opens only for a server-prepared transaction that matches it exactly. */
type StockDraft = { intent: StockTransferIntent; network: StockNetworkId; resolvedAddress: string; units: string; note?: string };
/**
 * A reviewed request for several people, one asset and one note: USDC on the Arc network this server ran at review
 * time, or a listed token on the Robinhood network the review names. The wallet opens only for a prepared batch that
 * matches it exactly, and only for the payments not sent yet.
 */
type BatchDraft = {
  rows: BatchRow[];
  asset: { type: "usdc"; symbol: "USDC"; decimals: 6 } | StockTransferIntent["asset"];
  arcNetwork?: ArcNetworkId;
  stockNetwork?: StockNetworkId;
  mode: "each" | "split" | "listed";
  amount: string;
  totalAmount: string;
  totalUnits: string;
  sourcePlatform?: string;
  note: string;
};
type StockTransaction = { hash: string; network: StockNetworkId; status: "pending" | "confirmed" | "verification_failed" };
/**
 * A reviewed vault link for someone who has not joined yet, waiting for their account or their name (`lock`). The
 * wallet opens only for its exact approve and fund.
 */
type StockClaimDraft = { intent: StockTransferIntent; platform: StockClaimPlatform; network: StockNetworkId; units: string; escrow: `0x${string}`; expiryHours: number; lock: VaultLock };
type StockClaimFunding = { paymentId: `0x${string}`; escrow: `0x${string}`; hash?: string; status: "approving" | "funding" | "pending" | "confirmed" | "verification_failed"; link?: string };
type StockClaimAction = { hash: string; action: "claim" | "refund"; status: "pending" | "confirmed" | "failed" };

type LinkedAccount = { platform: string; username: string; verified: true };
type Provider = { id: string; name: string; configured: boolean; method: string; botUsername?: string; botId?: string };
type NetworkState = { ready: boolean; environment?: "testnet" | "mainnet"; chainName?: string; reason?: string; chainId?: number; chainIdHex?: `0x${string}`; rpcUrl?: string; explorerUrl?: string; faucetUrl?: string; claimablePaymentsReady?: boolean; claimRedemptionReady?: boolean; fees?: FeeSchedule | null; paymentNetworks?: PaymentNetworkCatalogEntry[] };
type PayTarget = { platform: string; username: string };
/** What `/api/solana`, `/api/solana/vault` and `/api/solana/assets` say about Solana on this server. */
type SolanaState = {
  ready: boolean;
  treasury?: string | null;
  transfers?: { enabled: boolean; reason?: string };
  stocks?: { enabled: boolean; reason?: string };
  vault?: { enabled: boolean; reason?: string; programId?: string };
  quotes: Record<string, number>;
  pricesAsOf?: string;
};
type FarcasterRequest = { requestId: string; url: string; expiresAt: string; qrCode: string };
type ClaimDetails = { paymentId: string; payer: string; amount: string; expiresAt: string; status: "claimable" | "expired" | "settled"; lock?: VaultLock; recipient?: { platform: string; username: string }; sourceIdentity?: { platform: string; username: string } };

/** The pauses and the notice from `/api/providers`, kept only in the shape the desk shows (plain text, known features). */
function readDeskControls(value: unknown): DeskControlsView {
  const controls: DeskControlsView = { paused: {}, notice: null };
  if (!value || typeof value !== "object") return controls;
  const { paused, notice } = value as { paused?: unknown; notice?: unknown };
  if (paused && typeof paused === "object") {
    for (const [feature, pause] of Object.entries(paused)) {
      if (isDeskFeature(feature) && pause && typeof (pause as DeskPause).message === "string") controls.paused[feature] = { message: (pause as DeskPause).message, since: String((pause as DeskPause).since ?? "") };
    }
  }
  if (notice && typeof notice === "object" && typeof (notice as { text?: unknown }).text === "string") {
    const { text, tone, since } = notice as { text: string; tone?: unknown; since?: unknown };
    controls.notice = { text, tone: tone === "warning" ? "warning" : "info", since: String(since ?? "") };
  }
  return controls;
}

async function readSessionResource<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error("Your session data could not be loaded. Try again.");
  return response.json() as Promise<T>;
}

/** One receipt history. A 503 means this server does not run that history, so it contributes no receipts. */
async function readReceiptHistory(path: string, key: "payments" | "transfers"): Promise<PaymentHistoryItem[]> {
  const response = await fetch(path, { cache: "no-store" });
  if (response.status === 503) {
    await response.body?.cancel();
    return [];
  }
  if (!response.ok) throw new Error("Your session data could not be loaded. Try again.");
  return ((await response.json()) as Partial<Record<typeof key, PaymentHistoryItem[]>>)[key] ?? [];
}

const ETHER = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

const identities = [
  { id: "github", name: "GitHub", tone: "ink" },
  { id: "x", name: "X", tone: "blue" },
  { id: "telegram", name: "Telegram", tone: "sky" },
  { id: "discord", name: "Discord", tone: "indigo" },
  { id: "farcaster", name: "Farcaster", tone: "violet" },
];

/** Where the visitor landed, read before the desk tidies the address bar; a move to the site's own origin keeps all of it. */
const landingPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;

/** What a provider sign-in that came back without linking means, and what to do next (the server's `reason`). */
function linkFailureMessage(provider: string, reason: string | null) {
  const name = identities.find((identity) => identity.id === provider)?.name ?? "The provider";
  switch (reason) {
    case "session": return `Your wallet session ended before ${name} answered, so nothing was linked. Verify your wallet and connect ${name} again.`;
    case "denied": return `${name} sign-in was cancelled. Nothing was linked.`;
    case "expired": return `That ${name} sign-in expired or was already used. Connect ${name} again.`;
    case "taken": return `This ${name} account is already linked to another wallet. Verify that wallet and remove ${name} there, then connect it here.`;
    case "setup": return `${name} refused HaPaPay's sign-in settings, so nothing was linked. This is a site setting, not your account: the operator needs to check ${provider === "telegram" ? "the Telegram bot token" : `the ${name} app's client secret and callback URL`}.`;
    case "access": return `${name} signed you in but would not tell HaPaPay which account it is, so nothing was linked. This is the site's ${name} developer access, not your account: the operator needs to restore it. Try again later.`;
    default: return `${name} did not confirm the account, so nothing was linked. Try again in a moment.`;
  }
}

/** What the account's own Solana address holds, as `GET /api/solana/holdings` reads it. */
type SolanaHoldingsRead = { address: string | null; sol: string; tokens: Array<{ symbol: string; amount: string }> };
type SolanaHoldingsView = { status: "loading" } | { status: "error" } | ({ status: "ready" } & SolanaHoldingsRead);

const holdsNothing = (held: Pick<SolanaHoldingsRead, "sol" | "tokens">) => held.tokens.length === 0 && Number(held.sol) === 0;

/** "Holds 0.01 GOOGLx · 0.0016 SOL", amounts cut to six decimals, or that it holds nothing yet. */
function holdingsText(held: Pick<SolanaHoldingsRead, "sol" | "tokens">) {
  const short = (amount: string) => {
    const [whole, fraction = ""] = amount.split(".");
    const cut = fraction.slice(0, 6).replace(/0+$/, "");
    if (!cut && whole === "0" && Number(amount) > 0) return "under 0.000001";
    return cut ? `${whole}.${cut}` : whole;
  };
  const parts = [...held.tokens.map(({ symbol, amount }) => `${short(amount)} ${symbol}`), ...(Number(held.sol) > 0 ? [`${short(held.sol)} SOL`] : [])];
  return parts.length ? `Holds ${parts.join(" · ")}` : "Holds no SOL or listed tokens yet";
}

/** The account's own Solana address and what it holds; undefined when it cannot be read. */
async function readSolanaHoldings(): Promise<SolanaHoldingsRead | undefined> {
  try {
    const response = await fetch("/api/solana/holdings", { cache: "no-store" });
    const result = await response.json().catch(() => ({})) as Partial<SolanaHoldingsRead>;
    if (!response.ok || typeof result.sol !== "string" || !Array.isArray(result.tokens)) return undefined;
    return { address: result.address ?? null, sol: result.sol, tokens: result.tokens };
  } catch {
    return undefined;
  }
}

/** Examples of every kind of request; each runs on its asset's own network. */
const suggestions = ["Send 2 TSLA to @toly on X", "Send 10 USDG to @octocat on GitHub", "Send 25 USDC to @carol on Telegram"];
/** The Robinhood network the desk runs. A claim page opens on its link's own network. */
const DESK_STOCK_NETWORK: StockNetworkId = "robinhood-mainnet";
/** How many seconds a flow waits for a receipt before it says the transaction is still pending. */
/**
 * A linked account's handle as the desk shows it. "#" and an ID stand for a handle that a newer sign-in proved now
 * belongs to someone else: the account stays linked by its ID and takes its new handle at its next sign-in.
 */
function handleLabel(username: string) {
  return username.startsWith("#") ? "Renamed: connect again to update" : `@${username}`;
}

const RECEIPT_ATTEMPTS = 90;
const ARC_FUNDING_REVERTED = "The vault funding reverted; your USDC stayed in your wallet.";
const ARC_PAYMENT_REVERTED = "The Arc payment reverted; no USDC moved.";

/** The record request for a funded Arc vault link, the same from the slip and from a later sign-in. */
function arcClaimConfirmation(review: ClaimDraft, funding: { paymentId: string; hash: string }) {
  return {
    transactionHash: funding.hash,
    paymentId: funding.paymentId,
    platform: review.intent.recipient.platform,
    username: review.intent.recipient.username,
    amount: review.intent.amount,
    lock: review.lock,
    ...(review.intent.sourcePlatform ? { sourcePlatform: review.intent.sourcePlatform } : {}),
  };
}

/** The record request for a funded Robinhood Chain vault link, the same from the slip and from a later sign-in. */
function stockClaimConfirmation(review: StockClaimDraft, funding: { paymentId: `0x${string}`; escrow: `0x${string}`; hash: string }) {
  return {
    network: review.network,
    token: { symbol: review.intent.asset.symbol, address: review.intent.asset.address },
    amount: review.intent.amount,
    recipient: review.intent.recipient,
    lock: review.lock,
    ...(review.intent.sourcePlatform ? { sourcePlatform: review.intent.sourcePlatform } : {}),
    escrow: funding.escrow,
    paymentId: funding.paymentId,
    transactionHash: funding.hash,
  };
}
const allowlisted: Record<StockNetworkId, Set<string>> = {
  "robinhood-mainnet": new Set(ROBINHOOD_ASSET_ALLOWLISTS["robinhood-mainnet"].tokens.map((token) => `${token.symbol}:${token.address}`)),
  "robinhood-testnet": new Set(ROBINHOOD_ASSET_ALLOWLISTS["robinhood-testnet"].tokens.map((token) => `${token.symbol}:${token.address}`)),
};
const initialStockSnapshot = (network: StockNetworkId) => stockTokenCatalog(network, ROBINHOOD_ASSET_ALLOWLISTS[network].tokens, ROBINHOOD_ASSET_ALLOWLISTS[network].verifiedOn);
const SIDE_TAB_LABELS = { stocks: "Stocks", activity: "Activity", claims: "Claims", sp: "SP", identities: "Identities" } as const;
type SideTab = keyof typeof SIDE_TAB_LABELS;
const THEME_KEY = "hapapay-theme";
const MOTION_KEY = "hapapay-motion";
type ColorTheme = "dark" | "light";

/** How a slip names a Robinhood Chain token: Stock Tokens by kind, other tokens such as USDG by their ticker. */
function assetNoun(asset: { kind: StockTokenKind; symbol: string }, testAssets: boolean) {
  if (isStockToken(asset)) return testAssets ? "Test stock-token" : "Stock-token";
  return asset.symbol;
}

/** "72 hours" or "7 days" for a vault window. */
/**
 * The fee rows of a slip: the fee on top of the amount and the total the wallet pays, so the review shows the
 * requested amount, what the recipient receives, the fee and the total debit before anything is signed. The rate
 * shown is the full 1%; a lower rate the fee router may give later comes back from the server before the wallet opens.
 */
function FeeFacts({ fees, units, decimals, symbol, recipient, amount, when }: { fees: FeeSchedule; units: string; decimals: number; symbol: string; recipient: string; amount: string; when: "now" | "claim" }) {
  const fee = platformFee(BigInt(units));
  return <>
    <div><dt>Fee</dt><dd>{formatUnits(fee, decimals)} {symbol} · {platformFeePercent(fees.feeBps)}<small>{when === "claim" ? `Paid only when @${recipient} claims it and returned with a refund. ` : ""}{fees.sink === "forwarder" ? "Goes to HaPaPay" : "Half goes to the burn vault, half to HaPaPay"}</small></dd></div>
    <div><dt>Total</dt><dd>{formatUnits(BigInt(units) + fee, decimals)} {symbol}<small>From your wallet · @{recipient} receives exactly {amount}</small></dd></div>
  </>;
}

/** What a slip says about a link waiting for a name (`vault-lock.ts`): who claims it, and to check the spelling. */
function NameLockNote({ platform, username, window }: { platform: string; username: string; window: string }) {
  const name = platformName(platform as Platform);
  return <><b>Locked to the {name} name @{username}.</b> Whoever connects {name} to HaPaPay with that name claims it{platform === "telegram" ? "" : ", with an account older than this link"}. Check the spelling; if nobody claims it within {window}, you take it back.</>;
}

/**
 * What a claim page says about a link that waits for a name: who claims it, that the name counts once the platform
 * confirms it after the link was made (so connect again if it is already connected), and the age rule.
 */
function NameClaimNote({ platform, username, tail = "" }: { platform: string; username: string; tail?: string }) {
  const name = platformName(platform as Platform);
  return <><b>Waiting for the {name} name @{username}.</b> Connect {name} to HaPaPay with the account that has that name now, again if it is already connected; the server signs a one-time claim only for it{platform === "telegram" ? "" : ", only when the account is older than the link"}{tail}.</>;
}

function windowLabel(hours: number) {
  return hours % 24 === 0 && hours > 72 ? `${hours / 24} days` : `${hours} hours`;
}

/** Ambient animation plays unless the viewer paused it in this browser. */
function readAmbientMotion() {
  try {
    return window.localStorage.getItem(MOTION_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Dark is the default; light is a per-viewer choice kept in this browser. */
function readColorTheme(): ColorTheme {
  try {
    return window.localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog for keyboards: focus moves into it when it opens, Tab and Shift+Tab stay inside it, Escape closes
 * it, and focus returns where it was (audit, 2026-10-06: Tab reached only the page behind the dialog and Escape did
 * nothing). A window drawn outside the page's root, such as Privy's, keeps its own keys.
 */
function useModalKeyboard(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const root = document.getElementById("root");
    const outsidePage = (element: Element | null) => Boolean(element && element !== document.body && root && !root.contains(element));
    const items = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
    dialog.focus();
    const onKey = (event: KeyboardEvent) => {
      if (outsidePage(document.activeElement)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = items();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const inside = dialog.contains(document.activeElement);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (!inside || document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, ref]);
}

export function App() {
  const [payTarget] = useState<PayTarget | undefined>(() => {
    const match = window.location.pathname.match(/^\/pay\/(github|x|telegram|discord|farcaster)\/([^/]+)$/);
    if (!match) return undefined;
    // A link whose handle is not valid percent-encoding is no pay link (audit, 2026-10-06: it blanked the whole page).
    try {
      return { platform: match[1], username: decodeURIComponent(match[2]).replace(/^@/, "") };
    } catch {
      return undefined;
    }
  });
  const [claimTarget] = useState<string | undefined>(() => window.location.pathname.match(/^\/claim\/(0x[0-9a-fA-F]{64})$/)?.[1]);
  const [stockClaimTarget] = useState(() => parseStockClaimPath(window.location.pathname));
  const [solanaClaimTarget] = useState(() => parseSolanaClaimPath(window.location.pathname));
  const [operatorPage] = useState(() => window.location.pathname === STOCK_ESCROW_OPERATOR_PATH);
  const [docsPage] = useState(() => DOCS_PATH.test(window.location.pathname));
  const [adminPage] = useState(() => ADMIN_PATH.test(window.location.pathname));
  /** A path no page answers (a mistyped or old link): it says so instead of showing the home page. */
  const [notFoundPage] = useState(() => !(/^\/(?:index\.html)?$/.test(window.location.pathname) || /^\/app\/?$/.test(window.location.pathname)
    || docsPage || adminPage || payTarget || claimTarget || stockClaimTarget || solanaClaimTarget || operatorPage));
  const [homePage] = useState(() => {
    const { pathname, search } = window.location;
    if (notFoundPage || docsPage || adminPage || payTarget || claimTarget || stockClaimTarget || solanaClaimTarget || operatorPage || /^\/app\/?$/.test(pathname)) return false;
    const params = new URLSearchParams(search);
    return !params.has("linked") && !params.has("link_error");
  });
  const [colorTheme, setColorTheme] = useState<ColorTheme>(readColorTheme);
  const [ambientMotion, setAmbientMotion] = useState(readAmbientMotion);
  const [sideTab, setSideTab] = useState<SideTab>("stocks");
  const [statusNote, setStatusNote] = useState<"solana" | "stocks" | "tokens" | "arc">();
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [claimDraft, setClaimDraft] = useState<ClaimDraft | null>(null);
  const [stockDraft, setStockDraft] = useState<StockDraft | null>(null);
  const [batchDraft, setBatchDraft] = useState<BatchDraft | null>(null);
  const [batchStates, setBatchStates] = useState<BatchRowState[]>([]);
  /** A Solana review from the chat; `id` gives each new review its own slip. */
  const [solanaDraft, setSolanaDraft] = useState<{ id: number; review: SolanaReview } | null>(null);
  const [solanaClaimDraft, setSolanaClaimDraft] = useState<{ id: number; review: SolanaVaultReview } | null>(null);
  const [solana, setSolana] = useState<SolanaState>({ ready: false, quotes: {} });
  const [privyAppId, setPrivyAppId] = useState<string>();
  const [solanaRpcUrl, setSolanaRpcUrl] = useState<string>();
  const [privyChanges, setPrivyChanges] = useState(0);
  /** Connect was pressed before the sign-in finished loading; it opens once it is ready. */
  const [privyOpening, setPrivyOpening] = useState(false);
  /** Privy's layer is loaded on the docs page only once someone presses Connect there. */
  const [privyWanted, setPrivyWanted] = useState(false);
  const privyOpeningRef = useRef(false);
  /** The Privy app id once /api/providers answers (undefined without one), for a Connect pressed before it does. */
  const privyAppIdRequest = useRef<Promise<string | undefined>>();
  const [boardNetwork, setBoardNetwork] = useState<"solana" | "robinhood">("robinhood");
  /** The request the last reply asked a question about, so a short typed answer finishes it. */
  const [pendingQuestion, setPendingQuestion] = useState<string>();
  const [stockTransaction, setStockTransaction] = useState<StockTransaction>();
  const [stockEligibility, setStockEligibility] = useState(false);
  const [stockClaimDraft, setStockClaimDraft] = useState<StockClaimDraft | null>(null);
  const [stockClaimFunding, setStockClaimFunding] = useState<StockClaimFunding>();
  const [stockClaimDetails, setStockClaimDetails] = useState<StockClaimDetails>();
  const [stockClaimAction, setStockClaimAction] = useState<StockClaimAction>();
  const [stockSnapshots, setStockSnapshots] = useState<Record<StockNetworkId, StockTokenSnapshot>>(() => ({
    "robinhood-mainnet": initialStockSnapshot("robinhood-mainnet"),
    "robinhood-testnet": initialStockSnapshot("robinhood-testnet"),
  }));
  const [stocksLoading, setStocksLoading] = useState(true);
  const [claimLink, setClaimLink] = useState<string>();
  /** The Arc vault link whose funding left the wallet: kept so a failed verification is verified again, never paid twice. */
  const [arcClaimFunding, setArcClaimFunding] = useState<{ paymentId: string; hash: string }>();
  const [claimDetails, setClaimDetails] = useState<ClaimDetails>();
  /** When the Solana link on this page is settled, its window's end; the slip reads the link itself. */
  const [solanaSettledExpiry, setSolanaSettledExpiry] = useState<string>();
  const [pendingClaims, setPendingClaims] = useState<PendingVaultLinks>();
  const [pendingClaimsState, setPendingClaimsState] = useState<{ status: "idle" | "loading" | "ready" | "error"; error?: string }>({ status: "idle" });
  const [pendingClaimAction, setPendingClaimAction] = useState<PendingClaimAction>();
  const [pendingStatements, setPendingStatements] = useState<ReadonlySet<string>>(() => new Set());
  const pendingClaimsRequestRef = useRef(0);
  const pendingClaimsReadAtRef = useRef(0);
  /** SP: the balance and history the server reports, the rules it earns by, and a short note after an award. */
  const [spSummary, setSpSummary] = useState<SpSummary>();
  const [spState, setSpState] = useState<{ status: "idle" | "loading" | "ready" | "error"; error?: string }>({ status: "idle" });
  const [spRules, setSpRules] = useState<SpRules>();
  const [spLoadingMore, setSpLoadingMore] = useState(false);
  const [spToast, setSpToast] = useState<{ amount?: number; text?: string; key: number }>();
  /** Invites: the account's code and what the people who joined with it earned it. */
  const [referral, setReferral] = useState<ReferralSummary>();
  const spRequestRef = useRef(0);
  /** What an admin paused and the desk notice, from the server. */
  const [deskControls, setDeskControls] = useState<DeskControlsView>({ paused: {}, notice: null });
  /** Links already announced for this wallet, so a later read speaks up only about new ones. */
  const announcedClaimsRef = useRef<{ wallet?: string; ids: Set<string> }>({ ids: new Set() });
  /** A provider sign-in that just returned (`?linked=`) brings the panel into view to show what waits for the account. */
  const revealClaimsRef = useRef(new URLSearchParams(window.location.search).has("linked"));
  const [reply, setReply] = useState(claimTarget
    ? ARC_CLAIM_REPLY
    : stockClaimTarget || solanaClaimTarget
      ? VAULT_CLAIM_REPLY
      : operatorPage
        ? "Connect the operator wallet. Solana takes one approval: the page deploys its vault program and sends back what is left. Robinhood Chain takes three signatures: the burn vault, the fee router, then the escrow."
        : "");
  const [busy, setBusy] = useState(false);
  const [conversation, updateConversation] = useReducer(paymentConversationReducer, emptyPaymentConversation);
  const chatSequenceRef = useRef(0);
  const deskLensRef = useRef<HTMLDivElement>(null);
  const chatRequestRef = useRef<number>();
  const [session, setSession] = useState<WalletSessionSnapshot<LinkedAccount, PaymentHistoryItem>>({
    accounts: [], payments: [], sessionStatus: "idle", profileStatus: "idle", paymentsStatus: "idle",
  });
  const [sessionController] = useState(() => createWalletSessionController<LinkedAccount, PaymentHistoryItem>({
    readSession: () => readSessionResource("/api/me"),
    readProfile: () => readSessionResource("/api/profile"),
    readPayments: async () => {
      // Arc USDC payments and Robinhood stock-token transfers are verified separately and shown as one activity list.
      const [payments, stockTransfers, solanaTransfers] = await Promise.all([
        readReceiptHistory("/api/payments", "payments"),
        readReceiptHistory("/api/stocks/transfers", "transfers"),
        readReceiptHistory("/api/solana/transfers", "transfers"),
      ]);
      return [...payments, ...stockTransfers, ...solanaTransfers].sort((left, right) => right.confirmedAt.localeCompare(left.confirmedAt));
    },
    publish: setSession,
    profileRetryDelays: [800, 2500],
  }));
  const { wallet, accounts, payments: paymentHistory } = session;
  const walletVerifying = session.sessionStatus === "verifying";
  // Linked accounts live on the server. Until a verified wallet's list has been read, the desk does not know them, so
  // it never calls an account "Not connected" for a wallet that is signed out, still loading or could not be read.
  const accountsKnown = Boolean(wallet) && session.profileStatus === "ready";
  const accountsUnknown = !wallet ? "Verify to see" : session.profileStatus === "error" ? "Could not load" : accountsKnown ? undefined : "Checking…";
  const [providers, setProviders] = useState<Provider[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  // Messages for the identity dialog: while it is open, the chat behind it cannot be seen.
  const [identityNotice, setIdentityNotice] = useState<string>();
  const [linking, setLinking] = useState<string>();
  /** What the account's Solana address holds, read while the identities dialog is open. */
  const [solanaHoldings, setSolanaHoldings] = useState<SolanaHoldingsView>();
  const [network, setNetwork] = useState<NetworkState>({ ready: false });
  const reviewEpochRef = useRef(0);
  const chatStageRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
  const [networkOpen, setNetworkOpen] = useState(false);
  const networkMenuRef = useRef<HTMLDivElement>(null);
  const identityModalRef = useRef<HTMLElement>(null);
  const [transactionHash, setTransactionHash] = useState<string>();
  const [transactionStatus, setTransactionStatus] = useState<"pending" | "confirmed" | "verification_failed">();
  /** A pay link's account, as the server's directory answers it. */
  const [payeeState, setPayeeState] = useState<"verifying" | "verified" | "unverified" | "error">("verifying");
  const [farcasterRequest, setFarcasterRequest] = useState<FarcasterRequest>();
  const [unlinkConfirm, setUnlinkConfirm] = useState<string>();
  /** Telegram's login script is loaded, so the Connect button can open its login window straight from the click. */
  const [telegramReady, setTelegramReady] = useState(() => Boolean(window.Telegram?.Login?.auth));
  /** Telegram's script could not load this time; the dialog says so, and opening it again tries again. */
  const [telegramFailed, setTelegramFailed] = useState(false);
  // Telegram's script without widget attributes only defines Telegram.Login: it draws nothing and evaluates no strings,
  // which the page's script policy forbids. It loads once, when the dialog that offers Telegram opens.
  useEffect(() => {
    if (!manageOpen || telegramReady || !providers.some((provider) => provider.id === "telegram" && provider.configured && provider.botId)) return;
    // The script may have finished while the dialog was closed, after its listener was removed.
    if (window.Telegram?.Login?.auth) return void setTelegramReady(true);
    let script = document.querySelector<HTMLScriptElement>("script[data-hapapay-telegram]");
    // A script that failed before is replaced, so reopening the dialog tries again.
    if (script?.dataset.hapapayTelegram === "failed") {
      script.remove();
      script = null;
    }
    if (!script) {
      script = document.createElement("script");
      script.async = true;
      script.src = "https://telegram.org/js/telegram-widget.js?22";
      script.dataset.hapapayTelegram = "";
      document.head.appendChild(script);
    }
    setTelegramFailed(false);
    const loaded = () => setTelegramReady(Boolean(window.Telegram?.Login?.auth));
    // Audit, 2026-10-06: a script that never loaded left the row on "Loading…" with no word why.
    const failed = (event: Event) => {
      (event.target as HTMLScriptElement).dataset.hapapayTelegram = "failed";
      setTelegramFailed(true);
    };
    script.addEventListener("load", loaded);
    script.addEventListener("error", failed);
    return () => {
      script?.removeEventListener("load", loaded);
      script?.removeEventListener("error", failed);
    };
  }, [manageOpen, telegramReady, providers]);
  const paymentNetworks = network.paymentNetworks ?? paymentNetworkCatalog(false, false);
  // Every request runs where its asset lives: USDC on the Arc network this server runs, Robinhood Chain tokens on
  // Robinhood Chain. Nobody picks a network; each review names its own before the wallet opens.
  const arcNetwork: ArcNetworkId | undefined = network.ready && network.environment ? `arc-${network.environment}` : undefined;
  const arcEntry = paymentNetworks.find((entry) => entry.id === arcNetwork);
  const arcAvailable = Boolean(arcEntry?.available);
  const arcLabel = network.chainName ?? "Arc";
  const arcReason = arcEntry?.reason ?? network.reason ?? "The Arc payment route is not ready.";
  const stockNetwork: StockNetworkId = stockClaimTarget?.network ?? DESK_STOCK_NETWORK;
  const stockSnapshot = stockSnapshots[stockNetwork];
  const stockChain = STOCK_CHAINS[stockNetwork];
  // Stock Tokens and the other listed tokens (USDG) have separate switches on the server.
  const stockTokensLive = Boolean(stockSnapshot.transfers?.enabled);
  const otherTokensLive = Boolean(stockSnapshot.transfers?.tokens?.enabled) && stockSnapshot.tokens.some((token) => !isStockToken(token));
  const stockTransfersLive = stockTokensLive || otherTokensLive;
  const stockTransfersReason = stockSnapshot.transfers?.reason ?? "Stock-token transfers are not available on this server right now.";
  const solanaLive = Boolean(solana.transfers?.enabled || solana.stocks?.enabled);
  const anyLive = solanaLive || arcAvailable || stockTransfersLive;
  /** The networks that sign right now, so the header never names one that is locked. */
  const liveNetworks = [solanaLive && "Solana", stockTransfersLive && stockChain.name, arcAvailable && arcLabel].filter((name): name is string => Boolean(name));
  function toggleStatusNote(note: "solana" | "stocks" | "tokens" | "arc") {
    setStatusNote((current) => current === note ? undefined : note);
  }

  // One pending card, and one lock on clearing the chat, for a claim link being funded or a claim page's claim or refund.
  const stockClaimActivity = stockClaimDraft && stockClaimFunding?.hash && stockClaimFunding.status !== "confirmed"
    ? { amount: stockClaimDraft.intent.amount, symbol: stockClaimDraft.intent.asset.symbol, detail: `Claim escrow · ${STOCK_CHAINS[stockClaimDraft.network].name}`, failed: stockClaimFunding.status === "verification_failed" }
    : stockClaimTarget && stockClaimDetails && stockClaimAction && stockClaimAction.status !== "confirmed"
      ? { amount: stockClaimDetails.amount, symbol: stockClaimDetails.token.symbol, detail: `${stockClaimAction.action === "claim" ? "Claim" : "Refund"} · ${STOCK_CHAINS[stockClaimTarget.network].name}`, failed: stockClaimAction.status === "failed" }
      : undefined;
  const stockClaimPending = Boolean(stockClaimActivity && !stockClaimActivity.failed);
  // The empty desk centers the hero and the request box; any request, draft or claim turns it into the working log.
  /** A claim page whose link is no longer in its escrow or program says so in its heading, not "Claim …". */
  const settledExpiry = claimTarget && claimDetails?.status === "settled" ? claimDetails.expiresAt
    : stockClaimTarget && stockClaimDetails?.status === "settled" ? stockClaimDetails.expiresAt
      : solanaClaimTarget ? solanaSettledExpiry : undefined;
  const settledPage = settledExpiry ? settledLink(settledExpiry) : undefined;
  /** A slip is on screen: what its buttons report goes under it, where the button is, not above it in the log. */
  const slipShown = Boolean(draft || claimDraft || stockDraft || batchDraft || stockClaimDraft || solanaDraft || solanaClaimDraft || claimTarget || stockClaimTarget || solanaClaimTarget || operatorPage);
  const showIntro = conversation.turns.length === 0 && !draft && !claimDraft && !stockDraft && !stockClaimDraft && !batchDraft && !solanaDraft && !solanaClaimDraft;
  const batchRunning = batchStates.some(({ status }) => status === "signing" || status === "pending");
  const resting = showIntro && !claimTarget && !stockClaimTarget && !solanaClaimTarget && !operatorPage;
  const heroShapes = claimTarget || solanaClaimTarget ? ["lock", "$"]
    : stockClaimTarget ? ["lock", !stockClaimDetails || stockClaimDetails.token.kind === "cash" ? "$" : stockClaimDetails.token.symbol]
    : operatorPage ? ["lock"]
    : payTarget ? ["@", "$"]
    : ["$", "€"];
  // While a request is typed, the dots take the shape of its asset: a dollar sign for USDC and USDG, or the ticker.
  const typedSymbol = payTarget ? undefined : message.match(/^\s*send\s+[\d.,]*\s*([a-z]{2,6})\b/i)?.[1]?.toUpperCase();
  const heroFocus = !typedSymbol ? undefined
    : typedSymbol === "USDC" || typedSymbol === "USDG" ? "$"
    : stockSnapshot.tokens.some((token) => token.symbol === typedSymbol) ? typedSymbol
    : undefined;
  const sideTabs: SideTab[] = ["stocks", "activity", "claims", "sp", "identities"];
  const activeTab: SideTab = sideTabs.includes(sideTab) ? sideTab : "activity";
  const pendingCards = Number(Boolean(stockDraft && stockTransaction && stockTransaction.status !== "confirmed")) + Number(Boolean(stockClaimActivity)) + Number(Boolean(transactionHash && transactionStatus !== "confirmed"));
  const waitingClaims = pendingClaims?.incoming.length ?? 0;
  const pausedFeatures = Object.entries(deskControls.paused).filter((entry): entry is [DeskFeature, DeskPause] => isDeskFeature(entry[0]) && Boolean(entry[1]));
  const vaultAccounts = accounts.filter((account) => isStockClaimPlatform(account.platform));
  const vaultAccountsKey = vaultAccounts.map((account) => `${account.platform}:${account.username}`).sort().join(",");
  const pendingClaimRunning = pendingClaimAction?.status === "signing" || pendingClaimAction?.status === "pending";

  function clearConversation() {
    if (busy || walletVerifying || linking || transactionStatus === "pending" || stockTransaction?.status === "pending" || stockClaimPending || pendingClaimRunning || batchRunning) return;
    updateConversation({ type: "clear" });
    setMessage("");
    // Back on the empty desk the steps under the request box say what to type, so no hint is repeated above it.
    if (!draft && !claimDraft && !stockDraft && !stockClaimDraft && !batchDraft && !solanaDraft && !solanaClaimDraft && !claimTarget && !stockClaimTarget && !solanaClaimTarget && !operatorPage && !transactionHash && !stockTransaction) setReply("");
    messageInputRef.current?.focus();
  }

  useEffect(() => {
    if (!conversation.turns.length) return;
    const stage = chatStageRef.current;
    if (stage) stage.scrollTo({ top: stage.scrollHeight, behavior: "auto" });
  }, [conversation]);

  /**
   * A board row writes a request for one of its asset on the board's own network, with the cursor where the handle
   * goes (audit, 2026-10-06: NVDA picked on the Robinhood Chain board wrote a bare ticker, which became a Solana NVDAx
   * review).
   */
  function writeBoardRequest(symbol: string, network: "Solana" | "Robinhood Chain") {
    if (claimTarget || stockClaimTarget || solanaClaimTarget || operatorPage) return;
    const recipient = payTarget ? `@${payTarget.username} on ${platformName(payTarget.platform)}` : "@";
    setMessage(`Send 1 ${symbol} to ${recipient} on ${network}`);
    window.requestAnimationFrame(() => {
      const input = messageInputRef.current;
      if (!input) return;
      input.focus();
      const handle = `Send 1 ${symbol} to @`.length;
      if (payTarget) input.setSelectionRange(5, 6);
      else input.setSelectionRange(handle, handle);
    });
  }

  /** A row on the Solana board writes a request for one of it, on Solana. */
  function selectSolanaAsset(asset: { symbol: string }) {
    writeBoardRequest(asset.symbol, "Solana");
  }

  /** A row on the Robinhood Chain board writes a request for one of it, on Robinhood Chain. */
  function selectStock(token: StockTokenQuote) {
    writeBoardRequest(token.symbol, "Robinhood Chain");
  }

  useEffect(() => {
    let cancelled = false;
    const load = async (network: StockNetworkId) => {
      const response = await fetch(`/api/stocks?network=${network}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Stock tokens are unavailable.");
      const next = await response.json() as StockTokenSnapshot;
      // Only allowlisted ticker/address pairs bundled with this page are ever shown.
      if (!cancelled && Array.isArray(next.tokens) && next.network === network) {
        setStockSnapshots((current) => ({ ...current, [network]: { ...next, tokens: next.tokens.filter((token) => allowlisted[network].has(`${token.symbol}:${token.address}`)) } }));
      }
    };
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load("robinhood-mainnet").catch(() => undefined).finally(() => { if (!cancelled) setStocksLoading(false); });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!draft && !claimDraft && !stockDraft && !stockClaimDraft && !batchDraft && !solanaDraft && !solanaClaimDraft) return;
    const stage = chatStageRef.current;
    const slip = stage?.querySelector(".payment-slip");
    const composer = composerRef.current;
    if (!stage || !slip || !composer) return;
    const overlap = slip.getBoundingClientRect().bottom - composer.getBoundingClientRect().top + 16;
    if (overlap > 0) stage.scrollTo({ top: stage.scrollTop + overlap, behavior: "auto" });
  }, [draft, claimDraft, stockDraft, stockClaimDraft, batchDraft, solanaDraft, solanaClaimDraft, stockClaimFunding?.link]);

  useEffect(() => {
    // Signing in should not wait for /api/providers and then for Privy's large chunk: both are fetched at once.
    if (!homePage && !docsPage && !notFoundPage) void loadPrivyBridge().catch(() => undefined);
    privyAppIdRequest.current = fetch("/api/providers").then((response) => response.json()).then((data) => {
      // Sign-ins return to the site's own origin, where the wallet session must live: another host moves there first.
      if (typeof data.appOrigin === "string" && /^https:\/\/[^/]+$/.test(data.appOrigin) && window.location.origin !== data.appOrigin) {
        window.location.replace(`${data.appOrigin}${landingPath}`);
        return undefined;
      }
      setProviders(data.providers ?? []);
      setDeskControls(readDeskControls(data.controls));
      setPageSolanaRpc(data.solanaRpcUrl);
      void pageSolanaRpcUrl().then(setSolanaRpcUrl);
      const appId = typeof data.privyAppId === "string" && /^[a-z0-9]{10,64}$/.test(data.privyAppId) ? data.privyAppId : undefined;
      if (appId) setPrivyAppId(appId);
      return appId;
    }).catch(() => {
      setPageSolanaRpc(undefined);
      return undefined;
    });
    void fetch("/api/network").then((response) => response.json()).then(setNetwork);
    void fetch("/api/sp/rules").then((response) => response.ok ? response.json() : undefined).then((data) => {
      if (data && typeof data.rules === "object" && data.rules) setSpRules(data.rules as SpRules);
    }).catch(() => undefined);
    void sessionController.restore();
    const params = new URLSearchParams(window.location.search);
    // Only a provider this desk links is named; any other text in the address is never shown (audit, 2026-10-06: a
    // crafted ?linked= put an arbitrary message on the desk under its own name).
    const linkedName = identities.find((identity) => identity.id === params.get("linked"))?.name;
    if (linkedName) setReply(`Your ${linkedName} account was verified by its official provider and linked to your wallet.`);
    const failedProvider = params.get("link_error");
    if (failedProvider) {
      const message = linkFailureMessage(failedProvider, params.get("reason"));
      setReply(message);
      setIdentityNotice(message);
      setManageOpen(true);
    }
    if (params.has("linked") || params.has("link_error")) window.history.replaceState({}, "", window.location.pathname === "/" ? DESK_PATH : window.location.pathname);
    if (payTarget) {
      void fetch(`/api/resolve/${payTarget.platform}/${encodeURIComponent(payTarget.username)}`, { cache: "no-store" }).then(async (response) => {
        await response.body?.cancel();
        if (response.status === 404 || response.status === 400) {
          setPayeeState("unverified");
          setReply("The social account in this payment link is unverified or no longer connected.");
          return;
        }
        if (!response.ok) throw new Error("unavailable");
        setPayeeState("verified");
        const platform = platformName(payTarget.platform);
        setMessage(`Send  to @${payTarget.username} on ${platform}`);
        window.requestAnimationFrame(() => {
          messageInputRef.current?.focus();
          messageInputRef.current?.setSelectionRange(5, 5);
        });
        setReply(`@${payTarget.username} was verified through the official ${platform} account. Enter an amount and an asset, like 25 USDC or 2 NVDA.`);
      }).catch(() => {
        // Never left at "Verifying…" (audit, 2026-10-06).
        setPayeeState("error");
        setReply("The account in this payment link could not be checked just now. Reload the page to try again.");
      });
    }
    if (claimTarget) {
      void fetch(`/api/claims/${claimTarget}`).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setClaimDetails(result);
        if (result.status === "settled") setReply(quietClaimReply);
      }).catch((error) => setReply(error instanceof Error ? error.message : "The social payment was not found."));
    }
    if (stockClaimTarget) void loadStockClaim();
    return () => sessionController.cancel();
  }, [payTarget, claimTarget, stockClaimTarget, sessionController]);

  // Solana, beside Robinhood Chain: whether it runs, its treasury and switches, its vault, and the board's prices.
  useEffect(() => {
    let cancelled = false;
    const read = (path: string) => fetch(path, { cache: "no-store" }).then((response) => response.ok ? response.json() : undefined).catch(() => undefined);
    const load = async () => {
      const [status, vault, assets] = await Promise.all([read("/api/solana"), read("/api/solana/vault"), read("/api/solana/assets")]);
      if (cancelled) return;
      setSolana({
        ready: Boolean(status?.ready),
        treasury: typeof status?.treasury === "string" ? status.treasury : undefined,
        transfers: status?.transfers,
        stocks: status?.stocks,
        vault: vault ? { enabled: Boolean(vault.enabled), reason: vault.reason, programId: vault.program?.id } : undefined,
        quotes: assets?.quotes && typeof assets.quotes === "object" ? assets.quotes : {},
        pricesAsOf: assets?.prices?.asOf,
      });
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Every later signature comes from the wallet the session was verified with: after a reload, Privy's wallet once
  // Privy has it, when it is that same wallet.
  useEffect(() => onPrivyChange(() => setPrivyChanges((count) => count + 1)), []);
  useEffect(() => {
    const privy = privyControls();
    if (!privy?.authenticated || !wallet) return;
    let cancelled = false;
    void privy.evm().then((evm) => {
      if (!cancelled && evm && evm.address.toLowerCase() === wallet.toLowerCase()) setActiveEvmProvider(evm.provider);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [privyChanges, wallet]);

  // The identities dialog says what the account's Solana address holds, so a payment that reached it is never out of
  // sight.
  useEffect(() => {
    if (!manageOpen || !wallet || !session.solanaAddress) return void setSolanaHoldings(undefined);
    const sessionContext = sessionController.capture();
    let cancelled = false;
    setSolanaHoldings({ status: "loading" });
    void readSolanaHoldings().then((held) => {
      if (cancelled || !sessionController.isCurrent(sessionContext)) return;
      setSolanaHoldings(held?.address ? { status: "ready", ...held } : { status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [manageOpen, wallet, session.solanaAddress]);

  useEffect(() => {
    if (!farcasterRequest) return;
    const sessionContext = sessionController.capture();
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch("/api/oauth/farcaster/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: farcasterRequest.requestId }),
        });
        const result = await response.json();
        if (cancelled || !sessionController.isCurrent(sessionContext)) return;
        if (response.status === 202) {
          timer = window.setTimeout(poll, 1_500);
          return;
        }
        if (!response.ok) throw new Error(result.error);
        await sessionController.refreshProfile(sessionContext);
        if (cancelled || !sessionController.isCurrent(sessionContext)) return;
        setReply(`@${result.account.username} was verified with a Farcaster signature and linked to your wallet.`);
        setFarcasterRequest(undefined);
        setLinking(undefined);
      } catch (error) {
        if (cancelled || !sessionController.isCurrent(sessionContext)) return;
        const message = error instanceof Error ? error.message : "Farcaster verification could not be completed.";
        setReply(message);
        setIdentityNotice(message);
        setFarcasterRequest(undefined);
        setLinking(undefined);
      }
    };
    timer = window.setTimeout(poll, 1_500);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [farcasterRequest?.requestId]);

  // A link sent to an account shows up as soon as the account is linked: the list is read again whenever the wallet
  // or its GitHub, X and Farcaster accounts change.
  useEffect(() => {
    void loadPendingClaims();
  }, [wallet, vaultAccountsKey]);
  // A vault link funded from this browser whose record never reached the server (a closed tab, a lost connection) is
  // recorded once its wallet is signed in again, so it reaches Claims on both sides.
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    void retryUnrecordedFundings(wallet, (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
      .then((recorded) => {
        if (recorded && !cancelled) void loadPendingClaims();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wallet]);
  // Another wallet starts with no claim in progress and no statement ticked.
  useEffect(() => {
    setPendingClaimAction(undefined);
    setPendingStatements(new Set());
  }, [wallet]);
  useEffect(() => {
    if (activeTab === "claims" && wallet && Date.now() - pendingClaimsReadAtRef.current > 20_000) void loadPendingClaims();
  }, [activeTab]);
  // SP is read after anything that can earn it: a sign-in, a recorded payment, a claimed or refunded link, a linked
  // account or a Solana address. Changes that land together are read once.
  const spTriggerKey = `${wallet ?? ""}|${paymentHistory.length}:${paymentHistory[0]?.confirmedAt ?? ""}|${accounts.length}|${session.solanaAddress ?? ""}|${pendingClaims ? `${pendingClaims.incoming.length}:${pendingClaims.outgoing.length}` : ""}`;
  useEffect(() => {
    if (!wallet) {
      setSpSummary(undefined);
      setReferral(undefined);
      setSpState({ status: "idle" });
      return;
    }
    const timer = window.setTimeout(() => void loadSp(), 600);
    return () => window.clearTimeout(timer);
  }, [spTriggerKey]);
  // Another wallet never shows the last one's SP, and claim reports an earlier visit left are sent again.
  useEffect(() => {
    setSpSummary(undefined);
    setReferral(undefined);
    if (wallet) void retrySpClaimReports();
  }, [wallet]);
  useEffect(() => {
    const listener = (event: Event) => {
      const awarded = (event as CustomEvent<{ awarded?: number }>).detail?.awarded ?? 0;
      if (awarded > 0) setSpToast({ amount: awarded, key: Date.now() });
      void loadSp();
    };
    window.addEventListener(SP_EVENT, listener);
    return () => window.removeEventListener(SP_EVENT, listener);
  }, [wallet]);
  useEffect(() => {
    if (!spToast) return;
    const timer = window.setTimeout(() => setSpToast(undefined), 4_500);
    return () => window.clearTimeout(timer);
  }, [spToast?.key]);

  useEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colorTheme === "light" ? "#F5F5F7" : "#0B0C0E");
  }, [colorTheme]);

  /** Switches dark and light. Where the browser supports view transitions, the new theme opens as a circle from the button. */
  function toggleColorTheme(event: MouseEvent<HTMLButtonElement>) {
    const next: ColorTheme = colorTheme === "dark" ? "light" : "dark";
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // A per-viewer preference only; the desk works without storage.
    }
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = next;
      flushSync(() => setColorTheme(next));
    };
    if (typeof document.startViewTransition !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return apply();
    const button = event.currentTarget.getBoundingClientRect();
    root.style.setProperty("--theme-x", `${Math.round(button.left + button.width / 2)}px`);
    root.style.setProperty("--theme-y", `${Math.round(button.top + button.height / 2)}px`);
    document.startViewTransition(apply);
  }

  useEffect(() => {
    document.documentElement.dataset.motion = ambientMotion ? "on" : "off";
  }, [ambientMotion]);

  /** Pauses or plays the scenes' ambient loops (WCAG 2.2.2); state changes such as a pending transfer still move. */
  function toggleAmbientMotion() {
    const next = !ambientMotion;
    setAmbientMotion(next);
    try {
      window.localStorage.setItem(MOTION_KEY, next ? "on" : "off");
    } catch {
      // A per-viewer preference only; the desk works without storage.
    }
  }

  // Controls light up their dots under the pointer: its position inside the control goes to --px and --py. The desk's
  // own dots light up around the pointer too, through a lens that moves with it and lines up with the desk's grid.
  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let frame = 0;
    let latest: PointerEvent | undefined;
    const paint = () => {
      frame = 0;
      if (!latest) return;
      const lens = deskLensRef.current;
      const desk = lens?.parentElement;
      if (lens && desk) {
        const box = desk.getBoundingClientRect();
        const left = Math.round(latest.clientX - box.left - DESK_LENS / 2);
        const top = Math.round(latest.clientY - box.top - DESK_LENS / 2);
        const align = (offset: number) => -(((offset % DESK_DOT) + DESK_DOT) % DESK_DOT);
        lens.style.transform = `translate(${left}px, ${top}px)`;
        lens.style.backgroundPosition = `${align(left)}px ${align(top)}px`;
        lens.classList.add("on");
      }
      const control = latest.target instanceof Element ? latest.target.closest<HTMLElement>("button, a[href], .composer") : null;
      if (!control) return;
      const rect = control.getBoundingClientRect();
      control.style.setProperty("--px", `${Math.round(latest.clientX - rect.left)}px`);
      control.style.setProperty("--py", `${Math.round(latest.clientY - rect.top)}px`);
    };
    const move = (event: PointerEvent) => {
      latest = event;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const away = () => deskLensRef.current?.classList.remove("on");
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", away);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", away);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // "/" jumps to the request box from anywhere on the desk, unless the user is typing or a dialog is open.
  useEffect(() => {
    function focusRequest(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "")) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const input = messageInputRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
    }
    window.addEventListener("keydown", focusRequest);
    return () => window.removeEventListener("keydown", focusRequest);
  }, []);
  useModalKeyboard(identityModalRef, manageOpen, closeIdentities);
  // The network list closes with Escape and with a press anywhere else, like any menu.
  useEffect(() => {
    if (!networkOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setNetworkOpen(false);
      networkMenuRef.current?.querySelector<HTMLElement>(".network-pill")?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!networkMenuRef.current?.contains(event.target as Node)) setNetworkOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [networkOpen]);

  /** Header links open a side panel; on one-column screens they also scroll down to it. */
  function openPanel(event: MouseEvent<HTMLAnchorElement>, tab: SideTab) {
    event.preventDefault();
    showPanel(tab, true);
  }

  /** Opens a side panel tab; on a phone, where the panel sits below the desk, it also scrolls into view. */
  function showPanel(tab: SideTab, focus: boolean) {
    setSideTab(tab);
    window.requestAnimationFrame(() => {
      const panel = document.getElementById("side-panel");
      if (panel && panel.getBoundingClientRect().top > window.innerHeight * 0.5) {
        panel.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      }
      if (focus) document.getElementById(`tab-${tab}`)?.focus({ preventScroll: true });
    });
  }

  /** Arrow keys, Home and End move between the side panel tabs. */
  function moveTab(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const index = sideTabs.indexOf(activeTab);
    const next = event.key === "ArrowRight" ? sideTabs[(index + 1) % sideTabs.length]
      : event.key === "ArrowLeft" ? sideTabs[(index - 1 + sideTabs.length) % sideTabs.length]
      : event.key === "Home" ? sideTabs[0]
      : event.key === "End" ? sideTabs[sideTabs.length - 1]
      : undefined;
    if (!next) return;
    event.preventDefault();
    setSideTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  async function loadPayments() {
    await sessionController.refreshPayments();
  }

  /** SP: reading the balance awards what this wallet did that had not earned yet; a new award shows for a moment. */
  async function loadSp() {
    const sessionContext = sessionController.capture();
    const request = ++spRequestRef.current;
    if (!wallet) {
      setSpSummary(undefined);
      setReferral(undefined);
      setSpState({ status: "idle" });
      return;
    }
    setSpState((current) => ({ ...current, status: "loading" }));
    try {
      // An invite link this browser was opened with is sent first, so the account joins before it earns anything.
      const joined = await joinWithPendingInvite().catch(() => undefined);
      const invites = readReferral().catch(() => undefined);
      const response = await fetch("/api/sp", { cache: "no-store" });
      const result = await response.json().catch(() => ({})) as Partial<SpSummary> & { awarded?: number; error?: string };
      if (request !== spRequestRef.current || !sessionController.isCurrent(sessionContext)) return;
      if (!response.ok || typeof result.balance !== "number") throw new Error(result.error ?? "Your SP could not be read. Try again.");
      setSpSummary({
        balance: result.balance,
        today: Number(result.today ?? 0),
        dailyCap: Number(result.dailyCap ?? 0),
        frozen: result.frozen === true,
        rulesVersion: Number(result.rulesVersion ?? 1),
        entries: Array.isArray(result.entries) ? result.entries : [],
        next: typeof result.next === "string" ? result.next : null,
      });
      setSpState({ status: "ready" });
      // Joining and what this read awarded share one toast, so neither hides the other.
      const awarded = typeof result.awarded === "number" && result.awarded > 0 ? result.awarded : undefined;
      if (joined === "joined" || awarded) setSpToast({ amount: awarded, text: joined === "joined" ? "You joined with an invite" : undefined, key: Date.now() });
      const summary = await invites;
      if (request === spRequestRef.current && sessionController.isCurrent(sessionContext)) setReferral(summary);
    } catch (error) {
      if (request !== spRequestRef.current || !sessionController.isCurrent(sessionContext)) return;
      setSpState({ status: "error", error: error instanceof Error ? error.message : "Your SP could not be read. Try again." });
    }
  }

  async function loadMoreSp() {
    const before = spSummary?.next;
    if (!before) return;
    const sessionContext = sessionController.capture();
    setSpLoadingMore(true);
    setSpState((current) => ({ status: current.status }));
    try {
      const response = await fetch(`/api/sp/history?before=${encodeURIComponent(before)}`, { cache: "no-store" });
      const result = await response.json().catch(() => ({})) as { entries?: SpEntry[]; next?: string | null; error?: string };
      if (!sessionController.isCurrent(sessionContext)) return;
      if (!response.ok || !Array.isArray(result.entries)) throw new Error(result.error ?? "Earlier SP could not be read. Try again.");
      const earlier = result.entries;
      setSpSummary((current) => current ? {
        ...current,
        entries: [...current.entries, ...earlier.filter((entry) => !current.entries.some((known) => known.id === entry.id))],
        next: typeof result.next === "string" ? result.next : null,
      } : current);
    } catch (error) {
      setSpState((current) => ({ ...current, error: error instanceof Error ? error.message : "Earlier SP could not be read. Try again." }));
    } finally {
      setSpLoadingMore(false);
    }
  }

  /** Pending claims: the vault links this wallet can act on, each read back from its escrow by the server. */
  async function loadPendingClaims() {
    const sessionContext = sessionController.capture();
    const request = ++pendingClaimsRequestRef.current;
    if (!wallet) {
      setPendingClaims(undefined);
      setPendingClaimsState({ status: "idle" });
      return;
    }
    setPendingClaimsState({ status: "loading" });
    try {
      const response = await fetch("/api/claims/pending", { cache: "no-store" });
      const result = await response.json().catch(() => ({})) as Partial<PendingVaultLinks> & { error?: string };
      if (request !== pendingClaimsRequestRef.current || !sessionController.isCurrent(sessionContext)) return;
      if (!response.ok) throw new Error(result.error ?? "Pending claims could not be checked. Try again.");
      const links: PendingVaultLinks = {
        incoming: Array.isArray(result.incoming) ? result.incoming : [],
        outgoing: Array.isArray(result.outgoing) ? result.outgoing : [],
        unavailable: Array.isArray(result.unavailable) ? result.unavailable.filter((name): name is string => typeof name === "string") : [],
      };
      pendingClaimsReadAtRef.current = Date.now();
      setPendingClaims(links);
      setPendingClaimsState({ status: "ready" });
      announceNewClaims(links);
    } catch (error) {
      if (request !== pendingClaimsRequestRef.current || !sessionController.isCurrent(sessionContext)) return;
      setPendingClaimsState({ status: "error", error: error instanceof Error ? error.message : "Pending claims could not be checked. Try again." });
    }
  }

  /**
   * Says once on the desk that links are waiting, and opens Claims: after a sign-in, and right after linking the
   * account a link was sent to. A flow in progress keeps its own message.
   */
  function announceNewClaims(links: PendingVaultLinks) {
    const known = announcedClaimsRef.current.wallet === wallet ? announcedClaimsRef.current.ids : new Set<string>();
    const fresh = links.incoming.filter((link) => !known.has(link.paymentId));
    announcedClaimsRef.current = { wallet, ids: new Set([...known, ...links.incoming.map((link) => link.paymentId)]) };
    if (!fresh.length || claimTarget || stockClaimTarget || solanaClaimTarget || operatorPage || draft || claimDraft || stockDraft || stockClaimDraft || solanaDraft || solanaClaimDraft || busy) return;
    const amounts = fresh.slice(0, 3).map((link) => `${link.amount} ${link.token.symbol}`).join(", ");
    setReply(`${fresh.length === 1 ? "A vault link is" : `${fresh.length} vault links are`} waiting for your accounts: ${amounts}${fresh.length > 3 ? " and more" : ""}. Claim ${fresh.length === 1 ? "it" : "them"} under Claims.`);
    if (revealClaimsRef.current) {
      revealClaimsRef.current = false;
      showPanel("claims", false);
    } else setSideTab("claims");
  }

  /** Copies a sent link again, for a sender who lost it. */
  async function copyPendingLink(link: PendingVaultLink) {
    const url = `${window.location.origin}${link.claimPath}`;
    try {
      await navigator.clipboard.writeText(url);
      setReply(`Claim link copied. Send it to @${link.recipient.username}; they claim it with their official ${platformName(link.recipient.platform)} account.`);
    } catch {
      setReply(`Copy this claim link for @${link.recipient.username}: ${url}`);
    }
  }

  /** Claims a link waiting for one of your accounts, or takes back one you sent, from Pending claims. */
  async function actOnPendingLink(link: PendingVaultLink, action: "claim" | "refund") {
    if (busy || pendingClaimRunning) return;
    if (link.network === SOLANA_MAINNET.id) return void await actOnSolanaLink(link, action);
    if (!await signingWallet()) return;
    const statement = action === "claim" && Boolean(link.statementRequired);
    if (statement && !pendingStatements.has(link.paymentId)) return void setReply("Confirm the Stock Token eligibility statement before claiming.");
    const arcLink = isArcNetworkId(link.network);
    if (arcLink && link.network !== arcNetwork) return void setReply(`This link is on ${link.chainName}, which this server does not run right now.`);
    const explorerUrl = isArcNetworkId(link.network) ? network.explorerUrl : STOCK_CHAINS[link.network].explorerUrl;
    const submitted = (hash: string) => {
      setPendingClaimAction({ paymentId: link.paymentId, action, status: "pending", hash, explorerUrl });
      setReply(`Your ${action} was submitted. Waiting for ${link.chainName} to confirm it.`);
    };
    setBusy(true);
    setPendingClaimAction({ paymentId: link.paymentId, action, status: "signing", explorerUrl });
    try {
      const receipt = isArcNetworkId(link.network)
        ? await signArcVaultAction(link.paymentId, action, submitted)
        : await signStockVaultAction({ network: link.network, paymentId: link.paymentId, escrow: link.escrow, symbol: link.token.symbol }, action, statement, submitted);
      setPendingClaimAction((current) => current?.paymentId === link.paymentId ? { ...current, status: "confirmed" } : current);
      const block = Number.parseInt(receipt.blockNumber, 16);
      setReply(action === "claim"
        ? `${link.amount} ${link.token.symbol} reached your wallet. Verified in ${link.chainName} block ${block}.`
        : `${link.amount} ${link.token.symbol} went back to your wallet. Verified in ${link.chainName} block ${block}.`);
      void loadPendingClaims();
    } catch (error) {
      const message = error instanceof Error ? error.message : `The ${action} was not signed.`;
      setPendingClaimAction((current) => current?.paymentId !== link.paymentId ? current : { ...current, status: current.hash ? "failed" : "refused", message });
      setReply(message);
    } finally {
      setBusy(false);
    }
  }

  /** A Solana vault link from Pending claims: claimed to, or taken back by, the account's own Solana address. */
  async function actOnSolanaLink(link: SolanaPendingVaultLink, action: "claim" | "refund") {
    if (!wallet) return void await connectWallet();
    const statement = action === "claim" && Boolean(link.statementRequired);
    if (statement && !pendingStatements.has(link.paymentId)) return void setReply("Confirm the xStocks eligibility statement before claiming.");
    const explorerUrl = SOLANA_MAINNET.explorerUrl;
    setBusy(true);
    setPendingClaimAction({ paymentId: link.paymentId, action, status: "signing", explorerUrl });
    try {
      const { signSolanaVaultAction } = await import("./solana-desk");
      const { slot } = await signSolanaVaultAction({
        paymentId: link.paymentId,
        programId: link.escrow,
        mint: link.token.address,
        action,
        solanaAddress: session.solanaAddress,
        eligibilityConfirmed: statement,
        onSubmitted: (hash) => {
          setPendingClaimAction({ paymentId: link.paymentId, action, status: "pending", hash, explorerUrl });
          setReply(`Your ${action} was submitted. Waiting for Solana to confirm it.`);
        },
      });
      setPendingClaimAction((current) => current?.paymentId === link.paymentId ? { ...current, status: "confirmed" } : current);
      setReply(action === "claim"
        ? `${link.amount} ${link.token.symbol} reached your Solana wallet. Confirmed in Solana slot ${slot}.`
        : `${link.amount} ${link.token.symbol} went back to your Solana wallet. Confirmed in Solana slot ${slot}.`);
      void loadPendingClaims();
    } catch (error) {
      const message = error instanceof Error ? error.message : `The ${action} was not signed.`;
      setPendingClaimAction((current) => current?.paymentId !== link.paymentId ? current : { ...current, status: current.hash ? "failed" : "refused", message });
      setReply(message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Connect: with Privy, one sign-in gives an EVM and a Solana wallet (embedded, or ones the person connects); without
   * it, the browser's EVM wallet. Either way the session is the EVM wallet's signature of the server's challenge, and
   * the Solana wallet from the same sign-in is added to the account with its own signature when it is new.
   */
  /**
   * The provider that signs for this session, or nothing once the step that gets one has run: without a session the
   * sign-in opens (Privy or the browser's wallet); after a reload, Privy's wallet comes back once Privy has loaded;
   * a session whose wallet is not on this device signs in again (audit, 2026-10-06: these buttons looked for a
   * browser wallet first, so on a phone, where Privy is the wallet, they did nothing or asked to install one).
   */
  async function signingWallet() {
    if (!wallet) {
      await connectWallet();
      return undefined;
    }
    const ready = evmProvider();
    if (ready) return ready;
    const privy = privyControls()?.ready ? privyControls() : (privyAppId ?? await privyAppIdRequest.current) ? await whenPrivyReady(PRIVY_READY_TIMEOUT_MS) : undefined;
    if (privy?.authenticated) {
      const evm = await privy.evm().catch(() => undefined);
      if (evm && evm.address.toLowerCase() === wallet.toLowerCase()) {
        setActiveEvmProvider(evm.provider);
        return evm.provider;
      }
    }
    await connectWallet();
    return undefined;
  }

  async function connectWallet() {
    let privy = privyControls();
    const injected = window.ethereum;
    if (!privy?.ready && (privyAppId ?? await privyAppIdRequest.current)) {
      // Pressed while the sign-in is still loading: it opens as soon as it is ready, with no second press.
      if (privyOpeningRef.current) return;
      privyOpeningRef.current = true;
      setPrivyOpening(true);
      setPrivyWanted(true);
      try {
        // With a browser wallet on this device, Privy is waited for briefly and that wallet signs in if it has not
        // loaded (audit, 2026-10-06: an unreachable Privy kept every Connect waiting 30 seconds, then failing).
        privy = await whenPrivyReady(injected ? PRIVY_FALLBACK_MS : PRIVY_READY_TIMEOUT_MS);
      } finally {
        privyOpeningRef.current = false;
        setPrivyOpening(false);
      }
      if (!privy && !injected) {
        const message = "The sign-in did not load. Check your connection and press Connect wallet again.";
        setReply(message);
        if (!operatorPage && !adminPage) {
          setIdentityNotice(message);
          setManageOpen(true);
        }
        return;
      }
    }
    if (!privy && !injected) {
      const message = "No browser wallet was found. Open this site in your wallet app's browser (MetaMask, Coinbase Wallet or Rabby) or install a browser wallet, then try again.";
      setReply(message);
      if (!operatorPage && !adminPage) {
        setIdentityNotice(message);
        setManageOpen(true);
      }
      return;
    }
    setIdentityNotice(undefined);
    let solanaWallet: SolanaWalletHandle | undefined;
    const outcome = await sessionController.verify(async () => {
      let provider: NonNullable<ReturnType<typeof evmProvider>>;
      let address: string;
      if (privy) {
        await privy.login();
        const evm = await privy.evm();
        if (!evm) throw new Error("The sign-in did not give an EVM wallet. Try again.");
        provider = evm.provider;
        address = evm.address;
        solanaWallet = privy.solana();
      } else {
        provider = injected!;
        address = ((await provider.request({ method: "eth_requestAccounts" })) as string[])[0];
      }
      setActiveEvmProvider(privy ? provider : undefined);
      const challengeResponse = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = await challengeResponse.json();
      if (!challengeResponse.ok) throw new Error(challenge.error);
      const signature = await provider.request({
        method: "personal_sign",
        params: [challenge.message, address],
      });
      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, challengeId: challenge.id, signature }),
      });
      const verified = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(verified.error);
      return { address: verified.address as string };
    });
    if (outcome.status === "verified") {
      // The Solana wallet from the same sign-in joins the account, so Solana payments reach it, unless the account's
      // address holds something: a switch would leave that behind, so the answer says why.
      const kept = solanaWallet ? await joinSolanaWallet(solanaWallet) : undefined;
      if (operatorPage) return void setReply(kept ?? "Your wallet signature is verified. Deploy the escrow on the network you want to open.");
      if (adminPage) return void setReply(kept ?? "Your wallet signature is verified.");
      setReply(kept ?? "Your wallet signature is verified. You can now connect accounts through their official providers.");
      if (kept) setIdentityNotice(kept);
      setManageOpen(true);
    } else if (outcome.status === "failed") {
      const message = outcome.error instanceof Error ? outcome.error.message : "Wallet verification was not completed.";
      setReply(message);
      if (manageOpen) setIdentityNotice(message);
    }
  }

  /**
   * After a sign-in, its Solana wallet joins the account when the account has no Solana address, or replaces one that
   * holds nothing. An address that holds something, or whose balance cannot be read, stays: switching would leave what
   * was paid to it in a wallet this sign-in may not open. The answer then says where the address is and how to reach it.
   */
  async function joinSolanaWallet(handle: SolanaWalletHandle): Promise<string | undefined> {
    const snapshot = sessionController.getSnapshot();
    if (snapshot.profileStatus !== "ready" || snapshot.solanaAddress === handle.address) return undefined;
    if (snapshot.solanaAddress) {
      const held = await readSolanaHoldings();
      const known = held && held.address === snapshot.solanaAddress ? held : undefined;
      if (!known || !holdsNothing(known)) {
        const where = `${snapshot.solanaAddress.slice(0, 4)}…${snapshot.solanaAddress.slice(-4)}`;
        return `Your Solana address stays ${where}, which ${known ? holdingsText(known).replace(/^Holds/, "holds") : "could not be read just now"}. It is not this sign-in's Solana wallet: send from it with the wallet that holds it (Phantom, Solflare or the sign-in that made it), or switch to this sign-in's wallet with the button next to the address.`;
      }
    }
    await addSolanaAddress(handle);
    return undefined;
  }

  /** Opens Privy's window with the private key of a wallet Privy made for this sign-in; the desk never sees the key. */
  async function exportWalletKey(family: "evm" | "solana", address: string) {
    const privy = privyControls();
    if (!privy) return;
    setLinking(`export:${family}`);
    setIdentityNotice(undefined);
    try {
      await privy.exportKey(family, address);
    } catch (error) {
      setIdentityNotice(error instanceof Error ? error.message : "The wallet could not be exported. Try again.");
    } finally {
      setLinking(undefined);
    }
  }

  /**
   * Adds a Solana address to the account: Privy's Solana wallet, or a browser Solana wallet, signs a one-time message
   * naming the account and the address. A new address replaces the old one; nothing moves.
   */
  async function addSolanaAddress(handle?: SolanaWalletHandle) {
    if (!wallet && !sessionController.getSnapshot().wallet) return void setReply("Verify your wallet first.");
    const sessionContext = sessionController.capture();
    setLinking("solana");
    setIdentityNotice(undefined);
    try {
      const { proveSolanaAddress, short, solanaWalletToAdd } = await import("./solana-desk");
      const solanaWallet = handle ?? await solanaWalletToAdd();
      const account = wallet ?? sessionController.getSnapshot().wallet;
      const ethereum = evmProvider();
      // After the first ten minutes of a sign-in, the account's own wallet signs the change too.
      const added = await proveSolanaAddress(solanaWallet, ethereum && account
        ? async (message) => await ethereum.request({ method: "personal_sign", params: [message, account] }) as string
        : undefined);
      await sessionController.refreshProfile(sessionContext);
      if (sessionController.isCurrent(sessionContext)) setReply(`Your Solana address ${short(added)} is on your HaPaPay wallet. Payments on Solana now reach it.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The Solana address was not added.";
      setReply(message);
      setIdentityNotice(message);
    } finally {
      setLinking(undefined);
    }
  }

  async function removeSolanaAddress() {
    if (unlinkConfirm !== "solana") return void setUnlinkConfirm("solana");
    const sessionContext = sessionController.capture();
    setLinking("unlink:solana");
    try {
      const response = await fetch("/api/auth/solana", { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "The Solana address could not be removed.");
      await sessionController.refreshProfile(sessionContext);
      setUnlinkConfirm(undefined);
      setReply("The Solana address was removed from your HaPaPay wallet. Payments on Solana stop reaching it.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The Solana address could not be removed.";
      setReply(message);
      setIdentityNotice(message);
    } finally {
      setLinking(undefined);
    }
  }

  async function linkProvider(provider: Provider) {
    if (!wallet) {
      setReply("Connect your wallet and sign the session message first.");
      return;
    }
    if (!provider.configured) return;
    if (provider.id === "telegram") return;
    setLinking(provider.id);
    setIdentityNotice(undefined);
    try {
      // Claim and pay pages come back to themselves after OAuth; the desk comes back through "/", which reopens it.
      const returnPath = /^\/(?:claim|pay)\//.test(window.location.pathname) ? window.location.pathname : "/";
      const response = await fetch(`/api/oauth/${provider.id}/start${provider.id === "farcaster" ? "" : `?returnTo=${encodeURIComponent(returnPath)}`}`, provider.id === "farcaster" ? { method: "POST" } : undefined);
      const result = await response.json().catch(() => ({})) as { error?: string; authorizationUrl?: string; url?: string; requestId?: string; expiresAt?: string };
      if (!response.ok) throw new Error(result.error ?? `The ${provider.name} connection could not be started. Try again.`);
      if (provider.id === "farcaster") {
        const qrCode = await QRCode.toDataURL(result.url!, { width: 220, margin: 1, color: { dark: "#201638", light: "#ffffff" } });
        setFarcasterRequest({ ...(result as FarcasterRequest), qrCode });
        return;
      }
      window.location.assign(result.authorizationUrl!);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The provider connection could not be started.";
      setReply(message);
      setIdentityNotice(message);
      setLinking(undefined);
    }
  }

  /** Closes the identities dialog the same way from its backdrop, its close button and Escape. */
  function closeIdentities() {
    setManageOpen(false);
    setFarcasterRequest(undefined);
    setLinking(undefined);
    setIdentityNotice(undefined);
    setUnlinkConfirm(undefined);
  }

  /** Opens Telegram's login window straight from the click (so the browser allows it) and links the account it returns. */
  function connectTelegram(provider: Provider) {
    const login = window.Telegram?.Login;
    if (!wallet || !provider.botId || !login?.auth) return void setIdentityNotice("Telegram is still loading. Try again in a moment.");
    const sessionContext = sessionController.capture();
    setLinking(provider.id);
    setIdentityNotice(undefined);
    // Telegram opens its window with window.open and never answers when the browser blocks it, so the window it gets
    // is looked at here (audit, 2026-10-06: a blocked window left the row on "Opening…" and the dialog locked).
    const open = window.open;
    let opened: Window | null | undefined;
    window.open = (...input: Parameters<typeof window.open>) => (opened = open.apply(window, input));
    try {
      login.auth({ bot_id: provider.botId, request_access: false }, (user) => void (async () => {
        try {
          if (!user) throw new Error("Telegram sign-in was cancelled. Nothing was linked.");
          const response = await fetch("/api/oauth/telegram/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(user),
          });
          const result = await response.json().catch(() => ({})) as { error?: string; reason?: string };
          if (!response.ok) throw new Error(result.reason === "setup" ? linkFailureMessage("telegram", "setup") : result.error ?? "Telegram verification failed. Try again.");
          await sessionController.refreshProfile(sessionContext);
          if (sessionController.isCurrent(sessionContext)) setReply("Your Telegram account was verified by Telegram and linked to your wallet.");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Telegram verification failed. Try again.";
          setReply(message);
          setIdentityNotice(message);
        } finally {
          setLinking(undefined);
        }
      })());
    } catch {
      opened = null;
    } finally {
      window.open = open;
    }
    if (opened === null) {
      setLinking(undefined);
      setIdentityNotice("Your browser blocked Telegram's sign-in window. Allow pop-ups for this site, then press Connect again.");
    }
  }

  /**
   * Disconnect: the server clears the session cookie and the desk forgets the wallet. Linked accounts stay linked to it.
   * Wallets that support it (MetaMask) also forget this site; others keep it in their own list of connected sites.
   */
  async function disconnectWallet() {
    const ethereum = evmProvider();
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("The wallet could not be disconnected. Try again.");
    } catch (error) {
      return void setIdentityNotice(error instanceof Error ? error.message : "The wallet could not be disconnected. Try again.");
    }
    try {
      if (privyControls()?.authenticated) await privyControls()!.logout();
      else await ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      // Not every wallet offers this; the session is already gone either way.
    }
    setActiveEvmProvider(undefined);
    setManageOpen(false);
    setIdentityNotice(undefined);
    setUnlinkConfirm(undefined);
    setFarcasterRequest(undefined);
    sessionController.cancel();
    await sessionController.restore();
    setReply("Wallet disconnected. Your linked accounts stay linked to it; verify it again to see them.");
  }

  async function unlinkIdentity(platform: string) {
    if (unlinkConfirm !== platform) {
      setUnlinkConfirm(platform);
      return;
    }
    if (!wallet) return;
    const sessionContext = sessionController.capture();
    setLinking(`unlink:${platform}`);
    try {
      const response = await fetch(`/api/identity/${platform}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await sessionController.refreshProfile(sessionContext);
      if (!sessionController.isCurrent(sessionContext)) return;
      setReply(`The ${platform} identity and payment route were removed.`);
      setUnlinkConfirm(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The identity could not be removed.";
      setReply(message);
      setIdentityNotice(message);
    } finally {
      setLinking(undefined);
    }
  }

  /** Copies an account's payment link from the identities dialog, and says so there, where the person is looking. */
  async function copyPaymentLink(platform: string, username: string) {
    const url = `${window.location.origin}/pay/${platform}/${encodeURIComponent(username)}`;
    try {
      await navigator.clipboard.writeText(url);
      setIdentityNotice(`The payment link for @${username} was copied: ${url}`);
    } catch {
      setIdentityNotice(`Copy the payment link for @${username}: ${url}`);
    }
  }

  async function switchWalletChain(chain: { chainId: `0x${string}`; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrl: string; explorerUrl?: string }) {
    const ethereum = evmProvider();
    if (!ethereum) throw new Error("No EVM-compatible wallet was found.");
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.chainId }] });
    } catch (switchError) {
      if ((switchError as { code?: number }).code !== 4902) throw switchError;
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chain.chainId,
          chainName: chain.chainName,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [chain.rpcUrl],
          blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : undefined,
        }],
      });
    }
  }

  /** The wallet's Arc network entry comes from the bundled chain constants, never from a server response. */
  async function switchToArc(arcNetwork: ArcNetworkId) {
    const chain = arcWalletChain(arcNetwork);
    await switchWalletChain({ chainId: chain.chainId, chainName: chain.chainName, nativeCurrency: chain.nativeCurrency, rpcUrl: chain.rpcUrls[0], explorerUrl: chain.blockExplorerUrls[0] });
  }

  /** The Arc network the server runs, for calls that are not tied to a reviewed network preference. */
  function runtimeArcNetwork(): ArcNetworkId {
    if (!network.ready || !network.environment) throw new Error("The Arc network is not available on this server.");
    return `arc-${network.environment}`;
  }

  /** The wallet's Robinhood network entry comes from the bundled chain constants, never from a server response. */
  async function switchStockChain(stockNetwork: StockNetworkId) {
    const chain = STOCK_CHAINS[stockNetwork];
    await switchWalletChain({ chainId: `0x${chain.id.toString(16)}`, chainName: chain.name, nativeCurrency: ETHER, rpcUrl: chain.rpcUrl, explorerUrl: chain.explorerUrl });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await sendRequest(message);
  }

  /**
   * Sends one typed or picked request to the desk. The answer says which network its asset runs on: a USDC review is
   * bound to the Arc network this server runs at that moment, a token review to the Robinhood network it names.
   */
  async function sendRequest(text: string) {
    if (!text.trim() || busy || chatRequestRef.current !== undefined) return;
    const reviewEpoch = ++reviewEpochRef.current;
    const reviewArc = arcNetwork;
    const requestId = ++chatSequenceRef.current;
    const requestMessage = text.trim();
    chatRequestRef.current = requestId;
    updateConversation({ type: "request", id: requestId, message: requestMessage });
    setMessage("");
    setBusy(true);
    setDraft(null);
    setClaimDraft(null);
    setStockDraft(null);
    setBatchDraft(null);
    setBatchStates([]);
    setStockTransaction(undefined);
    setStockEligibility(false);
    setStockClaimDraft(null);
    setStockClaimFunding(undefined);
    setSolanaDraft(null);
    setSolanaClaimDraft(null);
    setClaimLink(undefined);
    setArcClaimFunding(undefined);
    setTransactionHash(undefined);
    setTransactionStatus(undefined);
    // A short answer ("each", "X", "yes") goes with the request the last reply asked about; the server reads it again.
    const answering = pendingQuestion;
    setPendingQuestion(undefined);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: requestMessage, ...(answering ? { answering: { request: answering } } : {}) }),
      });
      const result = await response.json();
      if (reviewEpoch !== reviewEpochRef.current) return;
      const responseMessage = result.message ?? result.error ?? "The assistant could not prepare a payment. Try a recipient, platform, and USDC amount.";
      const offered = Array.isArray(result.suggestions) ? result.suggestions.filter((item: unknown): item is string => typeof item === "string" && item.length <= 500).slice(0, 3) : undefined;
      setReply(responseMessage);
      updateConversation({ type: "reply", id: requestId, message: responseMessage, suggestions: offered });
      if (typeof result.question?.request === "string" && result.question.request.length <= 500) setPendingQuestion(result.question.request);
      const note = typeof result.note === "string" ? result.note : undefined;
      if (result.status === "solana_review" && result.solana && Array.isArray(result.solana.payments)) setSolanaDraft({ id: requestId, review: result.solana });
      else if (result.status === "solana_claim_review" && result.solana && isStockClaimPlatform(result.solana.recipient?.platform)) setSolanaClaimDraft({ id: requestId, review: { ...result.solana, lock: vaultLockOf(result.vaultLock) } });
      else if (result.status === "ready_for_review") setDraft({ ...result, arcNetwork: reviewArc, note });
      else if (result.status === "stock_review") setStockDraft({ intent: result.stockIntent, network: result.stockNetwork, resolvedAddress: result.resolvedAddress, units: result.units, note });
      else if (result.status === "batch_review" && result.batch && Array.isArray(result.batch.payments)) {
        const batch = result.batch;
        setBatchDraft({
          rows: batch.payments,
          asset: batch.asset,
          ...(batch.asset.type === "usdc" ? { arcNetwork: reviewArc } : { stockNetwork: result.stockNetwork }),
          mode: batch.mode,
          amount: batch.amount,
          totalAmount: batch.totalAmount,
          totalUnits: batch.totalUnits,
          sourcePlatform: batch.sourcePlatform,
          note: typeof batch.note === "string" ? batch.note : "",
        });
        setBatchStates(batch.payments.map(() => ({ status: "waiting" as const })));
      }
      else if (result.status === "stock_claim_review" && isStockClaimPlatform(result.stockIntent?.recipient?.platform)) {
        setStockClaimDraft({ intent: result.stockIntent, platform: result.stockIntent.recipient.platform, network: result.stockNetwork, units: result.units, escrow: result.escrow, expiryHours: result.expiryHours, lock: vaultLockOf(result.vaultLock) });
      }
      else if (result.status === "claim_review" && isStockClaimPlatform(result.intent?.recipient?.platform)) {
        setClaimDraft({ intent: result.intent, arcNetwork: reviewArc, expiryHours: Number.isInteger(result.expiryHours) ? result.expiryHours : STOCK_CLAIM_WINDOW_HOURS.default, lock: vaultLockOf(result.vaultLock) });
      }
    } catch {
      if (reviewEpoch !== reviewEpochRef.current) return;
      const errorMessage = "The payment assistant is unavailable. Try again in a moment.";
      setReply(errorMessage);
      updateConversation({ type: "reply", id: requestId, message: errorMessage });
    } finally {
      if (chatRequestRef.current === requestId) chatRequestRef.current = undefined;
      setBusy(false);
    }
  }

  async function fundClaim() {
    if (!claimDraft) return;
    if (!claimDraft.arcNetwork || claimDraft.arcNetwork !== arcNetwork || !arcAvailable) return void setReply("The Arc network changed since this review. Write the request again.");
    const ethereum = await signingWallet();
    if (!ethereum || !wallet) return;
    const reviewEpoch = reviewEpochRef.current;
    let funding: { paymentId: string; hash: string } | undefined;
    setBusy(true);
    try {
      const response = await fetch("/api/claims/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: claimDraft.intent.recipient.platform,
          username: claimDraft.intent.recipient.username,
          amount: claimDraft.intent.amount,
          expiryHours: claimDraft.expiryHours,
          lock: claimDraft.lock,
          sourcePlatform: claimDraft.intent.sourcePlatform,
          networkPreference: claimDraft.arcNetwork,
        }),
      });
      const prepared = await response.json();
      // X did not answer the lookup for an account lock: the slip now offers the name lock, and nothing was signed.
      if (response.status === 409 && prepared.lock === "name") {
        setClaimDraft((current) => current ? { ...current, lock: "name" } : current);
        throw new Error(prepared.error);
      }
      if (!response.ok) throw new Error(prepared.error);
      if (reviewEpoch !== reviewEpochRef.current || prepared.networkId !== claimDraft.arcNetwork) {
        throw new Error("The prepared route is not the reviewed Arc network. Review it again.");
      }
      if (prepared.identity?.lock !== claimDraft.lock || !isArcNetworkId(prepared.networkId) || !matchesArcClaimFunding(prepared, {
        network: prepared.networkId,
        platform: claimDraft.intent.recipient.platform,
        amount: claimDraft.intent.amount,
        wallet,
        now: new Date(),
      })) throw new Error("The prepared escrow funding does not match this review. Nothing was signed.");
      await switchToArc(prepared.networkId);
      for (const transaction of prepared.transactions) {
        if (reviewEpoch !== reviewEpochRef.current) throw new Error("A new request replaced this review. Funding was stopped.");
        setReply(transaction.purpose === "approve" ? `Approve exactly ${prepared.fee.totalAmount} USDC in your wallet: ${claimDraft.intent.amount} for @${claimDraft.intent.recipient.username} and the ${platformFeePercent(prepared.fee.feeBps)} fee, held with it until the claim.` : `The second signature places the USDC in the vault for ${windowLabel(claimDraft.expiryHours)}.`);
        const hash = await ethereum.request({ method: "eth_sendTransaction", params: [walletRpcTransaction(transaction)] }) as string;
        if (transaction.purpose === "fund") {
          // From here the link is funded or about to be: the slip keeps its hash and verifies it, and never funds again
          // (audit, 2026-10-06: a failed verification left the fund button, and a second press funded a second link).
          funding = { paymentId: prepared.paymentId, hash };
          // Its record request is kept in this browser until the server has it, and sent again after the next sign-in
          // if this tab closes first (audit, 2026-10-06: such a link reached no Claims list).
          rememberUnrecordedFunding({ url: "/api/claims/confirm-funding", body: arcClaimConfirmation(claimDraft, funding), wallet, transaction: hash });
          setArcClaimFunding(funding);
          setTransactionHash(hash);
          setTransactionStatus("pending");
        }
        await waitForTransactionReceipt(receiptSource("arc", hash, ethereum), {
          attempts: RECEIPT_ATTEMPTS,
          revertedMessage: transaction.purpose === "approve" ? "The USDC approval reverted; nothing was reserved." : ARC_FUNDING_REVERTED,
        });
      }
      if (!funding) throw new Error("Escrow funding transaction was not returned.");
      await confirmArcClaimFunding(claimDraft, funding);
    } catch (error) {
      if (error instanceof Error && error.message === ARC_FUNDING_REVERTED) {
        // Nothing reached the vault, so the slip offers the funding again.
        if (funding) forgetUnrecordedFunding(funding.hash);
        setArcClaimFunding(undefined);
        setTransactionHash(undefined);
        setTransactionStatus(undefined);
      } else {
        // A funding that left the wallet is verified again from the slip, never funded twice.
        setTransactionStatus((current) => current === "pending" ? "verification_failed" : current);
      }
      setReply(error instanceof Error ? error.message : "The social escrow could not be funded.");
    } finally {
      setBusy(false);
    }
  }

  /** Records a funded Arc vault link once the server finds its exact PaymentCreated event, and shows its claim link. */
  async function confirmArcClaimFunding(review: ClaimDraft, funding: { paymentId: string; hash: string }) {
    const response = await fetch("/api/claims/confirm-funding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(arcClaimConfirmation(review, funding)),
    });
    const confirmed = await response.json().catch(() => ({})) as { claimPath?: string; expiresAt?: string; error?: string };
    if (!response.ok || !confirmed.claimPath) {
      setTransactionStatus("verification_failed");
      throw new Error(`${confirmed.error ?? "The vault funding could not be verified yet."} Your USDC is in the vault; verify it again to get the claim link.`);
    }
    forgetUnrecordedFunding(funding.hash);
    setClaimLink(`${window.location.origin}${confirmed.claimPath}`);
    setTransactionStatus("confirmed");
    void loadPendingClaims();
    // Recorded after its window closed, a link can only be taken back (from Claims), not claimed.
    if (confirmed.expiresAt && Date.parse(confirmed.expiresAt) <= Date.now()) return void setReply(`The link is recorded, but its window has closed, so @${review.intent.recipient.username} can no longer claim it. Take the USDC back under Claims.`);
    setReply(review.lock === "name"
      ? `USDC is verified in the vault for the ${platformName(review.intent.recipient.platform)} name @${review.intent.recipient.username}. Send them this link; they claim it within ${windowLabel(review.expiryHours)} by connecting ${platformName(review.intent.recipient.platform)} with that name, and it also waits under their Claims once they do.`
      : `USDC is verified in the vault. Send this link to @${review.intent.recipient.username}; they claim it with their official ${platformName(review.intent.recipient.platform)} account within ${windowLabel(review.expiryHours)}, and it also waits under their Claims once they link that account.`);
  }

  async function verifyArcClaimAgain() {
    if (!claimDraft || !arcClaimFunding || busy) return;
    setBusy(true);
    try {
      await confirmArcClaimFunding(claimDraft, arcClaimFunding);
    } catch (error) {
      setReply(error instanceof Error ? error.message : "The vault funding could not be verified yet.");
    } finally {
      setBusy(false);
    }
  }

  async function redeemClaim(action: "claim" | "refund") {
    if (!claimTarget || !arcNetwork) return;
    if (!await signingWallet()) return;
    setBusy(true);
    try {
      await signArcVaultAction(claimTarget, action, (hash) => {
        setTransactionHash(hash);
        setTransactionStatus("pending");
      });
      setTransactionStatus("confirmed");
      setReply(action === "claim" ? "USDC was claimed to your wallet and verified onchain." : "The expired payment was refunded to the sender's wallet.");
      void loadPendingClaims();
    } catch (error) {
      setReply(error instanceof Error ? error.message : "The social escrow transaction could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Prepares the claim or refund of an Arc vault link on the server and opens the wallet only for exactly that call
   * from this wallet, on the bundled Arc chain, then waits for its receipt. The claim page and Pending claims share it.
   */
  async function signArcVaultAction(paymentId: string, action: "claim" | "refund", onSubmitted: (hash: string) => void) {
    const ethereum = evmProvider();
    if (!ethereum || !wallet) throw new Error("Verify your wallet first.");
    const response = await fetch(`/api/claims/${paymentId}/prepare-${action}`, { method: "POST" });
    const prepared = await response.json();
    if (!response.ok) throw new Error(prepared.error);
    if (!matchesArcClaimAction(prepared, { action, paymentId, wallet })) throw new Error(`The prepared ${action} does not match this link and wallet. Nothing was signed.`);
    await switchToArc(runtimeArcNetwork());
    const hash = await ethereum.request({ method: "eth_sendTransaction", params: [walletRpcTransaction(prepared.transaction)] }) as string;
    onSubmitted(hash);
    const receipt = await waitForTransactionReceipt(receiptSource("arc", hash, ethereum), { attempts: RECEIPT_ATTEMPTS, revertedMessage: `The ${action} reverted; no USDC moved.` });
    // A claimed link earns SP for the claimer and its sender; the server checks the claim in this receipt.
    if (action === "claim" && runtimeArcNetwork() === "arc-mainnet") void reportSpClaim({ network: "arc", paymentId, transaction: hash });
    return receipt;
  }

  async function signPayment() {
    if (!draft) return;
    if (!draft.arcNetwork || draft.arcNetwork !== arcNetwork || !arcAvailable) return void setReply("The Arc network changed since this review. Write the request again.");
    const ethereum = await signingWallet();
    if (!ethereum || !wallet) return;
    const note = checkPaymentNote(draft.note);
    if (!note.ok) return void setReply(note.error);
    const reviewEpoch = reviewEpochRef.current;
    const sessionContext = sessionController.capture();
    setBusy(true);
    try {
      const response = await fetch("/api/payment/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft.intent, expectedRecipientAddress: draft.resolvedAddress, networkPreference: draft.arcNetwork, ...(note.note ? { note: note.note } : {}) }),
      });
      const prepared = await response.json();
      if (!response.ok) throw new Error(prepared.error);
      if (reviewEpoch !== reviewEpochRef.current || prepared.networkId !== draft.arcNetwork) {
        throw new Error("The prepared route is not the reviewed Arc network. Review it again.");
      }
      if (!isArcNetworkId(prepared.networkId) || !matchesArcPayment(prepared, { network: prepared.networkId, recipient: draft.resolvedAddress, amount: draft.intent.amount, wallet, note: note.note })) {
        throw new Error("The prepared payment does not match this review. Nothing was signed.");
      }
      await switchToArc(prepared.networkId);
      // Through the fee router the wallet approves the amount plus the fee, then pays; a testnet without one transfers.
      const calls: Array<{ purpose?: string; to: string; data: string; value: string; from?: string }> = prepared.transactions ?? [prepared.transaction];
      let hash = "";
      let receipt: { status: string; blockNumber: string } | undefined;
      for (const call of calls) {
        if (reviewEpoch !== reviewEpochRef.current) throw new Error("A new request replaced this review. Signing was stopped.");
        if (call.purpose === "approve") setReply(`Approve exactly ${prepared.fee.totalAmount} USDC for HaPaPay in your wallet: ${draft.intent.amount} for @${draft.intent.recipient.username} and the ${platformFeePercent(prepared.fee.feeBps)} fee.`);
        hash = await ethereum.request({ method: "eth_sendTransaction", params: [walletRpcTransaction(call)] }) as string;
        if (call.purpose !== "approve") {
          setTransactionHash(hash);
          setTransactionStatus("pending");
          setReply("The transaction was submitted from your wallet. Waiting for chain confirmation; the payment is not complete yet.");
        }
        receipt = await waitForTransactionReceipt(receiptSource("arc", hash, ethereum), {
          attempts: RECEIPT_ATTEMPTS,
          revertedMessage: call.purpose === "approve" ? "The USDC approval reverted; nothing moved." : ARC_PAYMENT_REVERTED,
        });
      }
      if (!receipt) throw new Error("No payment transaction was prepared.");
      await confirmArcPayment(draft, hash);
      setReply(`Payment verified in Arc block ${Number.parseInt(receipt.blockNumber, 16)}.`);
      void sessionController.refreshPayments(sessionContext);
    } catch (error) {
      if (error instanceof Error && error.message === ARC_PAYMENT_REVERTED) {
        // No USDC moved, so the slip offers the payment again.
        setTransactionHash(undefined);
        setTransactionStatus(undefined);
      } else {
        // A payment that left the wallet is verified again from the slip (audit, 2026-10-06), never sent twice.
        setTransactionStatus((current) => current === "pending" ? "verification_failed" : current);
      }
      setReply(error instanceof Error ? error.message : "The transaction was not signed.");
    } finally {
      setBusy(false);
    }
  }

  /** Records a mined Arc payment once the server finds its exact USDC transfer; 409 means it is already recorded. */
  async function confirmArcPayment(review: NonNullable<typeof draft>, hash: string) {
    const response = await fetch("/api/payments/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionHash: hash,
        amount: review.intent.amount,
        sourcePlatform: review.intent.sourcePlatform,
        recipient: review.intent.recipient,
      }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (response.ok || response.status === 409) {
      setTransactionStatus("confirmed");
      return;
    }
    setTransactionStatus("verification_failed");
    throw new Error(`${result.error ?? "The payment could not be verified yet."} If it reached @${review.intent.recipient.username}, verify it again; nothing is sent twice.`);
  }

  async function verifyArcPaymentAgain() {
    if (!draft || !transactionHash || busy) return;
    const sessionContext = sessionController.capture();
    setBusy(true);
    try {
      await confirmArcPayment(draft, transactionHash);
      setReply(`${draft.intent.amount} USDC to @${draft.intent.recipient.username} is verified on ${arcLabel}.`);
      void sessionController.refreshPayments(sessionContext);
    } catch (error) {
      setReply(error instanceof Error ? error.message : "The receipt could not be verified yet.");
    } finally {
      setBusy(false);
    }
  }

  /** Records a mined stock-token transfer after the server finds its exact Transfer log. */
  async function confirmStockTransfer(review: StockDraft, hash: string) {
    const chain = STOCK_CHAINS[review.network];
    const response = await fetch("/api/stocks/transfers/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        network: review.network,
        token: { symbol: review.intent.asset.symbol, address: review.intent.asset.address },
        amount: review.intent.amount,
        recipient: review.intent.recipient,
        sourcePlatform: review.intent.sourcePlatform,
        transactionHash: hash,
      }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    // 409 means this exact transfer is already in the history, for example after a lost response.
    if (response.ok || response.status === 409) {
      setStockTransaction((current) => current?.hash === hash ? { ...current, status: "confirmed" } : current);
      return;
    }
    setStockTransaction((current) => current?.hash === hash ? { ...current, status: "verification_failed" } : current);
    throw new Error(result.error ?? `The ${chain.name} receipt could not be verified yet.`);
  }

  async function signStockTransfer() {
    const review = stockDraft;
    if (!review) return;
    const availability = transferAvailabilityFor(stockSnapshots[review.network].transfers, review.intent.asset);
    if (!availability.enabled) return void setReply(availability.reason ?? "Transfers of this token are not available on this server right now.");
    const ethereum = await signingWallet();
    if (!ethereum || !wallet) return;
    const chain = STOCK_CHAINS[review.network];
    const { symbol, address: token } = review.intent.asset;
    // Only Robinhood Stock Tokens carry the issuer's eligibility rules; USDG does not.
    const needsStatement = !chain.testAssets && isStockToken(review.intent.asset);
    if (needsStatement && !stockEligibility) return void setReply("Confirm the Stock Token eligibility statement before signing.");
    const note = checkPaymentNote(review.note);
    if (!note.ok) return void setReply(note.error);
    const reviewEpoch = reviewEpochRef.current;
    const sessionContext = sessionController.capture();
    let submittedHash: string | undefined;
    setBusy(true);
    try {
      const response = await fetch("/api/stocks/transfers/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: review.network,
          token: { symbol, address: token },
          amount: review.intent.amount,
          recipient: review.intent.recipient,
          sourcePlatform: review.intent.sourcePlatform,
          expectedRecipientAddress: review.resolvedAddress,
          ...(needsStatement ? { eligibilityConfirmed: stockEligibility } : {}),
          ...(note.note ? { note: note.note } : {}),
        }),
      });
      const prepared = await response.json() as PreparedStockTransfer & { error?: string };
      if (!response.ok) throw new Error(prepared.error ?? "The stock-token transfer could not be prepared.");
      if (reviewEpoch !== reviewEpochRef.current) throw new Error("A new request replaced this review. Review the transfer again.");
      const reviewedRouter = stockSnapshots[review.network].fees?.router ?? null;
      if (!matchesStockReview(prepared, { network: review.network, token, sender: wallet, recipient: review.resolvedAddress, units: review.units, note: note.note, router: reviewedRouter })) {
        throw new Error(prepared.fee && !reviewedRouter
          ? `HaPaPay's ${platformFeePercent(prepared.fee.feeBps)} fee applies to this transfer, but the review did not show it. Your wallet was not opened; wait a moment for the fee to appear, then sign again.`
          : "The prepared transaction does not match your review, so your wallet was not opened.");
      }
      await switchStockChain(review.network);
      // One transfer while no fee router runs on the network; with one, an approval of the amount plus the fee, then pay.
      const calls = prepared.transactions ?? (prepared.transaction ? [{ ...prepared.transaction, purpose: "transfer" as const }] : []);
      let receipt: { status: string; blockNumber: string } | undefined;
      for (const call of calls) {
        if (reviewEpoch !== reviewEpochRef.current) throw new Error("A new request replaced this review. Signing was stopped.");
        if (call.purpose === "approve" && prepared.fee) {
          setReply(`Approve exactly ${prepared.fee.totalAmount} ${symbol} for HaPaPay in your wallet: ${review.intent.amount} for @${review.intent.recipient.username} plus the ${platformFeePercent(prepared.fee.feeBps)} fee.`);
        }
        const hash = await ethereum.request({ method: "eth_sendTransaction", params: [walletRpcTransaction(call)] }) as string;
        if (call.purpose !== "approve") {
          submittedHash = hash;
          setStockTransaction({ hash, network: review.network, status: "pending" });
          setReply(`The ${symbol} transfer was submitted from your wallet. Waiting for ${chain.name} to confirm it.`);
        }
        receipt = await waitForTransactionReceipt(
          receiptSource(review.network, hash, ethereum),
          { attempts: RECEIPT_ATTEMPTS, revertedMessage: call.purpose === "approve" ? `The ${symbol} approval reverted; nothing moved.` : `The ${chain.name} transaction reverted; no ${symbol} moved.` },
        );
      }
      if (!submittedHash || !receipt) throw new Error("The transfer transaction was not returned.");
      await confirmStockTransfer(review, submittedHash);
      setReply(`${review.intent.amount} ${symbol} reached @${review.intent.recipient.username}. Verified in ${chain.name} block ${Number.parseInt(receipt.blockNumber, 16)}.`);
      void sessionController.refreshPayments(sessionContext);
    } catch (error) {
      if (submittedHash) {
        const failedHash = submittedHash;
        setStockTransaction((current) => current?.hash === failedHash && current.status === "pending" ? { ...current, status: "verification_failed" } : current);
      }
      setReply(error instanceof Error ? error.message : "The stock-token transfer was not signed.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyStockTransferAgain() {
    if (!stockDraft || !stockTransaction || busy) return;
    const sessionContext = sessionController.capture();
    setBusy(true);
    try {
      await confirmStockTransfer(stockDraft, stockTransaction.hash);
      setReply(`${stockDraft.intent.amount} ${stockDraft.intent.asset.symbol} to @${stockDraft.intent.recipient.username} is verified on ${STOCK_CHAINS[stockTransaction.network].name}.`);
      void sessionController.refreshPayments(sessionContext);
    } catch (error) {
      setReply(error instanceof Error ? error.message : "The receipt could not be verified yet.");
    } finally {
      setBusy(false);
    }
  }

  /** Records one sent payment of a batch after the server finds its exact Transfer log; 409 means it is already recorded. */
  async function confirmBatchPayment(review: BatchDraft, row: BatchRow, hash: string) {
    const response = review.stockNetwork && review.asset.type === "stock-token"
      ? await fetch("/api/stocks/transfers/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: review.stockNetwork, token: { symbol: review.asset.symbol, address: review.asset.address }, amount: row.amount, recipient: row.recipient, sourcePlatform: review.sourcePlatform, transactionHash: hash }),
      })
      : await fetch("/api/payments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionHash: hash, amount: row.amount, sourcePlatform: review.sourcePlatform, recipient: row.recipient }),
      });
    if (response.ok || response.status === 409) return;
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? "The receipt could not be verified yet.");
  }

  /**
   * Signs a reviewed batch: the server prepares the payments not sent yet, the browser checks them against the review,
   * then the wallet signs at most one approval and one payment per person, each recorded as soon as its receipt is in.
   * Stopping keeps what went through; the rest can be sent afterwards without paying anyone twice.
   */
  async function signBatch() {
    const review = batchDraft;
    if (!review || busy) return;
    const ethereum = await signingWallet();
    if (!ethereum || !wallet) return;
    const note = checkPaymentNote(review.note);
    if (!note.ok) return void setReply(note.error);
    const pending = review.rows.map((row, index) => ({ row, index })).filter(({ index }) => ["waiting", "failed"].includes(batchStates[index]?.status ?? "waiting"));
    if (!pending.length) return;
    const symbol = review.asset.symbol;
    const reviewEpoch = reviewEpochRef.current;
    const sessionContext = sessionController.capture();
    const recipients = pending.map(({ row }) => ({ ...row.recipient, amount: row.amount, expectedRecipientAddress: row.resolvedAddress }));
    const mark = (index: number, state: BatchRowState) => setBatchStates((current) => current.map((entry, position) => position === index ? state : entry));
    let signing: number | undefined;
    // Whether any payment of this batch has left the wallet, before this press or during it.
    let sentAny = batchStates.some((state) => ["pending", "confirmed", "unverified"].includes(state?.status ?? ""));
    setBusy(true);
    try {
      let prepared: (PreparedStockBatch | (Parameters<typeof matchesArcBatch>[0] & { totalAmount: string })) & { error?: string };
      let source: "arc" | StockNetworkId;
      if (review.stockNetwork && review.asset.type === "stock-token") {
        const stockNetwork = review.stockNetwork;
        const chain = STOCK_CHAINS[stockNetwork];
        const fees = stockSnapshots[stockNetwork].fees;
        if (!fees) throw new Error(`Payments to several people run through the ${chain.name} fee router, which this server does not run yet.`);
        const needsStatement = !chain.testAssets && isStockToken(review.asset);
        if (needsStatement && !stockEligibility) throw new Error("Confirm the Stock Token eligibility statement before signing.");
        const response = await fetch("/api/stocks/transfers/prepare-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ network: stockNetwork, token: { symbol, address: review.asset.address }, recipients, sourcePlatform: review.sourcePlatform, ...(note.note ? { note: note.note } : {}), ...(needsStatement ? { eligibilityConfirmed: stockEligibility } : {}) }),
        });
        prepared = await response.json();
        if (!response.ok) throw new Error(prepared.error ?? "The payments could not be prepared.");
        if (reviewEpoch !== reviewEpochRef.current) throw new Error("A new request replaced this review. Review the payments again.");
        if (!matchesStockBatch(prepared as PreparedStockBatch, { network: stockNetwork, token: review.asset.address, router: fees.router, sender: wallet, note: note.note, payments: pending.map(({ row }) => ({ recipient: row.resolvedAddress, units: row.units })) })) {
          throw new Error("The prepared payments do not match your review, so your wallet was not opened.");
        }
        await switchStockChain(stockNetwork);
        source = stockNetwork;
      } else {
        if (!review.arcNetwork || review.arcNetwork !== arcNetwork || !arcAvailable) throw new Error("The Arc network changed since this review. Write the request again.");
        if (!network.fees) throw new Error(`Payments to several people run through the ${arcLabel} fee router, which this server does not run yet.`);
        const response = await fetch("/api/payment/prepare-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipients, sourcePlatform: review.sourcePlatform, networkPreference: review.arcNetwork, ...(note.note ? { note: note.note } : {}) }),
        });
        prepared = await response.json();
        if (!response.ok) throw new Error(prepared.error ?? "The payments could not be prepared.");
        if (reviewEpoch !== reviewEpochRef.current) throw new Error("A new request replaced this review. Review the payments again.");
        if (!matchesArcBatch(prepared as Parameters<typeof matchesArcBatch>[0], { network: review.arcNetwork, router: network.fees.router, wallet, note: note.note, payments: pending.map(({ row }) => ({ recipient: row.resolvedAddress, amount: row.amount })) })) {
          throw new Error("The prepared payments do not match this review. Nothing was signed.");
        }
        await switchToArc(review.arcNetwork);
        source = "arc";
      }
      if (prepared.approval) {
        setReply(`Approve exactly ${prepared.totalAmount} ${symbol} for HaPaPay in your wallet: ${pending.length} ${pending.length === 1 ? "payment" : "payments"} and the ${platformFeePercent(prepared.feeBps)} fee on each. Then sign one payment for each person.`);
        const approval = await ethereum.request({ method: "eth_sendTransaction", params: [walletRpcTransaction(prepared.approval)] }) as string;
        await waitForTransactionReceipt(receiptSource(source, approval, ethereum), { attempts: RECEIPT_ATTEMPTS, revertedMessage: `The ${symbol} approval reverted; nothing moved.` });
      }
      for (const [position, payment] of prepared.payments.entries()) {
        const { row, index } = pending[position];
        if (reviewEpoch !== reviewEpochRef.current) throw new Error("A new request replaced this review. Signing was stopped.");
        signing = index;
        mark(index, { status: "signing" });
        setReply(`Sign payment ${position + 1} of ${prepared.payments.length} in your wallet: ${row.amount} ${symbol} to @${row.recipient.username}.`);
        const hash = await ethereum.request({ method: "eth_sendTransaction", params: [walletRpcTransaction(payment.transaction)] }) as string;
        signing = undefined;
        sentAny = true;
        mark(index, { status: "pending", hash });
        const reverted = `The payment to @${row.recipient.username} reverted; nothing moved.`;
        try {
          await waitForTransactionReceipt(receiptSource(source, hash, ethereum), { attempts: RECEIPT_ATTEMPTS, revertedMessage: reverted });
          await confirmBatchPayment(review, row, hash);
          mark(index, { status: "confirmed", hash });
        } catch (error) {
          // A reverted payment moved nothing and can be sent again; one that may have gone through is only checked.
          mark(index, error instanceof Error && error.message === reverted ? { status: "failed" } : { status: "unverified", hash });
          throw error;
        }
      }
      setReply(`All ${review.rows.length} payments are verified${note.note ? ", each with its note on chain" : ""}.`);
      void sessionController.refreshPayments(sessionContext);
    } catch (error) {
      // The wallet closed without sending this one: nothing moved, so it can be sent again.
      if (signing !== undefined) mark(signing, { status: "failed" });
      const message = error instanceof Error ? error.message : "The payments were not signed.";
      // Only a batch that sent something says so (audit, 2026-10-06: one refused before the wallet opened said it).
      setReply(sentAny ? `${message} Payments that went through stay sent; the button sends only the others.` : message);
      void sessionController.refreshPayments(sessionContext);
    } finally {
      setBusy(false);
    }
  }

  /** Reads the receipts of batch payments that were sent but not recorded yet, and records them. */
  async function verifyBatchAgain() {
    const review = batchDraft;
    if (!review || busy) return;
    const sessionContext = sessionController.capture();
    setBusy(true);
    try {
      for (const [index, state] of batchStates.entries()) {
        if (state.status !== "unverified" || !state.hash) continue;
        await confirmBatchPayment(review, review.rows[index], state.hash);
        setBatchStates((current) => current.map((entry, position) => position === index ? { status: "confirmed", hash: state.hash } : entry));
      }
      setReply("The sent payments are verified.");
      void sessionController.refreshPayments(sessionContext);
    } catch (error) {
      setReply(error instanceof Error ? error.message : "The receipts could not be verified yet.");
    } finally {
      setBusy(false);
    }
  }

  /** Records a funded claim link after the server finds the exact PaymentCreated event from the escrow. */
  async function confirmStockClaimFunding(review: StockClaimDraft, funding: { paymentId: `0x${string}`; escrow: `0x${string}`; hash: string }) {
    const chain = STOCK_CHAINS[review.network];
    const response = await fetch("/api/stocks/claims/confirm-funding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stockClaimConfirmation(review, funding)),
    });
    const result = await response.json().catch(() => ({})) as { claimPath?: string; error?: string };
    if (response.ok && result.claimPath) {
      forgetUnrecordedFunding(funding.hash);
      const link = `${window.location.origin}${result.claimPath}`;
      setStockClaimFunding((current) => current?.hash === funding.hash ? { ...current, status: "confirmed", link } : current);
      void loadPendingClaims();
      return link;
    }
    setStockClaimFunding((current) => current?.hash === funding.hash ? { ...current, status: "verification_failed" } : current);
    throw new Error(result.error ?? `The ${chain.name} escrow receipt could not be verified yet.`);
  }

  async function fundStockClaim() {
    const review = stockClaimDraft;
    if (!review || busy) return;
    const claims = stockSnapshots[review.network].claims;
    const holdsAsset = isStockToken(review.intent.asset) ? claims?.stockTokens !== false : claims?.tokens !== false;
    if (!claims?.enabled || claims.escrow !== review.escrow || !holdsAsset) return void setReply(claims?.reason ?? "Vault links are not available on this server right now.");
    const ethereum = await signingWallet();
    if (!ethereum || !wallet) return;
    const chain = STOCK_CHAINS[review.network];
    const { symbol, address: token } = review.intent.asset;
    const needsStatement = !chain.testAssets && isStockToken(review.intent.asset);
    if (needsStatement && !stockEligibility) return void setReply("Confirm the Stock Token eligibility statement before reserving tokens.");
    const reviewEpoch = reviewEpochRef.current;
    const fundingReverted = `The escrow funding reverted; your ${symbol} stayed in your wallet.`;
    let submitted: { paymentId: `0x${string}`; escrow: `0x${string}`; hash: string } | undefined;
    setBusy(true);
    try {
      const response = await fetch("/api/stocks/claims/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: review.network,
          token: { symbol, address: token },
          amount: review.intent.amount,
          recipient: review.intent.recipient,
          lock: review.lock,
          sourcePlatform: review.intent.sourcePlatform,
          expiryHours: review.expiryHours,
          ...(needsStatement ? { eligibilityConfirmed: stockEligibility } : {}),
        }),
      });
      const prepared = await response.json() as PreparedStockClaimFunding & { error?: string; lock?: VaultLock };
      // X did not answer the lookup for an account lock: the slip now offers the name lock, and nothing was signed.
      if (response.status === 409 && prepared.lock === "name") {
        setStockClaimDraft((current) => current ? { ...current, lock: "name" } : current);
        throw new Error(prepared.error ?? "This link can wait for the name instead. Check it and reserve it again.");
      }
      if (!response.ok) throw new Error(prepared.error ?? "The claim link could not be prepared.");
      if (reviewEpoch !== reviewEpochRef.current) throw new Error("A new request replaced this review. Review the claim link again.");
      if (prepared.lock !== review.lock || !matchesStockClaimFunding(prepared, {
        network: review.network, token, payer: wallet, units: review.units, escrow: review.escrow, platform: review.platform, nowSeconds: Math.floor(Date.now() / 1000),
      })) {
        throw new Error("The prepared transactions do not match your review, so your wallet was not opened.");
      }
      await switchStockChain(review.network);
      const funding = { paymentId: prepared.paymentId, escrow: prepared.escrow };
      setStockClaimFunding({ ...funding, status: prepared.transactions[0]?.purpose === "approve" ? "approving" : "funding" });
      for (const transaction of prepared.transactions) {
        if (reviewEpoch !== reviewEpochRef.current) throw new Error("A new request replaced this review. Funding was stopped.");
        setReply(transaction.purpose === "approve"
          ? `Approve exactly ${prepared.fee.totalAmount} ${symbol} for the vault in your wallet: ${review.intent.amount} for @${review.intent.recipient.username} plus the ${platformFeePercent(prepared.fee.feeBps)} fee, paid only when they claim it.`
          : `The second signature places ${review.intent.amount} ${symbol} in the vault for ${windowLabel(review.expiryHours)}.`);
        const hash = await ethereum.request({ method: "eth_sendTransaction", params: [walletRpcTransaction(transaction)] }) as string;
        if (transaction.purpose === "fund") {
          submitted = { ...funding, hash };
          // Kept in this browser until the server has its record, and sent again after the next sign-in if needed.
          rememberUnrecordedFunding({ url: "/api/stocks/claims/confirm-funding", body: stockClaimConfirmation(review, submitted), wallet, transaction: hash });
          setStockClaimFunding({ ...funding, hash, status: "pending" });
        }
        await waitForTransactionReceipt(
          receiptSource(review.network, hash, ethereum),
          { attempts: RECEIPT_ATTEMPTS, revertedMessage: transaction.purpose === "approve" ? `The ${symbol} approval reverted; nothing was reserved.` : fundingReverted },
        );
        if (transaction.purpose === "approve") setStockClaimFunding({ ...funding, status: "funding" });
      }
      if (!submitted) throw new Error("The escrow funding transaction was not returned.");
      await confirmStockClaimFunding(review, submitted);
      setReply(review.lock === "name"
        ? `${review.intent.amount} ${symbol} is waiting in the vault for the ${platformName(review.platform)} name @${review.intent.recipient.username}. Send them the claim link; they claim it within ${windowLabel(review.expiryHours)} by connecting ${platformName(review.platform)} with that name, and it also waits under their Claims once they do.`
        : `${review.intent.amount} ${symbol} is waiting in the vault for @${review.intent.recipient.username}. Send them the claim link; they claim with their official ${platformName(review.platform)} account within ${windowLabel(review.expiryHours)}, and it also waits under their Claims once they link that account.`);
    } catch (error) {
      if (submitted && error instanceof Error && error.message === fundingReverted) {
        // Nothing reached the vault, so the slip offers the funding again rather than verifying a reverted one.
        forgetUnrecordedFunding(submitted.hash);
        setStockClaimFunding(undefined);
      } else if (submitted) {
        const failedHash = submitted.hash;
        setStockClaimFunding((current) => current?.hash === failedHash && current.status === "pending" ? { ...current, status: "verification_failed" } : current);
      } else {
        setStockClaimFunding((current) => current && !current.hash ? undefined : current);
      }
      setReply(error instanceof Error ? error.message : "The claim link was not funded.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyStockClaimAgain() {
    const funding = stockClaimFunding;
    if (!stockClaimDraft || !funding?.hash || busy) return;
    setBusy(true);
    try {
      await confirmStockClaimFunding(stockClaimDraft, { paymentId: funding.paymentId, escrow: funding.escrow, hash: funding.hash });
      setReply(`The claim link for @${stockClaimDraft.intent.recipient.username} is verified on ${STOCK_CHAINS[stockClaimDraft.network].name}.`);
    } catch (error) {
      setReply(error instanceof Error ? error.message : "The escrow receipt could not be verified yet.");
    } finally {
      setBusy(false);
    }
  }

  async function loadStockClaim() {
    if (!stockClaimTarget) return;
    try {
      const response = await fetch(`/api/stocks/claims/${stockClaimTarget.network}/${stockClaimTarget.paymentId}`, { cache: "no-store" });
      const result = await response.json() as StockClaimDetails & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "This claim link was not found.");
      setStockClaimDetails(result);
      if (result.status === "settled") setReply(quietClaimReply);
    } catch (error) {
      setReply(error instanceof Error ? error.message : "This claim link was not found.");
    }
  }

  async function redeemStockClaim(action: "claim" | "refund") {
    const target = stockClaimTarget;
    const details = stockClaimDetails;
    if (!target || !details || busy) return;
    if (!await signingWallet()) return;
    const chain = STOCK_CHAINS[target.network];
    // A token the page cannot classify is treated as a Stock Token, so the statement is asked for.
    const needsStatement = action === "claim" && !chain.testAssets && (!details.token.kind || isStockToken({ kind: details.token.kind }));
    if (needsStatement && !stockEligibility) return void setReply("Confirm the Stock Token eligibility statement before claiming.");
    let submitted: string | undefined;
    setBusy(true);
    try {
      const receipt = await signStockVaultAction({ ...target, escrow: details.escrow, symbol: details.token.symbol }, action, needsStatement, (hash) => {
        submitted = hash;
        setStockClaimAction({ hash, action, status: "pending" });
        setReply(`Your ${action === "claim" ? "claim" : "refund"} was submitted. Waiting for ${chain.name} to confirm it.`);
      });
      setStockClaimAction({ hash: submitted!, action, status: "confirmed" });
      const block = Number.parseInt(receipt.blockNumber, 16);
      setReply(action === "claim"
        ? `${details.amount} ${details.token.symbol} reached your wallet. Verified in ${chain.name} block ${block}.`
        : `${details.amount} ${details.token.symbol} went back to your wallet. Verified in ${chain.name} block ${block}.`);
      await loadStockClaim();
      void loadPendingClaims();
    } catch (error) {
      if (submitted) {
        const failedHash = submitted;
        setStockClaimAction((current) => current?.hash === failedHash && current.status === "pending" ? { ...current, status: "failed" } : current);
      }
      setReply(error instanceof Error ? error.message : `The ${action} was not signed.`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Prepares the claim or refund of a Robinhood Chain vault link on the server and opens the wallet only for exactly
   * that call to the link's escrow from this wallet, on the bundled chain, then waits for its receipt. `statement`
   * passes on the recipient's Stock Token statement. The claim page and Pending claims share it.
   */
  async function signStockVaultAction(target: { network: StockNetworkId; paymentId: string; escrow: string; symbol: string }, action: "claim" | "refund", statement: boolean, onSubmitted: (hash: string) => void) {
    const ethereum = evmProvider();
    if (!ethereum || !wallet) throw new Error("Verify your wallet first.");
    const response = await fetch(`/api/stocks/claims/${target.network}/${target.paymentId}/prepare-${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(statement ? { eligibilityConfirmed: true } : {}),
    });
    const prepared = await response.json() as PreparedStockClaimAction & { error?: string };
    if (!response.ok) throw new Error(prepared.error ?? `The ${action} could not be prepared.`);
    if (!matchesStockClaimAction(prepared, { network: target.network, escrow: target.escrow, wallet, paymentId: target.paymentId, action })) {
      throw new Error("The prepared transaction does not match this claim link, so your wallet was not opened.");
    }
    await switchStockChain(target.network);
    const hash = await ethereum.request({ method: "eth_sendTransaction", params: [walletRpcTransaction(prepared.transaction)] }) as string;
    onSubmitted(hash);
    const receipt = await waitForTransactionReceipt(receiptSource(target.network, hash, ethereum), {
      attempts: RECEIPT_ATTEMPTS,
      revertedMessage: `The ${STOCK_CHAINS[target.network].name} transaction reverted; no ${target.symbol} moved.`,
    });
    // A claimed link earns SP for the claimer and its sender; the server checks the claim in this receipt.
    if (action === "claim" && target.network === "robinhood-mainnet") void reportSpClaim({ network: "robinhood", paymentId: target.paymentId, transaction: hash });
    return receipt;
  }

  // The status line's notes: why each transfer kind is live or locked, in the server's words.
  const statusNoteText = statusNote === "solana" ? solanaLive ? `USDC, USDG${solana.stocks?.enabled ? " and xStocks" : ""} move on Solana too. Your Solana wallet signs and pays the network fee in SOL; several people are paid in one transaction, and the server reads it back from chain.` : solana.transfers?.reason ?? "Solana transfers are not available on this server right now."
    : statusNote === "stocks" ? stockTokensLive ? `Stock Tokens move on ${stockChain.name}, the main network. Your wallet signs each transfer and pays gas in ETH; the server checks the receipt on chain.` : stockTransfersReason
    : statusNote === "tokens" ? otherTokensLive ? `USDG moves real dollars on ${stockChain.name}. Your wallet signs each transfer and pays gas in ETH.` : stockSnapshot.transfers?.tokens?.reason ?? "USDG transfers are not available on this server right now."
    : statusNote === "arc" ? arcAvailable ? `USDC moves on ${arcLabel}. Your wallet signs each payment and pays its gas in USDC.` : arcReason
    : undefined;

  // The home page shows what Robinhood Chain mainnet runs on this server, from the same snapshot as the stock board.
  const mainnetSnapshot = stockSnapshots["robinhood-mainnet"];
  const homeStatus: HomeStatus = {
    checking: stocksLoading,
    solana: Boolean(solana.transfers?.enabled),
    xstocks: Boolean(solana.stocks?.enabled),
    stockTokens: Boolean(mainnetSnapshot.transfers?.enabled),
    tokens: Boolean(mainnetSnapshot.transfers?.tokens?.enabled),
    vault: Boolean(mainnetSnapshot.claims?.enabled),
    vaultReason: mainnetSnapshot.claims?.reason,
    arc: network.ready ? network.environment : undefined,
  };
  const mainnetStockCount = ROBINHOOD_ASSET_ALLOWLISTS["robinhood-mainnet"].tokens.filter(isStockToken).length;

  // Wallets Privy made for this sign-in can be exported from Privy's own window; an account's Solana address that is
  // not this sign-in's wallet says which wallet signs for it.
  const privyNow = privyControls();
  const privyMade = privyNow?.authenticated ? privyNow.embedded() : {};
  const exportableEvm = Boolean(wallet && privyMade.evm && privyMade.evm.toLowerCase() === wallet.toLowerCase());
  const exportableSolana = Boolean(session.solanaAddress && privyMade.solana === session.solanaAddress);
  const signInSolana = privyNow?.authenticated ? privyNow.solana()?.address : undefined;
  const solanaElsewhere = Boolean(session.solanaAddress && signInSolana && signInSolana !== session.solanaAddress);
  // Only an address read as empty is switched without asking; one still loading or unreadable may hold something
  // (audit, 2026-10-06: an unreadable address was replaced without a word).
  const solanaSwitchSafe = solanaHoldings?.status === "ready" && holdsNothing(solanaHoldings);
  // The header button's name starts with the words it shows, as a voice user reads them (audit, 2026-10-06).
  const walletButtonText = privyOpening ? "Opening…" : walletVerifying ? "Verifying…" : wallet ? `${wallet.slice(0, 5)}…${wallet.slice(-4)}` : "Connect wallet";

  const footerLinks = <div className="footer-links">
    <nav aria-label="Footer">
      <a href="/docs">Docs</a>
      <a href="/docs/security">Security</a>
      <a href="/docs/fees">Fees</a>
      <a href="/docs/legal">Legal</a>
    </nav>
    <button type="button" className="motion-toggle" aria-pressed={!ambientMotion} onClick={toggleAmbientMotion}>{ambientMotion ? "Pause animations" : "Play animations"}</button>
  </div>;

  return (
    <main className="shell" data-network-theme={claimTarget ? "arc" : solanaClaimTarget ? "solana" : "robinhood"}>
      {privyAppId && solanaRpcUrl && !homePage && (!docsPage || privyWanted) && !notFoundPage && <ChunkBoundary fallback={null}><Suspense fallback={null}><PrivyBridge appId={privyAppId} theme={colorTheme} solanaRpcUrl={solanaRpcUrl} /></Suspense></ChunkBoundary>}
      <div className="desk-lens" ref={deskLensRef} aria-hidden="true" />
      <DotBurst />
      {spToast && <div className="sp-toast" role="status" key={spToast.key}><SpMark size={18} /> {[spToast.text, spToast.amount ? `+${formatSp(spToast.amount)} SP` : undefined].filter(Boolean).join(" · ")}</div>}
      <header className={`topbar ${homePage ? "topbar-home" : ""}`}>
        <a className="brand" href="/" aria-label="HaPaPay home">
          <BrandMark className="brand-mark" tile />
          <DotText text="HaPaPay" />
        </a>
        <nav className="primary-nav" aria-label="Primary">
          {homePage ? <>
            <a href="#how">How it works</a>
            <a href="/docs">Docs</a>
          </> : notFoundPage ? <>
            <a href={DESK_PATH}>Payment desk</a>
            <a href="/docs">Docs</a>
          </> : docsPage ? <>
            <a href={DESK_PATH}>Payment desk</a>
            <button type="button" onClick={() => setManageOpen(true)}>Identities</button>
            <a href="/docs" aria-current="page">Docs</a>
          </> : adminPage ? <>
            <a href={DESK_PATH}>Payment desk</a>
            <a href="/admin" aria-current="page">Admin</a>
            <a href="/docs">Docs</a>
          </> : <>
            <a className="nav-panel" href="#payment">Payment</a>
            <a className="nav-panel" href="#panel-stocks" onClick={(event) => openPanel(event, "stocks")}>Stocks</a>
            <a className="nav-panel" href="#panel-activity" onClick={(event) => openPanel(event, "activity")}>Activity</a>
            <a className="nav-panel" href="#panel-claims" onClick={(event) => openPanel(event, "claims")}>Claims</a>
            <a className="nav-panel" href="#panel-sp" onClick={(event) => openPanel(event, "sp")}>SP</a>
            <a className="nav-panel" href="#panel-identities" onClick={(event) => openPanel(event, "identities")}>Identities</a>
            <a href="/docs">Docs</a>
          </>}
        </nav>
        {!homePage && !notFoundPage && <div className="network-menu-wrap" ref={networkMenuRef}>
          <button className={`network-pill ${anyLive ? "network-ready" : ""}`} type="button" aria-expanded={networkOpen} aria-haspopup="dialog" onClick={() => setNetworkOpen((open) => !open)}><span /> {network.environment === "testnet" ? "Networks" : "Mainnet"}{anyLive ? "" : " · locked"} <DotIcon name="chevron-down" size={14} /></button>
          {networkOpen && <div className="network-popover" role="dialog" aria-label="Networks">
            <div className="network-popover-head"><strong>Networks</strong><span>Picked by the asset you send</span></div>
            <ul className="network-status-list">
              <li className={solanaLive ? "live" : undefined}><i aria-hidden="true" /><b>Solana</b><code>mainnet</code><small>SOL, USDC, USDG and xStocks · {solanaLive ? "wallet-signed transfers" : "signing locked"} · fees in SOL</small><a href={SOLANA_MAINNET.explorerUrl} target="_blank" rel="noreferrer" aria-label="Solana explorer">Explorer <DotIcon name="arrow-up-right" size={12} /></a></li>
              <li className={stockTransfersLive ? "live" : undefined}><i aria-hidden="true" /><b>{stockChain.name}</b><code>{stockChain.id}</code><small>Stock Tokens and USDG · {stockTokensLive ? "wallet-signed transfers" : otherTokensLive ? "USDG transfers live, Stock Tokens locked" : "signing locked"} · gas in ETH</small><a href={stockChain.explorerUrl} target="_blank" rel="noreferrer" aria-label={`${stockChain.name} explorer`}>Explorer <DotIcon name="arrow-up-right" size={12} /></a></li>
              <li className={arcAvailable ? "live" : undefined}><i aria-hidden="true" /><b>{arcLabel}</b>{network.chainId ? <code>{network.chainId}</code> : null}<small>USDC · {arcAvailable ? "wallet-signed payments" : "signing locked"} · gas in USDC</small>{network.explorerUrl && <a href={network.explorerUrl} target="_blank" rel="noreferrer" aria-label={`${arcLabel} explorer`}>Explorer <DotIcon name="arrow-up-right" size={12} /></a>}</li>
            </ul>
            <p><b>Solana first.</b> A request goes on Solana when you and the person you pay have Solana addresses; write “on {arcLabel}” or “on {stockChain.name}” to send there instead. Every review names its network before your wallet opens.</p>
          </div>}
        </div>}
        {!homePage && !notFoundPage && !docsPage && !adminPage && wallet && spSummary && <button className="sp-pill" type="button" onClick={() => showPanel("sp", true)} aria-label={`${formatSp(spSummary.balance)} SP. Open SP`}><SpMark size={18} /><b>{formatSp(spSummary.balance)}</b><small>SP</small></button>}
        <button className="theme-toggle" type="button" onClick={toggleColorTheme} aria-label={colorTheme === "dark" ? "Use the light theme" : "Use the dark theme"} title={colorTheme === "dark" ? "Light theme" : "Dark theme"}>{colorTheme === "dark" ? <DotIcon name="sun" size={17} /> : <DotIcon name="moon" size={17} />}</button>
        {homePage || notFoundPage ? <a className="home-open topbar-open" href={DESK_PATH}><DecodeText text="Open the desk" /></a> : <button className="wallet-button" disabled={walletVerifying || privyOpening} onClick={wallet ? () => setManageOpen(true) : connectWallet} aria-label={wallet && !walletVerifying && !privyOpening ? `${walletButtonText}: manage connected identities` : walletButtonText}>
          <DotIcon name="wallet" size={17} /> <span className={wallet && !walletVerifying ? "wallet-address" : undefined}><DecodeText text={walletButtonText} /></span>
        </button>}
      </header>

      {homePage ? <HomePage status={homeStatus} stockCount={mainnetStockCount} xstockCount={SOLANA_XSTOCK_COUNT} motion={ambientMotion} onToggleMotion={toggleAmbientMotion} />
        : notFoundPage ? <section className="not-found-page" aria-labelledby="not-found-title"><div className="not-found-card">
          <h1 id="not-found-title">Page not found</h1>
          <p>Nothing lives at <code>{window.location.pathname}</code>. The link may be mistyped or old; a payment link starts with <code>/claim/</code>.</p>
          <div className="not-found-links"><a className="home-open" href={DESK_PATH}>Open the desk</a><a href="/docs">Read the docs</a><a href="/">Home</a></div>
        </div></section>
        : docsPage ? <ChunkBoundary fallback={<section className="docs-page"><p className="docs-loading" role="alert">The docs could not be loaded. <button type="button" onClick={() => window.location.reload()}>Reload the page</button></p></section>}>
        <Suspense fallback={<section className="docs-page" aria-busy="true"><p className="docs-loading">Loading the docs…</p></section>}>
          <DocsPage />
        </Suspense>
      </ChunkBoundary> : adminPage ? <ChunkBoundary fallback={<section className="admin-page"><p role="alert">The admin panel could not be loaded. <button type="button" onClick={() => window.location.reload()}>Reload the page</button></p></section>}>
        <Suspense fallback={<section className="admin-page" aria-busy="true"><p>Loading the admin panel…</p></section>}>
          <AdminPage wallet={wallet} walletVerifying={walletVerifying} message={reply} onConnect={() => void connectWallet()} />
        </Suspense>
      </ChunkBoundary> : <section className="workspace">
        <section className={`conversation ${resting ? "conversation-resting" : "conversation-active"}`} id="payment" aria-label="Payment desk">
          {conversation.turns.length > 0 && <div className="conversation-head">
            <span className="conversation-title"><span className={`network-dot ${anyLive ? "ready" : ""}`} aria-hidden="true" />{anyLive ? `${liveNetworks.length > 1 ? `${liveNetworks.slice(0, -1).join(", ")} and ${liveNetworks[liveNetworks.length - 1]}` : liveNetworks[0]} · wallet-signed` : "Signing locked"}</span>
            <button className="clear-conversation" type="button" disabled={busy || walletVerifying || Boolean(linking) || transactionStatus === "pending" || stockTransaction?.status === "pending" || stockClaimPending || pendingClaimRunning} onClick={clearConversation} title="Clear messages only. Payment reviews and submitted transactions stay visible."><DotIcon name="trash" size={14} /><span>Clear log</span></button>
          </div>}

          <div className="chat-stage" ref={chatStageRef} tabIndex={0} role="region" aria-label="Payment conversation">
            {(deskControls.notice || (pausedFeatures.length > 0 && !claimTarget && !stockClaimTarget && !solanaClaimTarget && !operatorPage)) && <div className="desk-notice" role="status" data-tone={deskControls.notice?.tone === "warning" || pausedFeatures.length > 0 ? "warning" : "info"}>
              <DotIcon name="shield" size={16} />
              <div>
                {deskControls.notice && <p>{deskControls.notice.text}</p>}
                {pausedFeatures.length > 0 && !claimTarget && !stockClaimTarget && !solanaClaimTarget && !operatorPage && <ul aria-label="Paused by HaPaPay">
                  {pausedFeatures.map(([feature, pause]) => <li key={feature}>{DESK_FEATURES[feature]}: {pause.message}</li>)}
                </ul>}
              </div>
            </div>}
            {showIntro && <div className="intro">
              <DotMorph shapes={heroShapes} focus={heroFocus} motion={ambientMotion} onToggleMotion={toggleAmbientMotion} />
              {payTarget && !claimTarget && !stockClaimTarget && !solanaClaimTarget && !operatorPage
                ? <h1>Prepare a payment for <span className="pay-identity">@{payTarget.username}</span></h1>
                : <DotText as="h1" text={settledPage ? settledPage.heading : claimTarget ? "Claim the USDC reserved for your account" : stockClaimTarget || solanaClaimTarget ? "Claim the tokens waiting for you in the vault" : operatorPage ? "Deploy the HaPaPay vault" : "What do you want to send?"} />}
              {/* The empty desk is the heading and the request box; the home page explains the rest. Link pages say what they do. */}
              {(claimTarget || stockClaimTarget || solanaClaimTarget || operatorPage || payTarget) && <p>{settledPage ? settledPage.intro : claimTarget ? "Verify your wallet. If your connected official account matches the payment identity, the funds move directly to you." : stockClaimTarget || solanaClaimTarget ? "Verify your wallet. If your connected account is the one this link was made for, the tokens move straight to your wallet." : operatorPage ? "Connect the operator wallet. On Solana one approval funds a temporary key that deploys the vault program, hands its upgrade key to your wallet and returns what is left. On Robinhood Chain you sign three deployments: the burn vault, the fee router and the escrow. The server checks each on chain and turns on vault links and the fee by itself. Arc Mainnet, at the end of the page, takes four deployments and then the three variables it shows." : payeeState === "verified" ? `${platformName(payTarget!.platform)} identity verified. You choose the amount.` : payeeState === "unverified" ? "This account is not verified on HaPaPay, or is no longer connected, so this link cannot take a payment." : payeeState === "error" ? "The account could not be checked just now. Reload the page to try again." : "Verifying the social identity…"}</p>}
            </div>}
            <PaymentConversation conversation={conversation} status={reply} busy={busy} statusBelow={slipShown} onSuggestion={(request) => void sendRequest(request)} />

            {(solanaDraft || solanaClaimDraft || solanaClaimTarget) && <ChunkBoundary fallback={<article className="payment-slip solana-slip" data-network-theme="solana" role="alert"><p className="escrow-console-note">The Solana slip could not be loaded.</p><button type="button" onClick={() => window.location.reload()}>Reload the page</button></article>}>
              <Suspense fallback={<article className="payment-slip solana-slip" data-network-theme="solana" aria-busy="true"><p className="escrow-console-note">Loading Solana…</p></article>}>
                {solanaDraft && <SolanaPaymentSlip
                  key={solanaDraft.id}
                  review={solanaDraft.review}
                  wallet={wallet}
                  solanaAddress={session.solanaAddress}
                  treasury={solana.treasury ?? undefined}
                  transfers={(solanaDraft.review.asset.kind === "stock" || solanaDraft.review.asset.kind === "etf" ? solana.stocks : solana.transfers) ?? { enabled: false, reason: "Solana is not available on this server right now." }}
                  price={solana.quotes[solanaDraft.review.asset.symbol]}
                  busy={busy}
                  setBusy={setBusy}
                  onConnect={() => void connectWallet()}
                  onAddSolana={() => addSolanaAddress()}
                  onMessage={setReply}
                  onRecorded={() => void loadPayments()}
                />}
                {solanaClaimDraft && <SolanaVaultSlip
                  key={solanaClaimDraft.id}
                  review={solanaClaimDraft.review}
                  programId={solana.vault?.programId}
                  wallet={wallet}
                  solanaAddress={session.solanaAddress}
                  enabled={Boolean(solana.vault?.enabled)}
                  reason={solana.vault?.reason}
                  busy={busy}
                  setBusy={setBusy}
                  onConnect={() => void connectWallet()}
                  onAddSolana={() => addSolanaAddress()}
                  onMessage={setReply}
                  onFunded={() => void loadPendingClaims()}
                  onWindow={(hours) => setSolanaClaimDraft((current) => current ? { ...current, review: { ...current.review, expiryHours: hours } } : current)}
                  onLock={(lock) => setSolanaClaimDraft((current) => current ? { ...current, review: { ...current.review, lock } } : current)}
                />}
                {solanaClaimTarget && <SolanaClaimSlip
                  paymentId={solanaClaimTarget.paymentId}
                  wallet={wallet}
                  solanaAddress={session.solanaAddress}
                  accounts={accounts}
                  busy={busy}
                  setBusy={setBusy}
                  onConnect={() => void connectWallet()}
                  onAddSolana={() => addSolanaAddress()}
                  onManage={() => setManageOpen(true)}
                  onMessage={setReply}
                  onSettled={() => void loadPendingClaims()}
                  onDetails={(details) => {
                    setSolanaSettledExpiry(details.status === "settled" ? details.expiresAt : undefined);
                    if (details.status === "settled") setReply(quietClaimReply);
                  }}
                />}
              </Suspense>
            </ChunkBoundary>}

            {draft && (
              <article className="payment-slip" data-state={transactionHash ? transactionStatus ?? "pending" : undefined} data-network-theme="arc">
                <div className="slip-top">
                  <div><small>Amount</small><strong><DotText text={draft.intent.amount} /> <span className="slip-symbol">USDC</span></strong></div>
                  {transactionHash && transactionStatus === "confirmed" && <VerifiedMark />}
                  <div className="platform-avatar"><ProviderIcon provider={draft.intent.recipient.platform} /></div>
                </div>
                <div className="recipient-line">
                  <div><small>Recipient</small><b>@{draft.intent.recipient.username}</b></div>
                  <span>{platformName(draft.intent.recipient.platform)}</span>
                </div>
                <div className="route-line"><span>{draft.intent.sourcePlatform ? `Your ${platformName(draft.intent.sourcePlatform)} identity` : "Your unified wallet"}</span><i /><span>{draft.resolvedAddress.slice(0, 6)}…{draft.resolvedAddress.slice(-4)}</span></div>
                <dl className="stock-facts">
                  <div><dt>Network</dt><dd>{arcLabel}{network.chainId ? ` · chain ID ${network.chainId}` : ""}<small>USDC payments run on Arc; gas is paid in USDC</small></dd></div>
                  {network.fees && arcNetwork && <FeeFacts fees={network.fees} units={parseUnits(draft.intent.amount, 6).toString()} decimals={6} symbol="USDC" recipient={draft.intent.recipient.username} amount={draft.intent.amount} when="now" />}
                </dl>
                {network.fees && arcNetwork && <NoteField id="payment-note" value={draft.note ?? ""} disabled={busy || Boolean(transactionHash)} onChange={(value) => setDraft((current) => current ? { ...current, note: value } : current)} />}
                <div className={`mainnet-lock ${arcAvailable ? "mainnet-ready" : ""}`}>{arcAvailable ? <DotIcon name="shield" size={16} /> : <DotIcon name="lock" size={16} />}<span><b>{arcAvailable ? `${arcLabel} ready.` : "Signing locked."}</b> {arcAvailable ? arcNetwork === "arc-testnet" ? "The recipient will be resolved again; your wallet will open a test-funds transaction only." : network.fees ? "The recipient will be resolved again; you sign twice in your wallet: the approval, then the payment." : "The recipient will be resolved again; live USDC moves only with your wallet signature." : arcReason}</span></div>
                {transactionHash ? <>
                  <a className={`transaction-link ${transactionStatus === "confirmed" ? "confirmed" : transactionStatus === "verification_failed" ? "verification-failed" : "pending"}`} href={network.explorerUrl ? `${network.explorerUrl.replace(/\/$/, "")}/tx/${transactionHash}` : undefined} target="_blank" rel="noreferrer">{transactionStatus === "confirmed" ? "Payment verified" : transactionStatus === "verification_failed" ? "Check in explorer" : "Transaction submitted"} · {transactionHash.slice(0, 10)}…</a>
                  {transactionStatus === "verification_failed" && <button className="stock-verify-again" disabled={busy} onClick={verifyArcPaymentAgain}>Verify the receipt again</button>}
                </> : <button disabled={!arcAvailable || draft.arcNetwork !== arcNetwork || busy} onClick={signPayment}>{arcAvailable ? wallet ? "Review and sign in wallet" : "Verify your wallet first" : "USDC signing is not available right now"}</button>}
              </article>
            )}

            {claimDraft && (
              <article className="payment-slip claim-slip" data-network-theme="arc">
                <div className="slip-top"><div><small>{claimLink ? "Waiting in the vault" : "USDC vault link"}</small><strong><DotText text={claimDraft.intent.amount} /> <span className="slip-symbol">USDC</span></strong></div><div className="platform-avatar"><ProviderIcon provider={claimDraft.intent.recipient.platform} /></div></div>
                <div className="recipient-line"><div><small>Not on HaPaPay yet</small><b>@{claimDraft.intent.recipient.username}</b></div><span>{platformName(claimDraft.intent.recipient.platform)}</span></div>
                <div className="claim-steps"><span><b>1</b> {network.fees ? "Approve amount + fee" : "Approve amount"}</span><i /><span><b>2</b> {windowLabel(claimDraft.expiryHours)} in the vault</span><i /><span><b>3</b> Official claim</span></div>
                {!claimLink && !transactionHash && <div className="vault-window" role="group" aria-label="Vault window">
                  <span>Vault window</span>
                  {STOCK_CLAIM_WINDOW_CHOICES.map((hours) => <button type="button" key={hours} aria-pressed={claimDraft.expiryHours === hours} disabled={busy} onClick={() => setClaimDraft((current) => current ? { ...current, expiryHours: hours } : current)}>{windowLabel(hours)}</button>)}
                </div>}
                <dl className="stock-facts">
                  <div><dt>Network</dt><dd>{arcLabel}{network.chainId ? ` · chain ID ${network.chainId}` : ""}<small>USDC vault links run on Arc; gas is paid in USDC</small></dd></div>
                  {network.fees && arcNetwork && <FeeFacts fees={network.fees} units={parseUnits(claimDraft.intent.amount, 6).toString()} decimals={6} symbol="USDC" recipient={claimDraft.intent.recipient.username} amount={claimDraft.intent.amount} when="claim" />}
                </dl>
                {claimDraft.intent.sourcePlatform && <div className="source-proof"><DotIcon name="shield" size={13} /> Your connected {platformName(claimDraft.intent.sourcePlatform)} account is reverified before funding.</div>}
                <div className={`mainnet-lock ${network.claimablePaymentsReady ? "mainnet-ready" : ""}`}><DotIcon name="shield" size={16} /><span>{claimDraft.lock === "name"
                  ? <NameLockNote platform={claimDraft.intent.recipient.platform} username={claimDraft.intent.recipient.username} window={windowLabel(claimDraft.expiryHours)} />
                  : <><b>The claim is locked to an immutable provider ID, not a username.</b> A renamed account cannot redirect the funds.</>}</span></div>
                {claimLink ? <div className="claim-link"><span>Claim link</span><CopyButton text={claimLink} /><code>{claimLink}</code></div>
                  : transactionHash && arcClaimFunding ? <>
                    <a className={`transaction-link ${transactionStatus === "verification_failed" ? "verification-failed" : "pending"}`} href={network.explorerUrl ? `${network.explorerUrl.replace(/\/$/, "")}/tx/${transactionHash}` : undefined} target="_blank" rel="noreferrer">{transactionStatus === "verification_failed" ? "Check in explorer" : "Funding submitted"} · {transactionHash.slice(0, 10)}…</a>
                    {transactionStatus === "verification_failed" && <button className="stock-verify-again" disabled={busy} onClick={verifyArcClaimAgain}>Verify the vault receipt again</button>}
                  </>
                  : <button disabled={!arcAvailable || !network.claimablePaymentsReady || claimDraft.arcNetwork !== arcNetwork || busy} onClick={fundClaim}>{arcAvailable && network.claimablePaymentsReady ? wallet ? claimDraft.lock === "name" ? `Keep it for the name @${claimDraft.intent.recipient.username}` : "Approve and keep in the vault" : "Verify your wallet first" : "Vault links are off on this server"}</button>}
              </article>
            )}

            {stockDraft && (() => {
              const chain = STOCK_CHAINS[stockDraft.network];
              const asset = stockDraft.intent.asset;
              const stockToken = isStockToken(asset);
              const transfers = transferAvailabilityFor(stockSnapshots[stockDraft.network].transfers, asset);
              const needsEligibility = transfers.enabled && !chain.testAssets && stockToken;
              const quote = stockSnapshots[stockDraft.network].tokens.find((token) => token.address === asset.address);
              const value = asset.kind === "cash" ? stockDraft.intent.amount : quote?.price ? stockTokenValue(stockDraft.intent.amount, quote.price) : undefined;
              const shares = stockToken && quote?.multiplier ? shareEquivalent(stockDraft.intent.amount, quote.multiplier) : undefined;
              const fees = stockSnapshots[stockDraft.network].fees ?? undefined;
              return <article className="payment-slip stock-slip" data-state={stockTransaction?.status} data-network-theme="robinhood">
                <div className="slip-top">
                  <div><small>{assetNoun(asset, chain.testAssets)} {transfers.enabled ? "transfer" : "draft"}</small><strong><DotText text={stockDraft.intent.amount} /> <span className="slip-symbol">{asset.symbol}</span></strong></div>
                  {stockTransaction?.status === "confirmed" && <VerifiedMark />}
                  <StockTile token={quote ?? { symbol: asset.symbol, kind: asset.kind }} size="large" />
                </div>
                <div className="recipient-line">
                  <div><small>Recipient</small><b>@{stockDraft.intent.recipient.username}</b></div>
                  <span>{platformName(stockDraft.intent.recipient.platform)}</span>
                </div>
                <div className="route-line"><span>{stockDraft.intent.sourcePlatform ? `Your ${platformName(stockDraft.intent.sourcePlatform)} identity` : "Your unified wallet"}</span><i /><span>{stockDraft.resolvedAddress.slice(0, 6)}…{stockDraft.resolvedAddress.slice(-4)}</span></div>
                <dl className="stock-facts">
                  <div><dt>Network</dt><dd>{chain.name} · chain ID {chain.id}</dd></div>
                  <div><dt>Token</dt><dd>{asset.name} · <a href={stockTokenExplorerUrl(asset.address, chain.id)} target="_blank" rel="noreferrer">{asset.address.slice(0, 6)}…{asset.address.slice(-4)} <DotIcon name="arrow-up-right" size={12} /></a></dd></div>
                  <div><dt>Amount</dt><dd>{stockDraft.intent.amount} {stockToken ? "tokens" : asset.symbol}<small>{stockDraft.units} base units · {asset.decimals} decimals</small></dd></div>
                  {fees && <FeeFacts fees={fees} units={stockDraft.units} decimals={asset.decimals} symbol={asset.symbol} recipient={stockDraft.intent.recipient.username} amount={stockDraft.intent.amount} when="now" />}
                  {shares && <div><dt>Share equivalent</dt><dd>≈ {shares} shares<small>multiplier {quote?.multiplier}</small></dd></div>}
                  <div><dt>Value</dt><dd>{chain.testAssets ? "Test token · no real value" : value ? `≈ ${formatUsd(value)} (${asset.kind === "cash" ? "dollar stablecoin" : "indicative"})` : "Price unavailable"}</dd></div>
                  <div><dt>Gas</dt><dd>{chain.testAssets ? "Test ETH" : "ETH"} on {chain.name}<small>{fees ? "Two signatures, paid by your wallet" : "Paid by your wallet"}</small></dd></div>
                </dl>
                {fees && transfers.enabled && <NoteField id="transfer-note" value={stockDraft.note ?? ""} disabled={busy || Boolean(stockTransaction)} onChange={(value) => setStockDraft((current) => current ? { ...current, note: value } : current)} />}
                {needsEligibility && !stockTransaction && <label className="stock-eligibility">
                  <input type="checkbox" checked={stockEligibility} disabled={busy} onChange={(event) => setStockEligibility(event.target.checked)} />
                  <span>I am not a U.S. person and I am outside the United States. To my knowledge the recipient is too, and Robinhood Stock Tokens are permitted where we both are. <a href="https://docs.robinhood.com/chain/stock-tokens/" target="_blank" rel="noreferrer">Restrictions</a></span>
                </label>}
                <div className={`mainnet-lock ${transfers.enabled ? "mainnet-ready" : ""}`}>{transfers.enabled ? <DotIcon name="shield" size={16} /> : <DotIcon name="lock" size={16} />}<span>{transfers.enabled
                  ? <><b>{chain.testAssets ? "Test transfer." : "Live transfer."}</b> The recipient is resolved again and the {asset.symbol} contract checks your balance, pauses and its compliance list before your wallet opens.</>
                  : <><b>Signing locked.</b> {transfers.reason ?? "Transfers of this token are not available on this server right now."} This draft never reaches your wallet.</>}</span></div>
                {stockTransaction ? <>
                  <a className={`transaction-link ${stockTransaction.status === "confirmed" ? "confirmed" : stockTransaction.status === "verification_failed" ? "verification-failed" : "pending"}`} href={`${chain.explorerUrl}/tx/${stockTransaction.hash}`} target="_blank" rel="noreferrer">{stockTransaction.status === "confirmed" ? "Transfer verified" : stockTransaction.status === "verification_failed" ? "Check in explorer" : "Transaction submitted"} · {stockTransaction.hash.slice(0, 10)}…</a>
                  {stockTransaction.status === "verification_failed" && <button className="stock-verify-again" disabled={busy} onClick={verifyStockTransferAgain}>Verify the receipt again</button>}
                </> : <button disabled={!transfers.enabled || busy || (Boolean(wallet) && needsEligibility && !stockEligibility)} onClick={signStockTransfer}>{!transfers.enabled ? stockToken ? "Stock transfers are off on this server" : `${asset.symbol} transfers are off on this server` : !wallet ? "Verify your wallet first" : needsEligibility && !stockEligibility ? "Confirm eligibility to continue" : "Review and sign in wallet"}</button>}
              </article>;
            })()}

            {batchDraft && (() => {
              const token = batchDraft.asset.type === "stock-token" ? batchDraft.asset : undefined;
              const chain = batchDraft.stockNetwork ? STOCK_CHAINS[batchDraft.stockNetwork] : undefined;
              const snapshot = batchDraft.stockNetwork ? stockSnapshots[batchDraft.stockNetwork] : undefined;
              const transfers = token && snapshot ? transferAvailabilityFor(snapshot.transfers, token) : undefined;
              const fees = snapshot ? snapshot.fees : network.fees;
              const ready = token ? Boolean(transfers?.enabled && fees) : Boolean(arcAvailable && batchDraft.arcNetwork === arcNetwork && network.fees);
              const lockReason = token
                ? transfers?.enabled ? `Payments to several people run through the ${chain!.name} fee router, which this server does not run yet.` : transfers?.reason ?? "Transfers of this token are not available on this server right now."
                : !arcAvailable ? arcReason ?? "USDC signing is not available right now." : batchDraft.arcNetwork !== arcNetwork ? "The Arc network changed since this review. Write the request again." : `Payments to several people run through the ${arcLabel} fee router, which this server does not run yet.`;
              const needsEligibility = Boolean(token && chain && !chain.testAssets && isStockToken(token) && ready);
              const started = batchStates.some(({ status }) => status !== "waiting");
              return <BatchSlip
                rows={batchDraft.rows}
                states={batchStates}
                symbol={batchDraft.asset.symbol}
                decimals={batchDraft.asset.decimals}
                mode={batchDraft.mode}
                amount={batchDraft.amount}
                totalAmount={batchDraft.totalAmount}
                totalUnits={batchDraft.totalUnits}
                fees={fees}
                networkLabel={chain ? `${chain.name} · chain ID ${chain.id}` : `${arcLabel}${network.chainId ? ` · chain ID ${network.chainId}` : ""}`}
                networkDetail={chain ? `Gas is paid in ${chain.testAssets ? "test ETH" : "ETH"}` : "USDC payments run on Arc; gas is paid in USDC"}
                explorerUrl={chain ? chain.explorerUrl : network.explorerUrl}
                theme={chain ? "robinhood" : "arc"}
                note={batchDraft.note}
                onNote={(value) => setBatchDraft((current) => current ? { ...current, note: value } : current)}
                sourcePlatform={batchDraft.sourcePlatform}
                ready={ready}
                lockReason={lockReason}
                busy={busy}
                wallet={wallet}
                canSign={ready && (!wallet || !needsEligibility || stockEligibility)}
                onSign={() => void signBatch()}
                onVerifyAgain={() => void verifyBatchAgain()}
              >
                {needsEligibility && !started && <label className="stock-eligibility">
                  <input type="checkbox" checked={stockEligibility} disabled={busy} onChange={(event) => setStockEligibility(event.target.checked)} />
                  <span>I am not a U.S. person and I am outside the United States. To my knowledge the recipients are too, and Robinhood Stock Tokens are permitted where we all are. <a href="https://docs.robinhood.com/chain/stock-tokens/" target="_blank" rel="noreferrer">Restrictions</a></span>
                </label>}
              </BatchSlip>;
            })()}

            {stockClaimDraft && (() => {
              const chain = STOCK_CHAINS[stockClaimDraft.network];
              const asset = stockClaimDraft.intent.asset;
              const stockToken = isStockToken(asset);
              const claims = stockSnapshots[stockClaimDraft.network].claims;
              const live = Boolean(claims?.enabled && claims.escrow === stockClaimDraft.escrow && (stockToken ? claims.stockTokens !== false : claims.tokens !== false));
              const needsEligibility = live && !chain.testAssets && stockToken;
              const quote = stockSnapshots[stockClaimDraft.network].tokens.find((token) => token.address === asset.address);
              const value = asset.kind === "cash" ? stockClaimDraft.intent.amount : quote?.price ? stockTokenValue(stockClaimDraft.intent.amount, quote.price) : undefined;
              const funding = stockClaimFunding;
              const recipient = stockClaimDraft.intent.recipient.username;
              const windowText = windowLabel(stockClaimDraft.expiryHours);
              const fees = stockSnapshots[stockClaimDraft.network].fees ?? claims?.fees;
              return <article className="payment-slip stock-slip claim-slip" data-state={funding?.hash ? funding.status : undefined} data-network-theme="robinhood">
                <div className="slip-top">
                  <div><small>{funding?.status === "confirmed" ? "Waiting in the vault" : `${assetNoun(asset, chain.testAssets)} vault link`}</small><strong><DotText text={stockClaimDraft.intent.amount} /> <span className="slip-symbol">{asset.symbol}</span></strong></div>
                  {funding?.status === "confirmed" && <VerifiedMark />}
                  <StockTile token={quote ?? { symbol: asset.symbol, kind: asset.kind }} size="large" />
                </div>
                <div className="recipient-line"><div><small>Not on HaPaPay yet</small><b>@{recipient}</b></div><span>{platformName(stockClaimDraft.platform)}</span></div>
                <div className="claim-steps"><span><b>1</b> Approve {asset.symbol}</span><i /><span><b>2</b> {windowText} in the vault</span><i /><span><b>3</b> Official claim</span></div>
                {!funding && <div className="vault-window" role="group" aria-label="Vault window">
                  <span>Vault window</span>
                  {STOCK_CLAIM_WINDOW_CHOICES.map((hours) => <button type="button" key={hours} aria-pressed={stockClaimDraft.expiryHours === hours} disabled={busy} onClick={() => setStockClaimDraft((current) => current ? { ...current, expiryHours: hours } : current)}>{windowLabel(hours)}</button>)}
                </div>}
                <dl className="stock-facts">
                  <div><dt>Network</dt><dd>{chain.name} · chain ID {chain.id}</dd></div>
                  <div><dt>Token</dt><dd>{asset.name} · <a href={stockTokenExplorerUrl(asset.address, chain.id)} target="_blank" rel="noreferrer">{asset.address.slice(0, 6)}…{asset.address.slice(-4)} <DotIcon name="arrow-up-right" size={12} /></a></dd></div>
                  <div><dt>Amount</dt><dd>{stockClaimDraft.intent.amount} {stockToken ? "tokens" : asset.symbol}<small>{stockClaimDraft.units} base units · {asset.decimals} decimals</small></dd></div>
                  {fees && <FeeFacts fees={fees} units={stockClaimDraft.units} decimals={asset.decimals} symbol={asset.symbol} recipient={recipient} amount={stockClaimDraft.intent.amount} when="claim" />}
                  <div><dt>Value</dt><dd>{chain.testAssets ? "Test token · no real value" : value ? `≈ ${formatUsd(value)} (${asset.kind === "cash" ? "dollar stablecoin" : "indicative"})` : "Price unavailable"}</dd></div>
                  <div><dt>Vault</dt><dd><a href={`${chain.explorerUrl}/address/${stockClaimDraft.escrow}`} target="_blank" rel="noreferrer">{stockClaimDraft.escrow.slice(0, 6)}…{stockClaimDraft.escrow.slice(-4)} <DotIcon name="arrow-up-right" size={12} /></a><small>The claim escrow contract holds it until @{recipient} claims it or the window closes</small></dd></div>
                  <div><dt>Gas</dt><dd>{chain.testAssets ? "Test ETH" : "ETH"} on {chain.name}<small>Two signatures, paid by your wallet</small></dd></div>
                </dl>
                {stockClaimDraft.intent.sourcePlatform && <div className="source-proof"><DotIcon name="shield" size={13} /> Your connected {platformName(stockClaimDraft.intent.sourcePlatform)} account is reverified before funding.</div>}
                {needsEligibility && !funding && <label className="stock-eligibility">
                  <input type="checkbox" checked={stockEligibility} disabled={busy} onChange={(event) => setStockEligibility(event.target.checked)} />
                  <span>I am not a U.S. person and I am outside the United States. To my knowledge the recipient is too, and Robinhood Stock Tokens are permitted where we both are. <a href="https://docs.robinhood.com/chain/stock-tokens/" target="_blank" rel="noreferrer">Restrictions</a></span>
                </label>}
                <div className={`mainnet-lock ${live ? "mainnet-ready" : ""}`}>{live ? <DotIcon name="shield" size={16} /> : <DotIcon name="lock" size={16} />}<span>{live
                  ? stockClaimDraft.lock === "name"
                    ? <NameLockNote platform={stockClaimDraft.platform} username={recipient} window={windowText} />
                    : <><b>Locked to @{recipient}'s {platformName(stockClaimDraft.platform)} account ID, not the handle.</b> A renamed or look-alike account cannot claim it. If nobody claims it within {windowText}, you take it back.</>
                  : <><b>Vault links locked.</b> {claims?.reason ?? "Vault links are not available on this server right now."} This draft never reaches your wallet.</>}</span></div>
                {funding?.link && <div className="claim-link"><span>Claim link</span><CopyButton text={funding.link} /><code>{funding.link}</code></div>}
                {funding?.hash ? <>
                  <a className={`transaction-link ${funding.status === "confirmed" ? "confirmed" : funding.status === "verification_failed" ? "verification-failed" : "pending"}`} href={`${chain.explorerUrl}/tx/${funding.hash}`} target="_blank" rel="noreferrer">{funding.status === "confirmed" ? "Vault funding verified" : funding.status === "verification_failed" ? "Check in explorer" : "Funding submitted"} · {funding.hash.slice(0, 10)}…</a>
                  {funding.status === "verification_failed" && <button className="stock-verify-again" disabled={busy} onClick={verifyStockClaimAgain}>Verify the vault receipt again</button>}
                </> : <button disabled={!live || busy || (Boolean(wallet) && needsEligibility && !stockEligibility)} onClick={fundStockClaim}>{!live ? "Vault links are off on this server" : !wallet ? "Verify your wallet first" : needsEligibility && !stockEligibility ? "Confirm eligibility to continue" : funding?.status === "approving" ? "Approve in your wallet…" : funding?.status === "funding" ? "Reserve in your wallet…" : "Approve and keep in the vault"}</button>}
              </article>;
            })()}

            {claimTarget && (
              <article className="payment-slip claim-slip claim-redeem" data-state={transactionHash ? transactionStatus ?? "pending" : undefined}>
                <div className="slip-top"><div><small>{claimDetails?.status === "settled" ? settledLink(claimDetails.expiresAt).label : claimDetails?.status === "expired" ? "Refundable social payment" : "Reserved for you"}</small><strong><DotText text={claimDetails?.amount ?? "—"} /> <span className="slip-symbol">USDC</span></strong></div><div className="platform-avatar"><DotIcon name="lock" size={18} /></div></div>
                <div className="claim-id"><small>Payment ID</small><code>{claimTarget.slice(0, 14)}…{claimTarget.slice(-8)}</code></div>
                {claimDetails?.recipient && <div className="claim-route"><span>{claimDetails.sourceIdentity ? `@${claimDetails.sourceIdentity.username}` : `${claimDetails.payer.slice(0, 6)}…${claimDetails.payer.slice(-4)}`}</span><i /><b>@{claimDetails.recipient.username}</b></div>}
                {claimDetails?.status === "settled" && <p className="claim-settled" role="status">{settledLink(claimDetails.expiresAt).note}</p>}
                {claimDetails && <div className="claim-expiry"><span>{claimDetails.status === "settled" ? "Claim window" : claimDetails.status === "expired" ? "Claim window expired" : "Claim by"}</span><b>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(claimDetails.expiresAt))}</b></div>}
                {claimDetails?.status !== "settled" && <>
                  <div className={`mainnet-lock ${network.claimRedemptionReady ? "mainnet-ready" : ""}`}><DotIcon name="shield" size={16} /><span>{claimDetails?.lock === "name" && claimDetails.recipient
                    ? <NameClaimNote platform={claimDetails.recipient.platform} username={claimDetails.recipient.username} />
                    : "The server issues a one-time claim authorization only when your immutable identity matches through official OAuth."}</span></div>
                  <p>Claim network: {network.ready ? `${arcLabel} · chain ID ${network.chainId}` : "Checking network…"}. Your wallet switches to it when you claim.</p>
                </>}
                {transactionHash ? <a className={`transaction-link ${transactionStatus === "confirmed" ? "confirmed" : "pending"}`} href={network.explorerUrl ? `${network.explorerUrl.replace(/\/$/, "")}/tx/${transactionHash}` : undefined}>Onchain {transactionStatus === "confirmed" ? "verified" : "pending"} · {transactionHash.slice(0, 10)}…</a> : claimDetails?.status !== "settled" && <div className="claim-actions"><button disabled={!arcNetwork || !network.claimRedemptionReady || busy} onClick={() => redeemClaim("claim")}>{wallet ? "Claim with my identity" : "Verify wallet"}</button><button disabled={!arcNetwork || !network.claimRedemptionReady || busy} onClick={() => redeemClaim("refund")}>Refund if expired</button></div>}
              </article>
            )}
            {stockClaimTarget && (() => {
              const chain = STOCK_CHAINS[stockClaimTarget.network];
              const details = stockClaimDetails;
              const platform = details?.recipient ? platformName(details.recipient.platform) : "GitHub, X, Farcaster, Discord or Telegram";
              const linked = details?.recipient ? accounts.find((account) => account.platform === details.recipient!.platform) : undefined;
              const isPayer = Boolean(wallet && details && wallet.toLowerCase() === details.payer.toLowerCase());
              const stockToken = !details?.token.kind || isStockToken({ kind: details.token.kind });
              const needsEligibility = !chain.testAssets && stockToken && details?.status === "claimable" && !isPayer;
              const paymentId = stockClaimTarget.paymentId;
              return <article className="payment-slip stock-slip claim-slip claim-redeem" data-state={stockClaimAction?.status}>
                <div className="slip-top">
                  <div><small>{stockClaimAction?.status === "confirmed" ? stockClaimAction.action === "claim" ? "Claimed to your wallet" : "Back in your wallet" : !details ? "Claim link" : details.status === "settled" ? settledLink(details.expiresAt).label : details.status === "expired" ? "Claim window closed" : "Reserved for you"}</small><strong><DotText text={details?.amount ?? "—"} /> <span className="slip-symbol">{details?.token.symbol ?? ""}</span></strong></div>
                  {stockClaimAction?.status === "confirmed" && <VerifiedMark />}
                  {details ? <StockTile token={{ symbol: details.token.symbol, kind: details.token.kind ?? "stock" }} size="large" /> : <div className="platform-avatar"><DotIcon name="lock" size={18} /></div>}
                </div>
                <div className="claim-id"><small>Claim link</small><code>{paymentId.slice(0, 14)}…{paymentId.slice(-8)}</code></div>
                {details?.recipient && <div className="claim-route"><span>{details.sourceIdentity ? `@${details.sourceIdentity.username}` : `${details.payer.slice(0, 6)}…${details.payer.slice(-4)}`}</span><i /><b>@{details.recipient.username}</b></div>}
                {details?.status === "settled" && !stockClaimAction && <p className="claim-settled" role="status">{settledLink(details.expiresAt).note}</p>}
                {details && <div className="claim-expiry"><span>{details.status === "claimable" ? "Claim by" : "Claim window"}</span><b>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(details.expiresAt))}</b></div>}
                {details && <dl className="stock-facts">
                  <div><dt>Network</dt><dd>{chain.name} · chain ID {chain.id}</dd></div>
                  <div><dt>Token</dt><dd>{details.token.name} · <a href={stockTokenExplorerUrl(details.token.address, chain.id)} target="_blank" rel="noreferrer">{details.token.address.slice(0, 6)}…{details.token.address.slice(-4)} <DotIcon name="arrow-up-right" size={12} /></a></dd></div>
                  <div><dt>Vault</dt><dd><a href={`${chain.explorerUrl}/address/${details.escrow}`} target="_blank" rel="noreferrer">{details.escrow.slice(0, 6)}…{details.escrow.slice(-4)} <DotIcon name="arrow-up-right" size={12} /></a><small>The claim escrow contract holds it until it is claimed or taken back</small></dd></div>
                  <div><dt>Gas</dt><dd>{chain.testAssets ? "Test ETH" : "ETH"} on {chain.name}<small>Paid by your wallet</small></dd></div>
                </dl>}
                {needsEligibility && !stockClaimAction && <label className="stock-eligibility">
                  <input type="checkbox" checked={stockEligibility} disabled={busy} onChange={(event) => setStockEligibility(event.target.checked)} />
                  <span>I am not a U.S. person and I am outside the United States, and Robinhood Stock Tokens are permitted where I am. <a href="https://docs.robinhood.com/chain/stock-tokens/" target="_blank" rel="noreferrer">Restrictions</a></span>
                </label>}
                {details?.status !== "settled" && <div className="mainnet-lock mainnet-ready"><DotIcon name="shield" size={16} /><span>{details?.lock === "name" && details.recipient
                  ? <NameClaimNote platform={details.recipient.platform} username={details.recipient.username} />
                  : <><b>Locked to one {platform} account.</b> The server signs a one-time claim only when your connected account is the one this link was made for; a renamed or look-alike account cannot claim it.</>}</span></div>}
                {details?.status === "claimable" && wallet && details.recipient && !linked && !isPayer && <button className="stock-verify-again" onClick={() => setManageOpen(true)}>Connect your {platform} account</button>}
                {stockClaimAction ? <a className={`transaction-link ${stockClaimAction.status === "confirmed" ? "confirmed" : stockClaimAction.status === "failed" ? "verification-failed" : "pending"}`} href={`${chain.explorerUrl}/tx/${stockClaimAction.hash}`} target="_blank" rel="noreferrer">{stockClaimAction.status === "confirmed" ? stockClaimAction.action === "claim" ? "Claim verified" : "Refund verified" : stockClaimAction.status === "failed" ? "Check in explorer" : "Transaction submitted"} · {stockClaimAction.hash.slice(0, 10)}…</a>
                  : details && details.status !== "settled" && <div className="claim-actions">
                    <button disabled={busy || details.status !== "claimable" || isPayer || (Boolean(wallet) && needsEligibility && !stockEligibility)} onClick={() => redeemStockClaim("claim")}>{!wallet ? "Verify wallet" : "Claim with my identity"}</button>
                    <button disabled={busy || details.status !== "expired" || (Boolean(wallet) && !isPayer)} onClick={() => redeemStockClaim("refund")}>Take back after expiry</button>
                  </div>}
              </article>;
            })()}

            {operatorPage && <ChunkBoundary fallback={<article className="payment-slip escrow-console" role="alert"><p className="escrow-console-note">The escrow console could not be loaded.</p><button type="button" onClick={() => window.location.reload()}>Reload the page</button></article>}>
              <Suspense fallback={<article className="payment-slip escrow-console"><p className="escrow-console-note">Loading the escrow console…</p></article>}>
                <SolanaOperator wallet={wallet} walletVerifying={walletVerifying} solanaAddress={session.solanaAddress} onConnect={() => void connectWallet()} onAddSolana={() => addSolanaAddress()} onMessage={setReply} />
                <StockEscrowOperator wallet={wallet} walletVerifying={walletVerifying} onConnect={connectWallet} switchChain={switchStockChain} switchArcChain={() => switchToArc("arc-mainnet")} onMessage={setReply} />
              </Suspense>
            </ChunkBoundary>}
            {slipShown && <SlipStatus conversation={conversation} status={reply} />}
          </div>

          <div className="composer-wrap" ref={composerRef}>
            {!claimTarget && !stockClaimTarget && !solanaClaimTarget && !operatorPage && <form className="composer" onSubmit={submit}>
              <input ref={messageInputRef} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={payTarget ? "Add an amount: send 2 TSLA or 10 USDG" : `Try: ${suggestions[0].replace(/^Send/, "send")}`} aria-label="Payment request" />
              <kbd className="composer-kbd" aria-hidden="true" title="Press / to type a request">/</kbd>
              <button className="send-button" type="submit" disabled={busy || !message.trim()} aria-label="Send request"><DotArrow /></button>
              {/* Each sent request leaves as a dotted bird, once. */}
              {conversation.turns.length > 0 && <span className="send-flight" key={conversation.turns.at(-1)?.id} aria-hidden="true"><BrandMark /></span>}
            </form>}
            {!payTarget && !claimTarget && !stockClaimTarget && !solanaClaimTarget && !operatorPage && conversation.turns.length === 0 && <div className="suggestions" role="group" aria-label="Example requests">
              {suggestions.map((item) => <button type="button" key={item} onClick={() => setMessage(item)}>{item}</button>)}
            </div>}
            {/* Each status item opens one sentence on why it is live or locked, from the server's own answer. */}
            {!claimTarget && !stockClaimTarget && !solanaClaimTarget && !operatorPage && <div className="desk-status-wrap">
              <p className="desk-status">
                <button type="button" className={stockTokensLive ? "live" : undefined} aria-expanded={statusNote === "stocks"} aria-controls="desk-status-note" onClick={() => toggleStatusNote("stocks")}>Stock Tokens · {stockTokensLive ? "wallet-signed" : "signing locked"}</button>
                <button type="button" className={otherTokensLive ? "live" : undefined} aria-expanded={statusNote === "tokens"} aria-controls="desk-status-note" onClick={() => toggleStatusNote("tokens")}>USDG · {otherTokensLive ? "wallet-signed" : "signing locked"}</button>
                <button type="button" className={solanaLive ? "live" : undefined} aria-expanded={statusNote === "solana"} aria-controls="desk-status-note" onClick={() => toggleStatusNote("solana")}>Solana · {solanaLive ? "wallet-signed" : "signing locked"}</button>
                <button type="button" className={arcAvailable ? "live" : undefined} aria-expanded={statusNote === "arc"} aria-controls="desk-status-note" onClick={() => toggleStatusNote("arc")}>USDC on {arcLabel} · {arcAvailable ? "wallet-signed" : "signing locked"}</button>
              </p>
              <p className="desk-status-note" id="desk-status-note" role="status" hidden={!statusNoteText}>{statusNoteText}</p>
            </div>}
          </div>
        </section>

        <aside className="side-panel" id="side-panel" aria-label="Stocks, activity, claims, SP and identities">
          <div className="side-tabs" role="tablist" aria-label="Desk panels" style={{ "--tabs": sideTabs.length, "--tab": sideTabs.indexOf(activeTab) } as CSSProperties}>
            {sideTabs.map((tab) => <button key={tab} type="button" role="tab" id={`tab-${tab}`} aria-selected={activeTab === tab} aria-controls={`panel-${tab}`} tabIndex={activeTab === tab ? 0 : -1} onClick={() => setSideTab(tab)} onKeyDown={moveTab}>
              <DecodeText text={SIDE_TAB_LABELS[tab]} replay={activeTab === tab} />{tab === "activity" && pendingCards > 0 && <span className="tab-pending"><span className="visually-hidden">, {pendingCards} pending</span></span>}{tab === "claims" && waitingClaims > 0 && <span className="tab-count">{waitingClaims}<span className="visually-hidden"> waiting for you</span></span>}
            </button>)}
          </div>
          <div className="side-section" role="tabpanel" id="panel-stocks" aria-labelledby="tab-stocks" hidden={activeTab !== "stocks"}>
            <div className="board-networks" role="group" aria-label="Board network" style={{ "--segment": boardNetwork === "robinhood" ? 0 : 1 } as CSSProperties}>
              <button type="button" aria-pressed={boardNetwork === "robinhood"} onClick={() => setBoardNetwork("robinhood")}>{stockChain.name}</button>
              <button type="button" aria-pressed={boardNetwork === "solana"} onClick={() => setBoardNetwork("solana")}>Solana</button>
            </div>
            {boardNetwork === "solana"
              ? <ChunkBoundary fallback={<p className="stock-empty" role="alert">The Solana board could not be loaded. <button type="button" onClick={() => window.location.reload()}>Reload</button></p>}>
                <Suspense fallback={<p className="stock-empty" aria-busy="true">Loading the Solana board…</p>}>
                  <SolanaStockBoard quotes={solana.quotes} asOf={solana.pricesAsOf} stocksLive={Boolean(solana.stocks?.enabled)} activeSymbol={solanaDraft?.review.asset.symbol} onSelect={selectSolanaAsset} />
                </Suspense>
              </ChunkBoundary>
              : <StockTokenList snapshot={stockSnapshot} loading={stocksLoading && stockNetwork === DESK_STOCK_NETWORK} activeSymbol={stockDraft?.network === stockNetwork ? stockDraft.intent.asset.symbol : undefined} onSelect={selectStock} />}
          </div>
          <div className="side-section" role="tabpanel" id="panel-activity" aria-labelledby="tab-activity" hidden={activeTab !== "activity"}>
            {stockDraft && stockTransaction && stockTransaction.status !== "confirmed" && <div className="live-activity"><span className={stockTransaction.status}><PendingMark /></span><div><strong>{stockDraft.intent.amount} {stockDraft.intent.asset.symbol}</strong><small>@{stockDraft.intent.recipient.username} · {STOCK_CHAINS[stockTransaction.network].name}</small></div><b>{stockTransaction.status === "verification_failed" ? "Review" : "Pending"}</b></div>}
            {stockClaimActivity && <div className="live-activity"><span className={stockClaimActivity.failed ? "verification_failed" : "pending"}><PendingMark /></span><div><strong>{stockClaimActivity.amount} {stockClaimActivity.symbol}</strong><small>{stockClaimActivity.detail}</small></div><b>{stockClaimActivity.failed ? "Review" : "Pending"}</b></div>}
            {transactionHash && transactionStatus !== "confirmed" && <div className="live-activity"><span className={transactionStatus ?? "pending"}><PendingMark /></span><div><strong>{draft?.intent.amount ?? claimDraft?.intent.amount ?? claimDetails?.amount ?? ""} USDC</strong><small>@{draft?.intent.recipient.username ?? claimDraft?.intent.recipient.username ?? claimDetails?.recipient?.username ?? "social-escrow"}</small></div><b>{transactionStatus === "verification_failed" ? "Review" : "Pending"}</b></div>}
            <PaymentActivity key={wallet ?? "signed-out"} payments={paymentHistory} authenticated={Boolean(wallet)}
              loading={session.paymentsStatus === "loading" || session.sessionStatus === "loading" || walletVerifying}
              error={session.paymentsStatus === "error" ? "Activity could not be refreshed. Try again." : undefined}
              explorerUrl={network.explorerUrl} chainName={network.chainName} networkLabel={`${stockChain.name} and ${arcLabel}`} onRefresh={() => void loadPayments()}
              emptyArtwork={<EmptyMark />} />
          </div>
          <div className="side-section" role="tabpanel" id="panel-claims" aria-labelledby="tab-claims" hidden={activeTab !== "claims"}>
            <PendingClaims links={pendingClaims} loading={pendingClaimsState.status === "loading" || session.sessionStatus === "loading" || walletVerifying}
              error={pendingClaimsState.status === "error" ? pendingClaimsState.error : undefined} authenticated={Boolean(wallet)} vaultAccounts={vaultAccounts.length}
              busy={busy} action={pendingClaimAction} statements={pendingStatements}
              onStatement={(paymentId, confirmed) => setPendingStatements((current) => {
                const next = new Set(current);
                if (confirmed) next.add(paymentId);
                else next.delete(paymentId);
                return next;
              })}
              onClaim={(link) => void actOnPendingLink(link, "claim")} onRefund={(link) => void actOnPendingLink(link, "refund")} onCopy={(link) => void copyPendingLink(link)}
              onRefresh={() => void loadPendingClaims()} onConnect={() => setManageOpen(true)} emptyArtwork={<EmptyMark />} />
          </div>
          <div className="side-section" role="tabpanel" id="panel-sp" aria-labelledby="tab-sp" hidden={activeTab !== "sp"}>
            <SpPanel summary={spSummary} rules={spRules} referral={referral} loading={spState.status === "loading" || walletVerifying} loadingMore={spLoadingMore}
              error={spState.error} authenticated={Boolean(wallet)}
              onRefresh={() => void loadSp()} onMore={() => void loadMoreSp()} onConnect={() => void connectWallet()} />
          </div>
          <div className="side-section" role="tabpanel" id="panel-identities" aria-labelledby="tab-identities" hidden={activeTab !== "identities"}>
            <section className="identity-summary" aria-labelledby="identity-summary-title">
              <div className="identity-summary-head"><h2 id="identity-summary-title">Identities</h2><span>{accountsKnown ? `${accounts.length} of ${identities.length} connected` : accountsUnknown}</span></div>
              <div className="wallet-line"><DotIcon name="wallet" size={16} /><span>{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Wallet"}</span><b className={wallet ? "verified" : undefined}>{wallet ? "Verified" : walletVerifying ? "Verifying…" : "Awaiting signature"}</b></div>
              {wallet && accountsKnown && <div className="wallet-line solana-line"><DotIcon name="link" size={16} /><span>{session.solanaAddress ? `Solana ${session.solanaAddress.slice(0, 4)}…${session.solanaAddress.slice(-4)}` : "Solana address"}</span>{session.solanaAddress ? <b className="verified">Added</b> : <button type="button" className="manage-link" disabled={Boolean(linking)} onClick={() => void addSolanaAddress()}>{linking === "solana" ? "Adding…" : "Add"}</button>}</div>}
              {wallet && session.profileStatus === "error" && <div className="identity-load-error" role="alert"><p>Your accounts could not be read just now. Nothing was removed: they are still linked.</p><button type="button" onClick={() => void sessionController.refreshProfile()}>Try again</button></div>}
              <ul className="identity-list" aria-label="Connected social identities">
                {identities.map(({ id, name, tone }) => {
                  const linked = accounts.find((account) => account.platform === id);
                  return <li className={`identity ${tone}`} key={id}>
                    <span className="identity-icon"><ProviderIcon provider={id} /></span>
                    <span className="identity-name"><strong>{name}</strong><small>{linked ? handleLabel(linked.username) : accountsUnknown ?? "Not connected"}</small></span>
                    {linked ? <DotIcon name="check" size={13} className="identity-state identity-linked" /> : <span className="identity-state" aria-hidden="true" />}
                  </li>;
                })}
              </ul>
              {wallet ? <button className="manage-link" type="button" onClick={() => setManageOpen(true)}>{accountsKnown && !accounts.length ? "Connect an account" : "Manage identities"}</button>
                : <button className="manage-link" type="button" disabled={walletVerifying || privyOpening} onClick={() => void connectWallet()}>{privyOpening ? "Opening…" : walletVerifying ? "Verifying…" : "Verify your wallet"}</button>}
              <p className="trust-note"><DotIcon name="shield" size={15} /><span>{wallet && accounts.length ? <><strong>Verified by you.</strong> Every account resolves to one wallet and stays linked until you remove it.</>
                : accountsKnown ? <><strong>No account connected yet.</strong> Connect one and people can pay you by its handle.</>
                : <><strong>Links stay saved.</strong> An account you connect stays linked to your wallet until you remove it.{wallet ? "" : " Verify that wallet to see yours."}</>}</span></p>
            </section>
          </div>
          {footerLinks}
        </aside>
      </section>}

      {(docsPage || homePage) && <footer className="site-footer">
        <p className="footer-brand"><BrandMark tile /> <DotText text="HaPaPay" /> <small>Wallet-signed payments to verified handles</small></p>
        {footerLinks}
      </footer>}

      {manageOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeIdentities}>
          <section className="identity-modal" ref={identityModalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="identity-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div><h2 id="identity-title">Connect your identities</h2><p>No username-only claims. Every account is verified by its official provider.</p></div>
              <button aria-label="Close dialog" onClick={closeIdentities}><DotIcon name="close" size={18} /></button>
            </div>
            {wallet && <div className="wallet-session">
              <DotIcon name="wallet" size={16} />
              <span><b>{`${wallet.slice(0, 6)}…${wallet.slice(-4)}`}</b><small>{exportableEvm ? "Made by Privy for this sign-in · Verified on this browser" : "Verified on this browser"}</small></span>
              {exportableEvm && <button type="button" className="export-action" disabled={Boolean(linking)} onClick={() => void exportWalletKey("evm", wallet)}>{linking === "export:evm" ? "Opening…" : "Export key"}</button>}
              <button type="button" className="disconnect-action" disabled={busy || walletVerifying || Boolean(linking) || transactionStatus === "pending" || stockTransaction?.status === "pending" || stockClaimPending || pendingClaimRunning} onClick={() => void disconnectWallet()}>Disconnect</button>
            </div>}
            {!wallet && <div className="wallet-gate"><DotIcon name="lock" size={18} /><span>Verify your wallet to see the accounts linked to it, or to connect one.</span><button disabled={walletVerifying || privyOpening} onClick={connectWallet}>{privyOpening ? "Opening…" : walletVerifying ? "Verifying…" : "Verify wallet"}</button></div>}
            {session.profileStatus === "error" && <div className="wallet-gate" role="alert"><span>Identities could not be refreshed.</span><button onClick={() => void sessionController.refreshProfile()}>Try again</button></div>}
            {identityNotice && <div className="wallet-gate identity-notice" role="alert"><span>{identityNotice}</span><button onClick={() => setIdentityNotice(undefined)}>Dismiss</button></div>}
            {farcasterRequest && <div className="farcaster-signin" aria-live="polite">
              <img src={farcasterRequest.qrCode} alt="Sign-in QR code to scan with the Farcaster app" />
              <div>
                <span className="farcaster-mark"><ProviderIcon provider="farcaster" /></span>
                <h3>Confirm in Farcaster</h3>
                <p>Scan the QR code with the Farcaster app. This panel closes after the signature is verified.</p>
                <a href={farcasterRequest.url} target="_blank" rel="noreferrer">Open Farcaster</a>
                <button onClick={() => { setFarcasterRequest(undefined); setLinking(undefined); }}>Cancel</button>
              </div>
            </div>}
            {wallet && <div className={`provider-row solana-row${unlinkConfirm === "solana" ? " confirming" : ""}`}>
              <span className="provider-logo provider-solana"><DotIcon name="link" size={16} /></span>
              <div><strong>Solana address</strong><small>{session.solanaAddress ? `${session.solanaAddress.slice(0, 6)}…${session.solanaAddress.slice(-6)} · ${exportableSolana ? "Made by Privy for this sign-in" : "Verified"}` : "Receive and send on Solana with this wallet"}</small>
                {session.solanaAddress && solanaHoldings && <small className="solana-holdings" aria-live="polite">{solanaHoldings.status === "ready" ? holdingsText(solanaHoldings) : solanaHoldings.status === "loading" ? "Reading what it holds…" : "What it holds could not be read just now."}</small>}
                {solanaElsewhere && <small className="solana-elsewhere">Not this sign-in's Solana wallet: payments from it need the wallet that holds it (Phantom, Solflare or the sign-in that made it).</small>}
              </div>
              {session.solanaAddress ? <div className="provider-actions"><span className="linked-badge"><DotIcon name="check" size={13} /> Added</span>{exportableSolana && <button type="button" className="export-action" disabled={Boolean(linking)} onClick={() => void exportWalletKey("solana", session.solanaAddress!)}>{linking === "export:solana" ? "Opening…" : "Export key"}</button>}<button className="share-action" disabled={Boolean(linking)} aria-label="Use another Solana wallet" onClick={() => (solanaSwitchSafe ? void addSolanaAddress() : setUnlinkConfirm("solana-switch"))}><DotIcon name="refresh" size={14} /></button>{unlinkConfirm !== "solana" && <button className="unlink-action" disabled={Boolean(linking)} aria-label="Remove the Solana address from this wallet" onClick={() => void removeSolanaAddress()}>Remove</button>}</div>
                : <button className="provider-action" disabled={session.profileStatus !== "ready" || Boolean(linking)} onClick={() => void addSolanaAddress()}>{linking === "solana" ? "Signing…" : "Add"}</button>}
              {unlinkConfirm === "solana" && session.solanaAddress && <div className="unlink-confirm" role="alert">
                <p>Remove this Solana address from your wallet? Payments on Solana stop reaching it until you add an address again.</p>
                <div><button className="unlink-action confirm" disabled={Boolean(linking)} onClick={() => void removeSolanaAddress()}>{linking === "unlink:solana" ? "Removing…" : "Remove"}</button><button className="unlink-keep" disabled={Boolean(linking)} onClick={() => setUnlinkConfirm(undefined)}>Keep</button></div>
              </div>}
              {unlinkConfirm === "solana-switch" && <div className="unlink-confirm" role="alert">
                <p>Switch to another Solana wallet? {solanaHoldings?.status === "ready" ? `This address ${holdingsText(solanaHoldings).replace(/^Holds/, "holds")}, and it stays here` : "What this address holds could not be read just now, and anything it holds stays here"}: {exportableSolana ? "export its key first to keep it within reach." : "only this address's own wallet can move it."}</p>
                <div><button className="unlink-action confirm" disabled={Boolean(linking)} onClick={() => { setUnlinkConfirm(undefined); void addSolanaAddress(); }}>Switch</button><button className="unlink-keep" disabled={Boolean(linking)} onClick={() => setUnlinkConfirm(undefined)}>Keep</button></div>
              </div>}
            </div>}
            <div className="provider-list">
              {providers.map((provider) => {
                const linked = accounts.find((account) => account.platform === provider.id);
                const confirming = Boolean(linked) && unlinkConfirm === provider.id;
                const telegramWaiting = provider.id === "telegram" && !telegramReady;
                return (
                  <div className={`provider-row${confirming ? " confirming" : ""}`} key={provider.id}>
                    <span className={`provider-logo provider-${provider.id}`}><ProviderIcon provider={provider.id} /></span>
                    <div><strong>{provider.name}</strong><small>{linked ? `${handleLabel(linked.username)} · Verified` : telegramWaiting && telegramFailed ? "Telegram's sign-in did not load. Close this window and open it again to retry." : provider.method}</small></div>
                    {linked ? <div className="provider-actions">{!linked.username.startsWith("#") && <button className="share-action" aria-label={`Copy ${provider.name} payment link`} onClick={() => copyPaymentLink(provider.id, linked.username)}><DotIcon name="link" size={14} /></button>}<span className="linked-badge"><DotIcon name="check" size={13} /> Linked</span>{!confirming && <button className="unlink-action" disabled={Boolean(linking)} aria-label={`Remove ${provider.name} from this wallet`} onClick={() => unlinkIdentity(provider.id)}>Remove</button>}</div> : (
                      <button className="provider-action" disabled={!provider.configured || !wallet || session.profileStatus !== "ready" || linking === provider.id || (provider.configured && telegramWaiting)} onClick={() => provider.id === "telegram" ? connectTelegram(provider) : linkProvider(provider)}>
                        {provider.configured ? linking === provider.id ? "Opening…" : telegramWaiting && wallet ? telegramFailed ? "Unavailable" : "Loading…" : "Connect" : "Setup required"}
                      </button>
                    )}
                    {confirming && linked && <div className="unlink-confirm" role="alert">
                      <p>Remove {handleLabel(linked.username)} from this wallet? Payments sent to this {provider.name} account stop reaching it until you connect it again.</p>
                      <div><button className="unlink-action confirm" disabled={Boolean(linking)} onClick={() => unlinkIdentity(provider.id)}>{linking === `unlink:${provider.id}` ? "Removing…" : "Remove"}</button><button className="unlink-keep" disabled={Boolean(linking)} onClick={() => setUnlinkConfirm(undefined)}>Keep</button></div>
                    </div>}
                  </div>
                );
              })}
            </div>
            <p className="privacy-line"><DotIcon name="link" size={14} /> A verified account receives on Solana (once it has a Solana address), {arcLabel} and {stockChain.name} right away. HaPaPay keeps the link on its own servers; the link itself is never written on chain.</p>
            <p className="privacy-line"><DotIcon name="shield" size={14} /> OAuth access tokens are not stored. Only the provider's immutable user ID and current username are recorded.</p>
            {(exportableEvm || exportableSolana) && <p className="privacy-line"><DotIcon name="lock" size={14} /> Export key opens Privy's own window with the private key of a wallet Privy made for you. HaPaPay never sees it; anyone who has the key controls the wallet, so keep it to yourself.</p>}
          </section>
        </div>
      )}
    </main>
  );
}
