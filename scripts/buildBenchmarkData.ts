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
import {
  AA_MAX_PAGES,
  aaModelsPageURL,
  combineAAPages,
  normalizeAAResponse,
  parseAAPage,
  type AAPage,
} from "../src/artificialAnalysis.js";
import type { BenchmarkSnapshot } from "../src/benchmarkTypes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "src", "data");
const snapshotPath = join(dataDir, "artificialAnalysis.snapshot.json");

interface BindingSpec {
  providerID: string;
  modelID: string;
  variant: string | null;
  slug: string;
  // Stable Artificial Analysis record for a model newer than the bundled
  // snapshot, taken from its public model page. Used only while the slug is
  // missing from the snapshot (the binding then resolves after the next
  // refresh); once present, the snapshot id must equal it.
  pinned?: { aaModelID: string; name: string };
}

// Claude Fable 5.2 (the default advisor) was published after the bundled
// snapshot. IDs and names from https://artificialanalysis.ai/models/claude-fable-5-2.
const FABLE_5_2_RECORDS: Record<string, { aaModelID: string; name: string }> = {
  "claude-fable-5-2": {
    aaModelID: "593f2d23-247b-41c9-a679-cebd225f0a9a",
    name: "Claude Fable 5.2 (Max, Default Fallback)",
  },
  "claude-fable-5-2-xhigh": {
    aaModelID: "76942526-cc96-46b0-bc27-29561c53ed70",
    name: "Claude Fable 5.2 (Xhigh, Default Fallback)",
  },
  "claude-fable-5-2-high": {
    aaModelID: "fdc1913b-9497-45ef-83f7-17dae756f37e",
    name: "Claude Fable 5.2 (High, Default Fallback)",
  },
  "claude-fable-5-2-medium": {
    aaModelID: "0c9b4e05-9259-42cc-b40e-d6acbbeaa7e8",
    name: "Claude Fable 5.2 (Medium, Default Fallback)",
  },
  "claude-fable-5-2-low": {
    aaModelID: "cfc7acb1-d903-4858-9b6c-6c7776caf8f9",
    name: "Claude Fable 5.2 (Low, Default Fallback)",
  },
};

// Advisor model bindings for every effort, direct and via the opencode
// gateway fallback route. The unset variant follows the max entry.
function fable52Bindings(): BindingSpec[] {
  const efforts: Array<[string | null, string]> = [
    ["max", "claude-fable-5-2"],
    ["xhigh", "claude-fable-5-2-xhigh"],
    ["high", "claude-fable-5-2-high"],
    ["medium", "claude-fable-5-2-medium"],
    ["low", "claude-fable-5-2-low"],
    [null, "claude-fable-5-2"],
  ];
  return ["anthropic", "opencode"].flatMap((providerID) =>
    efforts.map(([variant, slug]) => ({
      providerID,
      modelID: "claude-fable-5-2",
      variant,
      slug,
      pinned: FABLE_5_2_RECORDS[slug],
    })),
  );
}

// Curated baseline bindings. Slugs come from the Artificial Analysis
// models endpoint; a per-effort slug (for example `-xhigh`) is used
// whenever the source publishes one, so evaluated effort stays honest.
const BINDINGS: BindingSpec[] = [
  ...fable52Bindings(),
  // Anthropic family.
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
    variant: "medium",
    slug: "claude-fable-5-1-medium",
  },
  {
    providerID: "anthropic",
    modelID: "claude-fable-5-1",
    variant: "low",
    slug: "claude-fable-5-1-low",
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
  // Opus 5.5 (the previous advisor), direct and via the opencode gateway.
  {
    providerID: "anthropic",
    modelID: "claude-opus-5-5",
    variant: "max",
    slug: "claude-opus-5-5",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-5-5",
    variant: "xhigh",
    slug: "claude-opus-5-5-xhigh",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-5-5",
    variant: "high",
    slug: "claude-opus-5-5-high",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-5-5",
    variant: "medium",
    slug: "claude-opus-5-5-medium",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-5-5",
    variant: "low",
    slug: "claude-opus-5-5-low",
  },
  {
    providerID: "anthropic",
    modelID: "claude-opus-5-5",
    variant: null,
    slug: "claude-opus-5-5",
  },
  {
    providerID: "opencode",
    modelID: "claude-opus-5-5",
    variant: "max",
    slug: "claude-opus-5-5",
  },
  {
    providerID: "opencode",
    modelID: "claude-opus-5-5",
    variant: "xhigh",
    slug: "claude-opus-5-5-xhigh",
  },
  {
    providerID: "opencode",
    modelID: "claude-opus-5-5",
    variant: "high",
    slug: "claude-opus-5-5-high",
  },
  {
    providerID: "opencode",
    modelID: "claude-opus-5-5",
    variant: "medium",
    slug: "claude-opus-5-5-medium",
  },
  {
    providerID: "opencode",
    modelID: "claude-opus-5-5",
    variant: "low",
    slug: "claude-opus-5-5-low",
  },
  {
    providerID: "opencode",
    modelID: "claude-opus-5-5",
    variant: null,
    slug: "claude-opus-5-5",
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
  {
    providerID: "openai",
    modelID: "gpt-6-astra",
    variant: "medium",
    slug: "gpt-6-astra-medium",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-astra",
    variant: "low",
    slug: "gpt-6-astra-low",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-sol",
    variant: null,
    slug: "gpt-6-sol",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-sol",
    variant: "max",
    slug: "gpt-6-sol",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-sol",
    variant: "xhigh",
    slug: "gpt-6-sol-xhigh",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-sol",
    variant: "high",
    slug: "gpt-6-sol-high",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-sol",
    variant: "medium",
    slug: "gpt-6-sol-medium",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-sol",
    variant: "low",
    slug: "gpt-6-sol-low",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-luna",
    variant: null,
    slug: "gpt-6-luna",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-luna",
    variant: "max",
    slug: "gpt-6-luna",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-luna",
    variant: "xhigh",
    slug: "gpt-6-luna-xhigh",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-luna",
    variant: "high",
    slug: "gpt-6-luna-high",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-luna",
    variant: "medium",
    slug: "gpt-6-luna-medium",
  },
  {
    providerID: "openai",
    modelID: "gpt-6-luna",
    variant: "low",
    slug: "gpt-6-luna-low",
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
  {
    providerID: "meta",
    modelID: "muse-spark-1.2",
    variant: "xhigh",
    slug: "muse-spark-1-2",
  },
  {
    providerID: "meta",
    modelID: "muse-spark-1.2",
    variant: null,
    slug: "muse-spark-1-2",
  },
  {
    providerID: "opencode",
    modelID: "muse-spark-1.2",
    variant: "xhigh",
    slug: "muse-spark-1-2",
  },
  {
    providerID: "opencode",
    modelID: "muse-spark-1.2",
    variant: null,
    slug: "muse-spark-1-2",
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
  // Grok 4.7: the base entry is evaluated at xhigh, with a separate high
  // entry. There is no max entry; the null variant follows the base.
  { providerID: "xai", modelID: "grok-4.7", variant: null, slug: "grok-4-7" },
  {
    providerID: "xai",
    modelID: "grok-4.7",
    variant: "xhigh",
    slug: "grok-4-7",
  },
  {
    providerID: "xai",
    modelID: "grok-4.7",
    variant: "high",
    slug: "grok-4-7-high",
  },
  // DeepSeek. The official route mirrors the dotted model ID; heavily used
  // gateway routes get explicit bindings so matching works with the default
  // provider-strict policy (the opt-in cross-provider fallback covers the
  // rest).
  {
    providerID: "deepseek",
    modelID: "deepseek-v4.1-flash",
    variant: "max",
    slug: "deepseek-v4-1-flash",
  },
  {
    providerID: "deepseek",
    modelID: "deepseek-v4.1-flash",
    variant: null,
    slug: "deepseek-v4-1-flash",
  },
  {
    providerID: "opencode-go",
    modelID: "deepseek-v4.1-flash",
    variant: "max",
    slug: "deepseek-v4-1-flash",
  },
  {
    providerID: "opencode-go",
    modelID: "deepseek-v4.1-flash",
    variant: null,
    slug: "deepseek-v4-1-flash",
  },
  {
    providerID: "opencode",
    modelID: "deepseek-v4.1-flash",
    variant: "max",
    slug: "deepseek-v4-1-flash",
  },
  {
    providerID: "opencode",
    modelID: "deepseek-v4.1-flash",
    variant: null,
    slug: "deepseek-v4-1-flash",
  },
  {
    providerID: "vllm",
    modelID: "deepseek-ai/DeepSeek-V4.1-Flash",
    variant: "max",
    slug: "deepseek-v4-1-flash",
  },
  {
    providerID: "vllm",
    modelID: "deepseek-ai/DeepSeek-V4.1-Flash",
    variant: null,
    slug: "deepseek-v4-1-flash",
  },
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
    modelID: "deepseek-v4-pro",
    variant: "high",
    slug: "deepseek-v4-pro-0424-high",
  },
  {
    providerID: "deepseek",
    modelID: "deepseek-v4-flash",
    variant: null,
    slug: "deepseek-v4-flash",
  },
  {
    providerID: "deepseek",
    modelID: "deepseek-v4-flash",
    variant: "max",
    slug: "deepseek-v4-flash",
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
  const signal = AbortSignal.timeout(60_000);
  const pages: AAPage[] = [];
  for (let page = 1; ; page++) {
    if (page > AA_MAX_PAGES) {
      log(`Artificial Analysis reported more than ${AA_MAX_PAGES} pages`);
      process.exit(1);
    }
    const response = await fetch(aaModelsPageURL(page), {
      headers: { "x-api-key": key },
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      log(
        `Artificial Analysis request for page ${page} failed with HTTP ${response.status}`,
      );
      process.exit(1);
    }
    const parsed = parseAAPage(await response.json(), page);
    if ("error" in parsed) {
      log(`Artificial Analysis response rejected: ${parsed.error}`);
      process.exit(1);
    }
    pages.push(parsed);
    if (!parsed.hasMore) break;
  }
  const body = combineAAPages(pages);
  if ("error" in body) {
    log(`Artificial Analysis response rejected: ${body.error}`);
    process.exit(1);
  }
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
  const pending = new Set<string>();
  for (const spec of BINDINGS) {
    const model = bySlug.get(spec.slug);
    if (model && spec.pinned && model.id !== spec.pinned.aaModelID) {
      log(
        `pinned id for ${spec.slug} (${spec.pinned.aaModelID}) differs from the snapshot (${model.id})`,
      );
      process.exit(1);
    }
    const record = model
      ? { id: model.id, name: model.name }
      : spec.pinned
        ? { id: spec.pinned.aaModelID, name: spec.pinned.name }
        : null;
    if (!record) {
      missing.push(spec.slug);
      continue;
    }
    if (!model) pending.add(spec.slug);
    bindings.push({
      providerID: spec.providerID,
      modelID: spec.modelID,
      variant: spec.variant,
      aaModelID: record.id,
      evaluatedEffort: evaluatedEffortFromName(record.name),
      evidenceURL: `https://artificialanalysis.ai/models/${spec.slug}`,
    });
  }
  if (missing.length > 0) {
    log(`mapping slugs missing from the snapshot: ${missing.join(", ")}`);
    log("refresh the snapshot or drop the stale binding specs, then retry");
    process.exit(1);
  }
  if (pending.size > 0) {
    log(
      `pinned bindings awaiting a snapshot refresh: ${[...pending].join(", ")}`,
    );
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
