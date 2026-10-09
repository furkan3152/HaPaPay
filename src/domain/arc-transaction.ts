import { encodeFunctionData, getAddress, parseUnits } from "viem";

export const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** The most gas an Arc call of each kind needs: an ERC-20 approval, and a fee router `pay` or an escrow `createPayment`. */
export const ARC_APPROVE_GAS = 80_000n;
export const ARC_PAY_GAS = 200_000n;

/**
 * The USDC a wallet keeps for gas, in the six-decimal interface's units. Arc pays gas in USDC from the same balance
 * (natively in 18 decimals), so a wallet holding exactly the amount and the fee could approve but not pay (audit,
 * 2026-10-06). Twice the current gas price for every call, rounded up.
 */
export function arcGasReserve(gasPrice: bigint, calls: { approvals: number; payments: number }) {
  const wei = gasPrice * 2n * (ARC_APPROVE_GAS * BigInt(calls.approvals) + ARC_PAY_GAS * BigInt(calls.payments));
  return (wei + 999_999_999_999n) / 1_000_000_000_000n;
}

export function buildArcUsdcTransfer(input: {
  usdc: `0x${string}`;
  recipient: `0x${string}`;
  amount: string;
}) {
  const usdc = getAddress(input.usdc);
  const units = parseUnits(input.amount, 6);
  if (units <= 0n) throw new Error("Amount must be greater than zero.");

  return {
    to: usdc,
    data: encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [input.recipient, units],
    }),
    value: "0x0" as const,
  };
}

export function walletRpcTransaction(input: {
  from?: string;
  to: string;
  data: string;
  value: string;
  purpose?: string;
}) {
  return {
    ...(input.from ? { from: input.from } : {}),
    to: input.to,
    data: input.data,
    value: input.value,
  };
}

export const arcUsdcApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
