import { createApp } from "./app.js";
import { WalletAuthService } from "./wallet-auth.js";
import { DiscordOAuthProvider, GitHubOAuthProvider, TelegramBotTokenCheck, XOAuthProvider } from "./social-providers.js";
import { OAuthFlowStore } from "./oauth-flow-store.js";
import { VerifiedIdentityService } from "./verified-identity-service.js";
import { ARC_MAINNET, arcServerTransport, readArcContractConfig, readArcNetworkConfig, type ArcContractConfig, type ArcNetworkConfig } from "./arc-network.js";
import { AccountAddressService, MemoryAccountAddressRepository, type AccountAddressRepository } from "./account-address-service.js";
import { readSolanaConfig, solanaRpc } from "./solana-network.js";
import { SolanaMarketData } from "./solana-market.js";
import { MemorySolanaTransferRepository, SolanaTransferService, type SolanaTransferRepository } from "./solana-transfer-service.js";
import { MemorySolanaVaultRepository, SolanaVaultService, type SolanaVaultRepository } from "./solana-vault-service.js";
import { SOLANA_SOL } from "../src/domain/solana-assets.js";
import { SOLANA_ASSETS } from "../src/domain/solana-stocks.js";
import { SOLANA_MAINNET } from "../src/domain/solana-chains.js";
import { attachVercelDatabasePool, createDatabasePool, migrateDatabase, postgresStores, verifyDatabaseSchema } from "./database.js";
import type { IdentityStore } from "./identity-store";
import { createPublicClient, getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { arcGasReserve } from "../src/domain/arc-transaction.js";
import { privateKeyToAccount } from "viem/accounts";
import { createAppClient, viemConnector } from "@farcaster/auth-client";
import { FarcasterAuthService } from "./farcaster-auth-service.js";
import { MemoryTransientStateStore, type TransientStateStore } from "./transient-state-store.js";
import { readAppOrigin, readDatabaseUrl, readFarcasterRpcUrl, readSessionSecret, readTrustProxy } from "./runtime-config.js";
import { fileURLToPath } from "node:url";
import { MemoryPaymentRepository, PaymentHistoryService, type PaymentRepository } from "./payment-history-service.js";
import { OfficialRecipientDirectory } from "./recipient-discovery.js";
import { ClaimablePaymentService } from "./claimable-payment-service.js";
import { ClaimRedemptionService } from "./claim-redemption-service.js";
import { verifyArcRuntime } from "./arc-runtime-verification.js";
import { ClaimFundingService, MemoryClaimFundingRepository, type ClaimFundingRepository } from "./claim-funding-service.js";
import { StockTokenMarketData } from "./stock-token-market.js";
import { MemoryStockTransferRepository, StockTransferService, type StockTransferRepository } from "./stock-transfer-service.js";
import { readRobinhoodTransferConfig, readStockClaimConfig, robinhoodChainClient } from "./robinhood-network.js";
import { MemoryStockClaimRepository, StockClaimService, type StockClaimRepository } from "./stock-claim-service.js";
import { receiptReader } from "./receipts.js";
import { resolve } from "node:path";
import { loadEnvironmentFile } from "./environment.js";
import {
  type OnchainContractClient,
  verifyClaimEscrowContract,
  verifyIdentityRegistryContract,
} from "./readiness.js";
import type { FeeSchedule } from "../src/domain/fees.js";
import { STOCK_CLAIM_ESCROW_REVISION, stockClaimEscrowAbi } from "../src/domain/stock-claims.js";
import { STOCK_CHAINS } from "../src/domain/stock-tokens.js";
import { approvalCovers, quoteFee } from "./stock-transfer-service.js";
import type { ArcFeeDesk, ArcMainnetSetup } from "./app.js";
import { MemorySpRepository, SpService, type SpPrices, type SpRepository } from "./sp-service.js";
import { MemoryReferralStore, type ReferralStore } from "./referral-store.js";
import { ReferralPayouts } from "./referral-payouts.js";
import { SpActivity } from "./sp-activity.js";
import {
  AdminAuthService,
  MemoryAdminAuditRepository,
  MemoryAdminSettingsRepository,
  readAdminWallets,
  type AdminAuditRepository,
  type AdminSettingsRepository,
} from "./admin-service.js";
import type { AdminRecords } from "./admin-records.js";
import { DeskControls } from "./desk-controls.js";

loadEnvironmentFile();

export type StartupContractCapabilities = {
  identityRegistry?: { address: Address; verifier: Address; securityRevision: bigint };
  claimEscrow?: { address: Address; verifier: Address; securityRevision: bigint; fees: FeeSchedule };
  /** Why a configured contract was refused, for the operator page. Built from fixed messages; never a secret. */
  problems: Partial<Record<"identityRegistry" | "claimEscrow", string>>;
};

/**
 * Verifies the selected Arc network's configured registry and escrow on chain. Each contract is checked on its own,
 * so a refused registry never takes the escrow down with it (and the reverse); a refused contract leaves its reason in
 * `problems`. The desk writes no identity records (verified links live in the database), so the registry check only
 * keeps the operator's Arc contract set whole; a refused escrow switches vault links off, and with them the fee router
 * Arc Mainnet payments need.
 */
export async function verifyStartupContractCapabilities(input: {
  network: ArcNetworkConfig;
  client?: OnchainContractClient;
  contracts: ArcContractConfig;
}) {
  const capabilities: StartupContractCapabilities = { problems: {} };
  if (!input.network.ready || !input.client) return capabilities;
  const { contracts } = input;
  const reason = (error: unknown) => error instanceof Error ? error.message : "The contract could not be verified.";
  if (contracts.operatorInvalid) {
    const message = "The configured operator wallet is not a valid address, so no Arc contract is trusted.";
    if (contracts.registryAddress) capabilities.problems.identityRegistry = message;
    if (contracts.escrowAddress) capabilities.problems.claimEscrow = message;
    return capabilities;
  }

  if (contracts.registryAddress && contracts.identityAttestorKey) {
    try {
      // On Arc Mainnet the registry's owner is always checked: an unknown owner could rotate its verifier later.
      if (input.network.environment === "mainnet" && !contracts.operator) throw new Error("The operator wallet is not set, so the registry's owner cannot be verified.");
      const address = getAddress(contracts.registryAddress);
      const verifier = attestorAddress(contracts.identityAttestorKey);
      const verified = await verifyIdentityRegistryContract({
        registry: address,
        identityVerifier: verifier,
        ...(contracts.operator ? { owner: contracts.operator } : {}),
      }, input.client);
      capabilities.identityRegistry = { address, verifier, securityRevision: verified.securityRevision };
    } catch (error) {
      capabilities.problems.identityRegistry = reason(error);
    }
  }

  if (contracts.escrowAddress && contracts.claimAttestorKey) {
    try {
      if (!contracts.operator) throw new Error("The operator wallet is not set, so the escrow's fee contracts cannot be verified.");
      const address = getAddress(contracts.escrowAddress);
      const verifier = attestorAddress(contracts.claimAttestorKey);
      const verified = await verifyClaimEscrowContract({
        escrow: address,
        claimVerifier: verifier,
        operator: contracts.operator,
        chainName: input.network.chainName ?? "Arc",
      }, input.client);
      capabilities.claimEscrow = { address, verifier, securityRevision: verified.securityRevision, fees: verified.fees };
    } catch (error) {
      capabilities.problems.claimEscrow = reason(error);
    }
  }

  return capabilities;
}

type StartupReceiptClient = ConstructorParameters<typeof PaymentHistoryService>[0]["client"];
type StartupRecipientDirectory = ConstructorParameters<typeof ClaimablePaymentService>[0]["directory"];
type StartupEscrowPayment = { payer: Address; token: Address; identityKey: Hex; amount: bigint; fee: bigint; expiry: bigint };

const usdcBalanceAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
/** The USDC a plain transfer on Arc keeps aside for gas, which Arc takes in USDC. */
function transferGasOf(client: { getGasPrice(): Promise<bigint> }) {
  return async () => arcGasReserve(await client.getGasPrice(), { approvals: 1, payments: 0 });
}

/** Reads a wallet's USDC balance on Arc. */
function usdcBalanceOf(
  client: { readContract(call: { address: Address; abi: typeof usdcBalanceAbi; functionName: "balanceOf"; args: [Address] }): Promise<unknown> },
  usdc: Address,
) {
  return async (owner: Address) => await client.readContract({ address: usdc, abi: usdcBalanceAbi, functionName: "balanceOf", args: [owner] }) as bigint;
}

export function buildStartupServices(input: {
  network: ArcNetworkConfig;
  capabilities: StartupContractCapabilities;
  contracts: Pick<ArcContractConfig, "claimAttestorKey">;
  client?: StartupReceiptClient & {
    readContract(input: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
    readEscrowPayment(escrow: Address, paymentId: Hex): Promise<StartupEscrowPayment>;
    /** The network's gas price in native (18-decimal) USDC, for the gas a payment keeps aside. */
    getGasPrice?(): Promise<bigint>;
  };
  paymentRepository: PaymentRepository;
  claimFundingRepository: ClaimFundingRepository;
  recipientDirectory: StartupRecipientDirectory;
}) {
  if (!input.network.ready || !input.client) {
    return {
      payments: undefined,
      claims: undefined,
      claimFundings: undefined,
      redemptions: undefined,
      arcFees: undefined,
    };
  }

  const network = input.network;
  const client = input.client;
  const chainName = network.chainName ?? "Arc";
  const payments = new PaymentHistoryService({
    chainId: network.chainId,
    usdc: network.usdcAddress,
    repository: input.paymentRepository,
    client,
    chainName,
    // Direct payments go through the escrow's router; its `Paid` event is the fee a payment paid.
    ...(input.capabilities.claimEscrow?.fees ? { router: getAddress(input.capabilities.claimEscrow.fees.router) } : {}),
  });

  let claims: ClaimablePaymentService | undefined;
  let claimFundings: ClaimFundingService | undefined;
  let redemptions: ClaimRedemptionService | undefined;
  let arcFees: ArcFeeDesk | undefined;
  const claimAttestorKey = input.contracts.claimAttestorKey;
  const escrowCapability = input.capabilities.claimEscrow;
  if (escrowCapability?.securityRevision === STOCK_CLAIM_ESCROW_REVISION && claimAttestorKey) {
    const fees = escrowCapability.fees;
    const reader = { readContract: (call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => client.readContract(call) };
    const gasReserve = client.getGasPrice
      ? async (calls: { approvals: number; payments: number }) => arcGasReserve(await client.getGasPrice!(), calls)
      : undefined;
    claims = new ClaimablePaymentService({
      usdc: network.usdcAddress,
      escrow: escrowCapability.address,
      fees,
      client: reader as never,
      chainName,
      directory: input.recipientDirectory,
      gasReserve,
    });
    claimFundings = new ClaimFundingService({
      chainId: network.chainId,
      escrow: escrowCapability.address,
      usdc: network.usdcAddress,
      repository: input.claimFundingRepository,
      directory: input.recipientDirectory,
      client,
      chainName,
    });
    redemptions = new ClaimRedemptionService({
      chainId: network.chainId,
      escrow: escrowCapability.address,
      usdc: network.usdcAddress,
      attestor: privateKeyToAccount(claimAttestorKey as Hex),
      expectedVerifier: escrowCapability.verifier,
      readPayment: (paymentId) => client.readEscrowPayment(escrowCapability.address, paymentId),
      readReceipt: (hash) => receiptReader(client)({ hash }),
      records: input.claimFundingRepository,
      network: { id: network.environment === "mainnet" ? "arc-mainnet" : "arc-testnet", name: chainName },
    });
    // Direct payments use the same router as the escrow, so a payment and a vault link always cost the same.
    arcFees = {
      schedule: fees,
      quote: (payer: Address, units: bigint) => quoteFee(reader as never, fees, payer, units, chainName),
      usdcBalance: usdcBalanceOf(client, network.usdcAddress),
      approvalCovers: (owner: Address, total: bigint) => approvalCovers(reader, network.usdcAddress, owner, getAddress(fees.router), total),
      gasReserve,
    };
  }

  return { payments, claims, claimFundings, redemptions, arcFees };
}

export async function bootApplication(mode: "local" | "vercel") {
  const runtime = {
    NODE_ENV: mode === "vercel" ? "production" : process.env.NODE_ENV,
    APP_URL: process.env.APP_URL,
    APP_DOMAIN: process.env.APP_DOMAIN,
    SESSION_SECRET: process.env.SESSION_SECRET,
    FARCASTER_OPTIMISM_RPC_URL: process.env.FARCASTER_OPTIMISM_RPC_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  const { url: appUrl, domain: appDomain } = readAppOrigin(runtime);
  const sessionSecret = readSessionSecret(runtime);
  const farcasterRpcUrl = readFarcasterRpcUrl(runtime);
  const databaseUrl = readDatabaseUrl(runtime);
  const github = process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
  ? new GitHubOAuthProvider({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      redirectUri: `${appUrl}/api/oauth/github/callback`,
    })
  : undefined;
  const x = process.env.X_CLIENT_ID
  ? new XOAuthProvider({
      clientId: process.env.X_CLIENT_ID,
      clientSecret: process.env.X_CLIENT_SECRET,
      redirectUri: `${appUrl}/api/oauth/x/callback`,
    })
  : undefined;
  const discord = process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
  ? new DiscordOAuthProvider({
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      redirectUri: `${appUrl}/api/oauth/discord/callback`,
    })
  : undefined;
  // A space or line break pasted with the token changes every Telegram hash while the bot ID still reads correctly.
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;

  const pool = databaseUrl ? createDatabasePool(databaseUrl) : undefined;
  try {
  let identities: IdentityStore = new VerifiedIdentityService();
  let transientState: TransientStateStore = new MemoryTransientStateStore();
  let paymentRepository: PaymentRepository = new MemoryPaymentRepository();
  let claimFundingRepository: ClaimFundingRepository = new MemoryClaimFundingRepository();
  let stockTransferRepository: StockTransferRepository = new MemoryStockTransferRepository();
  let stockClaimRepository: StockClaimRepository = new MemoryStockClaimRepository();
  let accountAddressRepository: AccountAddressRepository = new MemoryAccountAddressRepository();
  let solanaTransferRepository: SolanaTransferRepository = new MemorySolanaTransferRepository();
  let solanaVaultRepository: SolanaVaultRepository = new MemorySolanaVaultRepository();
  let spRepository: SpRepository = new MemorySpRepository();
  let referralStore: ReferralStore = new MemoryReferralStore();
  let adminAuditRepository: AdminAuditRepository = new MemoryAdminAuditRepository();
  let adminSettingsRepository: AdminSettingsRepository = new MemoryAdminSettingsRepository();
  let adminRecords: AdminRecords | undefined;
  let identityStoreKind: "memory" | "postgres" = "memory";
  if (pool) {
    if (mode === "vercel") {
      await attachVercelDatabasePool(pool);
      await verifyDatabaseSchema(pool);
    } else if (runtime.NODE_ENV === "production") {
      // Production applies migrations only through `npm run migrate:database`; a container checks the schema read-only.
      await verifyDatabaseSchema(pool);
    } else {
      await migrateDatabase(pool);
    }
    const stores = postgresStores(pool);
    identities = stores.identities;
    transientState = stores.transientState;
    paymentRepository = stores.paymentRepository;
    claimFundingRepository = stores.claimFundingRepository;
    stockTransferRepository = stores.stockTransferRepository;
    stockClaimRepository = stores.stockClaimRepository;
    accountAddressRepository = stores.accountAddressRepository;
    solanaTransferRepository = stores.solanaTransferRepository;
    solanaVaultRepository = stores.solanaVaultRepository;
    spRepository = stores.spRepository;
    referralStore = stores.referralStore;
    adminAuditRepository = stores.adminAuditRepository;
    adminSettingsRepository = stores.adminSettingsRepository;
    adminRecords = stores.adminRecords;
    identityStoreKind = "postgres";
  }

  const network = readArcNetworkConfig({
    ARC_NETWORK_MODE: process.env.ARC_NETWORK_MODE,
    ARC_MAINNET_RPC_URL: process.env.ARC_MAINNET_RPC_URL,
    ARC_MAINNET_CHAIN_ID: process.env.ARC_MAINNET_CHAIN_ID,
    ARC_MAINNET_EXPLORER_URL: process.env.ARC_MAINNET_EXPLORER_URL,
    ARC_MAINNET_USDC_ADDRESS: process.env.ARC_MAINNET_USDC_ADDRESS,
  });
  // A failed Arc RPC check turns the Arc features off; it never takes the site (and Robinhood Chain) down with it.
  let arcNetwork: ArcNetworkConfig = network;
  let arcClient = network.ready ? createPublicClient({ transport: arcServerTransport(network) }) : undefined;
  if (network.ready && arcClient) {
    try {
      await verifyArcRuntime(network, arcClient);
    } catch {
      arcNetwork = { ready: false, reason: `${network.chainName ?? "Arc"} could not be verified right now. Try again shortly.`, environment: network.environment, chainName: network.chainName };
      arcClient = undefined;
    }
  }
  const arcMode = network.environment === "mainnet" ? "mainnet" : "testnet";
  const arcContractEnvironment = {
    ARC_IDENTITY_REGISTRY_ADDRESS: process.env.ARC_IDENTITY_REGISTRY_ADDRESS,
    IDENTITY_ATTESTOR_PRIVATE_KEY: process.env.IDENTITY_ATTESTOR_PRIVATE_KEY,
    ARC_CLAIM_ESCROW_ADDRESS: process.env.ARC_CLAIM_ESCROW_ADDRESS,
    CLAIM_ATTESTOR_PRIVATE_KEY: process.env.CLAIM_ATTESTOR_PRIVATE_KEY,
    CONTRACT_OWNER_ADDRESS: process.env.CONTRACT_OWNER_ADDRESS,
    ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS: process.env.ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS,
    ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY: process.env.ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY,
    ARC_MAINNET_CLAIM_ESCROW_ADDRESS: process.env.ARC_MAINNET_CLAIM_ESCROW_ADDRESS,
    ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: process.env.ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY,
    ARC_MAINNET_OPERATOR_ADDRESS: process.env.ARC_MAINNET_OPERATOR_ADDRESS,
    ROBINHOOD_OPERATOR_ADDRESS: process.env.ROBINHOOD_OPERATOR_ADDRESS,
    ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY: process.env.ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY,
    ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: process.env.ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY,
  };
  const arcContracts = readArcContractConfig(arcContractEnvironment, arcMode);
  const contractReader = (client: Pick<PublicClient, "getBytecode" | "readContract">): OnchainContractClient => ({
    getBytecode: ({ address }) => client.getBytecode({ address }),
    readContract: (call) => client.readContract(call as never),
  });
  const contractCapabilities = await verifyStartupContractCapabilities({
    network: arcNetwork,
    contracts: arcContracts,
    client: arcClient ? contractReader(arcClient) : undefined,
  });
  const recipientDirectory = new OfficialRecipientDirectory({
    // Trimmed as /api/health reads them, so a pasted space or line break never makes the two disagree.
    githubToken: process.env.GITHUB_API_TOKEN?.trim() || undefined,
    xBearerToken: process.env.X_API_BEARER_TOKEN?.trim() || undefined,
    // A platform that refuses this server's lookups pauses its vault links on every instance, not only this one.
    stateStore: transientState,
  });
  const startupServices = buildStartupServices({
    network: arcNetwork,
    capabilities: contractCapabilities,
    contracts: arcContracts,
    paymentRepository,
    claimFundingRepository,
    recipientDirectory,
    client: arcClient ? {
      getTransactionReceipt: ({ hash }) => arcClient!.getTransactionReceipt({ hash }),
      getTransaction: ({ hash }) => arcClient!.getTransaction({ hash }),
      readContract: (call) => arcClient!.readContract(call as never),
      getGasPrice: () => arcClient!.getGasPrice(),
      readEscrowPayment: async (claimEscrow, paymentId) => {
        const [payer, token, identityKey, amount, fee, expiry] = await arcClient!.readContract({
          address: claimEscrow,
          abi: stockClaimEscrowAbi,
          functionName: "payments",
          args: [paymentId],
        });
        return { payer, token, identityKey, amount, fee, expiry };
      },
    } : undefined,
  });

  // The operator page deploys Arc Mainnet's contracts before production switches to it, so its settings, attestor
  // addresses and a read-only check of a deployment are available while Arc still runs on testnet.
  const arcMainnetContracts = arcMode === "mainnet" ? arcContracts : readArcContractConfig(arcContractEnvironment, "mainnet");
  let arcMainnetClient: PublicClient | undefined;
  const arcMainnetSetup: ArcMainnetSetup = {
    contracts: arcMainnetContracts,
    live: arcMode === "mainnet" && arcNetwork.ready && Boolean(contractCapabilities.identityRegistry && contractCapabilities.claimEscrow),
    problems: arcMode === "mainnet" ? contractCapabilities.problems : {},
    fees: arcMode === "mainnet" ? contractCapabilities.claimEscrow?.fees : undefined,
    identityVerifier: safeAttestorAddress(arcMainnetContracts.identityAttestorKey),
    claimVerifier: safeAttestorAddress(arcMainnetContracts.claimAttestorKey),
    reader: () => {
      const provider = network.ready && network.environment === "mainnet" ? network.serverRpcUrl : undefined;
      arcMainnetClient ??= createPublicClient({ transport: arcServerTransport({ rpcUrl: ARC_MAINNET.rpcUrl, serverRpcUrl: provider, environment: "mainnet" }) }) as PublicClient;
      const client = arcMainnetClient;
      return {
        ...contractReader(client),
        getTransactionCount: ({ address }) => client.getTransactionCount({ address }),
        getTransactionReceipt: receiptReader(client),
      };
    },
  };

  // Robinhood reads start lazily: the first stock request verifies the RPC's chain ID, so boot never waits on it.
  const robinhood = readRobinhoodTransferConfig({
    ROBINHOOD_TESTNET_RPC_URL: process.env.ROBINHOOD_TESTNET_RPC_URL,
    ROBINHOOD_MAINNET_RPC_URL: process.env.ROBINHOOD_MAINNET_RPC_URL,
    ROBINHOOD_TESTNET_STOCK_TRANSFERS: process.env.ROBINHOOD_TESTNET_STOCK_TRANSFERS,
    ROBINHOOD_MAINNET_STOCK_TRANSFERS: process.env.ROBINHOOD_MAINNET_STOCK_TRANSFERS,
    ROBINHOOD_TESTNET_TOKEN_TRANSFERS: process.env.ROBINHOOD_TESTNET_TOKEN_TRANSFERS,
    ROBINHOOD_MAINNET_TOKEN_TRANSFERS: process.env.ROBINHOOD_MAINNET_TOKEN_TRANSFERS,
  });
  // Every network with a valid RPC gets a read-only client: USDG, claims and refunds read it even while
  // Stock Token transfers are off. The switches decide what may be prepared.
  const stockTransfers = new StockTransferService({
    networks: Object.fromEntries(Object.values(robinhood).map((config) => [config.network, {
      enabled: config.enabled,
      reason: config.reason,
      tokens: config.tokens,
      client: config.rpcUrl ? robinhoodChainClient(config.rpcUrl, STOCK_CHAINS[config.network].rpcUrl) : undefined,
    }])),
    repository: stockTransferRepository,
  });
  // Claim links reuse the transfer service's chain and token checks. The escrow address is not configuration: the
  // operator deploys it from the operator page and the server registers it after verifying it on chain.
  const stockClaims = new StockClaimService({
    transfers: stockTransfers,
    repository: stockClaimRepository,
    directory: recipientDirectory,
    config: readStockClaimConfig({
      ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY: process.env.ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY,
      ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: process.env.ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY,
      CLAIM_ATTESTOR_PRIVATE_KEY: process.env.CLAIM_ATTESTOR_PRIVATE_KEY,
      IDENTITY_ATTESTOR_PRIVATE_KEY: process.env.IDENTITY_ATTESTOR_PRIVATE_KEY,
      ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: process.env.ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY,
      ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY: process.env.ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY,
      ROBINHOOD_OPERATOR_ADDRESS: process.env.ROBINHOOD_OPERATOR_ADDRESS,
      CONTRACT_OWNER_ADDRESS: process.env.CONTRACT_OWNER_ADDRESS,
    }),
  });

  const farcaster = new FarcasterAuthService({
    domain: appDomain,
    siweUri: `${appUrl}/farcaster/login`,
    client: createAppClient({
      relay: "https://relay.farcaster.xyz",
      ethereum: viemConnector({ rpcUrl: farcasterRpcUrl }),
    }),
    stateStore: transientState,
  });

  // Solana (beside Robinhood Chain, the main network): the cluster is fixed to mainnet; the environment names an RPC
  // provider, the fee treasury, the switches and the vault's operator and attestor.
  const solanaConfig = readSolanaConfig({
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    SOLANA_BROWSER_RPC_URL: process.env.SOLANA_BROWSER_RPC_URL,
    SOLANA_TREASURY_ADDRESS: process.env.SOLANA_TREASURY_ADDRESS,
    SOLANA_TRANSFERS: process.env.SOLANA_TRANSFERS,
    SOLANA_STOCK_TRANSFERS: process.env.SOLANA_STOCK_TRANSFERS,
    SOLANA_OPERATOR_ADDRESS: process.env.SOLANA_OPERATOR_ADDRESS,
    SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY: process.env.SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY,
  });
  const solanaClient = solanaRpc(solanaConfig.rpcUrl);
  const solanaTransfers = new SolanaTransferService({ config: solanaConfig, rpc: solanaClient, repository: solanaTransferRepository });
  const solana = {
    config: solanaConfig,
    transfers: solanaTransfers,
    addresses: new AccountAddressService({ domain: appDomain, repository: accountAddressRepository, stateStore: transientState }),
    // SOL is priced too, though no longer sent: SP still values a SOL payment sent before.
    market: new SolanaMarketData({ assets: [...SOLANA_ASSETS, SOLANA_SOL] }),
    // The vault program is not configuration either: the operator deploys it from the operator page and the server
    // registers it after reading its code, its settings and its upgrade authority (the operator's) back from chain.
    vault: new SolanaVaultService({ config: solanaConfig, rpc: solanaClient, repository: solanaVaultRepository, transfers: solanaTransfers, directory: recipientDirectory }),
  };

  // SP: stablecoins count at $1; anything else at the price the desk already shows.
  const stocks = new StockTokenMarketData();
  const spPrices: SpPrices = async (network, symbol) => {
    if (network === "solana") return (await solana.market.snapshot()).quotes[symbol];
    if (network === "robinhood") {
      const token = (await stocks.snapshot("robinhood-mainnet")).tokens.find((entry) => entry.symbol === symbol);
      const price = token?.price ? Number(token.price) : undefined;
      return price !== undefined && Number.isFinite(price) && price > 0 ? price : undefined;
    }
    return undefined;
  };
  const spService = new SpService({ repository: spRepository, referrals: referralStore, prices: spPrices });
  // Invite rewards are paid in USDC on Solana from a wallet an admin connects; the server only prepares and checks.
  const referralPayouts = new ReferralPayouts({
    store: referralStore,
    rpc: solanaClient,
    solana: solanaTransfers,
    solanaAddress: (wallet) => solana.addresses.solana(wallet),
    frozen: async (wallet) => Boolean((await spRepository.flags(wallet))?.frozen),
    audit: ({ admin, batch, signature }) => adminAuditRepository.record({
      actor: admin, action: "referral.payout", target: batch.id,
      details: { batch: batch.id, signature, payer: batch.payer, preparedBy: batch.createdBy, items: batch.items, totalUnits: batch.totalUnits },
    }),
  });
  const redemptions = startupServices.redemptions;
  const spActivity = new SpActivity({
    sp: spService,
    identities,
    stateStore: transientState,
    sources: {
      arc: { payments: paymentRepository, links: claimFundingRepository, settle: redemptions ? (record, input) => redemptions.settlement(record, input) : undefined },
      robinhood: { transfers: stockTransferRepository, links: stockClaimRepository, settle: (record, input) => stockClaims.settlement("robinhood-mainnet", record, input) },
      solana: { transfers: solanaTransferRepository, address: (wallet) => solana.addresses.solana(wallet), links: solanaVaultRepository, settle: (record, input) => solana.vault.settlement(record, { candidates: input.candidates }) },
    },
  });
  const adminWallets = readAdminWallets({
    ADMIN_WALLET_ADDRESSES: process.env.ADMIN_WALLET_ADDRESSES,
    ROBINHOOD_OPERATOR_ADDRESS: process.env.ROBINHOOD_OPERATOR_ADDRESS,
    ARC_MAINNET_OPERATOR_ADDRESS: process.env.ARC_MAINNET_OPERATOR_ADDRESS,
  });

  const app = createApp({
    auth: new WalletAuthService({
      domain: appDomain,
      uri: appUrl,
      sessionSecret,
      stateStore: transientState,
    }),
    oauthFlows: new OAuthFlowStore({ stateStore: transientState }),
    identities,
    identityStoreKind,
    github,
    x,
    discord,
    telegramBotToken,
    telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME?.trim() || undefined,
    telegramTokenCheck: telegramBotToken ? new TelegramBotTokenCheck(telegramBotToken) : undefined,
    appOrigin: process.env.NODE_ENV === "production" ? appUrl : undefined,
    network: arcNetwork,
    ...startupServices,
    arcReceipts: arcClient ? receiptReader(arcClient) : undefined,
    arcUsdcBalance: arcClient && network.ready ? usdcBalanceOf(arcClient, network.usdcAddress) : undefined,
    // A plain transfer fits one approval's gas budget (ARC_APPROVE_GAS, 80,000): about 49,000 gas to an address that
    // holds USDC, and about 75,000 to one that holds none.
    arcTransferGas: arcClient ? transferGasOf(arcClient) : undefined,
    arcMainnetSetup,
    farcaster,
    stocks,
    stockTransfers,
    stockClaims,
    recipientLookups: { githubToken: Boolean(process.env.GITHUB_API_TOKEN?.trim()), xBearerToken: Boolean(process.env.X_API_BEARER_TOKEN?.trim()) },
    recipientDirectory,
    rpcProviders: {
      solana: solanaConfig.rpcUrl !== SOLANA_MAINNET.rpcUrl,
      solanaBrowser: Boolean(solanaConfig.browserRpcUrl),
      arc: Boolean(arcNetwork.ready && arcNetwork.serverRpcUrl),
      robinhood: Boolean(robinhood["robinhood-mainnet"].rpcUrl && robinhood["robinhood-mainnet"].rpcUrl !== STOCK_CHAINS["robinhood-mainnet"].rpcUrl),
    },
    solana,
    sp: { service: spService, activity: spActivity },
    admin: {
      auth: new AdminAuthService({ domain: appDomain, wallets: adminWallets.wallets, stateStore: transientState }),
      audit: adminAuditRepository,
      controls: new DeskControls(adminSettingsRepository),
      records: adminRecords,
      settings: adminSettingsRepository,
      payouts: referralPayouts,
      cronSecret: process.env.CRON_SECRET?.trim() || undefined,
      database: identityStoreKind,
    },
    privyAppId: privyAppId(process.env.PRIVY_APP_ID),
    vercelIngress: mode === "vercel",
    trustProxy: mode === "local" ? readTrustProxy({ TRUST_PROXY: process.env.TRUST_PROXY }) : undefined,
    webRoot: mode === "local" && process.env.NODE_ENV === "production"
      ? fileURLToPath(new URL("../dist", import.meta.url))
      : undefined,
  });

  return { app, close: () => pool?.end() };
  } catch (error) {
    await pool?.end();
    throw error;
  }
}

/** A Privy app ID is public (the browser sends it with every sign-in); only its shape is checked. */
export function privyAppId(value: string | undefined) {
  const input = value?.trim();
  return input && /^[a-z0-9]{10,64}$/.test(input) ? input : undefined;
}

function attestorAddress(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Configured attestor key is malformed.");
  return privateKeyToAccount(value as Hex).address;
}

function safeAttestorAddress(value: string | undefined) {
  try {
    return value ? attestorAddress(value) : undefined;
  } catch {
    return undefined;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootApplication("local").then(({ app, close }) => {
    const listener = app.listen(8787, () => console.log("HaPaPay API listening on http://localhost:8787"));
    process.once("SIGTERM", () => listener.close(() => { void close(); }));
    process.once("SIGINT", () => listener.close(() => { void close(); }));
  }).catch((error) => {
    console.error("HaPaPay failed to start", error);
    process.exitCode = 1;
  });
}
