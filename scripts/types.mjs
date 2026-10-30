/**
 * Normalize emitted declaration imports for the published ESM package.
 *
 * `tsc` keeps the source specifiers (`./usage` or `./usage.ts`), but consumers
 * resolve the sibling `.d.ts` files from explicit `.js` paths. This mirrors the
 * extension rewrite `build.mjs` applies to the JavaScript output.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");

function withJsExtensions(code) {
  return code.replace(
    /(from\s+["'])(\.\.?\/[^"']+?)(["'])/g,
    (match, prefix, specifier, suffix) =>
      /\.(?:js|mjs|cjs|json)$/.test(specifier) ? match : `${prefix}${specifier.replace(/\.tsx?$/, "")}.js${suffix}`,
  );
}

async function visit(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(fullPath);
    } else if (entry.name.endsWith(".d.ts")) {
      const code = await fs.readFile(fullPath, "utf8");
      await fs.writeFile(fullPath, withJsExtensions(code));
    }
  }
}

await visit(distDir);
console.log("normalized declaration imports");
