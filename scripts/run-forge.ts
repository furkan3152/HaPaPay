import { spawn } from "node:child_process";
import { resolveFoundryBinary } from "./foundry-binary";

const binaryPath = resolveFoundryBinary("forge");
const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit" });

await new Promise<void>((resolveChild, rejectChild) => {
  child.once("error", rejectChild);
  child.once("exit", (code, signal) => {
    if (signal) {
      rejectChild(new Error(`Forge terminated by signal ${signal}`));
      return;
    }
    process.exitCode = code ?? 1;
    resolveChild();
  });
});
