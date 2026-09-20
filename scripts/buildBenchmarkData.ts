// Generates the bundled Artificial Analysis data used by the advisor gate:
// the validated seed snapshot (when refreshing) and the curated baseline
// model mappings.
//
//   bun scripts/buildBenchmarkData.ts                       # mappings only
//   ARTIFICIAL_ANALYSIS_API_KEY=... bun scripts/buildBenchmarkData.ts --refresh-snapshot
//
// Progress goes to stderr so `npm pack --json` stdout stays parseable.
// The API key is read from the environment, sent only in the x-api-key
// header, and never written anywhere.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAAResponse } from "../src/artificialAnalysis.js";
import type { BenchmarkSnapshot } from "../src/benchmarkTypes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "src", "data");
const snapshotPath = join(dataDir, "artificialAnalysis.snapshot.json");

interface BindingSpec {
  providerID: string;
  modelID: string;
  variant: string | null;
  slug: string;
}

// Curated baseline bindings. Slugs come from the Artificial Analysis
// models endpoint; a per-effort slug (for example `-xhigh`) is used
// whenever the source publishes one, so evaluated effort stays honest.
const BINDINGS: BindingSpec[] = [
  // Anthropic advisor family.
  {
    providerID: "anthropic",
    modelID: "claude-fable-5-1",
    variant: "max",
    slug: "claude-fable-5-1",
  },
  {
    providerID: "anthropic",
    modelID: "claude-fable-5-1",
    variant: "xhigh",
    slug: "claude-fable-5-1-xhigh",
  },
  {
    providerID: "anthropic",
    modelID: "claude-fable-5-1",
    variant: "high",
    slug: "claude-fable-5-1-high",
  },
  {
    providerID: "anthropic",
    modelID: "claude-fable-5-1",
    variant: null,
    slug: "claude-fable-5-1",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-5",
    variant: null,
    slug: "claude-opus-5",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-5",
    variant: "max",
    slug: "claude-opus-5",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-5",
    variant: "xhigh",
    slug: "claude-opus-5-xhigh",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-5",
    variant: "high",
    slug: "claude-opus-5-high",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-4-8",
    variant: null,
    slug: "claude-opus-4-8",
  },
  // OpenAI.
  {
    providerID: "openai",
    modelID: "gpt-6-astra",
    variant: null,
    slug: "gpt-6-astra",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-astra",
    variant: "max",
    slug: "gpt-6-astra",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-astra",
    variant: "xhigh",
    slug: "gpt-6-astra-xhigh",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-astra",
    variant: "high",
    slug: "gpt-6-astra-high",
  },
  // Meta.
  {
    providerID: "meta",
    modelID: "muse-spark-1.3",
    variant: null,
    slug: "muse-spark-1-3",
  },
  {
    providerID: "meta",
    modelID: "muse-spark-1.3",
    variant: "max",
    slug: "muse-spark-1-3",
  },
  {
    providerID: "meta",
    modelID: "muse-spark-1.3",
    variant: "xhigh",
    slug: "muse-spark-1-3-xhigh",
  },
  // xAI.
  { providerID: "xai", modelID: "grok-4.6", variant: null, slug: "grok-4-6" },
  { providerID: "xai", modelID: "grok-4.6", variant: "high", slug: "grok-4-6" },
  {
    providerID: "xai",
    modelID: "grok-4.6",
    variant: "xhigh",
    slug: "grok-4-6-xhigh",
  },
  // DeepSeek.
  {
    providerID: "deepseek",
    modelID: "deepseek-v4-pro",
    variant: null,
    slug: "deepseek-v4-pro",
  },
  {
    providerID: "deepseek",
    modelID: "deepseek-v4-pro",
    variant: "max",
    slug: "deepseek-v4-pro",
  },
  {
    providerID: "deepseek",
    modelID: "deepseek-v4-1-flash",
    variant: null,
    slug: "deepseek-v4-1-flash",
  },
  // Moonshot.
  {
    providerID: "moonshot",
    modelID: "kimi-k3",
    variant: null,
    slug: "kimi-k3",
  },
  // Zhipu.
  { providerID: "zhipu", modelID: "glm-5.3", variant: null, slug: "glm-5-3" },
];

function log(message: string): void {
  console.error(message);
}

function loadSnapshot(): BenchmarkSnapshot {
  const parsed: unknown = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const snapshot = parsed as BenchmarkSnapshot;
  if (!Array.isArray(snapshot.models) || snapshot.models.length === 0) {
    throw new Error(
      `no models in ${snapshotPath}; run with --refresh-snapshot and a key first`,
    );
  }
  return snapshot;
}

// Effort as published in the model name, or null when the source does not
// state one. Never inferred from scores.
function evaluatedEffortFromName(name: string): string | null {
  if (/\bmax\b/i.test(name)) return "max";
  if (/\bxhigh\b/i.test(name)) return "xhigh";
  if (/\bhigh\b/i.test(name)) return "high";
  if (/\bmedium\b/i.test(name)) return "medium";
  if (/\blow\b/i.test(name)) return "low";
  return null;
}

async function refreshSnapshot(): Promise<void> {
  const key = (process.env.ARTIFICIAL_ANALYSIS_API_KEY ?? "").trim();
  if (!key) {
    log("ARTIFICIAL_ANALYSIS_API_KEY is required for --refresh-snapshot");
    process.exit(2);
  }
  const response = await fetch(
    "https://artificialanalysis.ai/api/v2/data/llms/models",
    {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    },
  );
  if (!response.ok) {
    log(`Artificial Analysis request failed with HTTP ${response.status}`);
    process.exit(1);
  }
  const body: unknown = await response.json();
  const snapshot = normalizeAAResponse(body, new Date().toISOString());
  if ("error" in snapshot) {
    log(`Artificial Analysis response rejected: ${snapshot.error}`);
    process.exit(1);
  }
  writeFileSync(
    join(dataDir, "artificialAnalysis.snapshot.json"),
    JSON.stringify(snapshot, null, 2) + "\n",
  );
  log(
    `seed snapshot refreshed: ${snapshot.models.length} models, hash ${snapshot.contentHash}`,
  );
}

function buildMappings(snapshot: BenchmarkSnapshot): void {
  const bySlug = new Map(snapshot.models.map((model) => [model.slug, model]));
  const bindings: Array<Record<string, unknown>> = [];
  const missing: string[] = [];
  for (const spec of BINDINGS) {
    const model = bySlug.get(spec.slug);
    if (!model) {
      missing.push(spec.slug);
      continue;
    }
    bindings.push({
      providerID: spec.providerID,
      modelID: spec.modelID,
      variant: spec.variant,
      aaModelID: model.id,
      evaluatedEffort: evaluatedEffortFromName(model.name),
      evidenceURL: `https://artificialanalysis.ai/models/${model.slug}`,
    });
  }
  if (missing.length > 0) {
    log(`mapping slugs missing from the snapshot: ${missing.join(", ")}`);
  }
  const mappings = { schemaVersion: 1, bindings };
  writeFileSync(
    join(dataDir, "artificialAnalysis.mappings.json"),
    JSON.stringify(mappings, null, 2) + "\n",
  );
  log(`bundled mappings written: ${bindings.length} bindings`);
}

await (async () => {
  if (process.argv.includes("--refresh-snapshot")) {
    await refreshSnapshot();
  }
  buildMappings(loadSnapshot());
})();
