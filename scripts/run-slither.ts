import { spawn } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { resolveFoundryBinary } from "./foundry-binary";

const forgeDirectory = dirname(resolveFoundryBinary("forge"));
const child = spawn("pipx", [
  "run",
  "--spec",
  "slither-analyzer==0.11.6",
  "slither",
  ".",
  "--compile-force-framework",
  "foundry",
  "--exclude-dependencies",
  "--filter-paths",
  "foundry-test|tests/fixtures",
  "--fail-medium",
], {
  env: { ...process.env, PATH: `${forgeDirectory}${delimiter}${process.env.PATH ?? ""}` },
  stdio: "inherit",
});

await new Promise<void>((resolveChild, rejectChild) => {
  child.once("error", rejectChild);
  child.once("exit", (code, signal) => {
    if (signal) {
      rejectChild(new Error(`Slither terminated by signal ${signal}`));
      return;
    }
    process.exitCode = code ?? 1;
    resolveChild();
  });
});
