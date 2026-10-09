import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import ts from "typescript";

it("type-checks the Vercel entrypoint and contract reads with the nearest tsconfig", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entrypoint = resolve(root, "server.ts");
  const configPath = ts.findConfigFile(dirname(entrypoint), ts.sys.fileExists);
  assert.ok(configPath);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);

  // @vercel/node resolves the entrypoint's nearest config, not tsc -b's
  // referenced projects. Its missing-module fallback also disables strict mode.
  const compilerOptions = { ...config.config.compilerOptions };
  compilerOptions.target ??= "ES2021";
  compilerOptions.esModuleInterop ??= true;
  if (compilerOptions.module === undefined) {
    compilerOptions.module = "NodeNext";
    compilerOptions.moduleResolution = "NodeNext";
    compilerOptions.strict = false;
  }
  const parsed = ts.parseJsonConfigFileContent(
    { ...config.config, compilerOptions }, ts.sys, dirname(configPath),
  );
  const tracedFiles = [entrypoint, resolve(root, "server/index.ts")];
  const program = ts.createProgram(tracedFiles, { ...parsed.options, noEmit: true });
  const diagnostics = tracedFiles.flatMap((path) => {
    const source = program.getSourceFile(path);
    assert.ok(source);
    return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  });
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: (path) => path,
    getNewLine: () => "\n",
  }));
});
