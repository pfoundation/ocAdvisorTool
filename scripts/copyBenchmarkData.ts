// Copies bundled benchmark data into dist/. The TypeScript compiler does
// not emit JSON assets, so the build runs this step explicitly after tsc.
import { mkdirSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "data");
const to = join(root, "dist", "data");

// Progress goes to stderr: publish and CI flows parse `npm pack --json`
// from stdout, and any stray stdout text breaks that JSON.
function log(message: string): void {
  console.error(message);
}

if (!existsSync(from)) {
  log("copyBenchmarkData: no src/data directory, nothing to copy");
  process.exit(0);
}

mkdirSync(to, { recursive: true });
const copied: string[] = [];
for (const name of readdirSync(from)) {
  if (!name.endsWith(".json")) continue;
  copyFileSync(join(from, name), join(to, name));
  copied.push(name);
}
log(
  `copyBenchmarkData: copied ${copied.length} file(s): ${copied.join(", ") || "none"}`,
);
