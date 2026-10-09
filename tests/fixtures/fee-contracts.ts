import type { Address } from "viem";
import { compileOperatorContract } from "../../scripts/generate-stock-claim-escrow-artifact";
import type { StockChainClient } from "../../server/stock-transfer-service";

export const FEE_ROUTER = "0x3333333333333333333333333333333333333333" as const;
export const FEE_BURN_VAULT = "0x4444444444444444444444444444444444444444" as const;

/**
 * A chain that serves only the fee contracts behind one escrow: the bundled runtime code of the router and the burn
 * vault, and the reviewed settings, with overrides for the cases the server must refuse.
 */
export async function feeContractsClient(input: { escrow: Address; owner: Address; treasury?: Address; feeBps?: bigint }): Promise<StockChainClient> {
  const [router, vault] = await Promise.all([compileOperatorContract("HaPaPayRouter"), compileOperatorContract("HaPaPayBurnVault")]);
  const reads: Record<string, unknown> = {
    [`${input.escrow}:feeRouter`]: FEE_ROUTER,
    [`${FEE_ROUTER}:securityRevision`]: 1n,
    [`${FEE_ROUTER}:FEE_BPS`]: input.feeBps ?? 100n,
    [`${FEE_ROUTER}:BURN_SHARE_BPS`]: 5000n,
    [`${FEE_ROUTER}:owner`]: input.owner,
    [`${FEE_ROUTER}:treasury`]: input.treasury ?? input.owner,
    [`${FEE_ROUTER}:burnVault`]: FEE_BURN_VAULT,
    [`${FEE_BURN_VAULT}:securityRevision`]: 1n,
    [`${FEE_BURN_VAULT}:owner`]: input.owner,
    [`${FEE_BURN_VAULT}:burnToken`]: "0x0000000000000000000000000000000000000000",
  };
  return {
    getChainId: async () => 46630,
    getBytecode: async ({ address }) => address === FEE_ROUTER ? router.deployedBytecode : address === FEE_BURN_VAULT ? vault.deployedBytecode : undefined,
    readContract: async ({ address, functionName }) => {
      const key = `${address}:${functionName}`;
      if (!(key in reads)) throw new Error(`unexpected read ${key}`);
      return reads[key];
    },
    call: async () => { throw new Error("no calls expected"); },
    getTransactionReceipt: async () => { throw new Error("no receipts expected"); },
  };
}
