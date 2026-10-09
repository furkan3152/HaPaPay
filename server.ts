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
