import { getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { platformName } from "../src/domain/payment-intent.js";
import { PENDING_CLAIMS_LIMIT } from "../src/domain/pending-claims.js";
import { robinhoodAsset } from "../src/domain/robinhood-assets.js";
import { countedUiAmount } from "../src/domain/solana-amounts.js";
import { isSolanaStock, SOLANA_SOL } from "../src/domain/solana-assets.js";
import { solanaAssetByMint, vaultAssetByMint } from "../src/domain/solana-stocks.js";
import { vaultFee } from "../src/domain/solana-vault.js";
import { referralCode, type ReferralJoinStatus } from "../src/domain/referrals.js";
import { roundSp, type SpAssetClass, type SpNetwork } from "../src/domain/sp.js";
import { isStockClaimPlatform, type StockClaimPlatform } from "../src/domain/stock-claims.js";
import { STOCK_CHAINS, type StockTokenKind } from "../src/domain/stock-tokens.js";
import { ARC_MAINNET } from "./arc-network.js";
import type { ClaimFundingRecord, ClaimFundingRepository } from "./claim-funding-service.js";
import type { IdentityStore } from "./identity-store";
import type { PaymentRepository } from "./payment-history-service.js";
import type { SolanaTransferRepository } from "./solana-transfer-service.js";
import { NATIVE_SOL_MINT } from "./solana-transfer-service.js";
import type { SolanaClaimRecord, SolanaVaultRepository } from "./solana-vault-service.js";
import { SpRequestError, type SpAmount, type SpAwardResult, type SpPaymentEvent, type SpService, type SpVerifiedFee } from "./sp-service.js";
import type { StockClaimRecord, StockClaimRepository } from "./stock-claim-service.js";
import type { StockTransferRepository } from "./stock-transfer-service.js";
import type { TransientStateStore } from "./transient-state-store.js";
import { SETTLED_BEFORE_EXPIRY_MARGIN_SECONDS, type VaultClaimCandidate, type VaultSettlement } from "./vault-settlement.js";
import type { VerifiedSocialAccount } from "./verified-identity-service.js";

/** Only mainnet activity earns SP: Arc Mainnet, Robinhood Chain and Solana mainnet (testnets never do). */
const ROBINHOOD_MAINNET_ID = STOCK_CHAINS["robinhood-mainnet"].id;
/** A settled Solana link is read back for this long after its window closes; later ones are left to an admin. */
const SOLANA_LINK_LOOKBACK_SECONDS = 45n * 86_400n;

type Settle<R> = (record: R, input: { claimTransaction?: Hex; candidates: readonly VaultClaimCandidate[] }) => Promise<VaultSettlement>;

export type SpActivitySources = {
  arc?: { payments: PaymentRepository; links?: ClaimFundingRepository; settle?: Settle<ClaimFundingRecord> };
  robinhood?: { transfers: StockTransferRepository; links?: StockClaimRepository; settle?: Settle<StockClaimRecord> };
  solana?: { transfers: SolanaTransferRepository; address?: (wallet: Address) => Promise<string | undefined>; links?: SolanaVaultRepository; settle?: Settle<SolanaClaimRecord> };
};

/** One recorded vault link, the same on every network. */
type VaultLink<R> = {
  network: SpNetwork;
  /** `<network>:<payment id>`, the key of its SP rows. */
  link: string;
  record: R;
  payer: Address;
  recipient: { platform: StockClaimPlatform; username: string };
  amount: SpAmount;
  expiry: bigint;
  fundedAt: Date;
  /** The fee the link paid, when its record proves it (a Solana link: the program takes exactly 1% on top). */
  fee?: SpVerifiedFee;
};

/** A recorded fee in base units against the payment's base units; nothing when none was verified. */
const verifiedFee = (feeUnits: string | bigint | undefined, paymentUnits: bigint): SpVerifiedFee | undefined => {
  if (feeUnits === undefined || paymentUnits <= 0n) return undefined;
  const units = BigInt(feeUnits);
  return units > 0n ? { units, paymentUnits } : undefined;
};

type VaultNetwork<R> = {
  network: SpNetwork;
  /** EVM escrows forget a settled link, so only links whose window is open can be read back without a receipt. */
  evm: boolean;
  get(paymentId: string): Promise<R | undefined>;
  fundedBy(wallet: Address, limit: number): Promise<R[]>;
  waitingFor(recipients: Array<{ platform: StockClaimPlatform; username: string }>, now: bigint, limit: number): Promise<R[]>;
  view(record: R): VaultLink<R> | undefined;
  settle: Settle<R>;
};

export type SpClaimReport = {
  status: "awarded" | "already" | "pending" | "open" | "refunded" | "unknown";
  /** SP this report gave the reporting account. */
  awarded: number;
};

const robinhoodAssetClass = (kind: StockTokenKind): SpAssetClass => kind === "cash" ? "stable" : kind === "stock" || kind === "etf" ? "stock" : "crypto";

/**
 * Finds what an account did through HaPaPay and awards its SP: payments it sent on
 * Solana, Arc and Robinhood Chain mainnet, vault links claimed (for the claimer and for the sender), its linked
 * accounts and its Solana address. Every award is keyed by what earned it, so this can run any number of times and
 * each payment, link and bonus earns once. The desk runs it whenever it shows the balance; admins run it for everyone.
 */
export class SpActivity {
  private readonly vaults: Array<VaultNetwork<unknown>>;
  private readonly now: () => Date;

  constructor(private readonly options: {
    sp: SpService;
    identities: IdentityStore;
    sources: SpActivitySources;
    /** Where the last vault-link scan of each account is kept, so chains are read at most every `linkScanMs`. */
    stateStore?: TransientStateStore;
    linkScanMs?: number;
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
    this.vaults = [];
    const { arc, robinhood, solana } = options.sources;
    if (arc?.links && arc.settle) {
      const links = arc.links;
      this.vaults.push({
        network: "arc",
        evm: true,
        get: (paymentId) => /^0x[0-9a-fA-F]{64}$/.test(paymentId) ? links.get(ARC_MAINNET.chainId, paymentId as Hex) : Promise.resolve(undefined),
        fundedBy: (wallet, limit) => links.fundedBy(ARC_MAINNET.chainId, wallet, limit),
        waitingFor: (recipients, now, limit) => links.waitingFor(ARC_MAINNET.chainId, recipients, now, limit),
        view: (record) => ({
          network: "arc", link: `arc:${record.paymentId.toLowerCase()}`, record, payer: getAddress(record.payer),
          recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
          amount: { symbol: "USDC", assetClass: "stable", amount: record.amount }, expiry: record.expiry, fundedAt: new Date(record.confirmedAt),
        }),
        settle: arc.settle,
      } satisfies VaultNetwork<ClaimFundingRecord> as VaultNetwork<unknown>);
    }
    if (robinhood?.links && robinhood.settle) {
      const links = robinhood.links;
      this.vaults.push({
        network: "robinhood",
        evm: true,
        get: (paymentId) => /^0x[0-9a-fA-F]{64}$/.test(paymentId) ? links.claim(ROBINHOOD_MAINNET_ID, paymentId as Hex) : Promise.resolve(undefined),
        fundedBy: (wallet, limit) => links.fundedBy(ROBINHOOD_MAINNET_ID, wallet, limit),
        waitingFor: (recipients, now, limit) => links.waitingFor(ROBINHOOD_MAINNET_ID, recipients, now, limit),
        view: (record) => {
          const asset = robinhoodAsset("robinhood-mainnet", record.tokenAddress);
          if (!asset || record.chainId !== ROBINHOOD_MAINNET_ID) return undefined;
          return {
            network: "robinhood", link: `robinhood:${record.paymentId.toLowerCase()}`, record, payer: getAddress(record.payer),
            recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
            amount: { symbol: asset.symbol, assetClass: robinhoodAssetClass(asset.kind), amount: record.amount }, expiry: record.expiry, fundedAt: new Date(record.confirmedAt),
          };
        },
        settle: robinhood.settle,
      } satisfies VaultNetwork<StockClaimRecord> as VaultNetwork<unknown>);
    }
    if (solana?.links && solana.settle) {
      const links = solana.links;
      this.vaults.push({
        network: "solana",
        evm: false,
        get: (paymentId) => /^0x[0-9a-f]{64}$/.test(paymentId) ? links.claim(paymentId) : Promise.resolve(undefined),
        fundedBy: (wallet, limit) => links.fundedBy(wallet, limit),
        waitingFor: (recipients, now, limit) => links.waitingFor(recipients, now, limit),
        view: (record) => {
          const asset = vaultAssetByMint(record.mint);
          const amount = asset && countedUiAmount(record, asset);
          if (!asset || !amount) return undefined;
          return {
            network: "solana", link: `solana:${record.paymentId}`, record, payer: getAddress(record.payerWallet),
            recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
            amount: { symbol: asset.symbol, assetClass: asset.kind === "cash" ? "stable" : isSolanaStock(asset) ? "stock" : "crypto", amount },
            expiry: record.expiry, fundedAt: new Date(record.confirmedAt),
            // A Solana link is recorded only when its fee is exactly the program's 1% on top, paid to the treasury at the claim.
            fee: verifiedFee(vaultFee(record.units), record.units),
          };
        },
        settle: solana.settle,
      } satisfies VaultNetwork<SolanaClaimRecord> as VaultNetwork<unknown>);
    }
  }

  private seconds() {
    return BigInt(Math.floor(this.now().getTime() / 1000));
  }

  /** Payments this wallet sent on each mainnet, as SP events. */
  private async payments(wallet: Address): Promise<SpPaymentEvent[]> {
    const { arc, robinhood, solana } = this.options.sources;
    const [arcPayments, robinhoodTransfers, solanaTransfers] = await Promise.all([
      arc ? arc.payments.list(ARC_MAINNET.chainId, wallet) : [],
      robinhood ? robinhood.transfers.list(wallet) : [],
      solana ? solana.transfers.list(wallet) : [],
    ]);
    const events: SpPaymentEvent[] = [];
    for (const record of arcPayments) {
      if (record.chainId !== ARC_MAINNET.chainId || getAddress(record.sender) !== wallet) continue;
      events.push({
        account: wallet, network: "arc", sourceKey: `arc:${record.transactionHash.toLowerCase()}`, counterparty: getAddress(record.recipient),
        amount: { symbol: "USDC", assetClass: "stable", amount: record.amount }, fee: verifiedFee(record.feeUnits, parseUnits(record.amount, 6)),
        detail: `${record.amount} USDC to @${record.username} on ${platformName(record.platform)}`, at: new Date(record.confirmedAt),
      });
    }
    for (const record of robinhoodTransfers) {
      if (record.chainId !== ROBINHOOD_MAINNET_ID || getAddress(record.sender) !== wallet) continue;
      const asset = robinhoodAsset("robinhood-mainnet", record.tokenAddress);
      if (!asset) continue;
      events.push({
        account: wallet, network: "robinhood", sourceKey: `robinhood:${record.transactionHash.toLowerCase()}`, counterparty: getAddress(record.recipient),
        amount: { symbol: asset.symbol, assetClass: robinhoodAssetClass(asset.kind), amount: record.amount }, fee: verifiedFee(record.feeUnits, record.units),
        detail: `${record.amount} ${asset.symbol} to @${record.username} on ${platformName(record.platform)}`, at: new Date(record.confirmedAt),
      });
    }
    for (const record of solanaTransfers) {
      if (!isAddress(record.senderWallet) || getAddress(record.senderWallet) !== wallet) continue;
      const asset = record.mint === NATIVE_SOL_MINT ? SOLANA_SOL : solanaAssetByMint(record.mint);
      // What the row counts for comes from the units its confirm verified on chain, never from its amount text alone.
      const amount = asset && countedUiAmount(record, asset);
      if (!asset || !amount) continue;
      events.push({
        account: wallet, network: "solana", sourceKey: `solana:${record.signature}:${record.paymentIndex}`,
        counterparty: isAddress(record.recipientWallet) ? getAddress(record.recipientWallet) : null,
        amount: { symbol: asset.symbol, assetClass: asset.kind === "cash" ? "stable" : isSolanaStock(asset) ? "stock" : "crypto", amount },
        // The Solana confirm checks the treasury received the whole fee before it records the payments.
        fee: verifiedFee(record.feeUnits, BigInt(record.units)),
        detail: `${amount} ${asset.symbol} to @${record.username} on ${platformName(record.platform)}`, at: new Date(record.confirmedAt),
      });
    }
    return events;
  }

  private async verifiedAccounts(wallet: Address) {
    const profile = await this.options.identities.profile(wallet);
    return (await Promise.all(profile.accounts.map((account) => this.options.identities.account(wallet, account.platform))))
      .filter((account): account is VerifiedSocialAccount => account !== undefined);
  }

  /**
   * Awards everything this account did that has no SP row yet, oldest first, so the first-payment bonus and each
   * day's cap fall where they happened. Vault links are read back from chain at most every `linkScanMs`, or always
   * with `links: "now"`.
   */
  async syncAccount(walletInput: string, options: { links?: boolean | "now" } = {}) {
    const wallet = getAddress(walletInput);
    const result = { awarded: 0, pending: 0, unavailable: [] as SpNetwork[] };
    const add = (award: SpAwardResult) => {
      result.awarded = roundSp(result.awarded + award.awarded);
      if (award.pending) result.pending++;
    };
    const events = (await this.payments(wallet)).sort((left, right) => left.at.getTime() - right.at.getTime());
    const accounts = await this.verifiedAccounts(wallet);
    const solanaAddress = await this.options.sources.solana?.address?.(wallet);
    const keys = [
      ...events.map((event) => event.sourceKey),
      ...accounts.map((account) => `linked:${account.platform}:${account.providerUserId}`),
      ...(solanaAddress ? [`solana_address:${solanaAddress}`] : []),
    ];
    const done = await this.options.sp.repository.sourceKeys(keys);
    for (const event of events) if (!done.has(event.sourceKey)) add(await this.options.sp.awardPayment(event));
    for (const account of accounts) {
      if (done.has(`linked:${account.platform}:${account.providerUserId}`)) continue;
      const verifiedAt = new Date(account.verifiedAt);
      add(await this.options.sp.awardLinkedAccount({ account: wallet, platform: account.platform, providerUserId: account.providerUserId, at: Number.isNaN(verifiedAt.getTime()) ? this.now() : verifiedAt }));
    }
    if (solanaAddress && !done.has(`solana_address:${solanaAddress}`)) add(await this.options.sp.awardSolanaAddress({ account: wallet, address: solanaAddress, at: this.now() }));
    if (options.links !== false && (options.links === "now" || await this.linkScanDue(wallet))) {
      for (const vault of this.vaults) {
        try {
          for (const award of await this.scanLinks(vault, wallet, accounts)) add(award);
        } catch {
          // A chain that cannot be read now is read again at the next scan; nothing is written for it.
          result.unavailable.push(vault.network);
        }
      }
    }
    // Shares an invite missed while it was being written are given now; a failure waits for the next sync.
    await this.options.sp.referralCatchUp(wallet).catch(() => 0);
    return result;
  }

  /**
   * Joins this account to the person whose invite code it brings, once and for good. Only
   * an account that has not yet paid anyone or funded a vault link through HaPaPay can join, never with its own
   * code or with the code of someone it invited.
   */
  async joinWithCode(walletInput: string, codeInput: unknown): Promise<ReferralJoinStatus> {
    const referrals = this.options.sp.referrals;
    if (!referrals) throw new SpRequestError("Invites are not available on this server.");
    const wallet = getAddress(walletInput);
    const code = referralCode(codeInput);
    const referrer = code ? await referrals.accountOf(code) : undefined;
    if (!code || !referrer) return "unknown";
    if (referrer === wallet) return "self";
    if (await referrals.referrerOf(wallet)) return "already";
    if ((await referrals.referrerOf(referrer))?.referrer === wallet) return "cycle";
    if (!await this.isNew(wallet)) return "not_new";
    const binding = await referrals.bind({ invitee: wallet, referrer, code });
    if (!binding) return "cycle";
    return binding.referrer === referrer ? "joined" : "already";
  }

  /** New to invites: no payment sent and no vault link funded through HaPaPay on any mainnet. */
  private async isNew(wallet: Address) {
    if ((await this.payments(wallet)).length) return false;
    for (const vault of this.vaults) if ((await vault.fundedBy(wallet, 1)).length) return false;
    return true;
  }

  private async linkScanDue(wallet: Address) {
    const store = this.options.stateStore;
    if (!store) return true;
    const every = this.options.linkScanMs ?? 180_000;
    const now = this.now().getTime();
    const last = await store.get<{ at: number }>("sp-link-scan", wallet).catch(() => undefined);
    if (last && now - last.at < every) return false;
    await store.put("sp-link-scan", wallet, { at: now }, now + every).catch(() => undefined);
    return true;
  }

  /**
   * The account's vault links that have not earned yet: links sent to its accounts whose window is open (claimed by
   * it, if the chain shows them claimed) and links it funded (claimed by whoever holds the account it was locked to).
   */
  private async scanLinks(vault: VaultNetwork<unknown>, wallet: Address, accounts: VerifiedSocialAccount[]) {
    const now = this.seconds();
    const vaultAccounts = accounts.filter((account) => isStockClaimPlatform(account.platform)) as Array<VerifiedSocialAccount & { platform: StockClaimPlatform }>;
    const [waiting, funded] = await Promise.all([
      vaultAccounts.length ? vault.waitingFor(vaultAccounts.map(({ platform, username }) => ({ platform, username })), now, PENDING_CLAIMS_LIMIT) : [],
      vault.fundedBy(wallet, PENDING_CLAIMS_LIMIT * 2),
    ]);
    const incoming = waiting.map((record) => vault.view(record)).filter((link): link is VaultLink<unknown> => link !== undefined);
    const outgoing = funded.map((record) => vault.view(record)).filter((link): link is VaultLink<unknown> => link !== undefined)
      // An EVM escrow forgets a settled link, so a closed window can only be told by its claim receipt.
      .filter((link) => vault.evm ? now + SETTLED_BEFORE_EXPIRY_MARGIN_SECONDS < link.expiry : link.expiry + SOLANA_LINK_LOOKBACK_SECONDS > now);
    const done = await this.options.sp.repository.sourceKeys([
      ...incoming.map((link) => `claim:${link.link}`),
      ...outgoing.map((link) => `vault:${link.link}`),
    ]);
    const awards: SpAwardResult[] = [];
    const me: VaultClaimCandidate = { wallet, accounts };
    // A settled link awards both sides; this account's sync counts only what it earned itself (audit, 2026-10-06: the
    // sender's toast added the claimer's SP).
    const own = async (link: VaultLink<unknown>, settlement: VaultSettlement) => {
      const [claimer, sender] = await this.settled(link, settlement);
      if (claimer && settlement.state === "claimed" && settlement.claimer && getAddress(settlement.claimer) === wallet) awards.push(claimer);
      if (sender && getAddress(link.payer) === wallet) awards.push(sender);
    };
    for (const link of incoming.filter((candidate) => !done.has(`claim:${candidate.link}`))) {
      await own(link, await vault.settle(link.record, { candidates: [me] }));
    }
    for (const link of outgoing.filter((candidate) => !done.has(`vault:${candidate.link}`))) {
      await own(link, await vault.settle(link.record, { candidates: [me, ...await this.holder(link)] }));
    }
    return awards;
  }

  /** The account a link's recipient handle is linked to now, as a claim candidate. */
  private async holder(link: VaultLink<unknown>): Promise<VaultClaimCandidate[]> {
    const wallet = await this.options.identities.resolve(link.recipient.platform, link.recipient.username);
    if (!wallet) return [];
    const account = await this.options.identities.account(wallet, link.recipient.platform);
    return account ? [{ wallet: getAddress(wallet), accounts: [account] }] : [];
  }

  private async settled(link: VaultLink<unknown>, settlement: VaultSettlement): Promise<SpAwardResult[]> {
    const detail = `${link.amount.amount} ${link.amount.symbol} vault link for @${link.recipient.username} on ${platformName(link.recipient.platform)}`;
    if (settlement.state === "refunded") {
      await this.options.sp.closeRefundedLink({ sender: link.payer, network: link.network, link: link.link, detail, at: this.now() });
      return [];
    }
    if (settlement.state !== "claimed") return [];
    const award = await this.options.sp.awardClaim({
      claimer: settlement.claimer, sender: link.payer, network: link.network, link: link.link, amount: link.amount, fee: link.fee,
      detail, at: this.now(), fundedAt: link.fundedAt,
    });
    return [award.claimer, award.sender];
  }

  /**
   * A vault link the account says it claimed: read back from chain (the claim receipt on Arc and Robinhood Chain, the
   * program's account on Solana) and awarded to whoever claimed it, with the sender's SP. Safe to repeat.
   */
  async reportClaim(walletInput: string, input: { network: SpNetwork; paymentId: string; transaction?: string }): Promise<SpClaimReport> {
    const wallet = getAddress(walletInput);
    const vault = this.vaults.find((candidate) => candidate.network === input.network);
    if (!vault) throw new SpRequestError("Vault links on this network do not earn SP on this server.");
    const paymentId = input.paymentId.toLowerCase();
    const record = await vault.get(input.paymentId) ?? (paymentId !== input.paymentId ? await vault.get(paymentId) : undefined);
    const link = record === undefined ? undefined : vault.view(record);
    if (!link) throw new SpRequestError("HaPaPay has no record of this vault link.");
    const claimTransaction = vault.evm && input.transaction && /^0x[0-9a-fA-F]{64}$/.test(input.transaction) ? input.transaction as Hex : undefined;
    if ((await this.options.sp.repository.sourceKeys([`claim:${link.link}`])).size) return { status: "already", awarded: 0 };
    const settlement = await vault.settle(link.record, { claimTransaction, candidates: [{ wallet, accounts: await this.verifiedAccounts(wallet) }, ...await this.holder(link)] });
    if (settlement.state !== "claimed") return { status: settlement.state, awarded: 0 };
    const [claimer, sender] = await this.settled(link, settlement);
    if (claimer?.pending || sender?.pending) return { status: "pending", awarded: 0 };
    return { status: "awarded", awarded: settlement.claimer === wallet ? claimer?.awarded ?? 0 : 0 };
  }
}
