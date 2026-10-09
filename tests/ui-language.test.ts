import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

function relativeLuminance(hex: string) {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const [red, green, blue] = channels.map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("English payment desk", () => {
  it("keeps the dark-first desk accessible in both themes", async () => {
    const [html, app, styles, mark, icons, conversation, conversationStyles, home] = await Promise.all([
      readFile(new URL("../index.html", import.meta.url), "utf8"),
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
      readFile(new URL("../src/components/BrandMark.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/ProviderIcon.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/PaymentConversation.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/payment-conversation.css", import.meta.url), "utf8"),
      readFile(new URL("../src/components/HomePage.tsx", import.meta.url), "utf8"),
    ]);

    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="description" content="Send money and stocks to a verified social handle\./);
    assert.doesNotMatch(html, /Robinhood Chain|in development/, "the description no longer calls the product a stock-token project in development");
    // A shared link shows the same words and the dotted bird, from a file served beside the favicon.
    for (const tag of ["og:title", "og:description", "og:image", "twitter:card", "twitter:image"]) assert.match(html, new RegExp(`(?:property|name)="${tag}"`), tag);
    assert.doesNotMatch(html, /og:url|https:\/\/[a-z0-9.-]+\.(com|app|io)\//, "the page names no fixed domain: it is served from the operator's own");
    assert.match(html, /<meta property="og:image" content="\/share\.png" \/>/);
    await access(new URL("../public/share.png", import.meta.url));
    assert.match(html, /<meta name="theme-color" content="#0B0C0E" \/>/, "the browser chrome starts dark");
    assert.match(app, /<nav className="primary-nav" aria-label="Primary">/);
    assert.match(app, /href="#payment">Payment/);
    assert.match(app, /setManageOpen\(true\)\}>Identities/);
    assert.match(app, /href="#panel-activity" onClick=\{\(event\) => openPanel\(event, "activity"\)\}>Activity/, "header links open the side panel tabs");
    // Robinhood Chain is the main network: the desk
    // wears Robin Neon, USDC slips and USDC claim pages on Arc wear Arc's blue, and Solana's slips and claim pages keep
    // Solana's purple.
    assert.match(app, /data-network-theme=\{claimTarget \? "arc" : solanaClaimTarget \? "solana" : "robinhood"\}/);
    assert.match(app, /useState<"solana" \| "robinhood">\("robinhood"\)/, "the board opens on Robinhood Chain");
    assert.match(styles, /\.shell\[data-network-theme='solana'\],\n\.payment-slip\[data-network-theme='solana'\] \{/, "Solana's slips keep its purple on the Robin Neon desk");
    assert.equal(app.match(/data-network-theme="arc"/g)?.length, 2, "both USDC slips are drawn in Arc's colors");
    assert.match(app, /import \{ BrandMark \} from "\.\/components\/BrandMark"/);
    assert.match(mark, /export function BrandMark/);
    assert.match(mark, /viewBox="0 0 64 64" aria-hidden="true" focusable="false"/);
    assert.match(icons, /export function ProviderIcon/);
    assert.match(icons, /viewBox="0 0 24 24" aria-hidden="true" focusable="false"/);
    assert.match(app, /<PaymentConversation conversation=\{conversation\} status=\{reply\} busy=\{busy\} statusBelow=\{slipShown\} onSuggestion=\{\(request\) => void sendRequest\(request\)\} \/>/);
    // A slip's answer sits under the slips, never above them out of sight.
    assert.match(app, /\{slipShown && <SlipStatus conversation=\{conversation\} status=\{reply\} \/>\}\n\s*<\/div>\n\n\s*<div className="composer-wrap"/);
    assert.match(conversation, /role="group" aria-label="Send one of these instead"/, "an answer can offer complete requests to pick");
    assert.match(conversation, /onSuggestion && turn === lastTurn && turn\.suggestions\?\.length/, "only the newest answer offers them");
    assert.match(conversation, /aria-label="Payment conversation"/);
    assert.doesNotMatch(conversation, /Request log/, "the log carries no label; the desk stays plain");
    assert.match(conversation, /Preparing your draft/);
    assert.match(conversationStyles, /prefers-reduced-motion: reduce/);
    assert.doesNotMatch(conversation, /eth_sendTransaction|window\.ethereum|fetch\(|localStorage|dangerouslySetInnerHTML/);
    assert.deepEqual(conversation.match(/onClick=\{[^}]+\}/g), ["onClick={() => onSuggestion(suggestion)}"], "the log's only action sends a picked request as text");
    assert.match(app, /<ProviderIcon provider=\{draft\.intent\.recipient\.platform\} \/>/);
    assert.match(app, /<ProviderIcon provider=\{provider\.id\} \/>/);
    assert.match(home, /<ol className="home-steps">/, "the home page explains the three steps");
    assert.doesNotMatch(app, /intro-steps|className="disclaimer"/, "the desk itself is the heading and the request box");
    assert.doesNotMatch(app, /\/illustrations\/|function SocialExchangeIllustration|Pixel[A-Z]/, "the pixel artwork and its images are gone");
    assert.match(app, /: "What do you want to send\?"\} \/>\}/);
    assert.match(home, /<DotText as="h1" id="home-title" text="Send money and stocks to a verified handle" \/>/);
    assert.match(home, /<p className="home-eyebrow">Social payments on Robinhood Chain<\/p>/, "Robinhood Chain is the main network");
    assert.match(home, /your own wallet signs it\./);
    assert.match(app, /`Send  to @\$\{payTarget\.username\} on \$\{platform\}`/, "pay links leave room for an amount and any asset");
    assert.match(app, /setSelectionRange\(5, 5\)/);
    assert.match(app, /walletRpcTransaction/);
    assert.match(styles, /family=Doto:ROND,wght@[^&']+&family=IBM\+Plex\+Mono:[^&']+&family=Space\+Grotesk:/);
    assert.match(styles, /--font-text: "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI",/, "Space Grotesk for text, the system face while it loads");
    assert.match(styles, /--font-display: "Doto", "Space Grotesk",/, "a dot-matrix face for the brand, headings and amounts");
    // Dark is the default; light is a per-viewer choice, switched with a view transition where the browser has one.
    assert.match(app, /return window\.localStorage\.getItem\(THEME_KEY\) === "light" \? "light" : "dark";/);
    assert.match(app, /className="theme-toggle" type="button" onClick=\{toggleColorTheme\}/);
    assert.match(app, /document\.startViewTransition\(apply\)/);
    assert.match(app, /prefers-reduced-motion: reduce\)"\)\.matches\) return apply\(\);/, "reduced motion switches the theme without the reveal");
    assert.match(app, /if \(event\.key !== "\/"/, "\"/\" jumps to the request box");
    assert.match(app, /<kbd className="composer-kbd" aria-hidden="true"/);
    assert.match(styles, /focus-visible/);
    assert.match(styles, /prefers-reduced-motion: reduce/);
    assert.match(styles, /-webkit-backdrop-filter: saturate\(140%\) blur\(14px\); backdrop-filter: saturate\(140%\) blur\(14px\)/, "the header blur works in Safari too");
    for (const control of [/\.network-pill \{[^}]*min-height: 44px/, /\.theme-toggle \{[^}]*width: 44px; height: 44px/, /\.wallet-button \{[^}]*min-height: 44px/, /\.composer \.send-button \{[^}]*width: 44px; height: 44px/, /\.payment-slip > button, \.transaction-link, \.claim-actions button \{[^}]*min-height: 48px/]) {
      assert.match(styles, control, "controls keep a comfortable touch target");
    }
    assert.match(styles, /\.network-status-list small \{ grid-column: 2 \/ -1; color: var\(--muted\)/);
    assert.doesNotMatch(styles, /network-choice-list/, "there is no network to choose");
    assert.doesNotMatch(styles, /data-desk-skin|--pass-text/, "no desk skin depends on what a wallet holds");
    assert.doesNotMatch(styles, /Manrope|Nunito|Pixelify|background-clip:\s*text/, "no other display faces or gradient headlines");
    const gradients = styles.match(/radial-gradient\(/g)?.length ?? 0;
    const dotGradients = styles.match(/radial-gradient\(circle, (?:[^(),]|\((?:[^()]|\([^()]*\))*\))+ [\d.]+px, transparent [\d.]+px\)/g)?.length ?? 0;
    const pointerMasks = styles.match(/mask-image: radial-gradient\(\d+px circle at var\(--px, 50%\) var\(--py, 50%\), #000, transparent \d+%\)/g)?.length ?? 0;
    const revealMasks = styles.match(/radial-gradient\(circle, #000 var\(--reveal\), transparent calc\(var\(--reveal\) \+ \.5px\)\)/g)?.length ?? 0;
    assert.equal(revealMasks, 4, "reading text arrives through a field of hard-edged dots that grow until they cover it");
    assert.ok(gradients > 0 && dotGradients + pointerMasks + revealMasks === gradients, "radial gradients only draw dots (a hard edge within a pixel) or mask a field of dots around the pointer, never glows");
    assert.match(styles, /\.shell\[data-network-theme='robinhood'\]/);
    const block = (selector: RegExp) => styles.match(selector)?.[1] ?? "";
    const blocks = {
      dark: block(/^:root\s*\{([^}]+)\}/m),
      light: block(/^:root\[data-theme='light'\]\s*\{([^}]+)\}/m),
      robinhood: block(/^\.shell\[data-network-theme='robinhood'\]\s*\{([^}]+)\}/m),
      lightRobinhood: block(/^:root\[data-theme='light'\] \.shell\[data-network-theme='robinhood'\]\s*\{([^}]+)\}/m),
      solana: block(/^\.shell\[data-network-theme='solana'\],\n\.payment-slip\[data-network-theme='solana'\]\s*\{([^}]+)\}/m),
      lightSolana: block(/^:root\[data-theme='light'\] \.shell\[data-network-theme='solana'\],\n:root\[data-theme='light'\] \.payment-slip\[data-network-theme='solana'\]\s*\{([^}]+)\}/m),
    };
    for (const [name, value] of Object.entries(blocks)) assert.ok(value.length > 40, `${name} theme block`);
    // An Arc slip on the green desk repeats the root's Arc colors exactly, so the Arc contrast checks below cover it.
    const accentsOf = (value: string) => ["accent", "accent-text", "accent-soft", "on-accent"].map((key) => value.match(new RegExp(`--${key}:\\s*(#[0-9A-F]{6})`, "i"))?.[1]);
    assert.deepEqual(accentsOf(block(/^\.payment-slip\[data-network-theme='arc'\]\s*\{([^}]+)\}/m)), accentsOf(blocks.dark));
    assert.deepEqual(accentsOf(block(/^:root\[data-theme='light'\] \.payment-slip\[data-network-theme='arc'\]\s*\{([^}]+)\}/m)), accentsOf(blocks.light));
    // A Robinhood Chain slip on the Solana desk repeats the Robinhood desk's colors exactly, so its checks cover it.
    assert.deepEqual(accentsOf(block(/^\.payment-slip\[data-network-theme='robinhood'\]\s*\{([^}]+)\}/m)), accentsOf(blocks.robinhood));
    assert.deepEqual(accentsOf(block(/^:root\[data-theme='light'\] \.payment-slip\[data-network-theme='robinhood'\]\s*\{([^}]+)\}/m)), accentsOf(blocks.lightRobinhood));
    // Later blocks win, as in the cascade: light over dark, the network over the root.
    const themes: Record<string, string[]> = {
      "dark arc": [blocks.dark],
      "dark robinhood": [blocks.dark, blocks.robinhood],
      "dark solana": [blocks.dark, blocks.solana],
      "light arc": [blocks.dark, blocks.light],
      "light robinhood": [blocks.dark, blocks.light, blocks.robinhood, blocks.lightRobinhood],
      "light solana": [blocks.dark, blocks.light, blocks.solana, blocks.lightSolana],
    };
    for (const [name, layers] of Object.entries(themes)) {
      const token = (key: string) => layers.map((layer) => layer.match(new RegExp(`--${key}:\\s*(#[0-9A-F]{6})`, "i"))?.[1]).filter(Boolean).at(-1) ?? "";
      const pairs: Array<[string, string, string]> = [
        ["on-accent", "accent", "primary buttons"],
        ["accent-text", "panel", "links on cards"],
        ["accent-text", "paper", "links on grouped rows"],
        ["accent-text", "accent-soft", "selected chips"],
        ["slate", "accent-soft", "selected network helper text"],
        ["muted", "panel", "secondary text on cards"],
        ["muted", "paper", "secondary text on grouped rows"],
        ["green", "panel", "confirmed status"],
        ["red", "panel", "failed verification"],
        ["green-text", "green-soft", "ready notices"],
        ["locked-text", "locked", "locked notices"],
        ["disabled-text", "disabled", "disabled buttons"],
        ["ink", "canvas", "body text on the page"],
        ["ink", "raised", "the selected segment"],
        ["muted", "rail", "unselected segments"],
        ["slate", "green-soft", "the trust note"],
        ["on-green", "green", "verified transaction bars"],
        ["on-red", "red", "failed verification bars"],
        ["red", "red-soft", "failed pending cards"],
        ["gold-text", "rail", "USDG tickers on their tiles"],
        ["gold-text", "panel", "USDG tickers on cards"],
        ["locked-text", "panel", "\"Signing locked\" labels on slips"],
        ["green-text", "panel", "\"Live transfer\" labels on slips"],
        ["muted", "canvas", "the hero paragraph and the steps"],
        ["accent-text", "canvas", "step numbers on the desk"],
        ["ink", "rail", "ticker tiles"],
      ];
      for (const [text, background, label] of pairs) {
        assert.ok(contrastRatio(token(text), token(background)) >= 4.5, `${name}: ${label} stay readable (${text} on ${background})`);
      }
    }
    assert.match(styles, /\.primary-nav a:hover[^}]+color:\s*var\(--accent-text\)/);
    // Robinhood selections wear Robin Neon, the green of Robinhood's own crypto pages; the light theme darkens it only for text.
    assert.match(styles, /\.shell\[data-network-theme='robinhood'\] \{\s*--accent: #CCFF00;\s*--accent-text: #CCFF00;/);
    assert.match(styles, /:root\[data-theme='light'\] \.shell\[data-network-theme='robinhood'\] \{\s*--accent: #CCFF00;\s*--accent-text: #4E6100;/);
    assert.match(styles, /--green: #CCFF00;/, "the status green is the same neon");
    // Solana's slips and claim pages wear Solana's purple and green; the light theme darkens both for text.
    assert.match(styles, /\.payment-slip\[data-network-theme='solana'\] \{\s*--accent: #9945FF;\s*--accent-text: #B98AFF;[^}]*--green: #14F195;/);
    assert.match(styles, /:root\[data-theme='light'\] \.payment-slip\[data-network-theme='solana'\] \{\s*--accent: #9945FF;\s*--accent-text: #7A2FE0;/);
    // Neon fills are too pale for a ring on white, so fields that hide the outline ring in the text accent.
    assert.match(styles, /\.composer:focus-within \{ border-color: color-mix\(in srgb, var\(--accent-text\) 70%, transparent\)/);
    assert.match(styles, /\.escrow-register input:focus \{ border-color: var\(--accent-text\);/);
    assert.match(styles, /\.pay-identity\s*\{[^}]+color:\s*var\(--accent-text\)/);
    assert.match(styles, /@media \(max-width: 1050px\)/);
    assert.match(styles, /@media \(max-width: 760px\)/);
    assert.doesNotMatch(app, /Conversation options|aria-label="Add"/);
    assert.doesNotMatch(app, /function SteppedCoinLogo|>\ud835\udd4f</);
    assert.doesNotMatch(`${html}\n${app}\n${styles}\n${mark}\n${icons}\n${conversation}`, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });
  it("adds verified stock boards and wallet-signed stock transfers to the desk", async () => {
    const [app, board, boardStyles] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/StockTokenList.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/stock-token-list.css", import.meta.url), "utf8"),
    ]);
    assert.match(app, /<div className="side-section" role="tabpanel" id="panel-stocks" aria-labelledby="tab-stocks" hidden=\{activeTab !== "stocks"\}>/, "the board is always on the desk");
    assert.match(app, /<StockTokenList snapshot=\{stockSnapshot\}/);
    assert.match(app, /fetch\(`\/api\/stocks\?network=\$\{network\}`/);
    assert.match(app, /allowlisted\[network\]\.has\(`\$\{token\.symbol\}:\$\{token\.address\}`\)/, "only bundled allowlist entries are shown");
    assert.match(app, /body: JSON\.stringify\(\{ message: requestMessage, \.\.\.\(answering \? \{ answering: \{ request: answering \} \} : \{\}\) \}\)/, "the server picks each request's network from its asset; the body carries the request and the question it answers");
    assert.doesNotMatch(app, /chooseNetwork|networkPreferenceRef|reviewPreference|Network preference|aria-label="Network preference"|load\("robinhood-testnet"\)/, "there is no network to pick and no testnet on the desk");
    assert.match(app, /<strong>Networks<\/strong><span>Picked by the asset you send<\/span>/);
    assert.match(app, /if \(reviewEpoch !== reviewEpochRef\.current \|\| prepared\.networkId !== draft\.arcNetwork\) \{/, "a USDC payment is signed only on the Arc network it was reviewed on");
    assert.match(app, /if \(reviewEpoch !== reviewEpochRef\.current \|\| prepared\.networkId !== claimDraft\.arcNetwork\) \{/, "and so is a USDC vault link");
    assert.match(app, /else if \(result\.status === "claim_review" && isStockClaimPlatform\(result\.intent\?\.recipient\?\.platform\)\) \{/, "a USDC vault link comes from the server's own vault offer");
    assert.match(app, /result\.status === "stock_review"/);
    assert.match(app, /base units · \{asset\.decimals\} decimals/, "USDG shows six decimals, Stock Tokens eighteen");
    assert.match(app, /Test token · no real value/);
    const stockCalls = Array.from(app.matchAll(/fetch\(\s*[`"']([^`"']+)/g), (match) => match[1]).filter((path) => /stock/i.test(path));
    assert.deepEqual(stockCalls, [
      "/api/stocks?network=${network}",
      "/api/stocks/transfers/confirm",
      "/api/stocks/transfers/prepare",
      "/api/stocks/transfers/confirm",
      "/api/stocks/transfers/prepare-batch",
      "/api/stocks/claims/confirm-funding",
      "/api/stocks/claims/prepare",
      "/api/stocks/claims/${stockClaimTarget.network}/${stockClaimTarget.paymentId}",
      "/api/stocks/claims/${target.network}/${target.paymentId}/prepare-${action}",
    ]);
    assert.match(app, /readReceiptHistory\("\/api\/stocks\/transfers", "transfers"\)/, "stock transfers join the verified activity list");
    const stockSlip = app.slice(app.indexOf("{stockDraft && (() => {"), app.indexOf("})()}", app.indexOf("{stockDraft && (() => {")));
    assert.ok(stockSlip.length > 200);
    assert.doesNotMatch(stockSlip, /eth_|window\.ethereum|walletRpcTransaction/, "the slip reaches a wallet only through the reviewed signer");
    assert.match(stockSlip, /onClick=\{signStockTransfer\}/);
    assert.match(stockSlip, /Stock transfers are off on this server/);
    assert.match(stockSlip, /I am not a U\.S\. person and I am outside the United States/);
    const signer = app.slice(app.indexOf("async function signStockTransfer()"), app.indexOf("async function verifyStockTransferAgain()"));
    const reviewCheck = signer.indexOf("matchesStockReview(");
    assert.ok(reviewCheck > 0 && reviewCheck < signer.indexOf("eth_sendTransaction"), "the wallet opens only after the prepared transfer matches the review");
    assert.match(signer, /await switchStockChain\(review\.network\)/);
    const chainSwitch = app.slice(app.indexOf("async function switchStockChain("), app.indexOf("async function submit("));
    assert.match(chainSwitch, /switchWalletChain\(\{ chainId: `0x\$\{chain\.id\.toString\(16\)\}`, chainName: chain\.name, nativeCurrency: ETHER, rpcUrl: chain\.rpcUrl/, "wallet network entries use bundled chain constants");
    assert.match(signer, /eligibilityConfirmed: stockEligibility/);
    assert.match(board, /not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc\./);
    assert.doesNotMatch(`${app}\n${board}`, /tokeni[sz]ed (stock|equit)/i, "Robinhood's brand rules ask for \"Stock Tokens\" in full");
    assert.match(board, /Test stock board/);
    assert.match(board, /https:\/\/faucet\.testnet\.chain\.robinhood\.com/);
    assert.match(board, /Stock Tokens give economic exposure, not ownership of the underlying shares/);
    assert.doesNotMatch(`${app}\n${board}`, /cdn\.robinhood\.com|logoUrl/, "Robinhood's placeholder logo is never shown as a stock logo");
    assert.match(boardStyles, /\.stock-row-price b \{[^}]*font-variant-numeric: tabular-nums/, "prices line up in columns");
    assert.match(boardStyles, /\.stock-views button\[aria-pressed='true'\]/);
    // Rows show the ticker and name without logos; slips keep a neutral two-letter tile in the theme's colors.
    assert.doesNotMatch(board, /data-tone|<StockTile token=\{token\} \/>/);
    assert.match(boardStyles, /\.stock-tile \{[^}]*color: var\(--ink\); background: var\(--rail\)/);
    assert.doesNotMatch(`${app}\n${board}`, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });
  it("sends stock claim links, claims them, and deploys the escrow only through reviewed wallet calls", async () => {
    const [app, operator] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/StockEscrowOperator.tsx", import.meta.url), "utf8"),
    ]);
    const slip = (marker: string) => app.slice(app.indexOf(marker), app.indexOf("})()}", app.indexOf(marker)));
    for (const [marker, handler] of [["{stockClaimDraft && (() => {", "onClick={fundStockClaim}"], ["{stockClaimTarget && (() => {", "onClick={() => redeemStockClaim(\"claim\")}"]]) {
      const view = slip(marker);
      assert.ok(view.length > 200, marker);
      assert.doesNotMatch(view, /eth_|window\.ethereum|walletRpcTransaction/, "slips reach a wallet only through the reviewed signers");
      assert.ok(view.includes(handler), handler);
    }
    assert.match(slip("{stockClaimDraft && (() => {"), /I am not a U\.S\. person and I am outside the United States\. To my knowledge the recipient is too/);
    assert.match(slip("{stockClaimTarget && (() => {"), /I am not a U\.S\. person and I am outside the United States, and Robinhood Stock Tokens are permitted where I am\./);
    assert.match(slip("{stockClaimDraft && (() => {"), /Vault links are off on this server/);
    for (const [start, end, check] of [
      ["async function fundStockClaim()", "async function verifyStockClaimAgain()", "matchesStockClaimFunding("],
      ["async function redeemStockClaim(", "return (\n    <main", "matchesStockClaimAction("],
    ]) {
      const signer = app.slice(app.indexOf(start), app.indexOf(end));
      const review = signer.indexOf(check);
      assert.ok(review > 0 && review < signer.indexOf("eth_sendTransaction"), `${start} opens the wallet only after ${check}`);
      assert.match(signer, /await switchStockChain\(/);
    }
    assert.match(app, /const StockEscrowOperator = lazy\(\(\) => import\("\.\/components\/StockEscrowOperator"\)\)/, "the creation code loads only on the operator page");
    assert.doesNotMatch(app, /stock-claim-escrow-artifact/);
    // Three signatures: the burn vault, the fee router (that vault, the operator as treasury), then the escrow on that router.
    assert.match(operator, /encodeDeployData\(\{ abi: burnVaultAbi, bytecode: BURN_VAULT_ARTIFACT\.bytecode \}\)/);
    assert.match(operator, /encodeDeployData\(\{ abi: payRouterAbi, bytecode: PAY_ROUTER_ARTIFACT\.bytecode, args: \[burnVault, entry\.operator\] \}\)/);
    assert.match(operator, /encodeDeployData\(\{ abi: stockClaimEscrowAbi, bytecode: STOCK_CLAIM_ESCROW_ARTIFACT\.bytecode, args: \[entry\.verifier, router\] \}\)/);
    assert.doesNotMatch(app, /fee-artifacts/, "the fee contracts' creation code also loads only on the operator page");
    assert.match(app, /On Robinhood Chain you sign three deployments: the burn vault, the fee router and the escrow\./);
    assert.match(app, /On Solana one approval funds a temporary key that deploys the vault program, hands its upgrade key to your wallet and returns what is left\./);
    assert.match(app, /Arc Mainnet, at the end of the page, takes four deployments and then the three variables it shows\./);
    assert.doesNotMatch(`${app}\n${operator}`, /one signature|contract owner wallet|Connect the owner wallet/, "the operator page names the operator wallet and its three signatures");
    assert.match(operator, /fetch\("\/api\/stocks\/escrow\/register"/);
    assert.match(operator, /I understand this vault will hold real tokens on \{chain\.name\}/);
    assert.doesNotMatch(`${app}\n${operator}`, /tokeni[sz]ed (stock|equit)/i);
    // Identity errors appear inside the open dialog, where the chat behind it cannot be seen.
    assert.match(app, /\{identityNotice && <div className="wallet-gate identity-notice" role="alert">/);
    const linker = app.slice(app.indexOf("async function linkProvider("), app.indexOf("function connectTelegram("));
    assert.match(linker, /setIdentityNotice\(message\)/);
    assert.match(linker, /response\.json\(\)\.catch\(/, "a non-JSON error page never becomes a parse error");
    // Telegram logs in through its popup from the desk's own button: no widget, so nothing is evaluated from a string,
    // which the page's script policy forbids (the widget's data-onauth needed eval and never drew its button).
    assert.doesNotMatch(app, /onauth|onTelegramAuth|data-telegram-login|function TelegramLogin/);
    const telegram = app.slice(app.indexOf("function connectTelegram("), app.indexOf("async function disconnectWallet("));
    assert.ok(telegram.length > 300);
    assert.match(telegram, /login\.auth\(\{ bot_id: provider\.botId, request_access: false \}, \(user\) => void \(async \(\) => \{/, "the popup opens straight from the click");
    assert.match(telegram, /fetch\("\/api\/oauth\/telegram\/verify"/);
    assert.match(telegram, /setIdentityNotice\(message\)/);
    assert.match(app, /script\.src = "https:\/\/telegram\.org\/js\/telegram-widget\.js\?22";\n\s+script\.dataset\.hapapayTelegram = "";/, "the login script loads once, without widget attributes");
    assert.match(app, /provider\.id === "telegram" \? connectTelegram\(provider\) : linkProvider\(provider\)/);
    assert.doesNotMatch(`${app}\n${operator}`, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });
  it("says a vault link that was already claimed is settled, on every network, and offers nothing to sign", async () => {
    const [app, solanaSlip] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/SolanaClaimSlip.tsx", import.meta.url), "utf8"),
    ]);
    // Arc: the server answers a link the escrow no longer holds as settled instead of "not found".
    assert.match(app, /status: "claimable" \| "expired" \| "settled";/);
    assert.match(app, /\{claimDetails\?\.status === "settled" && <p className="claim-settled" role="status">\{settledLink\(claimDetails\.expiresAt\)\.note\}<\/p>\}/);
    assert.match(app, /: claimDetails\?\.status !== "settled" && <div className="claim-actions">/);
    // Robinhood Chain and Solana say the same, and none of the three keeps a Claim or Refund button.
    assert.match(app, /\{details\?\.status === "settled" && !stockClaimAction && <p className="claim-settled" role="status">\{settledLink\(details\.expiresAt\)\.note\}<\/p>\}/);
    assert.match(app, /: details && details\.status !== "settled" && <div className="claim-actions">/);
    assert.match(solanaSlip, /\{details\?\.status === "settled" && !action && <p className="claim-settled" role="status">\{settledLink\(details\.expiresAt\)\.note\}<\/p>\}/);
    assert.match(solanaSlip, /: details && details\.status !== "settled" && <div className="claim-actions">/);
    // The page around the slip says it too: its heading and lead, and no instruction to verify a wallet for it.
    assert.match(app, /<DotText as="h1" text=\{settledPage \? settledPage\.heading : claimTarget \? "Claim the USDC reserved for your account"/);
    assert.match(app, /<p>\{settledPage \? settledPage\.intro : claimTarget \?/);
    assert.match(app, /const settledExpiry = claimTarget && claimDetails\?\.status === "settled" \? claimDetails\.expiresAt\s*: stockClaimTarget && stockClaimDetails\?\.status === "settled" \? stockClaimDetails\.expiresAt\s*: solanaClaimTarget \? solanaSettledExpiry : undefined;/);
    assert.equal(app.match(/if \(result\.status === "settled"\) setReply\(quietClaimReply\);/g)?.length, 2, "Arc and Robinhood Chain links");
    assert.match(app, /if \(details\.status === "settled"\) setReply\(quietClaimReply\);/, "and Solana links");
    assert.match(solanaSlip, /onDetails\?\.\(result\);/);
    // What a claim needs (the one-time authorization, the claim network, the lock to one account) is not shown for it.
    assert.match(app, /\{claimDetails\?\.status !== "settled" && <>\s*<div className=\{`mainnet-lock/);
    assert.match(app, /\{details\?\.status !== "settled" && <div className="mainnet-lock mainnet-ready"><DotIcon name="shield" size=\{16\} \/><span>\{details\?\.lock === "name" && details\.recipient\s*\? <NameClaimNote [^\n]+\n\s*: <><b>Locked to one \{platform\} account\.<\/b>/);
    assert.match(solanaSlip, /\{details\?\.status !== "settled" && <div className="mainnet-lock mainnet-ready"><DotIcon name="shield" size=\{16\} \/><span>\{details\?\.lock === "name" && details\.recipient\s*\? <><b>Waiting for the \{platform\} name @\{details\.recipient\.username\}\.<\/b>[^\n]+\n\s*: <><b>Locked to one \{platform\} account\.<\/b>/);
    // A link that waits for a name says whose name, on every network.
    assert.match(app, /\{claimDetails\?\.lock === "name" && claimDetails\.recipient\s*\? <NameClaimNote platform=\{claimDetails\.recipient\.platform\} username=\{claimDetails\.recipient\.username\} \/>/);
  });
  it("signs Arc payments and vault links only after the browser's own review, on the bundled chain", async () => {
    const [app, arcOperator, operator] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/ArcMainnetOperator.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/StockEscrowOperator.tsx", import.meta.url), "utf8"),
    ]);
    for (const [start, end, check] of [
      ["async function fundClaim()", "async function redeemClaim(", "matchesArcClaimFunding("],
      ["async function redeemClaim(", "async function signPayment()", "matchesArcClaimAction("],
      ["async function signPayment()", "async function signStockTransfer()", "matchesArcPayment("],
    ]) {
      const signer = app.slice(app.indexOf(start), app.indexOf(end));
      assert.ok(signer.length > 100, start);
      const review = signer.indexOf(check);
      assert.ok(review > 0 && review < signer.indexOf("eth_sendTransaction"), `${start} opens the wallet only after ${check}`);
      assert.ok(signer.indexOf("switchToArc(") > review, `${start} switches chains only after the review`);
      assert.doesNotMatch(signer, /params: \[prepared\.transaction\]|switchToArc\(prepared\.chainIdHex/, "no prepared call reaches the wallet unreviewed");
    }
    // A funded Arc vault link or Arc payment is verified again from its slip, never funded or paid a second time
    // (audit, 2026-10-06): the funding's hash is kept before its receipt is awaited, and the slips offer verify again.
    const funding = app.slice(app.indexOf("async function fundClaim()"), app.indexOf("async function confirmArcClaimFunding("));
    assert.ok(funding.indexOf("setArcClaimFunding(funding);") > 0 && funding.indexOf("setArcClaimFunding(funding);") < funding.indexOf("await waitForTransactionReceipt("), "the funding is kept as soon as it leaves the wallet");
    assert.match(app, /: transactionHash && arcClaimFunding \? <>/, "a submitted funding replaces the fund button");
    assert.match(app, /onClick=\{verifyArcClaimAgain\}>Verify the vault receipt again<\/button>/);
    assert.match(app, /onClick=\{verifyArcPaymentAgain\}>Verify the receipt again<\/button>/);
    assert.match(app, /if \(response\.ok \|\| response\.status === 409\) \{\n\s+setTransactionStatus\("confirmed"\);/, "an Arc payment already recorded counts as verified");
    // A batch opens the wallet only after the browser's own check of every payment, then switches to the reviewed chain.
    const batch = app.slice(app.indexOf("async function signBatch()"), app.indexOf("async function verifyBatchAgain()"));
    assert.ok(batch.length > 1000);
    for (const check of ["matchesStockBatch(", "matchesArcBatch("]) {
      assert.ok(batch.indexOf(check) > 0 && batch.indexOf(check) < batch.indexOf("eth_sendTransaction"), `${check} before any wallet call`);
    }
    assert.ok(batch.indexOf("switchStockChain(") > batch.indexOf("matchesStockBatch(") && batch.indexOf("switchToArc(") > batch.indexOf("matchesArcBatch("));
    assert.match(batch, /\["waiting", "failed"\]\.includes\(/, "only payments not sent are prepared again");
    // The reviewed note goes into every check, so a note the sender did not review never reaches the wallet.
    assert.match(app, /matchesArcPayment\(prepared, \{ network: prepared\.networkId, recipient: draft\.resolvedAddress, amount: draft\.intent\.amount, wallet, note: note\.note \}\)/);
    assert.match(app, /matchesStockReview\(prepared, \{ network: review\.network, token, sender: wallet, recipient: review\.resolvedAddress, units: review\.units, note: note\.note, router: reviewedRouter \}\)/, "a fee the review did not show is never signed");
    // The wallet's Arc entry is the bundled one; a server response never names the chain, its RPC or its explorer.
    assert.match(app, /const chain = arcWalletChain\(arcNetwork\);/);
    assert.doesNotMatch(app, /prepared\.rpcUrl|prepared\.explorerUrl/);
    // Arc Mainnet on the operator page: four bundled builds from the operator wallet, then a read-only server check.
    assert.match(operator, /const arc = <ArcMainnetOperator wallet=\{wallet\}/);
    assert.equal(operator.match(/\{arc\}/g)?.length, 2, "the Arc card shows whether or not the Robinhood status loads");
    assert.match(app, /switchArcChain=\{\(\) => switchToArc\("arc-mainnet"\)\}/);
    assert.match(arcOperator, /encodeDeployData\(\{ abi: feeForwarderAbi, bytecode: FEE_FORWARDER_ARTIFACT\.bytecode, args: \[setup\.operator\] \}\)/);
    assert.match(arcOperator, /encodeDeployData\(\{ abi: payRouterAbi, bytecode: PAY_ROUTER_ARTIFACT\.bytecode, args: \[next\.forwarder!, setup\.operator\] \}\)/);
    assert.match(arcOperator, /encodeDeployData\(\{ abi: arcIdentityRegistryAbi, bytecode: ARC_IDENTITY_REGISTRY_ARTIFACT\.bytecode, args: \[setup\.identityVerifier\] \}\)/);
    assert.match(arcOperator, /encodeDeployData\(\{ abi: stockClaimEscrowAbi, bytecode: STOCK_CLAIM_ESCROW_ARTIFACT\.bytecode, args: \[setup\.claimVerifier, next\.router!\] \}\)/);
    assert.equal(arcOperator.match(/Signature \d of 4:/g)?.length, 4);
    assert.match(arcOperator, /fetch\("\/api\/arc\/mainnet-setup\/verify"/);
    assert.match(arcOperator, /I understand these contracts will hold and move real USDC on Arc Mainnet/);
    assert.match(arcOperator, /half through the fee forwarder, which can only pass it on to the operator\./, "the Arc fee half is not presented as burned");
    assert.doesNotMatch(app, /arc-identity-registry-artifact|ArcMainnetOperator/, "the Arc creation code loads only on the operator page");
    const storage = arcOperator.match(/window\.localStorage\.[a-zA-Z]+\(/g) ?? [];
    assert.equal(storage.length, 2);
    for (const name of ["function readDeployed()", "function writeDeployed("]) assert.match(arcOperator.slice(arcOperator.indexOf(name), arcOperator.indexOf("\n}\n", arcOperator.indexOf(name))), /try \{[\s\S]*\} catch/, `${name} survives blocked storage`);
    assert.doesNotMatch(arcOperator, /one signature|contract owner wallet|private ?key|0x[0-9a-fA-F]{64}/i);
    assert.doesNotMatch(arcOperator, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });
  it("lists pending claims and acts on them only through the reviewed claim signers", async () => {
    const [app, claims, styles] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/PendingClaims.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/pending-claims.css", import.meta.url), "utf8"),
    ]);
    // The list is display data from the server; it never reaches a wallet, the network or storage by itself.
    assert.doesNotMatch(claims, /eth_|window\.ethereum|fetch\(|localStorage|dangerouslySetInnerHTML/);
    assert.match(app, /fetch\("\/api\/claims\/pending", \{ cache: "no-store" \}\)/);
    // It is read again whenever the wallet or its vault accounts change, so a link appears as soon as its account is linked.
    assert.match(app, /\}, \[wallet, vaultAccountsKey\]\);/);
    assert.match(app, /<a className="nav-panel" href="#panel-claims" onClick=\{\(event\) => openPanel\(event, "claims"\)\}>Claims<\/a>/);
    // Claims and refunds from the list go through the claim pages' signers, which check the call before the wallet opens.
    const action = app.slice(app.indexOf("async function actOnPendingLink("), app.indexOf("\n  }\n", app.indexOf("async function actOnPendingLink(")));
    assert.ok(action.length > 200);
    assert.doesNotMatch(action, /eth_sendTransaction|walletRpcTransaction|switchToArc\(|switchStockChain\(/);
    assert.match(action, /signArcVaultAction\(link\.paymentId, action, submitted\)/);
    assert.match(action, /signStockVaultAction\(\{ network: link\.network, paymentId: link\.paymentId, escrow: link\.escrow, symbol: link\.token\.symbol \}, action, statement, submitted\)/);
    for (const [start, check, chainSwitch] of [["async function signArcVaultAction(", "matchesArcClaimAction(", "switchToArc("], ["async function signStockVaultAction(", "matchesStockClaimAction(", "switchStockChain("]]) {
      const signer = app.slice(app.indexOf(start), app.indexOf("\n  }\n", app.indexOf(start)));
      const review = signer.indexOf(check);
      assert.ok(review > 0 && review < signer.indexOf(chainSwitch) && signer.indexOf(chainSwitch) < signer.indexOf("eth_sendTransaction"), `${start} checks the call, then switches chains, then opens the wallet`);
    }
    for (const page of ["async function redeemClaim(", "async function redeemStockClaim("]) {
      const body = app.slice(app.indexOf(page), app.indexOf("\n  }\n", app.indexOf(page)));
      assert.doesNotMatch(body, /eth_sendTransaction/, `${page} signs through the shared signer`);
    }
    // A refused claim says why on the link itself, not only in the conversation where the button would look dead, and
    // the buttons stay to try again.
    assert.match(claims, /\{mine && action\.message && \(action\.status === "refused" \|\| action\.status === "failed"\) && <p className="claim-item-error" role="alert">\{action\.message\}<\/p>\}/);
    assert.equal(app.match(/setPendingClaimAction\(\(current\) => current\?\.paymentId !== link\.paymentId \? current : \{ \.\.\.current, status: current\.hash \? "failed" : "refused", message \}\);/g)?.length, 2, "Arc and Robinhood Chain links, and Solana links");
    assert.match(styles, /\.claim-item-error \{/);
    // A mainnet Stock Token claim asks for the statement in the list too.
    assert.match(claims, /I am not a U\.S\. person and I am outside the United States, and Robinhood Stock Tokens are permitted where I am\./);
    assert.match(styles, /prefers-reduced-motion: reduce/);
    assert.doesNotMatch(`${claims}\n${styles}`, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });
  it("shows a note as public and permanent, a batch row by row, and sends a short answer with the question it answers", async () => {
    const [app, slip, note, activity] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/BatchSlip.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/NoteField.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/PaymentActivity.tsx", import.meta.url), "utf8"),
    ]);
    assert.match(note, /Optional · public on chain/);
    assert.match(note, /Written on chain with the payment: anyone can read it and it cannot be removed\./);
    assert.match(note, /aria-label="Clear the note"/);
    assert.match(slip, /One approval of the total, then one payment for each person/);
    assert.match(slip, /A payment that went through stays sent if you stop; the rest can be sent afterwards\./);
    assert.match(slip, /`Send the other \$\{remaining\}`/);
    assert.match(slip, /disabled=\{started \|\| props\.busy\}/, "the note cannot change once signing has started");
    assert.match(app, /answering: \{ request: answering \}/);
    assert.match(app, /item\.length <= 500/, "a request for several people fits in a suggestion");
    assert.match(activity, /<dt>Note<\/dt>/);
    for (const text of [app, slip, note, activity]) assert.doesNotMatch(text, /[\u011f\u011e\u0131\u0130\u015f\u015e]|one signature/);
  });
  it("disconnects the wallet, removes an account only after saying what stops, and says why a sign-in failed", async () => {
    const [app, styles] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    ]);
    // Disconnect clears the server session first, asks the wallet to forget the site where it can, then reads the cookie again.
    const disconnect = app.slice(app.indexOf("async function disconnectWallet("), app.indexOf("\n  }\n", app.indexOf("async function disconnectWallet(")));
    assert.ok(disconnect.length > 300);
    assert.ok(disconnect.indexOf('fetch("/api/auth/logout"') < disconnect.indexOf("wallet_revokePermissions") && disconnect.indexOf("wallet_revokePermissions") < disconnect.indexOf("sessionController.restore()"));
    assert.match(disconnect, /Wallet disconnected\. Your linked accounts stay linked to it; verify it again to see them\./);
    assert.match(app, /<button type="button" className="disconnect-action" disabled=\{busy \|\| walletVerifying \|\| Boolean\(linking\)/, "no disconnect in the middle of a payment");
    // Remove is a word, not an icon, and asks in words before anything is removed.
    assert.doesNotMatch(app, /"Remove\?"|name="unlink"/);
    assert.match(app, /Remove \{handleLabel\(linked\.username\)\} from this wallet\? Payments sent to this \{provider\.name\} account stop reaching it until you connect it again\./);
    assert.match(app, /className="unlink-keep"[^>]*onClick=\{\(\) => setUnlinkConfirm\(undefined\)\}>Keep<\/button>/);
    // Links live on HaPaPay's servers: no identity record is written on chain, so linking and removing sign nothing.
    assert.match(app, /HaPaPay keeps the link on its own servers; the link itself is never written on chain\./);
    assert.doesNotMatch(app, /Record on Arc|Register on Arc|\/api\/identity\/registry|prepare-registry|matchesArcRegistryCall/);
    const remove = app.slice(app.indexOf("async function unlinkIdentity("), app.indexOf("async function copyPaymentLink("));
    assert.ok(remove.length > 300);
    assert.doesNotMatch(remove, /eth_sendTransaction|switchToArc/, "removing an account opens no wallet");
    // A sign-in that came back without a link says why.
    for (const text of ["Your wallet session ended before ${name} answered", "sign-in was cancelled. Nothing was linked.", "expired or was already used", "is already linked to another wallet. Verify that wallet and remove ${name} there", "refused HaPaPay's sign-in settings, so nothing was linked. This is a site setting, not your account", "did not confirm the account"]) {
      assert.ok(app.includes(text), text);
    }
    assert.match(app, /linkFailureMessage\(failedProvider, params\.get\("reason"\)\)/);
    // Opened on another host (a preview or deployment URL), the desk moves to the site's own origin first.
    assert.match(app, /const landingPath = `\$\{window\.location\.pathname\}\$\{window\.location\.search\}\$\{window\.location\.hash\}`;/, "read before the address bar is tidied");
    assert.match(app, /window\.location\.origin !== data\.appOrigin\) \{\n\s+window\.location\.replace\(`\$\{data\.appOrigin\}\$\{landingPath\}`\);/);
    assert.match(styles, /\.unlink-confirm \{ grid-column: 1 \/ -1;/);
    assert.match(styles, /\.wallet-session \{/);
    assert.doesNotMatch(app, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });

  it("never shows a linked account as not connected while the desk cannot see it", async () => {
    const [app, styles, controller] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
      readFile(new URL("../src/domain/wallet-session-controller.ts", import.meta.url), "utf8"),
    ]);
    const panel = app.slice(app.indexOf('<section className="identity-summary"'), app.indexOf("</section>", app.indexOf('<section className="identity-summary"')));
    assert.ok(panel.length > 500);
    // "Not connected" is said only once the verified wallet's accounts have been read.
    assert.match(app, /const accountsKnown = Boolean\(wallet\) && session\.profileStatus === "ready";/);
    assert.match(app, /const accountsUnknown = !wallet \? "Verify to see" : session\.profileStatus === "error" \? "Could not load" : accountsKnown \? undefined : "Checking…";/);
    assert.equal(panel.match(/Not connected/g)?.length, 1);
    assert.match(panel, /accountsUnknown \?\? "Not connected"/);
    assert.match(panel, /accountsKnown \? `\$\{accounts\.length\} of \$\{identities\.length\} connected` : accountsUnknown/);
    // A failed read says the accounts are still linked and reads again; signed out, one button verifies the wallet.
    assert.match(panel, /Nothing was removed: they are still linked\./);
    assert.match(panel, /onClick=\{\(\) => void sessionController\.refreshProfile\(\)\}>Try again/);
    // A press while the sign-in is still loading says so and opens it once ready.
    assert.match(panel, /disabled=\{walletVerifying \|\| privyOpening\} onClick=\{\(\) => void connectWallet\(\)\}>\{privyOpening \? "Opening…" : walletVerifying \? "Verifying…" : "Verify your wallet"\}/);
    assert.match(panel, /An account you connect stays linked to your wallet until you remove it\./);
    assert.match(app, /profileRetryDelays: \[800, 2500\]/);
    assert.match(controller, /for \(const delay of \[0, \.\.\.\(transport\.profileRetryDelays \?\? \[\]\)\]\)/);
    assert.match(styles, /\.identity-load-error \{/);
    assert.match(styles, /:is\(\.clear-conversation, \.manage-link, \.identity-load-error button,/, "the verify button looks disabled while the wallet signs");
    assert.doesNotMatch(panel, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });

  it("asks for the Stock Token statement only for Stock Tokens", async () => {
    const [app, docs, home, board, styles] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/DocsPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/HomePage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/StockTokenList.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    ]);
    for (const [start, end] of [
      ["async function signStockTransfer()", "async function verifyStockTransferAgain()"],
      ["async function fundStockClaim()", "async function verifyStockClaimAgain()"],
    ]) {
      const signer = app.slice(app.indexOf(start), app.indexOf(end));
      assert.match(signer, /const needsStatement = !chain\.testAssets && isStockToken\(review\.intent\.asset\)/, `${start}: USDG needs no Stock Token statement`);
      assert.match(signer, /\.\.\.\(needsStatement \? \{ eligibilityConfirmed: stockEligibility \} : \{\}\)/);
    }
    const redeemer = app.slice(app.indexOf("async function redeemStockClaim("), app.indexOf("return (\n    <main"));
    assert.match(redeemer, /!details\.token\.kind \|\| isStockToken\(\{ kind: details\.token\.kind \}\)/, "an unclassified token still asks for the statement");
    // Docs load only on /docs and read public status endpoints; they never touch a wallet or a secret.
    assert.match(app, /const DocsPage = lazy\(\(\) => import\("\.\/components\/DocsPage"\)\)/);
    assert.match(app, /class ChunkBoundary extends Component/, "a failed lazy chunk shows a retry instead of a blank app");
    assert.equal(app.match(/<ChunkBoundary fallback=/g)?.length, 6, "every lazy chunk is wrapped: the docs, the admin panel, the operator page, the Solana slips, the Solana board and the sign-in");
    assert.match(app, /const AdminPage = lazy\(\(\) => import\("\.\/components\/AdminPage"\)\)/, "the admin panel loads only on /admin");
    assert.match(app, /The admin panel could not be loaded\./);
    assert.match(app, /The docs could not be loaded\./);
    assert.match(styles, /\.docs-loading \{/, "the fallback's style ships in the main stylesheet, not the chunk that failed");
    assert.match(app, /<a href="\/docs">Docs<\/a>/);
    for (const id of ["overview", "quick-start", "accounts", "sending", "vault", "claiming", "networks", "security", "fees", "faq", "operators", "legal"]) {
      assert.match(docs, new RegExp(`id="${id}" className="docs-section"`), id);
      assert.match(docs, new RegExp(`\\{ id: "${id}", title:`), `${id} is in the table of contents`);
    }
    assert.doesNotMatch(docs, /window\.ethereum|method: "eth_|process\.env|localStorage/);
    assert.match(docs, /not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc\./);
    // Vault windows are the same for everyone: no desk skin depends on what a wallet holds.
    assert.doesNotMatch(`${app}\n${docs}\n${home}\n${styles}`, /data-desk-skin|goldDesk/);
    assert.match(docs, /You choose how long a link stays open: \{STOCK_CLAIM_WINDOW_HOURS\.default\} hours, 7, 14 or 30 days\./);
    assert.equal(app.match(/\{STOCK_CLAIM_WINDOW_CHOICES\.map\(\(hours\) => <button type="button" key=\{hours\}/g)?.length, 2, "both vault slips offer every window");
    assert.doesNotMatch(docs, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
    assert.doesNotMatch(docs, /tokeni[sz]ed (stock|equit)/i);
    // Arc Mainnet: the operator steps, where the Arc fee goes, and no claim that Arc mainnet is off or that its fee is burned.
    assert.match(docs, /<h3>Open Arc Mainnet<\/h3>/);
    assert.match(docs, /<code>ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY<\/code> and <code>ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY<\/code> \(Sensitive, Production\)/);
    assert.match(docs, /Nothing is burned on Arc, so the whole Arc fee goes to the operator/);
    assert.match(docs, /<b>\{health\?\.network === "mainnet" \? "Arc Mainnet" : "Arc Testnet"\}<\/b>/, "the live status names the Arc network the server runs");
    assert.doesNotMatch(docs, /Arc mainnet stays off/, "Arc Mainnet is not described as off");
    assert.doesNotMatch(docs, /0x[0-9a-fA-F]{40}/, "the guide names no deployment's contracts");
    assert.doesNotMatch(docs, /Arc[^.<]*\b(?<!cannot be )burn(?:s|ed)\b/i, "nothing is burned on Arc");
  });

  it("sets labels and amounts in dot-matrix type and lights buttons with dots under the pointer", async () => {
    const [app, styles, arrow, decode] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
      readFile(new URL("../src/components/DotIcon.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/DecodeText.tsx", import.meta.url), "utf8"),
    ]);
    // Doto sets everything short that is read at a glance (the brand, headings, amounts, step numbers, tabs, navigation,
    // card titles, slip labels, the log's names) and every button; sentences, inputs and prices keep the text faces.
    assert.match(styles, /^\.brand > \.dot-text, \.intro h1, \.home h1, \.home h2, \.home-step-number, \.home-route > \.dot-text, \.home-assets strong, \.slip-top strong, \.side-tabs button, \.primary-nav :is\(a, button\), \.footer-brand, \.home-steps b, \.home-more, \.message-author, [^{]+ \{ font-family: var\(--font-display\); font-variation-settings: "ROND" 100; \}$/m);
    const pillFamilies = styles.match(/^:is\(\.wallet-button, [^{]+\{[^}]+\}$|^:is\(\.network-pill, [^{]+\{[^}]+\}$/gm) ?? [];
    assert.equal(pillFamilies.filter((rule) => /font-family: var\(--font-display\); font-weight: 800; letter-spacing: \.06em; text-transform: uppercase;/.test(rule)).length, 2, "both button families are set in dot-matrix capitals");
    assert.match(styles, /\.wallet-address \{ text-transform: none;/, "a wallet address keeps its letters as they are");
    const sheets = await Promise.all(["../src/styles.css", "../src/components/home-page.css", "../src/components/payment-conversation.css", "../src/components/stock-token-list.css", "../src/components/payment-activity.css", "../src/components/docs-page.css"]
      .map((path) => readFile(new URL(path, import.meta.url), "utf8")));
    for (const sheet of sheets) {
      for (const [, selector] of sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^}]*var\(--font-display\)[^}]*\}/g)) {
        assert.doesNotMatch(selector, /input|textarea|price|-lead\b|\bp\b|\bli\b|message-(?:user|assistant)/, `${selector.trim()} is a sentence, an input or a price, never dot-matrix`);
      }
    }
    // Every icon is drawn in dots; no icon library is left.
    assert.match(app, /aria-label="Send request"><DotArrow \/><\/button>/);
    assert.match(arrow, /<svg className=\{`dot-icon dot-icon-\$\{name\} \$\{className\}`\} width=\{size\} height=\{size\} viewBox="0 0 20 20" aria-hidden="true" focusable="false">/);
    assert.match(arrow, /return <DotIcon name=\{direction === "up" \? "arrow-up" : "arrow-right"\} size=\{18\} className="dot-arrow" \/>;/);
    assert.match(app, /<DotIcon name=\{colorTheme === "dark" \? "sun" : "moon"\}|colorTheme === "dark" \? <DotIcon name="sun"/, "the theme button draws its sun and moon in dots");
    const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
    assert.doesNotMatch(packageJson, /lucide/, "no icon library");
    for (const source of [app, arrow, decode]) assert.doesNotMatch(source, /lucide-react/);
    // Labels decode from binary on hover; the real label keeps the width and is what assistive technology reads.
    assert.match(decode, /<span className="visually-hidden">\{text\}<\/span>\s*<span className="decode-size" aria-hidden="true">\{text\}<\/span>\s*<span className="decode-live" aria-hidden="true">\{shown\}<\/span>/);
    assert.match(decode, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(styles, /\.decode-size \{ visibility: hidden; \}/, "the sizing copy is never seen, so a label's visible words are said once");
    assert.match(styles, /@media \(forced-colors: active\) \{\s*\.decode-live \{ display: none; \}\s*\.decode-size \{ visibility: visible; \}/, "high-contrast mode shows the plain label");
    assert.match(app, /<DecodeText text=\{SIDE_TAB_LABELS\[tab\]\} replay=\{activeTab === tab\} \/>/);
    // The dot spotlight follows a mouse or trackpad only; touch screens keep plain buttons.
    assert.match(app, /if \(!window\.matchMedia\("\(hover: hover\) and \(pointer: fine\)"\)\.matches\) return;/);
    assert.match(app, /closest<HTMLElement>\("button, a\[href\], \.composer"\)/);
    assert.match(styles, /:is\(\.wallet-button, \.home-open, \.composer \.send-button, (?:[^()]|\([^()]*\))+\):hover:not\(:disabled\)::after \{ opacity: \.5; \}/, "primary pills light their dots under the pointer");
    assert.doesNotMatch(`${arrow}\n${decode}`, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });

  it("lets the pointer play with dot-matrix text and opens the docs from the text cards", async () => {
    const [app, home, docs, operator, dotText, styles, homeStyles] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/HomePage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/DocsPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/StockEscrowOperator.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/DotText.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
      readFile(new URL("../src/components/home-page.css", import.meta.url), "utf8"),
    ]);
    // The real text stays for assistive technology and search; the letters the pointer plays with are hidden from it.
    assert.match(dotText, /<span className="visually-hidden">\{text\}<\/span>\s*<span className="dot-text-live" aria-hidden="true" key=\{text\}>/);
    // A new text gets new letters, so the cleanup that puts back the letters it flickered can never bring an old text
    // back over a new one (a claim page would keep showing "—" after its amount loaded).
    assert.match(dotText, /node\.textContent = original\[index\];/);
    assert.match(dotText, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(dotText, /if \(!reduced\.matches && decodable\[index\] && heat\[index\] > 0\.42\)/, "reduced motion keeps only the warm color");
    assert.match(dotText, /if \(warm \|\| fresh \|\| ripple\) frame = requestAnimationFrame\(tick\);/, "frames run only while a letter is warm");
    assert.match(dotText, /const REST_MS = 380;/, "a resting pointer lets the letters settle");
    for (const event of ["pointerenter", "pointermove", "pointerleave", "pointerdown"]) assert.match(dotText, new RegExp(`root\\.addEventListener\\("${event}"`));
    assert.match(dotText, /control\?\.matches\(":focus-visible"\)/, "keyboard focus sweeps the text once");
    assert.match(styles, /\.dot-char \{ display: inline-block; color: color-mix\(in srgb, var\(--accent-text\) calc\(var\(--heat, 0\) \* 100%\), currentColor\);/);
    const forcedColors = styles.slice(styles.indexOf("@media (forced-colors: active)"), styles.indexOf("\n}\n", styles.indexOf("@media (forced-colors: active)")));
    assert.match(forcedColors, /\.dot-char \{ color: inherit; transform: none; \}/, "high-contrast mode shows the plain letters");
    // Dot-matrix text everywhere it appears: the brand, headings, step numbers, asset names, slip amounts and the docs.
    assert.match(app, /<DotText text="HaPaPay" \/>/);
    assert.equal(app.match(/<strong><DotText text=\{/g)?.length, 6, "every slip amount answers the pointer");
    assert.match(home, /<DotText className="home-step-number" text=\{number\} \/>/);
    assert.match(home, /<DotText as="strong" text=\{name\} \/>/);
    assert.match(docs, /<DotText as="h1" id="docs-title" text="How HaPaPay works" \/>/);
    assert.match(operator, /<DotText as="strong" id="setup-checklist-title" text="Server setup" \/>/);
    // A key the platform refuses is not a missing key.
    assert.match(docs, /X\{health\?\.recipientLookup\?\.x === "refused_by_x" \? " · refusing this server's lookups" : health && health\.recipientLookup\?\.x !== "configured" \? " · needs an API bearer token" : ""\}/);
    assert.match(docs, /health\?\.recipientLookup\?\.github === "refused_by_github" \? " · refusing this server's lookups"/);
    assert.match(operator, /health\?\.recipientLookup\?\.x === "refused_by_x" \? "X_API_BEARER_TOKEN, which X refuses now: check the key, the project's credits and the app's access in the X developer console"/);
    // Text cards open the docs section that explains them.
    for (const href of ["/docs/quick-start", "/docs/sending", "/docs/security", "/docs/networks", "/docs/vault", "/docs/accounts"]) assert.ok(home.includes(href), href);
    assert.match(home, /<a className="home-card" href=\{href\}>/);
    assert.match(homeStyles, /\.home-card:hover::after \{ opacity: 1; \}/);
    // Status items on the desk explain themselves in the server's words.
    assert.match(app, /aria-expanded=\{statusNote === "stocks"\} aria-controls="desk-status-note"/);
    assert.match(app, /<p className="desk-status-note" id="desk-status-note" role="status" hidden=\{!statusNoteText\}>/);
    assert.match(app, /: stockTransfersReason/);
  });

  it("breaks a pressed button into dots and binary digits that scatter", async () => {
    const [app, burst, styles] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/DotBurst.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    ]);
    // One decorative canvas over every page, out of the way of the pointer and of assistive technology.
    assert.match(app, /<div className="desk-lens" ref=\{deskLensRef\} aria-hidden="true" \/>\s*<DotBurst \/>/);
    assert.match(burst, /return <canvas className="dot-burst" ref=\{canvas\} aria-hidden="true" hidden \/>;/);
    assert.match(styles, /\.dot-burst \{ position: fixed; left: 0; top: 0; z-index: 120; pointer-events: none; \}/, "above the cards and dialogs, never in the way of a click");
    // The canvas covers the pressed buttons and the room their dots fly in, not the window.
    assert.match(burst, /const REACH = 220;/);
    assert.match(burst, /const reach = \{ left: box\.left \+ left - REACH, top: box\.top \+ top - REACH, right: box\.right \+ left \+ REACH, bottom: box\.bottom \+ top \+ REACH \};/);
    assert.match(burst, /element\.style\.transform = `translate\(\$\{area\.left - window\.scrollX\}px, \$\{area\.top - window\.scrollY\}px\)`;/);
    assert.doesNotMatch(burst, /window\.innerWidth \* scale/);
    // Buttons and links drawn as buttons; disabled buttons stay still and the theme switch keeps its own reveal.
    assert.match(burst, /const CONTROLS = "button:not\(:disabled\):not\(\.theme-toggle\), a:is\(\.home-open, \.home-docs, \.docs-back\)/);
    assert.match(burst, /document\.addEventListener\("click", press, true\);/, "every press is seen before the button's own handler changes the page");
    assert.match(burst, /const pointer = event\.detail > 0 && \(event\.clientX !== 0 \|\| event\.clientY !== 0\);/, "a key press bursts from the center");
    // The burst starts as the button's own 6 px dots, in a wave from the press point, and is over within about a second.
    assert.match(burst, /const PITCH = 6;/);
    assert.match(burst, /leaves: now \+ Math\.min\(140, distance \* 0\.9\),\s*life: 480 \+ Math\.random\(\) \* 420,/);
    assert.match(burst, /const digit = Math\.random\(\) < 0\.38;/, "some of the dots fly as 0 and 1");
    assert.match(burst, /const REFORM_MS = 560;/);
    assert.match(burst, /control\.animate\(\[\{ opacity: 1 \}, \{ opacity: 0\.16, offset: 0\.12 \}, \{ opacity: 1 \}\], \{ id: "dot-burst", duration: REFORM_MS/, "the button forms again under its dots");
    // Frames only while dots are in the air; the canvas memory is given back afterwards.
    assert.match(burst, /if \(particles\.length\) frame = requestAnimationFrame\(tick\);/);
    assert.match(burst, /element\.width = 0;\s*element\.height = 0;\s*element\.hidden = true;/);
    // It answers a press, so reduced motion and high-contrast mode keep plain buttons.
    assert.match(burst, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(burst, /window\.matchMedia\("\(forced-colors: active\)"\)/);
    assert.match(burst, /if \(reduced\.matches \|\| forced\.matches\) return;/);
    const reducedMotion = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"), styles.indexOf("\n}\n", styles.indexOf("@media (prefers-reduced-motion: reduce)")));
    assert.match(reducedMotion, /\.desk-lens, \.dot-burst \{ display: none; \}/);
    const forcedColors = styles.slice(styles.indexOf("@media (forced-colors: active)"), styles.indexOf("\n}\n", styles.indexOf("@media (forced-colors: active)")));
    assert.match(forcedColors, /\.dot-burst \{ display: none; \}/);
    assert.doesNotMatch(burst, /localStorage|fetch\(|innerHTML|eval\(/);
    assert.doesNotMatch(burst, /[ğĞıİşŞ]/);
  });

  it("opens on a home page that leads into the desk at /app", async () => {
    const [app, home, docs, oauth, ...sheets] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/HomePage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/DocsPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../server/oauth-flow-store.ts", import.meta.url), "utf8"),
      ...["../src/styles.css", "../src/components/home-page.css", "../src/components/payment-activity.css", "../src/components/stock-token-list.css", "../src/components/docs-page.css", "../src/components/payment-conversation.css", "../src/components/dot-morph.css"]
        .map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    ]);
    // "/" is the home page and "/app" the desk; pay links, claim pages and the operator page open the desk as before.
    assert.match(app, /const DESK_PATH = "\/app";/);
    assert.match(app, /if \(notFoundPage \|\| docsPage \|\| adminPage \|\| payTarget \|\| claimTarget \|\| stockClaimTarget \|\| solanaClaimTarget \|\| operatorPage \|\| \/\^\\\/app\\\/\?\$\/\.test\(pathname\)\) return false;/);
    // A path no page answers says so instead of opening the home page, and leads to the desk, the docs and home.
    assert.match(app, /const \[notFoundPage\] = useState\(\(\) => !\(\/\^\\\/\(\?:index\\\.html\)\?\$\/\.test\(window\.location\.pathname\) \|\| \/\^\\\/app\\\/\?\$\/\.test\(window\.location\.pathname\)\s*\|\| docsPage \|\| adminPage \|\| payTarget \|\| claimTarget \|\| stockClaimTarget \|\| solanaClaimTarget \|\| operatorPage\)\);/);
    assert.match(app, /<h1 id="not-found-title">Page not found<\/h1>/);
    assert.match(app, /<div className="not-found-links"><a className="home-open" href=\{DESK_PATH\}>Open the desk<\/a><a href="\/docs">Read the docs<\/a><a href="\/">Home<\/a><\/div>/);
    assert.match(app, /privyAppId && solanaRpcUrl && !homePage && \(!docsPage \|\| privyWanted\) && !notFoundPage && <ChunkBoundary/, "no wallet sign-in loads on a page that is not there, and the docs load it only for a Connect pressed there");
    // A sign-in started on the desk returns to "/" (the server's return path for the desk) and reopens the desk at /app.
    assert.match(app, /return !params\.has\("linked"\) && !params\.has\("link_error"\);/);
    assert.match(app, /window\.history\.replaceState\(\{\}, "", window\.location\.pathname === "\/" \? DESK_PATH : window\.location\.pathname\)/);
    assert.match(oauth, /if \(!input \|\| input === "\/"\) return "\/";/, "the server's return paths are unchanged");
    assert.match(app, /<a className="brand" href="\/" aria-label="HaPaPay home">/);
    assert.match(app, /\{homePage \|\| notFoundPage \? <a className="home-open topbar-open" href=\{DESK_PATH\}>/);
    assert.match(docs, /<a className="docs-back" href="\/app">Open the payment desk<\/a>/);
    // The home page: the dollar turning into €, the steps, and only what the server reports as running.
    assert.match(home, /<DotMorph shapes=\{\["\$", "\u20ac"\]\}/, "the home hero starts with the dollar, as on the desk");
    assert.match(home, /<a className="home-open" href="\/app"><DecodeText text="Open the desk" \/> <DotArrow direction="right" \/><\/a>/);
    assert.match(home, /Stock Tokens · \{state\(status\.stockTokens, "wallet-signed", "signing locked"\)\}/);
    assert.match(home, /Vault links · \{state\(status\.vault, "open", "not open yet"\)\}/);
    assert.match(app, /stockTokens: Boolean\(mainnetSnapshot\.transfers\?\.enabled\),/);
    assert.match(app, /vault: Boolean\(mainnetSnapshot\.claims\?\.enabled\),/);
    assert.match(app, /arc: network\.ready \? network\.environment : undefined,/);
    assert.match(home, /"USDC on Solana, or on Arc Mainnet when you write “on Arc”\."/);
    assert.match(home, /"USDC on Solana, sent by handle from your own wallet\."/);
    assert.match(home, /Solana · \{state\(Boolean\(status\.solana\), "wallet-signed", "signing locked"\)\}/);
    assert.match(home, /USDG · \{state\(status\.tokens, "wallet-signed", "signing locked"\)\}/);
    assert.ok(home.indexOf("Stock Tokens · {state(") < home.indexOf("Solana · {state("), "Robinhood Chain leads the home page's status");
    assert.doesNotMatch(home, /Arc mainnet stays off/, "the home page no longer says Arc mainnet is off");
    assert.match(home, /Stock Tokens give economic exposure, not ownership of the underlying shares\./);
    assert.match(home, /HaPaPay is not affiliated with, endorsed by, or officially connected with the Solana Foundation, the xStocks issuer, Robinhood Markets, Inc\., Paxos, Circle or Arc\./);
    assert.doesNotMatch(home, /tokeni[sz]ed (stock|equit)|\bfees?\b|\byield\b|guarantee/i);
    // Firmer corners: controls are rectangles with rounded corners, no pills are left.
    assert.match(sheets[0], /--r-control: 10px;/);
    for (const sheet of sheets) assert.doesNotMatch(sheet, /border-radius: 999px/);
    assert.doesNotMatch(`${home}\n${sheets[1]}`, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });

  it("draws the desk in dots that answer the pointer, and keeps state in text", async () => {
    const [app, board, claims, conversation, marks, morph, docs, mark, favicon, ...sheets] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/StockTokenList.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/PendingClaims.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/PaymentConversation.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/StatusMarks.tsx", import.meta.url), "utf8"),
      // The hero: the page's side and the engine that moves and draws its dots (on the page or in a worker).
      Promise.all(["../src/components/DotMorph.tsx", "../src/components/dot-morph-engine.ts"].map((path) => readFile(new URL(path, import.meta.url), "utf8"))).then((parts) => parts.join("\n")),
      readFile(new URL("../src/components/DocsPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/BrandMark.tsx", import.meta.url), "utf8"),
      readFile(new URL("../public/favicon.svg", import.meta.url), "utf8"),
      ...["../src/styles.css", "../src/components/dot-morph.css", "../src/components/status-marks.css", "../src/components/payment-conversation.css", "../src/components/payment-activity.css", "../src/components/stock-token-list.css", "../src/components/docs-page.css", "../src/components/home-page.css", "../src/components/pending-claims.css"]
        .map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    ]);
    // The cartoon set is gone: no scenes, couriers, mailboxes or tickets anywhere.
    await assert.rejects(access(new URL("../src/components/Scenes.tsx", import.meta.url)));
    assert.doesNotMatch(`${app}\n${marks}\n${docs}\n${claims}\n${board}`, /Courier|CityScene|VaultScene|NightTown|MailRack|PassTicket|EmptyMailbox|StepArt|\.\/Scenes/);
    // The mark is the HaPaPay swallow as a halftone: its outline filled with dots of many sizes that never touch, the
    // raised wing its own group so it can flap. The favicon is a coarser bird of the same dots.
    assert.doesNotMatch(`${mark}\n${favicon}`, /<path /, "no outline anywhere in the bird");
    assert.equal(favicon.match(/<circle /g)?.length, 90);
    assert.match(favicon, /<g fill="#CCFF00">/, "the favicon bird is Robin Neon, the main network's green");
    const dotsIn = (from: string, to: string) => [...mark.slice(mark.indexOf(from), mark.indexOf(to)).matchAll(/\[([\d.]+), ([\d.]+), ([\d.]+)\]/g)].map((dot) => dot.slice(1, 4).map(Number));
    const wingDots = dotsIn("const WING", "const BODY");
    const birdDots = [...wingDots, ...dotsIn("const BODY", "/** The bird fills")];
    assert.ok(birdDots.length > 150, "the bird is drawn in many dots");
    assert.ok(wingDots.length > 50, "the raised wing is a field of dots");
    assert.ok(new Set(birdDots.map((dot) => dot[2])).size > 20, "the dots come in many sizes");
    let closest = Infinity;
    for (let i = 0; i < birdDots.length; i++) for (let j = i + 1; j < birdDots.length; j++) closest = Math.min(closest, Math.hypot(birdDots[i][0] - birdDots[j][0], birdDots[i][1] - birdDots[j][1]) - birdDots[i][2] - birdDots[j][2]);
    assert.ok(closest > 0, "no two dots touch");
    assert.match(mark, /<g className="mark-wing">\{wing\}<\/g>/, "the wing is its own group, so it can flap");
    assert.match(sheets[0], /\.mark-wing \{ transform-box: view-box; transform-origin: 37\.42px 26\.58px; \}/, "the wing turns at the shoulder");
    assert.match(sheets[0], /\.brand \.mark-dot \{ animation: mark-assemble \.7s/, "the header bird gathers from its dots once");
    assert.match(sheets[0], /@keyframes wing-flap \{ 50% \{ transform: rotate\(-42deg\) scaleY\(-\.5\) rotate\(42deg\); \} \}/, "a flap folds the wing across the spine");
    assert.doesNotMatch(morph, /bird/i, "the big hero sign is never the bird; it starts with the dollar");
    assert.match(morph, /r: dotRadius\(\) \* \(0\.62 \+ 0\.38 \* Math\.min\(1, \(covered - 0\.42\) \/ 0\.5\)\)/, "dots at the edge of a shape are smaller");
    assert.match(app, /<span className="send-flight" key=\{conversation\.turns\.at\(-1\)\?\.id\} aria-hidden="true"><BrandMark \/><\/span>/, "a sent request leaves as the bird, once");
    // The hero: dots that gather into $ and €, the typed asset, or a lock on vault pages.
    assert.match(app, /<DotMorph shapes=\{heroShapes\} focus=\{heroFocus\} motion=\{ambientMotion\} onToggleMotion=\{toggleAmbientMotion\} \/>/);
    assert.match(app, /: \["\$", "\u20ac"\];/, "the desk moves between the dollar and the euro sign");
    assert.match(app, /const heroShapes = claimTarget \|\| solanaClaimTarget \? \["lock", "\$"\]/);
    assert.match(app, /typedSymbol === "USDC" \|\| typedSymbol === "USDG" \? "\$"/);
    assert.match(app, /: stockSnapshot\.tokens\.some\(\(token\) => token\.symbol === typedSymbol\) \? typedSymbol/, "only allowlisted tickers become shapes");
    assert.match(morph, /const canvas = document\.createElement\("canvas"\);\s*canvas\.setAttribute\("aria-hidden", "true"\);/, "the dots are decorative; the heading says what the page is for");
    assert.match(morph, /aria-label=\{motion \? "Pause animations" : "Play animations"\}/);
    assert.match(morph, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(morph, /new IntersectionObserver\(/, "the field runs only while it is on screen");
    for (const event of ["pointermove", "pointerdown", "pointerup", "pointerleave", "pointercancel"]) assert.match(morph, new RegExp(`addEventListener\\("${event}"`));
    assert.match(morph, /const ambient = motion && !still;/, "the shape cycle, drift and scan stop when animations are paused");
    assert.doesNotMatch(morph, /localStorage|fetch\(|dangerouslySetInnerHTML|eval\(/);
    // Ambient motion can be paused (WCAG 2.2.2) on the hero and in the footer links, and is remembered in this browser.
    assert.match(app, /className="motion-toggle" aria-pressed=\{!ambientMotion\} onClick=\{toggleAmbientMotion\}/);
    assert.match(app, /document\.documentElement\.dataset\.motion = ambientMotion \? "on" : "off";/);
    // One side panel with real tabs.
    assert.match(app, /className="side-tabs" role="tablist" aria-label="Desk panels"/);
    assert.match(app, /role="tab" id=\{`tab-\$\{tab\}`\} aria-selected=\{activeTab === tab\} aria-controls=\{`panel-\$\{tab\}`\} tabIndex=\{activeTab === tab \? 0 : -1\}/);
    for (const tab of ["stocks", "activity", "claims", "sp", "identities"]) assert.match(app, new RegExp(`role="tabpanel" id="panel-${tab}" aria-labelledby="tab-${tab}" hidden=\\{activeTab !== "${tab}"\\}`));
    assert.match(app, /const sideTabs: SideTab\[\] = \["stocks", "activity", "claims", "sp", "identities"\];/, "SP has its own tab (2026-10-05)");
    assert.match(app, /event\.key === "ArrowRight"/, "arrow keys move between tabs");
    assert.doesNotMatch(app, /identity-rail|activity-rail|status-card/, "no third column and no duplicate status card");
    // State marks render only with their states.
    for (const svg of marks.match(/<svg [^>]*>/g) ?? []) assert.match(svg, /aria-hidden="true" focusable="false"/);
    assert.match(app, /transactionHash && transactionStatus === "confirmed" && <VerifiedMark \/>/, "the USDC check appears only after receipt verification");
    assert.match(app, /stockTransaction\?\.status === "confirmed" && <VerifiedMark \/>/, "the stock check appears only after receipt verification");
    assert.match(app, /funding\?\.status === "confirmed" && <VerifiedMark \/>/, "the vault-link check appears only after the funding receipt is verified");
    assert.match(app, /stockClaimAction\?\.status === "confirmed" && <VerifiedMark \/>/, "the claim-page check appears only after the receipt");
    assert.equal(app.match(/<PendingMark \/>/g)?.length, 3, "every pending card shows the chasing dots");
    assert.match(app, /emptyArtwork=\{<EmptyMark \/>\}/);
    assert.equal(app.match(/<article className="payment-slip[^"]*" data-state=/g)?.length, 5, "slips that move funds expose their transfer state to the route");
    assert.equal(app.match(/"verification-failed" : "pending"\}`\}/g)?.length, 5, "submitted transaction bars are marked pending until the receipt");
    assert.doesNotMatch(`${app}\n${conversation}`, /Sparkles/, "no sparkle icons");
    assert.doesNotMatch(`${app}\n${conversation}`, /HaPaPay assistant|Payment assistant| \u2014 /, "plain labels, no chatbot persona or dashed asides");
    assert.match(board, /"--segment": views\.indexOf\(view\)/, "the view tabs slide to the chosen view");
    // Entrances and confirmations stop within five seconds; only pending and loading states repeat on their own. The hero
    // is drawn on a canvas, so its motion is governed by the pause control and reduced motion above.
    for (const sheet of sheets) {
      for (const [, selector, value] of sheet.matchAll(/([^{}]+)\{[^}]*?animation:\s*([^;]+);/g)) {
        const parts = value.trim().split(/\s+/);
        if (parts.includes("infinite")) {
          assert.match(selector, /pending|aria-busy/, `${selector.trim()} repeats only while pending or loading`);
          continue;
        }
        const times = parts.filter((part) => /^[\d.]+m?s$/.test(part)).map((part) => part.endsWith("ms") ? Number.parseFloat(part) / 1000 : Number.parseFloat(part));
        const count = Number(parts.find((part) => /^\d+$/.test(part)) ?? 1);
        const [duration = 0, delay = 0] = times;
        assert.ok(delay + duration * count <= 5, `${selector.trim()} stops by itself within five seconds`);
      }
      assert.doesNotMatch(sheet, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
    }
    assert.match(sheets[0], /@property --accent \{ syntax: '<color>'/, "network and desk colors cross-fade instead of jumping");
    assert.match(sheets[1], /--dot-glyph: var\(--accent-text\); --dot-hot: var\(--ink\); --dot-base: var\(--line-strong\)/, "the dots follow the theme and the network");
    for (const sheet of sheets.slice(0, 4)) assert.match(sheet, /prefers-reduced-motion: reduce/);
    assert.doesNotMatch(`${app}\n${marks}\n${morph}\n${mark}`, /[\u011f\u011e\u0131\u0130\u015f\u015e]/);
  });
});

describe("the HaPaPay fee on the slips", () => {
  it("shows the amount, what the recipient receives, the fee and the total before anything is signed", async () => {
    const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
    assert.match(app, /function FeeFacts\(/);
    assert.equal(app.match(/<FeeFacts /g)?.length, 4, "the Arc and Robinhood transfer and vault slips all show the fee");
    assert.match(app, /\{fees\.sink === "forwarder" \? "Goes to HaPaPay" : "Half goes to the burn vault, half to HaPaPay"\}/, "Arc names where its fee goes; nothing is burned there");
    assert.match(app, /\{network\.fees && arcNetwork && <FeeFacts fees=\{network\.fees\} units=\{parseUnits\(draft\.intent\.amount, 6\)\.toString\(\)\}/);
    assert.match(app, /Approve exactly \$\{prepared\.fee\.totalAmount\} USDC for HaPaPay in your wallet/);
    assert.match(app, /Approve exactly \$\{prepared\.fee\.totalAmount\} USDC in your wallet: \$\{claimDraft\.intent\.amount\} for/);
    assert.match(app, /you sign twice in your wallet: the approval, then the payment\./);
    assert.match(app, /<div><dt>Fee<\/dt><dd>\{formatUnits\(fee, decimals\)\} \{symbol\} · \{platformFeePercent\(fees\.feeBps\)\}/);
    assert.match(app, /<div><dt>Total<\/dt><dd>\{formatUnits\(BigInt\(units\) \+ fee, decimals\)\} \{symbol\}<small>From your wallet · @\{recipient\} receives exactly \{amount\}<\/small>/);
    assert.match(app, /Paid only when @\$\{recipient\} claims it and returned with a refund/);
    // The wallet approves exactly the amount plus the fee, and the reply says so before it opens.
    assert.match(app, /Approve exactly \$\{prepared\.fee\.totalAmount\} \$\{symbol\} for HaPaPay in your wallet/);
    assert.match(app, /Approve exactly \$\{prepared\.fee\.totalAmount\} \$\{symbol\} for the vault in your wallet/);
    assert.doesNotMatch(app, /\bfees? (are|is) (zero|free|waived)\b/i);
  });
});

describe("the desk's own state, from the 2026-10-06 audit", () => {
  it("gets the signing wallet through the session, names a board's network and shows only known providers", async () => {
    const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
    // Every EVM button signs in (Privy or a browser wallet) instead of asking a phone to install a wallet.
    assert.match(app, /async function signingWallet\(\) \{\n    if \(!wallet\) \{\n      await connectWallet\(\);\n      return undefined;\n    \}/);
    assert.equal(app.match(/await signingWallet\(\)/g)?.length, 8, "pending links, both vault links, both claim pages, Arc, stock and batch payments");
    assert.doesNotMatch(app, /No EVM-compatible wallet was found\. Install or enable your browser wallet/);
    assert.match(app, /whenPrivyReady\(injected \? PRIVY_FALLBACK_MS : PRIVY_READY_TIMEOUT_MS\)/, "a browser wallet signs in when Privy does not load");
    // A board row's request names the board's network; ?linked= names only a provider the desk links.
    assert.match(app, /setMessage\(`Send 1 \$\{symbol\} to \$\{recipient\} on \$\{network\}`\)/);
    assert.match(app, /writeBoardRequest\(token\.symbol, "Robinhood Chain"\)/);
    assert.match(app, /const linkedName = identities\.find\(\(identity\) => identity\.id === params\.get\("linked"\)\)\?\.name;/);
    assert.doesNotMatch(app, /setReply\(`Your \$\{params\.get\("linked"\)\}/);
  });

  it("never leaves a page blank, a pay link verifying, a batch overstating or a copy unanswered", async () => {
    const [app, main, copy, vault, admin] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/CopyButton.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/SolanaVaultSlip.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/AdminPage.tsx", import.meta.url), "utf8"),
    ]);
    assert.match(app, /try \{\n      return \{ platform: match\[1\], username: decodeURIComponent\(match\[2\]\)/);
    assert.match(main, /<PageBoundary><App \/><\/PageBoundary>/);
    assert.match(app, /useState<"verifying" \| "verified" \| "unverified" \| "error">\("verifying"\)/);
    assert.match(app, /setReply\(sentAny \? `\$\{message\} Payments that went through stay sent; the button sends only the others\.` : message\);/);
    assert.match(copy, /"Copied"/);
    assert.equal(app.match(/<CopyButton text=/g)?.length, 2);
    assert.match(vault, /<CopyButton text=\{funding\.link\} \/>/);
    assert.match(app, /error=\{spState\.error\}/, "an earlier page of SP that fails says so");
    assert.match(admin, /if \(shown\.current !== path\) \{\n      shown\.current = path;\n      setValue\(undefined\);/);
  });

  it("behaves as a modal for keyboards, closes its menus, and keeps a Telegram or Farcaster sign-in from stalling", async () => {
    const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
    assert.match(app, /function useModalKeyboard\(/);
    assert.match(app, /useModalKeyboard\(identityModalRef, manageOpen, closeIdentities\);/);
    assert.match(app, /<section className="identity-modal" ref=\{identityModalRef\} tabIndex=\{-1\} role="dialog" aria-modal="true"/);
    assert.match(app, /<div className="modal-backdrop" role="presentation" onMouseDown=\{closeIdentities\}>/);
    assert.match(app, /<button aria-label="Close dialog" onClick=\{closeIdentities\}>/);
    assert.match(app, /if \(!networkMenuRef\.current\?\.contains\(event\.target as Node\)\) setNetworkOpen\(false\);/);
    assert.match(app, /<a href=\{farcasterRequest\.url\} target="_blank" rel="noreferrer">Open Farcaster<\/a>/);
    assert.match(app, /script\.addEventListener\("error", failed\);/);
    assert.match(app, /Your browser blocked Telegram's sign-in window\. Allow pop-ups for this site, then press Connect again\./);
    // An address whose holdings are unknown is never switched without asking.
    assert.match(app, /const solanaSwitchSafe = solanaHoldings\?\.status === "ready" && holdsNothing\(solanaHoldings\);/);
  });

  it("keeps a vault funding's record request until the server has it, on every network", async () => {
    const [app, vault] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/SolanaVaultSlip.tsx", import.meta.url), "utf8"),
    ]);
    assert.match(app, /rememberUnrecordedFunding\(\{ url: "\/api\/claims\/confirm-funding", body: arcClaimConfirmation\(claimDraft, funding\), wallet, transaction: hash \}\);/);
    assert.match(app, /rememberUnrecordedFunding\(\{ url: "\/api\/stocks\/claims\/confirm-funding", body: stockClaimConfirmation\(review, submitted\), wallet, transaction: hash \}\);/);
    assert.match(vault, /rememberUnrecordedFunding\(\{ url: "\/api\/solana\/claims\/confirm", body: confirmation\(submitted\), wallet: payer, transaction: submitted \}\);/);
    assert.match(app, /void retryUnrecordedFundings\(wallet, /);
    assert.match(vault, /setFunding\(\(current\) => current\?\.status === "pending" \? \{ \.\.\.current, status: "verification_failed" \} : current\);/, "a wait that ends without an answer offers to record again");
  });
});

describe("WCAG A/AA checks from the 2026-10-06 axe scan", () => {
  it("names controls by their visible words, lets keyboards scroll every region, and keeps the reload link readable", async () => {
    const [app, docs, tokens, solana, listStyles] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/DocsPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/StockTokenList.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/SolanaStockBoard.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/stock-token-list.css", import.meta.url), "utf8"),
    ]);
    assert.match(app, /aria-label=\{wallet && !walletVerifying && !privyOpening \? `\$\{walletButtonText\}: manage connected identities` : walletButtonText\}/);
    assert.match(app, /<div className="chat-stage" ref=\{chatStageRef\} tabIndex=\{0\} role="region" aria-label="Payment conversation">/);
    assert.equal(docs.match(/<table className="docs-table" tabIndex=\{0\}>/g)?.length, docs.match(/<table /g)?.length, "every docs table scrolls from the keyboard on a phone");
    for (const board of [tokens, solana]) assert.doesNotMatch(board, /aria-label=\{`Send \$\{/, "a row is named by the words it shows");
    assert.match(listStyles, /\.stock-empty button \{[^}]*color: var\(--accent-text\)/);
  });
});
