import { getAddress, keccak256, type Address, type Hex } from "viem";
import {
  BURN_VAULT_ARTIFACT,
  FEE_FORWARDER_ARTIFACT,
  PAY_ROUTER_ARTIFACT,
} from "../src/domain/fee-artifacts.js";
import {
  PLATFORM_FEE_BURN_SHARE_BPS,
  BURN_VAULT_REVISION,
  PLATFORM_FEE_BPS,
  FEE_FORWARDER_REVISION,
  PAY_ROUTER_REVISION,
  burnVaultAbi,
  feeForwarderAbi,
  payRouterAbi,
  type FeeSchedule,
} from "../src/domain/fees.js";
import { stockClaimEscrowAbi } from "../src/domain/stock-claims.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The chain reads the verification needs: runtime code and view calls. */
export type FeeContractReader = {
  getBytecode(input: { address: Address }): Promise<Hex | undefined>;
  readContract(input: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
};

/**
 * Where the router pays the burn half: the burn vault on Robinhood Chain, or on Arc the fee forwarder, which can only
 * pass it on to the treasury (the burn token cannot be bought and burned there).
 */
export type FeeSink = "burn_vault" | "forwarder";

/**
 * Verifies the fee contracts behind a vault escrow on chain: the escrow's `feeRouter()` must carry the bundled
 * HaPaPayRouter runtime code at its reviewed revision, charge 1% split in half, be owned by the operator and pay its
 * treasury half to the operator; the router's `burnVault()` must be the bundled HaPaPayBurnVault owned by the operator,
 * or for `sink: "forwarder"` the bundled HaPaPayFeeForwarder forwarding to the operator. `fail` builds the error for a
 * contract that is not the reviewed one, `unreachable` the error for a read that did not complete.
 */
export async function verifyFeeContracts(client: FeeContractReader, input: {
  escrow: Address;
  operator: Address;
  sink: FeeSink;
  chainName: string;
  fail: (message: string) => Error;
  unreachable: () => Error;
}): Promise<FeeSchedule> {
  const { chainName, fail, operator } = input;
  const read = async <T>(address: Address, abi: readonly unknown[], functionName: string) => {
    try {
      return await client.readContract({ address, abi, functionName, args: [] }) as T;
    } catch {
      throw input.unreachable();
    }
  };
  const codeHash = async (address: Address) => {
    let code: Hex | undefined;
    try {
      code = await client.getBytecode({ address });
    } catch {
      throw input.unreachable();
    }
    return code && code !== "0x" ? keccak256(code) : undefined;
  };
  const router = getAddress(await read<string>(input.escrow, stockClaimEscrowAbi, "feeRouter"));
  if (await codeHash(router) !== PAY_ROUTER_ARTIFACT.runtimeCodeHash) {
    throw fail(`The ${chainName} escrow's fee router at ${router} is not the reviewed HaPaPayRouter build.`);
  }
  const [routerRevision, feeBps, burnShareBps, routerOwner, treasury, burnVaultValue] = await Promise.all([
    read<bigint>(router, payRouterAbi, "securityRevision"),
    read<bigint>(router, payRouterAbi, "FEE_BPS"),
    read<bigint>(router, payRouterAbi, "BURN_SHARE_BPS"),
    read<string>(router, payRouterAbi, "owner"),
    read<string>(router, payRouterAbi, "treasury"),
    read<string>(router, payRouterAbi, "burnVault"),
  ]);
  if (routerRevision !== PAY_ROUTER_REVISION || feeBps !== PLATFORM_FEE_BPS || burnShareBps !== PLATFORM_FEE_BURN_SHARE_BPS) {
    throw fail(`The ${chainName} fee router does not charge the reviewed 1% fee split in half.`);
  }
  if (getAddress(routerOwner) !== operator || getAddress(treasury) !== operator) {
    throw fail(`The ${chainName} fee router must be owned by the operator wallet and pay its treasury half to it.`);
  }
  const burnVault = getAddress(burnVaultValue);
  const schedule: FeeSchedule = {
    router,
    burnVault,
    treasury: getAddress(treasury),
    feeBps: Number(feeBps),
    burnShareBps: Number(burnShareBps),
  };
  if (input.sink === "forwarder") {
    if (await codeHash(burnVault) !== FEE_FORWARDER_ARTIFACT.runtimeCodeHash) {
      throw fail(`The ${chainName} fee forwarder at ${burnVault} is not the reviewed HaPaPayFeeForwarder build.`);
    }
    const [forwarderRevision, forwarderTreasury] = await Promise.all([
      read<bigint>(burnVault, feeForwarderAbi, "securityRevision"),
      read<string>(burnVault, feeForwarderAbi, "treasury"),
    ]);
    if (forwarderRevision !== FEE_FORWARDER_REVISION || getAddress(forwarderTreasury) !== operator) {
      throw fail(`The ${chainName} fee forwarder must be the reviewed revision and forward to the operator wallet.`);
    }
    return { ...schedule, sink: "forwarder" };
  }
  if (await codeHash(burnVault) !== BURN_VAULT_ARTIFACT.runtimeCodeHash) {
    throw fail(`The ${chainName} burn vault at ${burnVault} is not the reviewed HaPaPayBurnVault build.`);
  }
  const [vaultRevision, vaultOwner, burnToken] = await Promise.all([
    read<bigint>(burnVault, burnVaultAbi, "securityRevision"),
    read<string>(burnVault, burnVaultAbi, "owner"),
    read<string>(burnVault, burnVaultAbi, "burnToken"),
  ]);
  if (vaultRevision !== BURN_VAULT_REVISION || getAddress(vaultOwner) !== operator) {
    throw fail(`The ${chainName} burn vault must be the reviewed revision and owned by the operator wallet.`);
  }
  return { ...schedule, ...(getAddress(burnToken) !== ZERO_ADDRESS ? { burnToken: getAddress(burnToken) } : {}) };
}
