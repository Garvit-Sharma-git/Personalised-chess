#!/usr/bin/env node
/**
 * The `stockfish` package ships every build variant (~249 MB), but the server
 * only ever runs one of them. Deleting the rest keeps deploys small and fast,
 * which matters on hosts with tight build limits.
 *
 * Usage: node scripts/prune-engine.js [--dry-run]
 * Keeps the variant named by STOCKFISH_VARIANT (default "lite").
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dryRun = process.argv.includes("--dry-run");

const VARIANT_SUFFIX = {
  full: "",
  lite: "-lite",
  single: "-single",
  "lite-single": "-lite-single",
  "single-lite": "-lite-single",
  asm: "-asm",
};

const variant = process.env.STOCKFISH_VARIANT || "lite";
const suffix = VARIANT_SUFFIX[variant];
if (suffix === undefined) {
  console.error(`Unknown STOCKFISH_VARIANT "${variant}"; expected one of ${Object.keys(VARIANT_SUFFIX).join(", ")}`);
  process.exit(1);
}

let binDir;
try {
  const pkgPath = require.resolve("stockfish/package.json");
  binDir = path.join(path.dirname(pkgPath), "bin");
} catch {
  console.log("[prune-engine] stockfish is not installed; nothing to do");
  process.exit(0);
}
if (!fs.existsSync(binDir)) {
  console.log("[prune-engine] no bin directory; nothing to do");
  process.exit(0);
}

const version = JSON.parse(fs.readFileSync(require.resolve("stockfish/package.json"), "utf8")).buildVersion;
const keep = new Set([`stockfish-${version}${suffix}.js`, `stockfish-${version}${suffix}.wasm`]);

const missing = [...keep].filter((f) => !fs.existsSync(path.join(binDir, f)));
if (missing.length) {
  console.error(`[prune-engine] refusing to prune: the "${variant}" build is incomplete (${missing.join(", ")})`);
  process.exit(1);
}

let freed = 0;
const removed = [];
for (const entry of fs.readdirSync(binDir)) {
  if (keep.has(entry)) continue;
  const full = path.join(binDir, entry);
  const stat = fs.lstatSync(full);
  // Symlinks (stockfish.js / stockfish.wasm) point at the full build we are
  // removing, so they go too; the engine resolves the variant by name.
  freed += stat.isSymbolicLink() ? 0 : stat.size;
  removed.push(entry);
  if (!dryRun) fs.rmSync(full, { force: true });
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `[prune-engine] ${dryRun ? "would remove" : "removed"} ${removed.length} file(s), freeing ${mb(freed)}; kept the "${variant}" build`
);
