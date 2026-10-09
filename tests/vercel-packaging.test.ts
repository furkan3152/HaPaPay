import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { stageVercelAssets, verifyReferencedVercelAssets } from "../scripts/build-vercel";
import { CONNECT_SOURCES, FRAME_SOURCES, PRIVY_FRAMES } from "../server/app";

describe("Vercel packaging seam", () => {
  it("pins the deploy runtime and root lock metadata to Node 24 with an explicit build command", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
    assert.equal(manifest.engines?.node, "24.x");
    assert.equal(lock.packages?.[""]?.engines?.node, manifest.engines.node);
    assert.equal(manifest.scripts?.["build:vercel"], "npm run build && tsx scripts/build-vercel.ts");
    assert.match(manifest.scripts?.["deploy:vercel:production"] ?? "", /build:vercel.*vercel@59\.16\.0 build --prod.*package node@24 -- npm ci.*HAPAPAY_VERIFY_VERCEL_OUTPUT=1 npm test.*vercel@59\.16\.0 deploy --prebuilt --prod/u);
  });

  it("routes only non-API navigation to the SPA and disables API caching", async () => {
    const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.equal(config.buildCommand, "npm run build:vercel");
    assert.equal(config.framework, "express");
    assert.deepEqual(config.regions, ["fra1"]);
    // A plain Git build of main has no staged public/** files, so a push to main must never deploy to production itself.
    assert.deepEqual(config.git, { deploymentEnabled: { main: false } });
    assert.ok(config.rewrites.some((rewrite: { source: string; destination: string }) => rewrite.destination === "/index.html" && rewrite.source.includes("?!api")));
    assert.ok(config.headers.some((rule: { source: string; headers: Array<{ key: string; value: string }> }) => rule.source.startsWith("/api") && rule.headers.some((header) => header.key === "Cache-Control" && header.value === "no-store")));
    const fallback = new RegExp(`^${config.rewrites[0].source}$`);
    assert.equal(fallback.test("/pay/x/nora"), true);
    assert.equal(fallback.test("/api/health"), false);
    assert.equal(fallback.test("/assets/nope.js"), false);
  });

  it("keeps the terminal root route limited to GET/HEAD with complete non-cacheable security headers", async () => {
    const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
    const root = config.routes.find((route: { src?: string }) => route.src === "^/$");
    assert.equal(root.dest, "/index.html");
    assert.deepEqual(root.methods, ["GET", "HEAD"]);
    assert.notEqual(root.continue, true);
    const globalHeaders = config.headers.find((rule: { source: string }) => rule.source === "/(.*)").headers;
    const securityHeaders = Object.fromEntries(globalHeaders.map((header: { key: string; value: string }) => [header.key, header.value]));
    assert.deepEqual(Object.keys(securityHeaders).sort(), ["Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options"]);
    assert.deepEqual(root.headers, { ...securityHeaders, "Cache-Control": "no-store" });
    // The pages come from the CDN with these headers, not from Express: Telegram's login popup may answer through
    // oauth.telegram.org, and no string is ever evaluated as script.
    // Privy's sign-in (one login for an EVM and a Solana wallet) adds its frames, its bot check and the wallet relays;
    // the lists are the server's own, so the CDN's pages and the API answer with the same policy.
    const directives = new Map<string, string>(securityHeaders["Content-Security-Policy"].split("; ").map((directive: string) => {
      const [name, ...values] = directive.split(" ");
      return [name, values.join(" ")] as [string, string];
    }));
    assert.equal(directives.get("connect-src"), CONNECT_SOURCES.join(" "));
    assert.equal(directives.get("frame-src"), FRAME_SOURCES.join(" "));
    assert.equal(directives.get("child-src"), PRIVY_FRAMES.join(" "));
    assert.equal(directives.get("script-src"), "'self' https://telegram.org https://challenges.cloudflare.com");
    assert.equal(directives.get("frame-ancestors"), "'none'");
    // As the server's own policy has them (audit, 2026-10-06): no injected <base>, form target or inline handler.
    assert.equal(directives.get("base-uri"), "'self'");
    assert.equal(directives.get("form-action"), "'self'");
    assert.equal(directives.get("script-src-attr"), "'none'");
    assert.doesNotMatch(securityHeaders["Content-Security-Policy"], /unsafe-eval/);
    // The security headers cover every path, with or without a trailing slash ("/app/" opens the desk too).
    const everyPath = new RegExp(`^${config.headers.find((rule: { source: string }) => rule.source === "/(.*)").source}$`);
    for (const path of ["/", "/app", "/app/", "/docs/", "/docs/vault/", "/pay/x/nora/", "/api/health"]) assert.equal(everyPath.test(path), true, path);
    const matchesRoot = new RegExp(root.src);
    assert.equal(matchesRoot.test("/"), true);
    for (const path of ["/identity", "/api", "/api/health", "/assets/nope.js", "/favicon.svg"]) {
      assert.equal(matchesRoot.test(path), false);
    }
  });

  it("routes GET/HEAD root to the CDN before the Function filesystem match in actual Vercel output", {
    skip: process.env.HAPAPAY_VERIFY_VERCEL_OUTPUT !== "1",
  }, async () => {
    // Run after `vercel build --prod`; a source-regex assertion cannot prove
    // where the deployed router places a rewrite relative to index.func.
    const output = JSON.parse(await readFile(new URL("../.vercel/output/config.json", import.meta.url), "utf8"));
    const routes: Array<{
      src?: string; dest?: string; handle?: string; methods?: string[];
      headers?: Record<string, string>; continue?: boolean;
    }> = output.routes;
    const filesystem = routes.findIndex((route) => route.handle === "filesystem");
    const root = routes.findIndex((route) => route.src === "^/$" && route.dest === "/index.html");
    assert.ok(root >= 0 && root < filesystem, "The exact root CDN route must precede the Function filesystem match.");
    assert.deepEqual(routes[root].methods, ["GET", "HEAD"]);
    assert.notEqual(routes[root].continue, true);
    const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
    const globalHeaders = config.headers.find((rule: { source: string }) => rule.source === "/(.*)").headers;
    const securityHeaders = Object.fromEntries(globalHeaders.map((header: { key: string; value: string }) => [header.key, header.value]));
    assert.deepEqual(routes[root].headers, { ...securityHeaders, "Cache-Control": "no-store" });

    const fallback = routes.find((route, index) => index > filesystem && route.dest === "/index.html");
    assert.ok(fallback?.src, "The post-filesystem SPA fallback must remain available.");
    const matchesFallback = new RegExp(fallback.src);
    assert.equal(matchesFallback.test("/identity"), true);
    assert.equal(matchesFallback.test("/api/health"), false);
    assert.equal(matchesFallback.test("/assets/nope.js"), false);
    assert.ok(routes.some((route) => route.headers?.["Cache-Control"] === "no-store"
      && route.src && new RegExp(route.src).test("/api/health")));
    assert.ok((await stat(new URL("../.vercel/output/static/index.html", import.meta.url))).isFile());
    assert.ok((await stat(new URL("../.vercel/output/functions/index.func", import.meta.url))).isDirectory());
    await verifyReferencedVercelAssets(
      fileURLToPath(new URL("../.vercel/output/static/index.html", import.meta.url)),
      fileURLToPath(new URL("../.vercel/output/static", import.meta.url)),
    );
  });

  it("rejects a Vercel artifact whose HTML references a missing hashed asset", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "hapapay-vercel-output-"));
    try {
      await mkdir(join(fixture, "assets"));
      const indexPath = join(fixture, "index.html");
      await writeFile(indexPath, '<link rel="stylesheet" href="/assets/app.css"><script src="/assets/missing.js"></script>');
      await writeFile(join(fixture, "assets", "app.css"), "body {}");
      await assert.rejects(
        verifyReferencedVercelAssets(indexPath, fixture),
        /missing referenced Vercel asset.*missing\.js/iu,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("keeps the authored favicon while staging the built shell and assets", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "hapapay-vercel-stage-"));
    const dist = join(fixture, "dist");
    const publicRoot = join(fixture, "public");
    try {
      await mkdir(join(dist, "assets"), { recursive: true });
      await mkdir(publicRoot);
      await writeFile(join(dist, "index.html"), '<script src="/assets/demo.js"></script>');
      await writeFile(join(dist, "assets", "demo.js"), "console.log('built')");
      await writeFile(join(dist, "favicon.svg"), "generated copy");
      await writeFile(join(publicRoot, "favicon.svg"), "authored favicon");
      await stageVercelAssets(dist, publicRoot);
      assert.match(await readFile(join(publicRoot, "index.html"), "utf8"), /assets\/demo.js/);
      assert.equal(await readFile(join(publicRoot, "favicon.svg"), "utf8"), "authored favicon");
      assert.ok((await stat(join(publicRoot, "assets", "demo.js"))).isFile());
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
