// Artificial Analysis response normalization: maps the documented LLM
// models payload onto the versioned benchmark snapshot. The response
// carries no structured effort, evaluation date, or methodology version,
// so those fields stay null rather than guessed.
import {
  BENCHMARK_SCHEMA_VERSION,
  BENCHMARK_SOURCE,
  BENCHMARK_SOURCE_URL,
  RECOGNIZED_METRICS,
  computeSnapshotHash,
  parseBenchmarkModel,
  type BenchmarkModel,
  type BenchmarkSnapshot,
  type BenchmarkValidationError,
} from "./benchmarkTypes.js";

export const AA_LLM_MODELS_ENDPOINT =
  "https://artificialanalysis.ai/api/v2/data/llms/models";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAAResponse(
  body: unknown,
  fetchedAt: string,
): BenchmarkSnapshot | BenchmarkValidationError {
  if (!isRecord(body)) {
    return { error: "artificial analysis response must be an object" };
  }
  if (
    typeof fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(fetchedAt))
  ) {
    return {
      error: "artificial analysis refresh needs a valid fetchedAt timestamp",
    };
  }
  if (!Array.isArray(body.data) || body.data.length === 0) {
    return { error: "artificial analysis response has an empty data array" };
  }
  const seen = new Set<string>();
  const models: BenchmarkModel[] = [];
  for (let index = 0; index < body.data.length; index++) {
    const entry = body.data[index];
    const label = `entry ${index}`;
    if (!isRecord(entry)) return { error: `${label} must be an object` };
    const creator = isRecord(entry.model_creator) ? entry.model_creator : null;
    const creatorID =
      creator && typeof creator.id === "string" ? creator.id.trim() : "";
    if (!creatorID) {
      return { error: `${label} is missing a model creator id` };
    }
    const parsed = parseBenchmarkModel(
      {
        id: entry.id,
        creatorID,
        name: entry.name,
        slug: entry.slug,
        evaluatedEffort: null,
        evaluatedAt: null,
        evaluations: entry.evaluations ?? {},
      },
      label,
    );
    if ("error" in parsed) return parsed;
    if (seen.has(parsed.id)) {
      return { error: `duplicate benchmark model id ${parsed.id}` };
    }
    seen.add(parsed.id);
    models.push(parsed);
  }
  const usable = models.some((model) =>
    RECOGNIZED_METRICS.some(
      (metric) => typeof model.evaluations[metric.key] === "number",
    ),
  );
  if (!usable) {
    return {
      error: "artificial analysis response has no usable benchmark scores",
    };
  }
  const snapshot: BenchmarkSnapshot = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    source: BENCHMARK_SOURCE,
    sourceURL: BENCHMARK_SOURCE_URL,
    endpoint: AA_LLM_MODELS_ENDPOINT,
    fetchedAt,
    contentHash: "",
    methodologyVersion: null,
    metricDefinitions: [...RECOGNIZED_METRICS],
    models,
  };
  snapshot.contentHash = computeSnapshotHash({
    source: snapshot.source,
    endpoint: snapshot.endpoint,
    methodologyVersion: snapshot.methodologyVersion,
    models: snapshot.models,
  });
  return snapshot;
}
