import { neon } from "@neondatabase/serverless";
import { migrateDatabase, verifyDatabaseSchema } from "../server/database";

const DEFAULT_TIMEOUT_MS = 15_000;

export class NeonHttpMigrationError extends Error {
  constructor(message: string, readonly commitStatus: "not_submitted" | "unknown" | "acknowledged") {
    super(message);
    this.name = "NeonHttpMigrationError";
  }
}

export async function recordMigrationStatements(): Promise<string[]> {
  const statements: string[] = [];
  await migrateDatabase({
    async query(statement, parameters) {
      if (parameters?.length) throw new Error("Migration recorder accepts fixed SQL without parameters only.");
      statements.push(statement);
      return { rows: [] };
    },
  });
  if (statements.length !== 69) throw new Error("Expected exactly sixty-nine fixed repository migration statements.");
  return statements;
}

export type NeonHttpClient = {
  transaction(statements: string[], signal: AbortSignal): Promise<unknown>;
  query(statement: string, signal: AbortSignal): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export function parseMigrationArguments(arguments_: string[]): { transport: "pg" | "neon-http"; checkOnly: boolean } {
  let transport: "pg" | "neon-http" = "pg";
  let checkOnly = false;
  for (const argument of arguments_) {
    if (argument === "--transport=neon-http") transport = "neon-http";
    else if (argument === "--check-only") checkOnly = true;
    else throw new Error("Unsupported migration option.");
  }
  return { transport, checkOnly };
}

export async function runNeonHttpMigration(client: NeonHttpClient, options: { checkOnly: boolean; timeoutMs?: number }): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new NeonHttpMigrationError("Invalid HTTP migration timeout.", "not_submitted");

  if (!options.checkOnly) {
    const statements = await recordMigrationStatements();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const results = await client.transaction(statements, controller.signal);
      if (!Array.isArray(results) || results.length !== statements.length
        || results.some((result) => !result || !Array.isArray(result.rows))) {
        throw new Error("Incomplete HTTP transaction result.");
      }
    } catch {
      throw new NeonHttpMigrationError("Neon HTTP migration submission failed; commit status UNKNOWN. Check schema read-only before any retry.", "unknown");
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    await verifyDatabaseSchema({
      async query(statement) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await client.query(statement, controller.signal);
        } finally {
          clearTimeout(timer);
        }
      },
    });
  } catch {
    const status = options.checkOnly ? "not_submitted" : "acknowledged";
    throw new NeonHttpMigrationError("Neon HTTP schema verification failed; inspect schema read-only.", status);
  }
}

export async function migrateViaNeonHttp(databaseUrl: string, options: { checkOnly: boolean; timeoutMs?: number }): Promise<void> {
  try {
    const sql = neon(databaseUrl, { fullResults: true });
    await runNeonHttpMigration({
      async transaction(statements, signal) {
        const queries = statements.map((statement) => sql.query(statement, []));
        return sql.transaction(queries, { fullResults: true, fetchOptions: { signal } });
      },
      async query(statement, signal) {
        return sql.query(statement, [], { fullResults: true, fetchOptions: { signal } });
      },
    }, options);
  } catch (error) {
    if (error instanceof NeonHttpMigrationError) throw error;
    throw new NeonHttpMigrationError("Neon HTTP migration setup failed before submission.", "not_submitted");
  }
}
