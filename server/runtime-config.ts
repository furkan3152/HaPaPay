import { BlockList, isIP } from "node:net";

const DEVELOPMENT_SESSION_SECRET = "development-only-session-secret-change-me";

export function readAppOrigin(environment: {
  NODE_ENV?: string;
  APP_URL?: string;
  APP_DOMAIN?: string;
}) {
  if (environment.NODE_ENV !== "production") {
    return { url: environment.APP_URL ?? "http://localhost:5173", domain: environment.APP_DOMAIN ?? "localhost" };
  }
  if (!environment.APP_URL) throw new Error("APP_URL is required in production.");
  let url: URL;
  try { url = new URL(environment.APP_URL); } catch { throw new Error("APP_URL must be an absolute HTTPS URL in production."); }
  if (url.protocol !== "https:") throw new Error("APP_URL must use HTTPS in production.");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port) {
    throw new Error("APP_URL must be a bare HTTPS origin in production.");
  }
  if (!environment.APP_DOMAIN || environment.APP_DOMAIN !== url.hostname) {
    throw new Error("APP_DOMAIN must match the APP_URL hostname in production.");
  }
  return { url: url.origin, domain: environment.APP_DOMAIN };
}

/**
 * A session secret anyone can read in this repository: the development default or the template's placeholder. Sessions
 * signed with one could be forged by anybody, so production refuses them and readiness reports them as missing.
 */
export function isPublishedSessionSecret(value: string | undefined) {
  const secret = value?.trim() ?? "";
  return secret === DEVELOPMENT_SESSION_SECRET || secret.startsWith("replace-with-");
}

export function readSessionSecret(environment: {
  NODE_ENV?: string;
  SESSION_SECRET?: string;
}) {
  if (environment.NODE_ENV === "production") {
    if (!environment.SESSION_SECRET) throw new Error("SESSION_SECRET is required in production.");
    if (isPublishedSessionSecret(environment.SESSION_SECRET)) {
      throw new Error("SESSION_SECRET is a published example value; generate your own (openssl rand -hex 32).");
    }
  }
  return environment.SESSION_SECRET || DEVELOPMENT_SESSION_SECRET;
}

const TRUST_PROXY_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);
/** IPv4-mapped IPv6 addresses (::ffff:0:0/96) however they are written: Express matches IPv4 clients against them. */
const IPV4_MAPPED = new BlockList();
IPV4_MAPPED.addSubnet("::ffff:0:0", 96, "ipv6");

/**
 * Which proxies in front of a self-hosted server to trust for the client's address (Express's `trust proxy`): a hop
 * count, or the proxies' addresses, CIDR ranges or presets, comma-separated. Rate limits count clients by that address,
 * so behind a reverse proxy without it every client shares one limit. `true` would believe any client's
 * X-Forwarded-For and is refused. Unset or empty: no proxy is trusted.
 */
export function readTrustProxy(environment: { TRUST_PROXY?: string }) {
  const value = environment.TRUST_PROXY?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > 10) throw new Error("TRUST_PROXY must count between 1 and 10 proxies.");
    return hops;
  }
  const entries = value.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const [address, prefix, ...rest] = entry.split("/");
    // A range broader than a /8 (IPv4, however an IPv4-mapped range is written) or a /16 (IPv6) is refused: it would
    // believe nearly anyone's X-Forwarded-For, as `true` would. The presets cover the wider private ranges.
    const v6 = isIP(address ?? "") === 6;
    const floor = v6 ? (IPV4_MAPPED.check(address, "ipv6") ? 104 : 16) : 8;
    const validPrefix = prefix === undefined
      || (/^\d{1,3}$/.test(prefix) && Number(prefix) >= floor && Number(prefix) <= (v6 ? 128 : 32));
    if (TRUST_PROXY_PRESETS.has(entry) || (isIP(address ?? "") && validPrefix && !rest.length)) continue;
    throw new Error("TRUST_PROXY must be a hop count (1-10) or the proxies' addresses: IPs, CIDR ranges no broader than /8 "
      + "(IPv4) or /16 (IPv6), or loopback, linklocal and uniquelocal; never true.");
  }
  return entries.join(",");
}

export function readFarcasterRpcUrl(environment: {
  NODE_ENV?: string;
  FARCASTER_OPTIMISM_RPC_URL?: string;
}) {
  if (environment.NODE_ENV === "production" && !environment.FARCASTER_OPTIMISM_RPC_URL) {
    throw new Error("FARCASTER_OPTIMISM_RPC_URL is required in production.");
  }
  return environment.FARCASTER_OPTIMISM_RPC_URL || undefined;
}

export function readDatabaseUrl(environment: {
  NODE_ENV?: string;
  DATABASE_URL?: string;
}) {
  if (environment.NODE_ENV === "production" && !environment.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production.");
  }
  return environment.DATABASE_URL || undefined;
}
