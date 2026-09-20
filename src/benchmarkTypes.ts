// Versioned Artificial Analysis benchmark snapshot: shared schema,
// validation, and content hashing for the updater, reader, CLI, and gate.
//
// One validation path serves downloads, the bundled seed, user snapshots,
// and mapping-adjacent reads so every consumer agrees on what is usable.
// Unknown additive fields are ignored or preserved (never invented), and
// undocumented metadata stays null instead of guessed.
import { createHash } from "node:crypto";

export const BENCHMARK_SCHEMA_VERSION = 1;
export const BENCHMARK_SOURCE = "artificial-analysis";
export const BENCHMARK_SOURCE_URL = "https://artificialanalysis.ai/";

export type MetricCategory = "coding" | "general" | "reasoning" | "math";
export type MetricUnit = "index_points" | "fraction";

export interface MetricDefinition {
  key: string;
  label: string;
  category: MetricCategory;
  unit: MetricUnit;
  higherIsBetter: boolean;
  benchmarkVersion: string | null;
}

export interface BenchmarkModel {
  id: string;
  creatorID: string;
  name: string;
  slug: string;
  evaluatedEffort: string | null;
  evaluatedAt: string | null;
  evaluations: Record<string, number | null>;
}

export interface BenchmarkSnapshot {
  schemaVersion: 1;
  source: "artificial-analysis";
  sourceURL: string;
  endpoint: string;
  // Download time. This is snapshot freshness, never an evaluation date.
  fetchedAt: string;
  // SHA-256 over the canonical model content; excludes fetchedAt so an
  // unchanged refetch keeps its hash.
  contentHash: string;
  methodologyVersion: string | null;
  metricDefinitions: MetricDefinition[];
  models: BenchmarkModel[];
}

// Recognized metrics in deterministic gate-selection order: the two
// Artificial Analysis indexes first, then reasoning/math evidence. Scores
// keep their published labels and units; index points and fractions are
// never mixed into one aggregate.
export const RECOGNIZED_METRICS: readonly MetricDefinition[] = [
  {
    key: "artificial_analysis_coding_index",
    label: "Artificial Analysis Coding Index",
    category: "coding",
    unit: "index_points",
    higherIsBetter: true,
    benchmarkVersion: null,
  },
  {
    key: "artificial_analysis_intelligence_index",
    label: "Artificial Analysis Intelligence Index",
    category: "general",
    unit: "index_points",
    higherIsBetter: true,
    benchmarkVersion: null,
  },
  {
    key: "hle",
    label: "HLE (Humanity's Last Exam)",
    category: "reasoning",
    unit: "fraction",
    higherIsBetter: true,
    benchmarkVersion: null,
  },
  {
    key: "gpqa",
    label: "GPQA",
    category: "reasoning",
    unit: "fraction",
    higherIsBetter: true,
    benchmarkVersion: null,
  },
  {
    key: "artificial_analysis_math_index",
    label: "Artificial Analysis Math Index",
    category: "math",
    unit: "index_points",
    higherIsBetter: true,
    benchmarkVersion: null,
  },
];

export const GATE_METRIC_ORDER: readonly string[] = RECOGNIZED_METRICS.map(
  (metric) => metric.key,
);

const RECOGNIZED_KEYS = new Set(GATE_METRIC_ORDER);
const HASH_FORMAT = /^[0-9a-f]{64}$/;
const CATEGORIES: readonly string[] = [
  "coding",
  "general",
  "reasoning",
  "math",
];
const UNITS: readonly string[] = ["index_points", "fraction"];

export type BenchmarkValidationError = { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isValidationError(
  value: string | null | BenchmarkValidationError,
): value is BenchmarkValidationError {
  return typeof value === "object" && value !== null;
}

// `in` narrowing cannot discriminate an index-signature Record from the
// error shape, so evaluations results use this predicate instead.
function isParseError<T>(
  value: T | BenchmarkValidationError,
): value is BenchmarkValidationError {
  return typeof value === "object" && value !== null && "error" in value;
}

function parseNullableString(
  value: unknown,
  field: string,
): string | null | BenchmarkValidationError {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    return { error: `${field} must be a string or null` };
  return value;
}

// Recognized scores must be finite numbers or explicit nulls (zero is a
// real score). Unknown keys keep finite numbers and nulls for forward
// compatibility; anything else is ignored rather than rejected so additive
// upstream changes cannot break previously valid snapshots.
function parseEvaluations(
  value: unknown,
  label: string,
): Record<string, number | null> | BenchmarkValidationError {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) {
    return { error: `${label} evaluations must be an object` };
  }
  const evaluations: Record<string, number | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) {
      evaluations[key] = null;
      continue;
    }
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      if (RECOGNIZED_KEYS.has(key)) {
        return { error: `${label} has an invalid ${key} score` };
      }
      continue;
    }
    evaluations[key] = entry;
  }
  return evaluations;
}

export function parseBenchmarkModel(
  value: unknown,
  label: string,
): BenchmarkModel | BenchmarkValidationError {
  if (!isRecord(value)) {
    return { error: `${label} must be an object` };
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) return { error: `${label} is missing a stable model id` };
  const creatorID =
    typeof value.creatorID === "string" ? value.creatorID.trim() : "";
  if (!creatorID) return { error: `${label} is missing a creator id` };
  if (typeof value.name !== "string" || typeof value.slug !== "string") {
    return { error: `${label} is missing its name or slug` };
  }
  const evaluatedEffort = parseNullableString(
    value.evaluatedEffort,
    `${label} evaluatedEffort`,
  );
  if (isValidationError(evaluatedEffort)) return evaluatedEffort;
  const evaluatedAt = parseNullableString(
    value.evaluatedAt,
    `${label} evaluatedAt`,
  );
  if (isValidationError(evaluatedAt)) return evaluatedAt;
  if (
    typeof evaluatedAt === "string" &&
    evaluatedAt.trim() &&
    !isValidDateTime(evaluatedAt)
  ) {
    return { error: `${label} has an invalid evaluatedAt date` };
  }
  const evaluations = parseEvaluations(value.evaluations, label);
  if (isParseError(evaluations)) return evaluations;
  return {
    id,
    creatorID,
    name: value.name,
    slug: value.slug,
    evaluatedEffort: evaluatedEffort as string | null,
    evaluatedAt: evaluatedAt as string | null,
    evaluations,
  };
}

function parseMetricDefinitions(
  value: unknown,
): MetricDefinition[] | BenchmarkValidationError {
  if (!Array.isArray(value)) {
    return { error: "metricDefinitions must be an array" };
  }
  const seen = new Set<string>();
  const definitions: MetricDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    const label = `metric definition ${index}`;
    if (!isRecord(entry)) return { error: `${label} must be an object` };
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key) return { error: `${label} is missing its key` };
    if (seen.has(key)) {
      return { error: `duplicate metric definition for ${key}` };
    }
    seen.add(key);
    if (typeof entry.label !== "string") {
      return { error: `${label} is missing its label` };
    }
    if (
      typeof entry.category !== "string" ||
      !CATEGORIES.includes(entry.category)
    ) {
      return { error: `${label} has an unknown category` };
    }
    if (typeof entry.unit !== "string" || !UNITS.includes(entry.unit)) {
      return { error: `${label} has an unknown unit` };
    }
    if (typeof entry.higherIsBetter !== "boolean") {
      return { error: `${label} is missing higherIsBetter` };
    }
    const benchmarkVersion = parseNullableString(
      entry.benchmarkVersion,
      `${label} benchmarkVersion`,
    );
    if (isValidationError(benchmarkVersion)) return benchmarkVersion;
    definitions.push({
      key,
      label: entry.label,
      category: entry.category as MetricCategory,
      unit: entry.unit as MetricUnit,
      higherIsBetter: entry.higherIsBetter,
      benchmarkVersion: benchmarkVersion as string | null,
    });
  }
  return definitions;
}

function hasUsableScore(models: BenchmarkModel[]): boolean {
  return models.some((model) =>
    GATE_METRIC_ORDER.some(
      (key) =>
        typeof model.evaluations[key] === "number" &&
        Number.isFinite(model.evaluations[key]),
    ),
  );
}

export function parseBenchmarkSnapshot(
  value: unknown,
): BenchmarkSnapshot | BenchmarkValidationError {
  if (!isRecord(value)) {
    return { error: "benchmark snapshot must be an object" };
  }
  if (value.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    return {
      error: `unsupported benchmark snapshot schema version ${String(value.schemaVersion)} (expected ${BENCHMARK_SCHEMA_VERSION})`,
    };
  }
  if (value.source !== BENCHMARK_SOURCE) {
    return {
      error: `benchmark snapshot source must be ${BENCHMARK_SOURCE}`,
    };
  }
  if (typeof value.sourceURL !== "string" || !value.sourceURL.trim()) {
    return { error: "benchmark snapshot is missing its sourceURL" };
  }
  if (typeof value.endpoint !== "string" || !value.endpoint.trim()) {
    return { error: "benchmark snapshot is missing its endpoint" };
  }
  if (
    typeof value.fetchedAt !== "string" ||
    !isValidDateTime(value.fetchedAt)
  ) {
    return { error: "benchmark snapshot has an invalid fetchedAt timestamp" };
  }
  if (
    typeof value.contentHash !== "string" ||
    !HASH_FORMAT.test(value.contentHash)
  ) {
    return { error: "benchmark snapshot has an invalid contentHash" };
  }
  const methodologyVersion = parseNullableString(
    value.methodologyVersion,
    "methodologyVersion",
  );
  if (isValidationError(methodologyVersion)) return methodologyVersion;
  const metricDefinitions = parseMetricDefinitions(value.metricDefinitions);
  if ("error" in metricDefinitions) return metricDefinitions;
  if (!Array.isArray(value.models) || value.models.length === 0) {
    return { error: "benchmark snapshot has an empty model dataset" };
  }
  const seen = new Set<string>();
  const models: BenchmarkModel[] = [];
  for (let index = 0; index < value.models.length; index++) {
    const parsed = parseBenchmarkModel(value.models[index], `model ${index}`);
    if ("error" in parsed) return parsed;
    if (seen.has(parsed.id)) {
      return { error: `duplicate benchmark model id ${parsed.id}` };
    }
    seen.add(parsed.id);
    models.push(parsed);
  }
  if (!hasUsableScore(models)) {
    return { error: "benchmark snapshot has no usable benchmark scores" };
  }
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    source: BENCHMARK_SOURCE,
    sourceURL: value.sourceURL,
    endpoint: value.endpoint,
    fetchedAt: value.fetchedAt,
    contentHash: value.contentHash,
    methodologyVersion: methodologyVersion as string | null,
    metricDefinitions,
    models,
  };
}

// Canonical JSON: object keys sorted recursively, arrays in order. Used only
// for hashing, never for display.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function computeSnapshotHash(input: {
  source: string;
  endpoint: string;
  methodologyVersion: string | null;
  models: BenchmarkModel[];
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        source: input.source,
        endpoint: input.endpoint,
        methodologyVersion: input.methodologyVersion,
        models: input.models,
      }),
      "utf8",
    )
    .digest("hex");
}

export function verifySnapshotHash(snapshot: BenchmarkSnapshot): boolean {
  return (
    computeSnapshotHash({
      source: snapshot.source,
      endpoint: snapshot.endpoint,
      methodologyVersion: snapshot.methodologyVersion,
      models: snapshot.models,
    }) === snapshot.contentHash
  );
}
