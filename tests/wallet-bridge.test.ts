import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// The bridge reads its timer from `window`, as it does in the browser.
(globalThis as { window?: unknown }).window ??= globalThis;
const { onPrivyChange, privyControls, registerPrivy, whenPrivyReady } = await import("../src/wallet/wallet-bridge");
type Controls = NonNullable<ReturnType<typeof privyControls>>;
const controls = (ready: boolean): Controls => ({ ready, authenticated: false, login: async () => undefined, logout: async () => undefined, evm: async () => undefined, solana: () => undefined, embedded: () => ({}), exportKey: async () => undefined });

/**
 * The Privy layer and the desk. The desk re-renders on every notice and a desk render renders the Privy layer again, so a notice on every
 * registration kept both rendering without end; the bridge now speaks only when Privy's state changes, and a Connect
 * pressed before the sign-in is ready waits for it instead of asking for another press.
 */
describe("the Privy bridge", () => {
  it("tells the desk only when Privy's state changes, and always hands out the latest controls", () => {
    let heard = 0;
    const stop = onPrivyChange(() => heard++);
    const first = controls(false);
    registerPrivy(first, "false|false||");
    assert.equal(heard, 1);
    const again = controls(false);
    registerPrivy(again, "false|false||");
    assert.equal(heard, 1, "the same state registered again is not news");
    assert.equal(privyControls(), again);
    registerPrivy(again, "true|false||");
    assert.equal(heard, 2);
    registerPrivy(again, "true|true|0xabc|So1");
    assert.equal(heard, 3);
    registerPrivy(undefined);
    assert.equal(heard, 4);
    assert.equal(privyControls(), undefined);
    stop();
  });

  it("lets a Connect wait for the sign-in to be ready, for a limited time", async () => {
    const waiting = whenPrivyReady(1_000);
    registerPrivy(controls(false), "false");
    const ready = controls(true);
    setTimeout(() => registerPrivy(ready, "true"), 20);
    assert.equal(await waiting, ready);
    assert.equal(await whenPrivyReady(1_000), ready, "an already ready sign-in answers at once");
    registerPrivy(undefined);
    assert.equal(await whenPrivyReady(30), undefined, "and nothing comes after the time is up");
  });

  it("builds one set of controls and one config for Elysium, and renders only when its props change", async () => {
    const [bridge, session] = await Promise.all([
      readFile(new URL("../src/wallet/PrivyBridge.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/elysa/session.tsx", import.meta.url), "utf8"),
    ]);
    assert.match(bridge, /const controls = useMemo<PrivyControls>\(\(\) => \(\{/);
    assert.match(bridge, /useEffect\(\(\) => registerPrivy\(controls, `\$\{ready\}\|\$\{authenticated\}\|\$\{evmAddress\}\|\$\{embedded \?\? ""\}`\), \[controls, ready, authenticated, evmAddress, embedded\]\);/);
    assert.match(bridge, /const config = useMemo<PrivyClientConfig>\(/);
    assert.match(bridge, /walletChainType: "ethereum-only"/, "one EVM wallet, on Elysium only");
    assert.match(bridge, /supportedChains: \[elysiumTestnet\]/);
    assert.doesNotMatch(bridge, /@privy-io\/react-auth\/solana|toSolanaWalletConnectors|createOnLogin: "all-users" \}, solana/, "no Solana wallet is made or connected");
    assert.match(bridge, /export default memo\(PrivyBridge\);/);
    // With a browser wallet on the device Privy is waited for ten seconds, then that wallet signs in.
    assert.match(session, /privy = await whenPrivyReady\(window\.ethereum \? 10_000 : 30_000\);/);
    // The session is the wallet's signature of the server's challenge.
    assert.match(session, /await api<\{ address: string \}>\("\/api\/auth\/verify"/);
  });

  it("exports only a wallet Privy made for this sign-in, through Privy's own window", async () => {
    const bridge = await readFile(new URL("../src/wallet/PrivyBridge.tsx", import.meta.url), "utf8");
    assert.match(bridge, /if \(!now\.authenticated \|\| embeddedWallet\(now\.wallets\)\?\.toLowerCase\(\) !== address\.toLowerCase\(\)\) throw new Error\("Only a wallet Privy made for this sign-in can be exported here\."\);/);
    assert.match(bridge, /await now\.exportWallet\(\{ address \}\);/);
    assert.doesNotMatch(bridge, /privateKey|exportedKey|seedPhrase/, "the site never handles a key itself");
  });
});
