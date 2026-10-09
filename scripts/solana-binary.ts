import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

type SolanaTool = "solana-test-validator" | "cargo-build-sbf";

/**
 * Where a Solana tool lives: `SOLANA_BIN_DIR`, then `PATH`, then the Agave installer's default
 * (`~/.local/share/solana/install/active_release/bin`). Undefined when it is not installed, so tests that need a
 * local validator can skip with a reason instead of failing.
 */
export function resolveSolanaBinary(tool: SolanaTool): string | undefined {
  const directories = [
    process.env.SOLANA_BIN_DIR,
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local/share/solana/install/active_release/bin"),
  ].filter((value): value is string => Boolean(value));
  for (const directory of directories) {
    const candidate = join(directory, tool);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
