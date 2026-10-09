import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { Pool } from "pg";

const binDirectory = await findPostgresBinDirectory();
const clusterDirectory = await mkdtemp(join(tmpdir(), "hapapay-postgres-"));
const port = await unusedPort();
let postgres: ChildProcess | undefined;

try {
  await run(join(binDirectory, "initdb"), [
    "-D", clusterDirectory,
    "--auth-local=trust",
    "--auth-host=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);
  postgres = spawn(join(binDirectory, "postgres"), [
    "-D", clusterDirectory,
    "-h", "127.0.0.1",
    "-p", String(port),
    "-k", clusterDirectory,
    "-c", "fsync=off",
    "-c", "synchronous_commit=off",
  ], { stdio: "ignore" });
  const connectionString = `postgresql://127.0.0.1:${port}/postgres`;
  await waitForPostgres(connectionString, postgres);
  await run(process.execPath, ["--import", "tsx", "--test", "tests/postgres-production-smoke.test.ts"], {
    ...process.env,
    REAL_DATABASE_URL: connectionString,
  });
} finally {
  if (postgres && postgres.exitCode === null) {
    postgres.kill("SIGTERM");
    await waitForExit(postgres);
  }
  await rm(clusterDirectory, { recursive: true, force: true });
}

async function findPostgresBinDirectory() {
  const candidates = [
    process.env.POSTGRES_BIN_DIR,
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin",
    "/usr/lib/postgresql/15/bin",
    "/usr/local/bin",
    "/usr/bin",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await Promise.all([access(join(candidate, "initdb")), access(join(candidate, "postgres"))]);
      return candidate;
    } catch {}
  }
  throw new Error("PostgreSQL server binaries were not found. Set POSTGRES_BIN_DIR to run the real-engine smoke test.");
}

async function run(command: string, args: string[], environment = process.env) {
  const child = spawn(command, args, { cwd: process.cwd(), env: environment, stdio: "inherit" });
  const result = await waitForExit(child);
  if (result !== 0) throw new Error(`${command} exited with code ${result}.`);
}

function waitForExit(child: ChildProcess) {
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`Process exited from signal ${signal}.`)) : resolve(code ?? 1));
  });
}

async function waitForPostgres(connectionString: string, server: ChildProcess) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Temporary PostgreSQL exited with code ${server.exitCode}.`);
    const pool = new Pool({ connectionString });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Temporary PostgreSQL did not become ready.");
}

function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing PostgreSQL smoke port."));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
