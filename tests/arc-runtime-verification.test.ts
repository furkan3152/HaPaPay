import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyArcRuntime } from "../server/arc-runtime-verification";

const config = {
  ready: true as const,
  chainId: 9_999_999,
  chainIdHex: "0x98967f" as const,
  rpcUrl: "https://rpc.mainnet.arc.example/",
  explorerUrl: undefined,
  usdcAddress: "0x1111111111111111111111111111111111111111" as const,
};

describe("Arc runtime verification", () => {
  it("accepts only matching chain ID, deployed USDC bytecode, and six decimals", async () => {
    await assert.doesNotReject(() => verifyArcRuntime(config, {
      getChainId: async () => 9_999_999,
      getBytecode: async () => "0x60016000" as const,
      readContract: async () => 6,
    }));
  });

  it("rejects a mismatched RPC network before live signing opens", async () => {
    await assert.rejects(() => verifyArcRuntime(config, {
      getChainId: async () => 5_042_002,
      getBytecode: async () => "0x60016000" as const,
      readContract: async () => 6,
    }), /chain ID/);
  });

  it("rejects an empty or wrong-decimal USDC contract", async () => {
    await assert.rejects(() => verifyArcRuntime(config, {
      getChainId: async () => 9_999_999,
      getBytecode: async () => undefined,
      readContract: async () => 6,
    }), /no contract code/);
    await assert.rejects(() => verifyArcRuntime(config, {
      getChainId: async () => 9_999_999,
      getBytecode: async () => "0x60016000" as const,
      readContract: async () => 18,
    }), /must report 6 decimals/);
  });
});
