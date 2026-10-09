import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

it("loads emitted Vercel ESM with plain Node and serves a non-cacheable bootstrap failure", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const fixture = await mkdtemp(join(tmpdir(), "hapapay-vercel-esm-"));
  try {
    // Emit real application modules without rewriting their import specifiers,
    // matching Vercel's per-file TypeScript output rather than tsx's resolver.
    const files = ["server.ts"];
    for (const directory of ["server", "src/domain"]) {
      files.push(...(await readdir(join(root, directory)))
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
        .map((file) => join(directory, file)));
    }
    for (const file of files) {
      const output = ts.transpileModule(await readFile(join(root, file), "utf8"), {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      const target = join(fixture, file.replace(/\.ts$/, ".js"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, output);
    }
    await writeFile(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");

    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { createServer } from "node:http";
      const { default: app } = await import("./server.js");
      const { bootApplication } = await import("./server/index.js");
      assert.equal(typeof app, "function");
      assert.equal(typeof bootApplication, "function");
      const server = createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/health");
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.deepEqual(await response.json(), { error: "Service temporarily unavailable." });
        console.log("native-esm-bootstrap-ok");
      } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    `], {
      cwd: fixture,
      // No NODE_OPTIONS, inherited tsx registration, credentials, or .env files.
      env: { NODE_ENV: "production", APP_URL: "" },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "native-esm-bootstrap-ok");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
