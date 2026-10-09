import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARC_MAINNET, ARC_TESTNET, readArcMainnetConfig, readArcNetworkConfig } from "../server/arc-network";

describe("Arc runtime network selection seam", () => {
  it("uses the documented Arc Testnet parameters for the first testing phase", () => {
    assert.deepEqual(readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }), {
      ready: true,
      environment: "testnet",
      chainName: "Arc Testnet",
      chainId: 5_042_002,
      chainIdHex: "0x4cef52",
      rpcUrl: "https://rpc.testnet.arc.io/",
      explorerUrl: "https://explorer.testnet.arc.io/",
      faucetUrl: "https://faucet.circle.com/",
      usdcAddress: "0x3600000000000000000000000000000000000000",
    });
  });

  it("defaults to testnet and opens Arc Mainnet from the mode alone with the bundled official parameters", () => {
    assert.equal(readArcNetworkConfig({}).environment, "testnet");
    assert.deepEqual(readArcNetworkConfig({ ARC_NETWORK_MODE: "mainnet" }), {
      ready: true,
      environment: "mainnet",
      chainName: "Arc Mainnet",
      chainId: 5_042,
      chainIdHex: "0x13b2",
      rpcUrl: "https://rpc.mainnet.arc.io/",
      explorerUrl: "https://explorer.arc.io/",
      usdcAddress: "0x3600000000000000000000000000000000000000",
    });
  });

  it("rejects unknown network modes instead of choosing a chain silently", () => {
    assert.throws(() => readArcNetworkConfig({ ARC_NETWORK_MODE: "production" }), /ARC_NETWORK_MODE/);
  });
});

describe("Arc mainnet configuration seam", () => {
  it("uses the bundled official parameters when no override is supplied", () => {
    const config = readArcMainnetConfig({});
    assert.equal(config.ready, true);
    assert.equal(config.ready && config.chainId, ARC_MAINNET.chainId);
  });

  it("rejects known Arc testnet values in the mainnet configuration", () => {
    assert.throws(
      () => readArcMainnetConfig({ ARC_MAINNET_RPC_URL: "https://rpc.testnet.arc.io", ARC_MAINNET_CHAIN_ID: "5042002", ARC_MAINNET_USDC_ADDRESS: "0x3600000000000000000000000000000000000000" }),
      /testnet configuration cannot be used as mainnet/,
    );
  });

  it("accepts overrides only when they name exactly the official Arc Mainnet tuple", () => {
    assert.deepEqual(readArcMainnetConfig({
      ARC_MAINNET_RPC_URL: ARC_MAINNET.rpcUrl,
      ARC_MAINNET_CHAIN_ID: String(ARC_MAINNET.chainId),
      ARC_MAINNET_EXPLORER_URL: ARC_MAINNET.explorerUrl,
      ARC_MAINNET_USDC_ADDRESS: ARC_MAINNET.usdcAddress,
    }), {
      ready: true,
      ...ARC_MAINNET,
      chainIdHex: "0x13b2",
    });
    assert.equal(readArcMainnetConfig({ ARC_MAINNET_EXPLORER_URL: "https://explorer.arc.example" }).ready, false);
  });

  it("does not accept the shared USDC address on an invented mainnet chain", () => {
    const result = readArcMainnetConfig({
      ARC_MAINNET_RPC_URL: "https://rpc.mainnet.arc.example",
      ARC_MAINNET_CHAIN_ID: "9999999",
      ARC_MAINNET_USDC_ADDRESS: ARC_TESTNET.usdcAddress,
    });
    assert.equal(result.ready, false);
    assert.match(result.reason, /official.*mainnet|mainnet.*official/i);
  });

  it("takes any other https RPC as a provider for the server's reads while wallets keep the official one", () => {
    const provider = "https://example-name.arc-mainnet.quiknode.pro/0123456789abcdef/";
    const result = readArcMainnetConfig({ ARC_MAINNET_RPC_URL: provider, ARC_MAINNET_CHAIN_ID: String(ARC_MAINNET.chainId), ARC_MAINNET_USDC_ADDRESS: ARC_MAINNET.usdcAddress });
    assert.equal(result.ready, true);
    assert.equal(result.ready && result.rpcUrl, ARC_MAINNET.rpcUrl, "wallets are given the official RPC");
    assert.equal(result.ready && result.serverRpcUrl, provider);
    const onOfficialHost = readArcMainnetConfig({ ARC_MAINNET_RPC_URL: `${ARC_MAINNET.rpcUrl}unexpected?key=present` });
    assert.equal(onOfficialHost.ready && onOfficialHost.rpcUrl, ARC_MAINNET.rpcUrl);
    assert.equal(onOfficialHost.ready && onOfficialHost.serverRpcUrl, `${ARC_MAINNET.rpcUrl}unexpected?key=present`);
    assert.equal(readArcMainnetConfig({}).ready && "serverRpcUrl" in readArcMainnetConfig({}), false, "no provider without one");
  });

  it("refuses a provider RPC with credentials before the host or a fragment, and one that is not https", () => {
    for (const value of ["https://user:secret@example-name.arc-mainnet.quiknode.pro/", "https://example-name.arc-mainnet.quiknode.pro/token/#part"]) {
      const result = readArcMainnetConfig({ ARC_MAINNET_RPC_URL: value });
      assert.equal(result.ready, false);
      assert.match(result.reason, /ARC_MAINNET_RPC_URL/);
      assert.equal(result.reason.includes("secret"), false, "the value is never echoed");
    }
    assert.throws(() => readArcMainnetConfig({ ARC_MAINNET_RPC_URL: "http://example-name.arc-mainnet.quiknode.pro/token/" }), /malformed/);
  });

  it("does not make invented mainnet values wallet-ready", () => {
    const result = readArcMainnetConfig({ ARC_MAINNET_RPC_URL: "https://rpc.mainnet.arc.example", ARC_MAINNET_CHAIN_ID: "9999999", ARC_MAINNET_USDC_ADDRESS: "0x1111111111111111111111111111111111111111" });
    assert.equal(result.ready, false);
    assert.match(result.reason, /official.*verified tuple|verified tuple.*official/i);
  });
});
