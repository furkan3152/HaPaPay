import { access, cp, mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));

export async function stageVercelAssets(source: string, target: string) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "favicon.svg") continue; // Keep the authored public asset.
    await cp(join(source, entry.name), join(target, entry.name), { recursive: entry.isDirectory(), force: true });
  }
}

export async function verifyReferencedVercelAssets(indexPath: string, staticRoot: string) {
  const html = await readFile(indexPath, "utf8");
  const references = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"'#?]+)(?:[?#][^"']*)?["']/gu)]
    .map((match) => match[1]);
  if (references.length === 0) throw new Error("The Vercel HTML shell references no local assets.");
  for (const reference of new Set(references)) {
    const assetPath = resolve(staticRoot, `.${reference}`);
    const relativeAsset = relative(resolve(staticRoot), assetPath);
    if (relativeAsset.startsWith("..") || relativeAsset === "") {
      throw new Error(`Unsafe referenced Vercel asset path: ${reference}`);
    }
    try {
      await access(assetPath);
    } catch {
      throw new Error(`Missing referenced Vercel asset: ${reference}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageVercelAssets(dist, publicRoot);
  console.log(`Staged Vite output from ${dist} into ${publicRoot} for Vercel's public/** CDN.`);
}
