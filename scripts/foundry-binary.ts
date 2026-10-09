import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

type FoundryTool = "anvil" | "forge";
type PackageMetadata = { bin?: string | Record<string, string> };

const packageSuffixByPlatform: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>> = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-amd64" },
  linux: { arm64: "linux-arm64", x64: "linux-amd64" },
  win32: { x64: "win32-amd64" },
};

export function resolveFoundryBinary(tool: FoundryTool): string {
  const suffix = packageSuffixByPlatform[process.platform]?.[process.arch];
  if (!suffix) throw new Error(`Unsupported Foundry platform: ${process.platform}/${process.arch}`);

  const packageName = `@foundry-rs/${tool}-${suffix}`;
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const metadata = require(packageJsonPath) as PackageMetadata;
  const relativeBinary = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[tool];
  if (!relativeBinary) throw new Error(`${tool} binary is not declared by ${packageName}`);

  return resolve(dirname(packageJsonPath), relativeBinary);
}
