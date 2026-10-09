import { createDatabasePool, migrateDatabase, verifyDatabaseSchema } from "../server/database";
import { migrateViaNeonHttp, NeonHttpMigrationError, parseMigrationArguments } from "./neon-http-migration";
import { loadEnvironmentFile } from "../server/environment";
import { readDatabaseUrl } from "../server/runtime-config";

async function main() {
  const options = parseMigrationArguments(process.argv.slice(2));
  loadEnvironmentFile();
  const databaseUrl = readDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: process.env.DATABASE_URL })!;
  if (options.transport === "neon-http") {
    await migrateViaNeonHttp(databaseUrl, options);
  } else {
    const pool = createDatabasePool(databaseUrl);
    try {
      if (!options.checkOnly) await migrateDatabase(pool);
      await verifyDatabaseSchema(pool);
    } finally {
      await pool.end();
    }
  }
  console.log(options.checkOnly ? "HaPaPay PostgreSQL schema verification completed." : "HaPaPay PostgreSQL migrations and schema verification completed.");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof NeonHttpMigrationError ? error.message : "Database migration failed. Check configuration and schema read-only.");
  process.exitCode = 1;
}
