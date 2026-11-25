// Artificial Analysis response normalization: maps the documented language
// models payload onto the versioned benchmark snapshot. The response
// carries no structured effort or evaluation date, so those fields stay null
// rather than guessed; the Intelligence Index version becomes the snapshot's
// methodology version.
//
// The legacy `/api/v2/data/llms/models` endpoint returns 410 Gone since
// 2026-11-04. Its free-tier replacement is paginated; `combineAAPages`
// merges the pages into one body before normalization.
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
  "https://artificialanalysis.ai/api/v2/language/models/free";
// Upper bound on pages per refresh; a response that still reports more pages
// is rejected instead of silently truncated.
export const AA_MAX_PAGES = 50;

export function aaModelsPageURL(page: number): string {
  return `${AA_LLM_MODELS_ENDPOINT}?page=${page}`;
}

export interface AAPage {
  data: unknown[];
  hasMore: boolean;
  intelligenceIndexVersion: number | string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexVersion(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

// Reads one page of the paginated envelope. A missing `pagination` object is
// treated as a single, final page.
export function parseAAPage(
  body: unknown,
  page: number,
): AAPage | BenchmarkValidationError {
  if (!isRecord(body)) {
    return { error: `artificial analysis page ${page} must be an object` };
  }
  if (!Array.isArray(body.data)) {
    return { error: `artificial analysis page ${page} has no data array` };
  }
  const pagination = isRecord(body.pagination) ? body.pagination : null;
  return {
    data: body.data,
    hasMore: pagination?.has_more === true,
    intelligenceIndexVersion: indexVersion(body.intelligence_index_version),
  };
}

// Merges pages into the single body `normalizeAAResponse` expects. Pages
// must agree on the Intelligence Index version so one snapshot never mixes
// scores from two index versions.
export interface AAModelsBody {
  intelligence_index_version: number | string | null;
  data: unknown[];
}

export function combineAAPages(
  pages: AAPage[],
): AAModelsBody | BenchmarkValidationError {
  const versions = new Set(
    pages.map((page) => String(page.intelligenceIndexVersion)),
  );
  if (versions.size > 1) {
    return {
      error:
        "artificial analysis pages report different Intelligence Index versions; retry the refresh",
    };
  }
  return {
    intelligence_index_version: pages[0]?.intelligenceIndexVersion ?? null,
    data: pages.flatMap((page) => page.data),
  };
}

function methodologyVersion(value: unknown): string | null {
  const version = indexVersion(value);
  return version === null
    ? null
    : `artificial_analysis_intelligence_index v${version}`;
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
    // The language-models schema documents a null creator. Such entries
    // cannot satisfy the snapshot schema and are skipped; a malformed
    // creator object is still rejected below.
    if (entry.model_creator === null) continue;
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
    methodologyVersion: methodologyVersion(body.intelligence_index_version),
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
