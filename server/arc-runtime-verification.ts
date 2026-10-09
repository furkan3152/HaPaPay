import type { Address, Hex } from "viem";
import type { ArcNetworkConfig } from "./arc-network";

type ReadyArcNetwork = Extract<ArcNetworkConfig, { ready: true }>;

type ArcRuntimeClient = {
  getChainId(): Promise<number>;
  getBytecode(input: { address: Address }): Promise<Hex | undefined>;
  readContract(input: {
    address: Address;
    abi: readonly [{ readonly type: "function"; readonly name: "decimals"; readonly stateMutability: "view"; readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint8" }] }];
    functionName: "decimals";
  }): Promise<number>;
};

const decimalsAbi = [{
  type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }],
}] as const;

export async function verifyArcRuntime(network: ReadyArcNetwork, client: ArcRuntimeClient) {
  const reportedChainId = await client.getChainId();
  if (reportedChainId !== network.chainId) {
    throw new Error(`Arc RPC chain ID ${reportedChainId} does not match configured chain ID ${network.chainId}.`);
  }
  const bytecode = await client.getBytecode({ address: network.usdcAddress });
  if (!bytecode || bytecode === "0x") throw new Error("Configured Arc USDC address has no contract code.");
  const decimals = await client.readContract({ address: network.usdcAddress, abi: decimalsAbi, functionName: "decimals" });
  if (decimals !== 6) throw new Error(`Configured Arc ERC-20 USDC must report 6 decimals; received ${decimals}.`);
}

export const verifyArcMainnetRuntime = verifyArcRuntime;
