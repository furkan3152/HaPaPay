import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { bootApplication } from "./server/index.js";

const app = express();
let pending: ReturnType<typeof bootApplication> | undefined;

function ready() {
  pending ??= bootApplication("vercel").catch((error) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

/**
 * The desk itself. Current Vercel builds collect public/** before the build command runs, so the Vite output staged
 * there never reaches the CDN; the function bundle carries dist/ instead, and the pages are served from it here.
 * Assets have content-hashed names and are cached for good; every page is the one index.html (headers from vercel.json
 * still apply). /api never reaches these handlers.
 */
const webRoot = [fileURLToPath(new URL("./dist/", import.meta.url)), join(process.cwd(), "dist")].find((path) => existsSync(join(path, "index.html")));
if (webRoot) {
  app.use("/assets", express.static(join(webRoot, "assets"), { immutable: true, maxAge: "365d", index: false, fallthrough: false }));
  app.use(express.static(webRoot, { index: false, maxAge: 0 }));
  app.get(/^\/(?!api(?:\/|$)).*/, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(join(webRoot, "index.html"));
  });
}

app.use(async (request, response, next) => {
  try {
    if (process.env.NODE_ENV !== "production") throw new Error("Vercel runtime requires production configuration.");
    const initialized = await ready();
    initialized.app(request, response, next);
  } catch {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.status(503).json({ error: "Service temporarily unavailable." });
  }
});

export default app;
