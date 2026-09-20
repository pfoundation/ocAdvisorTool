// Exact model-to-benchmark mapping and capability comparison. OpenCode
// model references map to stable Artificial Analysis IDs through explicit
// curated bindings only: no fuzzy names, no prefix stripping, no sibling
// substitution, and no assumed effort equivalence. Local bindings override
// bundled ones per tuple; comparisons carry oriented deltas plus an
// explicit reason whenever scores cannot be strictly compared.
import {
  GATE_METRIC_ORDER,
  RECOGNIZED_METRICS,
  type BenchmarkModel,
  type BenchmarkSnapshot,
  type BenchmarkValidationError,
  type MetricUnit,
} from "./benchmarkTypes.js";

export const BENCHMARK_MAPPINGS_SCHEMA_VERSION = 1;

const CODING_INDEX_KEY = "artificial_analysis_coding_index";
const INTELLIGENCE_INDEX_KEY = "artificial_analysis_intelligence_index";
// Both indexes plus at most two reasoning/math metrics with data.
const GATE_METRIC_LIMIT = 4;

export interface ModelBinding {
  providerID: string;
  modelID: string;
  // Exact variant; null covers only unknown/unset, never "any variant".
  variant: string | null;
  aaModelID: string;
  // Effort the bound evaluation ran at, from verified source metadata.
  // Null means unreported: scores stay visible but leave strict comparison.
  evaluatedEffort: string | null;
  evidenceURL: string;
}

export interface ModelMappings {
  schemaVersion: 1;
  bindings: ModelBinding[];
}

export interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string | null;
}

export type MatchSource = "bundled" | "local";
export type MatchStatus =
  "matched" | "unmapped" | "missing_record" | "effort_unknown" | "unavailable";

export interface BenchmarkMatch {
  status: MatchStatus;
  source: MatchSource | null;
  aaModelID: string | null;
  record: BenchmarkModel | null;
  evaluatedEffort: string | null;
}

export type ComparisonReason =
  | "missing_requester"
  | "missing_advisor"
  | "effort_unknown"
  | "effort_mismatch"
  | null;

export interface MetricComparison {
  key: string;
  label: string;
  unit: MetricUnit;
  requester: number | null;
  advisor: number | null;
  advisorMinusRequester: number | null;
  comparable: boolean;
  reason: ComparisonReason;
}

export interface MergedBinding {
  binding: ModelBinding;
  source: MatchSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredId(
  value: unknown,
  field: string,
): string | BenchmarkValidationError {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { error: `binding ${field} must be a non-empty string` };
  return text;
}

function optionalId(
  value: unknown,
  field: string,
): string | null | BenchmarkValidationError {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    return { error: `binding ${field} must be a non-empty string or null` };
  }
  return value.trim();
}

function bindingKey(parts: {
  providerID: string;
  modelID: string;
  variant: string | null;
}): string {
  return JSON.stringify([parts.providerID, parts.modelID, parts.variant]);
}

export function parseModelMappings(
  value: unknown,
): ModelMappings | BenchmarkValidationError {
  if (!isRecord(value)) {
    return { error: "model mappings must be an object" };
  }
  if (value.schemaVersion !== BENCHMARK_MAPPINGS_SCHEMA_VERSION) {
    return {
      error: `unsupported model mappings schema version ${String(value.schemaVersion)} (expected ${BENCHMARK_MAPPINGS_SCHEMA_VERSION})`,
    };
  }
  if (!Array.isArray(value.bindings)) {
    return { error: "model mappings bindings must be an array" };
  }
  const seen = new Set<string>();
  const bindings: ModelBinding[] = [];
  for (let index = 0; index < value.bindings.length; index++) {
    const entry = value.bindings[index];
    const label = `binding ${index}`;
    if (!isRecord(entry)) return { error: `${label} must be an object` };
    const providerID = requiredId(entry.providerID, "providerID");
    if (typeof providerID !== "string") return providerID;
    const modelID = requiredId(entry.modelID, "modelID");
    if (typeof modelID !== "string") return modelID;
    const variant = optionalId(entry.variant, "variant");
    if (typeof variant !== "string" && variant !== null) return variant;
    const aaModelID = requiredId(entry.aaModelID, "aaModelID");
    if (typeof aaModelID !== "string") return aaModelID;
    const evaluatedEffort = optionalId(
      entry.evaluatedEffort,
      "evaluatedEffort",
    );
    if (typeof evaluatedEffort !== "string" && evaluatedEffort !== null) {
      return evaluatedEffort;
    }
    const evidenceURL =
      typeof entry.evidenceURL === "string" ? entry.evidenceURL.trim() : "";
    if (!/^https?:\/\/.+/.test(evidenceURL)) {
      return { error: `${label} needs an http(s) evidenceURL` };
    }
    const binding: ModelBinding = {
      providerID,
      modelID,
      variant,
      aaModelID,
      evaluatedEffort,
      evidenceURL,
    };
    const key = bindingKey(binding);
    if (seen.has(key)) {
      return {
        error: `duplicate binding for ${providerID}/${modelID}#${variant ?? "(unset)"}`,
      };
    }
    seen.add(key);
    bindings.push(binding);
  }
  return { schemaVersion: BENCHMARK_MAPPINGS_SCHEMA_VERSION, bindings };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metricDefinition(key: string): { label: string; unit: MetricUnit } {
  const found = RECOGNIZED_METRICS.find((metric) => metric.key === key);
  return { label: found?.label ?? key, unit: found?.unit ?? "index_points" };
}

export function compareBenchmarks(
  requester: BenchmarkMatch,
  advisor: BenchmarkMatch,
): MetricComparison[] {
  // Pair-level verdict first: without both records, or without compatible
  // evaluated efforts, no metric can be strictly compared. Per-metric
  // reasons below only refine the comparable case.
  let pairReason: ComparisonReason = null;
  if (!requester.record) {
    pairReason = "missing_requester";
  } else if (!advisor.record) {
    pairReason = "missing_advisor";
  } else if (
    requester.status === "effort_unknown" ||
    advisor.status === "effort_unknown"
  ) {
    pairReason = "effort_unknown";
  } else if (requester.evaluatedEffort !== advisor.evaluatedEffort) {
    pairReason = "effort_mismatch";
  }
  return GATE_METRIC_ORDER.map((key) => {
    const requesterScore = finiteOrNull(requester.record?.evaluations[key]);
    const advisorScore = finiteOrNull(advisor.record?.evaluations[key]);
    let reason: ComparisonReason = pairReason;
    if (reason === null) {
      if (requesterScore === null) {
        reason = "missing_requester";
      } else if (advisorScore === null) {
        reason = "missing_advisor";
      }
    }
    // All recognized v1 metrics are higher-is-better, so a positive delta
    // always favors the advisor. Revisit if a lower-is-better metric lands.
    const definition = metricDefinition(key);
    return {
      key,
      label: definition.label,
      unit: definition.unit,
      requester: requesterScore,
      advisor: advisorScore,
      advisorMinusRequester:
        reason === null ? advisorScore! - requesterScore! : null,
      comparable: reason === null,
      reason,
    };
  });
}

// Shared payload selection: both indexes always (nulls mark missing
// coverage), plus the first two reasoning/math metrics with any data, in
// deterministic gate order.
export function selectGateMetrics(
  comparisons: MetricComparison[],
): MetricComparison[] {
  const byKey = new Map(comparisons.map((entry) => [entry.key, entry]));
  const selected: MetricComparison[] = [];
  for (const key of [CODING_INDEX_KEY, INTELLIGENCE_INDEX_KEY]) {
    const entry = byKey.get(key);
    if (entry) selected.push(entry);
  }
  for (const key of GATE_METRIC_ORDER) {
    if (selected.length >= GATE_METRIC_LIMIT) break;
    if (key === CODING_INDEX_KEY || key === INTELLIGENCE_INDEX_KEY) continue;
    const entry = byKey.get(key);
    if (
      entry &&
      (typeof entry.requester === "number" || typeof entry.advisor === "number")
    ) {
      selected.push(entry);
    }
  }
  return selected;
}

export interface BenchmarkMatcher {
  match: (ref: ModelRef) => BenchmarkMatch;
  compare: (requester: ModelRef, advisor: ModelRef) => MetricComparison[];
  bindings: () => MergedBinding[];
}

export function createBenchmarkMatcher(input: {
  snapshot: BenchmarkSnapshot | null;
  bundled: ModelMappings;
  local: ModelMappings | null;
}): BenchmarkMatcher {
  const merged = new Map<string, MergedBinding>();
  for (const binding of input.bundled.bindings) {
    merged.set(bindingKey(binding), { binding, source: "bundled" });
  }
  for (const binding of input.local?.bindings ?? []) {
    merged.set(bindingKey(binding), { binding, source: "local" });
  }
  const records = new Map<string, BenchmarkModel>();
  for (const model of input.snapshot?.models ?? []) {
    records.set(model.id, model);
  }

  const match = (ref: ModelRef): BenchmarkMatch => {
    const found = merged.get(
      bindingKey({
        providerID: ref.providerID,
        modelID: ref.modelID,
        variant: ref.variant ?? null,
      }),
    );
    if (!found) {
      return {
        status: "unmapped",
        source: null,
        aaModelID: null,
        record: null,
        evaluatedEffort: null,
      };
    }
    if (!input.snapshot) {
      return {
        status: "unavailable",
        source: found.source,
        aaModelID: found.binding.aaModelID,
        record: null,
        evaluatedEffort: found.binding.evaluatedEffort,
      };
    }
    const record = records.get(found.binding.aaModelID) ?? null;
    if (!record) {
      return {
        status: "missing_record",
        source: found.source,
        aaModelID: found.binding.aaModelID,
        record: null,
        evaluatedEffort: found.binding.evaluatedEffort,
      };
    }
    if (found.binding.evaluatedEffort === null) {
      return {
        status: "effort_unknown",
        source: found.source,
        aaModelID: found.binding.aaModelID,
        record,
        evaluatedEffort: null,
      };
    }
    return {
      status: "matched",
      source: found.source,
      aaModelID: found.binding.aaModelID,
      record,
      evaluatedEffort: found.binding.evaluatedEffort,
    };
  };

  return {
    match,
    compare: (requester, advisor) =>
      compareBenchmarks(match(requester), match(advisor)),
    bindings: () => [...merged.values()],
  };
}
