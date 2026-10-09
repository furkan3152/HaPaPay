import { getAddress, getContractAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { ARC_IDENTITY_REGISTRY_ARTIFACT } from "../src/domain/arc-identity-registry-artifact.js";
import { FEE_FORWARDER_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../src/domain/fee-artifacts.js";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact.js";
import type { OnchainContractClient } from "./readiness.js";
import type { ChainReceipt } from "./receipts.js";

/** The read-only Arc Mainnet calls the operator page needs: contract reads, the operator's nonce and receipts. */
export type ArcMainnetReader = OnchainContractClient & {
  getTransactionCount(input: { address: Address }): Promise<number>;
  /** A mined transaction's receipt, or null while it is not mined (or unknown). */
  getTransactionReceipt(input: { hash: Hex }): Promise<ChainReceipt | null>;
};

export type ArcMainnetDeployment = { forwarder?: Address; router?: Address; registry?: Address; escrow?: Address };

type Role = keyof ArcMainnetDeployment;

const ROLES: Record<string, Role> = {
  [FEE_FORWARDER_ARTIFACT.runtimeCodeHash.toLowerCase()]: "forwarder",
  [PAY_ROUTER_ARTIFACT.runtimeCodeHash.toLowerCase()]: "router",
  [ARC_IDENTITY_REGISTRY_ARTIFACT.runtimeCodeHash.toLowerCase()]: "registry",
  [STOCK_CLAIM_ESCROW_ARTIFACT.runtimeCodeHash.toLowerCase()]: "escrow",
};

const bindingAbi = parseAbi([
  "function owner() view returns (address)",
  "function treasury() view returns (address)",
  "function burnVault() view returns (address)",
  "function verifier() view returns (address)",
  "function feeRouter() view returns (address)",
]);

/** How many of the operator's latest transactions are searched: room for several interrupted attempts. */
export const ARC_MAINNET_DEPLOYMENT_SEARCH_DEPTH = 48;

/**
 * The Arc Mainnet contracts the operator has already deployed, found on chain from its own nonces: the CREATE address
 * of each of its latest transactions whose runtime code is a pinned build and whose settings name the operator and
 * this server's attestors. The newest consistent set is returned (an escrow on its router, a router on its
 * forwarder), so the operator page resumes an interrupted deployment instead of paying for a contract twice, even
 * when the browser lost what it had deployed. Nothing here is trusted beyond that: the switch still needs the
 * server's full check.
 */
export async function findArcMainnetDeployment(
  reader: ArcMainnetReader,
  expected: { operator: Address; identityVerifier?: Address; claimVerifier?: Address },
  depth = ARC_MAINNET_DEPLOYMENT_SEARCH_DEPTH,
): Promise<ArcMainnetDeployment> {
  const operator = getAddress(expected.operator);
  const nonce = await reader.getTransactionCount({ address: operator });
  const nonces = Array.from({ length: Math.min(nonce, depth) }, (_, index) => nonce - 1 - index);
  // Newest first, so the first match of each role is the latest one.
  const created = (await Promise.all(nonces.map(async (index) => {
    const address = getContractAddress({ from: operator, nonce: BigInt(index) });
    const code = await reader.getBytecode({ address });
    const role = code && code !== "0x" ? ROLES[keccak256(code).toLowerCase()] : undefined;
    return role ? { address, role } : undefined;
  }))).filter((entry): entry is { address: Address; role: Role } => Boolean(entry));
  const read = async (address: Address, functionName: "owner" | "treasury" | "burnVault" | "verifier" | "feeRouter") => {
    try {
      return getAddress(await reader.readContract({ address, abi: bindingAbi, functionName }) as string);
    } catch {
      return undefined;
    }
  };
  const of = (role: Role) => created.filter((entry) => entry.role === role).map((entry) => entry.address);

  const forwarders = (await Promise.all(of("forwarder").map(async (address) => await read(address, "treasury") === operator ? address : undefined)))
    .filter((address): address is Address => Boolean(address));
  const routers = (await Promise.all(of("router").map(async (address) => {
    const [owner, treasury, burnVault] = await Promise.all([read(address, "owner"), read(address, "treasury"), read(address, "burnVault")]);
    return owner === operator && treasury === operator && burnVault && forwarders.includes(burnVault) ? { address, forwarder: burnVault } : undefined;
  }))).filter((router): router is { address: Address; forwarder: Address } => Boolean(router));
  const registries = expected.identityVerifier
    ? (await Promise.all(of("registry").map(async (address) => {
      const [owner, verifier] = await Promise.all([read(address, "owner"), read(address, "verifier")]);
      return owner === operator && verifier === getAddress(expected.identityVerifier!) ? address : undefined;
    }))).filter((address): address is Address => Boolean(address))
    : [];
  const escrows = expected.claimVerifier
    ? (await Promise.all(of("escrow").map(async (address) => {
      const [owner, verifier, feeRouter] = await Promise.all([read(address, "owner"), read(address, "verifier"), read(address, "feeRouter")]);
      const router = routers.find((entry) => entry.address === feeRouter);
      return owner === operator && verifier === getAddress(expected.claimVerifier!) && router ? { address, router } : undefined;
    }))).filter((escrow): escrow is { address: Address; router: { address: Address; forwarder: Address } } => Boolean(escrow))
    : [];

  const escrow = escrows[0];
  const router = escrow?.router ?? routers[0];
  const forwarder = router?.forwarder ?? forwarders[0];
  const registry = registries[0];
  return {
    ...(forwarder ? { forwarder } : {}),
    ...(router ? { router: router.address } : {}),
    ...(registry ? { registry } : {}),
    ...(escrow ? { escrow: escrow.address } : {}),
  };
}
