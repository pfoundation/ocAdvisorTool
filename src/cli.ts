#!/usr/bin/env bun
// ocadvisor maintenance CLI: refresh the local Artificial Analysis
// snapshot between plugin releases and inspect what the advisor gate
// sees. Thin adapters over the shared benchmark modules; intentionally
// disconnected from the plugin and the TypeSafe client.
//
// Exit codes: 0 success; 1 update failed, no usable snapshot, or model
// unresolved; 2 usage error.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveBenchmarkPaths,
  type BenchmarkPathOptions,
} from "./benchmarkConfig.js";
import {
  RECOGNIZED_METRICS,
  type BenchmarkValidationError,
} from "./benchmarkTypes.js";
import type { BenchmarkMatch, ModelRef } from "./benchmarkMatch.js";
import { createBenchmarkStore } from "./benchmarkStore.js";
import { AA_API_KEY_ENV, updateBenchmarkSnapshot } from "./benchmarkUpdate.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CliDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

interface ResolvedDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  nowMs: number;
}

function readPackageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(MODULE_DIR, "..", "package.json"), "utf8"),
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {}
  return "unknown";
}

const GLOBAL_HELP = `ocadvisor — benchmark-aware advisor maintenance

Usage:
  ocadvisor benchmarks update [--path <file>]
  ocadvisor benchmarks status [--path <file>] [--mappings-path <file>] [--model <provider/model#variant>]
  ocadvisor --help | --version

Exit codes: 0 success; 1 update failed, no usable snapshot, or model
unresolved; 2 usage error.

Benchmark data: Artificial Analysis (https://artificialanalysis.ai/).`;

const UPDATE_HELP = `ocadvisor benchmarks update — refresh the local snapshot

Usage:
  ocadvisor benchmarks update [--path <file>]

Fetches the Artificial Analysis models endpoint once using
ARTIFICIAL_ANALYSIS_API_KEY and atomically replaces the snapshot file.
Custom --path values must be absolute; the default lives under the
platform data directory. Prints the published path, model count,
coverage, and content hash on success.

Exit codes: 0 published; 1 fetch, validation, or write failure;
2 usage error.`;

const STATUS_HELP = `ocadvisor benchmarks status — inspect on-disk benchmark data

Usage:
  ocadvisor benchmarks status [--path <file>] [--mappings-path <file>] [--model <provider/model#variant>]

Reports the active snapshot and mappings files without network access.
With --model, resolves one exact provider/model/variant tuple against
the active data and prints its match or why it is unmatched. Status
describes on-disk candidates; a running plugin may still hold an older
in-memory copy until its next consultation.

Testing-only flags (not part of the documented surface):
--seed-snapshot <file> and --seed-mappings <file> point the fallback
seed elsewhere, which is useful for deterministic tests.

Exit codes: 0 usable snapshot (and model resolved, when requested);
1 no usable snapshot or model unresolved; 2 usage error.

Benchmark data: Artificial Analysis (https://artificialanalysis.ai/).`;

type ParsedArgs =
  { ok: true; values: Record<string, string> } | { ok: false; message: string };

function parseFlags(args: string[], allowed: string[]): ParsedArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      return { ok: false, message: `unexpected argument: ${arg}` };
    }
    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    if (!allowed.includes(name)) {
      return { ok: false, message: `unknown flag: ${name}` };
    }
    const key = name.slice("--".length);
    if (equals >= 0) {
      values[key] = arg.slice(equals + 1);
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      return { ok: false, message: `flag ${name} needs a value` };
    }
    values[key] = next;
    index++;
  }
  return { ok: true, values };
}

export function parseModelCoordinate(
  value: string,
): ModelRef | BenchmarkValidationError {
  const text = value.trim();
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    return {
      error: "--model expects provider/model#variant (variant optional)",
    };
  }
  const providerID = text.slice(0, slash).trim();
  let rest = text.slice(slash + 1).trim();
  if (!providerID || !rest) {
    return {
      error: "--model expects provider/model#variant (variant optional)",
    };
  }
  let variant: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    variant = rest.slice(hash + 1).trim();
    rest = rest.slice(0, hash).trim();
    if (!rest || !variant || variant.includes("#")) {
      return {
        error: "--model expects provider/model#variant (variant optional)",
      };
    }
  }
  if (!rest || /[\s]/.test(providerID) || /[\s]/.test(rest)) {
    return {
      error: "--model expects provider/model#variant (variant optional)",
    };
  }
  return { providerID, modelID: rest, variant };
}

const SHORT_METRIC_LABELS: Record<string, string> = {
  artificial_analysis_coding_index: "coding_index",
  artificial_analysis_intelligence_index: "intelligence_index",
  hle: "hle",
  gpqa: "gpqa",
  artificial_analysis_math_index: "math_index",
};

function shortMetricLabel(key: string): string {
  return SHORT_METRIC_LABELS[key] ?? key;
}

function coverageLine(
  snapshot: { models: Array<{ evaluations: Record<string, unknown> }> } | null,
): string {
  if (!snapshot) return "models: 0";
  const counts = RECOGNIZED_METRICS.map((metric) => {
    const count = snapshot.models.filter(
      (model) => typeof model.evaluations[metric.key] === "number",
    ).length;
    return `${shortMetricLabel(metric.key)}: ${count}`;
  });
  return `models: ${snapshot.models.length} (${counts.join(", ")})`;
}

function ageLine(fetchedAt: string | null, nowMs: number): string | null {
  if (!fetchedAt) return null;
  const parsed = Date.parse(fetchedAt);
  if (!Number.isFinite(parsed)) return null;
  const days = (nowMs - parsed) / DAY_MS;
  if (days < 0) return `${fetchedAt} (in the future)`;
  return `${fetchedAt} (${days.toFixed(1)} days ago)`;
}

function matchLines(
  coordinate: string,
  match: BenchmarkMatch,
): { lines: string[]; resolved: boolean } {
  switch (match.status) {
    case "matched":
    case "effort_unknown": {
      const scores = Object.entries(match.record?.evaluations ?? {})
        .filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        )
        .map(([key, value]) => `${shortMetricLabel(key)}=${value}`)
        .join(", ");
      const lines = [
        `model: ${coordinate}`,
        `  match: ${match.status} (${match.source ?? "unknown"})`,
        `  aa_model: ${match.aaModelID ?? "unknown"}`,
        `  evaluated_effort: ${match.evaluatedEffort ?? "unknown"}`,
        `  scores: ${scores || "none"}`,
      ];
      if (match.status === "effort_unknown") {
        lines.push("  note: evaluation effort is unreported for this binding");
      }
      return { lines, resolved: true };
    }
    case "unmapped":
      return {
        lines: [
          `model: ${coordinate}`,
          "  match: unmapped (no binding for this exact provider/model/variant)",
        ],
        resolved: false,
      };
    case "missing_record":
      return {
        lines: [
          `model: ${coordinate}`,
          `  match: missing_record (binding points at ${match.aaModelID ?? "unknown"}, not in this snapshot)`,
        ],
        resolved: false,
      };
    case "unavailable":
    default:
      return {
        lines: [
          `model: ${coordinate}`,
          "  match: unavailable (no usable snapshot)",
        ],
        resolved: false,
      };
  }
}

async function benchmarksUpdate(
  args: string[],
  deps: ResolvedDeps,
  env: Record<string, string | undefined>,
): Promise<number> {
  const parsed = parseFlags(args, ["--path"]);
  if (!parsed.ok) {
    deps.err(`ocadvisor: ${parsed.message}\n${UPDATE_HELP}`);
    return 2;
  }
  const explicit: BenchmarkPathOptions = {};
  if (parsed.values.path !== undefined) explicit.path = parsed.values.path;
  const paths = resolveBenchmarkPaths(explicit, env);
  if ("error" in paths) {
    deps.err(`ocadvisor: ${paths.error}`);
    return 2;
  }
  const result = await updateBenchmarkSnapshot(paths.snapshotPath, {
    fetchImpl: deps.fetchImpl,
    env,
  });
  if (!result.ok) {
    deps.err(`benchmarks update failed (${result.code}): ${result.message}`);
    return 1;
  }
  const coverage = RECOGNIZED_METRICS.map(
    (metric) =>
      `${shortMetricLabel(metric.key)}: ${result.metricCoverage[metric.key] ?? 0}`,
  ).join(", ");
  deps.out(
    [
      `benchmarks updated: ${result.path}`,
      `  fetched_at: ${result.fetchedAt}`,
      `  models: ${result.modelCount} (${coverage})`,
      `  content_hash: ${result.contentHash}`,
      `  unchanged: ${result.unchanged}`,
      "Benchmark data: Artificial Analysis (https://artificialanalysis.ai/).",
    ].join("\n"),
  );
  return 0;
}

async function benchmarksStatus(
  args: string[],
  deps: ResolvedDeps,
  env: Record<string, string | undefined>,
): Promise<number> {
  const parsed = parseFlags(args, [
    "--path",
    "--mappings-path",
    "--model",
    "--seed-snapshot",
    "--seed-mappings",
  ]);
  if (!parsed.ok) {
    deps.err(`ocadvisor: ${parsed.message}\n${STATUS_HELP}`);
    return 2;
  }
  const explicit: BenchmarkPathOptions = {};
  if (parsed.values.path !== undefined) explicit.path = parsed.values.path;
  if (parsed.values["mappings-path"] !== undefined) {
    explicit.mappingsPath = parsed.values["mappings-path"];
  }
  const resolved = resolveBenchmarkPaths(explicit, env);
  if ("error" in resolved) {
    deps.err(`ocadvisor: ${resolved.error}`);
    return 2;
  }
  let coordinate: ModelRef | null = null;
  let coordinateText: string | null = null;
  if (parsed.values.model !== undefined) {
    coordinateText = parsed.values.model;
    const coordinateParsed = parseModelCoordinate(parsed.values.model);
    if ("error" in coordinateParsed) {
      deps.err(`ocadvisor: ${coordinateParsed.error}`);
      return 2;
    }
    coordinate = coordinateParsed;
  }
  const store = await createBenchmarkStore({
    snapshotPath: resolved.snapshotPath,
    mappingsPath: resolved.mappingsPath,
    // Seed overrides exist for testing the fallback path; ordinary use
    // reads the bundled data relative to this module.
    seedSnapshotPath: parsed.values["seed-snapshot"],
    seedMappingsPath: parsed.values["seed-mappings"],
  });
  const view = await store.view();
  const lines = ["benchmarks status (on-disk snapshot and mappings)"];
  if (view.snapshotSource === "user") {
    lines.push(`  snapshot: user ${resolved.snapshotPath}`);
  } else if (view.snapshotSource === "seed") {
    lines.push("  snapshot: bundled seed");
  } else {
    lines.push("  snapshot: unavailable");
  }
  const age = ageLine(view.snapshot?.fetchedAt ?? null, deps.nowMs);
  if (age) lines.push(`  fetched_at: ${age}`);
  lines.push(`  ${coverageLine(view.snapshot)}`);
  if (view.snapshot) {
    lines.push(`  content_hash: ${view.snapshot.contentHash}`);
  }
  const localCount = view.localMappings?.bindings.length ?? 0;
  const bundledCount = view.bundledMappings.bindings.length;
  lines.push(`  mappings: ${localCount} local, ${bundledCount} bundled`);
  for (const note of [
    view.snapshotNote,
    view.localMappingsNote,
    view.bundledMappingsNote,
  ]) {
    if (note) lines.push(`  note: ${note}`);
  }
  lines.push(
    "Benchmark data: Artificial Analysis (https://artificialanalysis.ai/).",
  );

  if (coordinate && coordinateText) {
    // Resolve against the same active data the plugin would use.
    const { lines: modelLines, resolved: modelResolved } = matchLines(
      coordinateText,
      view.matcher.match(coordinate),
    );
    lines.push(...modelLines);
    deps.out(lines.join("\n"));
    return view.snapshot && modelResolved ? 0 : 1;
  }
  deps.out(lines.join("\n"));
  return view.snapshot ? 0 : 1;
}

export async function runCli(
  argv: string[],
  deps: CliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;
  const full: ResolvedDeps = {
    out,
    err,
    env,
    fetchImpl: deps.fetchImpl,
    nowMs: deps.nowMs ?? Date.now(),
  };
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    if (argv[0] === "benchmarks" && argv[1] === "update") {
      out(UPDATE_HELP);
    } else if (argv[0] === "benchmarks" && argv[1] === "status") {
      out(STATUS_HELP);
    } else {
      out(GLOBAL_HELP);
    }
    return 0;
  }
  if (argv[0] === "--version") {
    out(`ocadvisor ${readPackageVersion()}`);
    return 0;
  }
  if (argv.length === 0 || argv[0] === "benchmarks") {
    if (argv.length <= 1) {
      out(GLOBAL_HELP);
      return 0;
    }
    const [command, ...rest] = argv.slice(1);
    if (command === "update") return benchmarksUpdate(rest, full, env);
    if (command === "status") return benchmarksStatus(rest, full, env);
    err(`ocadvisor: unknown benchmarks command: ${command}\n${GLOBAL_HELP}`);
    return 2;
  }
  err(`ocadvisor: unknown command: ${argv[0]}\n${GLOBAL_HELP}`);
  return 2;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), {
    out: (line: string) => console.log(line),
    err: (line: string) => console.error(line),
  }).catch((error: unknown) => {
    console.error(
      `ocadvisor: unexpected failure: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  });
  process.exit(code);
}
