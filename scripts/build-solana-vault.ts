import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSolanaBinary } from "./solana-binary";

/**
 * Builds the Solana vault program (programs/hapapay-vault) with cargo-build-sbf, copies the build to
 * public/solana/hapapay_vault.so, which the operator page deploys, and pins its size and SHA-256 in
 * src/domain/solana-vault-artifact.ts, which the page and the server both check before they accept a program.
 */
const root = new URL("../", import.meta.url);
const program = fileURLToPath(new URL("programs/hapapay-vault/", root));
const built = fileURLToPath(new URL("programs/hapapay-vault/target/deploy/hapapay_vault.so", root));
const published = fileURLToPath(new URL("public/solana/hapapay_vault.so", root));
const artifact = fileURLToPath(new URL("src/domain/solana-vault-artifact.ts", root));

export function renderSolanaVaultArtifact(bytes: Uint8Array) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return `/**
 * The Solana vault program build the operator page deploys and the server accepts, made by
 * \`npx tsx scripts/build-solana-vault.ts\` from programs/hapapay-vault. The page refuses a download that does not
 * match, and the server registers a program only when its deployed code has exactly these bytes.
 */
export const SOLANA_VAULT_ARTIFACT = {
  path: "/solana/hapapay_vault.so",
  size: ${bytes.length},
  sha256: "${sha256}",
} as const;
`;
}

/** The toolchain the pinned build was made with: another one writes different bytes, and so a different pin. */
export const SOLANA_VAULT_TOOLCHAIN = { cargoBuildSbf: "4.4.0", platformTools: "v1.57" } as const;

/** Refuses a cargo-build-sbf whose `--version` output names another release or another platform-tools. */
export function checkSolanaToolchain(versionOutput: string) {
  const cargo = /cargo-build-sbf (\S+)/.exec(versionOutput)?.[1];
  const tools = /platform-tools (v\S+)/.exec(versionOutput)?.[1];
  if (cargo === SOLANA_VAULT_TOOLCHAIN.cargoBuildSbf && tools === SOLANA_VAULT_TOOLCHAIN.platformTools) return;
  throw new Error(`The pinned vault build needs cargo-build-sbf ${SOLANA_VAULT_TOOLCHAIN.cargoBuildSbf} with platform-tools ${SOLANA_VAULT_TOOLCHAIN.platformTools}; `
    + `this machine has ${cargo ?? "an unknown cargo-build-sbf"} with ${tools ?? "unknown platform-tools"}. Install Agave 4.3.0, whose `
    + "cargo-build-sbf reports those versions. To move to another toolchain on purpose, change SOLANA_VAULT_TOOLCHAIN and the "
    + "versions in CONTRIBUTING.md in the same commit as the new build and its pin.");
}

async function main() {
  const cargoBuildSbf = resolveSolanaBinary("cargo-build-sbf");
  if (!cargoBuildSbf) throw new Error("cargo-build-sbf is not installed. Install the Agave tool suite first.");
  checkSolanaToolchain(spawnSync(cargoBuildSbf, ["--version"], { encoding: "utf8" }).stdout ?? "");
  const result = spawnSync(cargoBuildSbf, ["--manifest-path", `${program}Cargo.toml`], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("cargo-build-sbf failed.");
  await copyFile(built, published);
  const bytes = new Uint8Array(await readFile(published));
  await writeFile(artifact, renderSolanaVaultArtifact(bytes));
  console.log(`Built the vault program: ${bytes.length} bytes, SHA-256 ${createHash("sha256").update(bytes).digest("hex")}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
