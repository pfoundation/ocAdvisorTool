import { describe, expect, test } from "bun:test";
import {
  AA_LLM_MODELS_ENDPOINT,
  normalizeAAResponse,
} from "./artificialAnalysis";
import {
  RECOGNIZED_METRICS,
  verifySnapshotHash,
  type BenchmarkSnapshot,
} from "./benchmarkTypes";

// Synthetic API fixtures: fake stable IDs, names, and scores shaped like the
// documented Artificial Analysis response. Never real published data.
function syntheticEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "synthetic-aa-1001",
    name: "Synthetic Model One",
    slug: "synthetic-model-one",
    model_creator: {
      id: "synthetic-creator-9",
      name: "Synthetic Lab",
      slug: "synthetic-lab",
    },
    evaluations: {
      artificial_analysis_coding_index: 50.25,
      artificial_analysis_intelligence_index: 51.75,
      hle: 0.25,
      gpqa: null,
    },
    pricing: {
      price_1m_blended_3_to_1: 1.5,
      price_1m_input_tokens: 1,
      price_1m_output_tokens: 2,
    },
    median_output_tokens_per_second: 10.5,
    median_time_to_first_token_seconds: 1.25,
    ...overrides,
  };
}

function syntheticBody(
  entries: Array<Record<string, unknown>> = [syntheticEntry()],
) {
  return {
    status: 200,
    prompt_options: { parallel_queries: 1, prompt_length: "medium" },
    data: entries,
  };
}

const FETCHED_AT = "2026-09-19T00:00:00.000Z";

function asSnapshot(value: unknown): BenchmarkSnapshot {
  if (typeof value !== "object" || value === null || "error" in value) {
    throw new Error(`expected a snapshot: ${JSON.stringify(value)}`);
  }
  return value as BenchmarkSnapshot;
}

function asError(value: unknown): string {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    throw new Error(`expected a validation error: ${JSON.stringify(value)}`);
  }
  return (value as { error: string }).error;
}

describe("normalizeAAResponse", () => {
  test("uses the documented models endpoint", () => {
    expect(AA_LLM_MODELS_ENDPOINT).toBe(
      "https://artificialanalysis.ai/api/v2/data/llms/models",
    );
  });

  test("normalizes a documented-shape response into a versioned snapshot", () => {
    const parsed = asSnapshot(normalizeAAResponse(syntheticBody(), FETCHED_AT));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.source).toBe("artificial-analysis");
    expect(parsed.sourceURL).toBe("https://artificialanalysis.ai/");
    expect(parsed.endpoint).toBe(AA_LLM_MODELS_ENDPOINT);
    expect(parsed.fetchedAt).toBe(FETCHED_AT);
    expect(parsed.metricDefinitions).toEqual([...RECOGNIZED_METRICS]);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]).toMatchObject({
      id: "synthetic-aa-1001",
      creatorID: "synthetic-creator-9",
      name: "Synthetic Model One",
      slug: "synthetic-model-one",
      evaluatedEffort: null,
      evaluatedAt: null,
    });
    expect(parsed.models[0]?.evaluations).toEqual({
      artificial_analysis_coding_index: 50.25,
      artificial_analysis_intelligence_index: 51.75,
      hle: 0.25,
      gpqa: null,
    });
    expect(verifySnapshotHash(parsed)).toBe(true);
  });

  test("leaves undocumented effort, dates, and methodology as null", () => {
    const parsed = asSnapshot(normalizeAAResponse(syntheticBody(), FETCHED_AT));
    expect(parsed.methodologyVersion).toBeNull();
    expect(parsed.models[0]?.evaluatedEffort).toBeNull();
    expect(parsed.models[0]?.evaluatedAt).toBeNull();
  });

  test("preserves zero scores and keeps missing values null", () => {
    const parsed = asSnapshot(
      normalizeAAResponse(
        syntheticBody([
          syntheticEntry({
            evaluations: {
              artificial_analysis_coding_index: 0,
              hle: 0,
              gpqa: null,
            },
          }),
        ]),
        FETCHED_AT,
      ),
    );
    expect(parsed.models[0]?.evaluations).toEqual({
      artificial_analysis_coding_index: 0,
      hle: 0,
      gpqa: null,
    });
  });

  test("ignores additive upstream fields while preserving unknown scores", () => {
    const parsed = asSnapshot(
      normalizeAAResponse(
        syntheticBody([
          syntheticEntry({
            evaluations: {
              artificial_analysis_coding_index: 50.25,
              synthetic_future_benchmark: 0.5,
            },
            synthetic_future_model_field: { nested: true },
          }),
        ]),
        FETCHED_AT,
      ),
    );
    expect(parsed.models[0]?.evaluations).toEqual({
      artificial_analysis_coding_index: 50.25,
      synthetic_future_benchmark: 0.5,
    });
    expect(parsed.models[0]).not.toHaveProperty("pricing");
    expect(parsed.models[0]).not.toHaveProperty("synthetic_future_model_field");
  });

  test("accepts entries without an evaluations object as unscored", () => {
    const parsed = asSnapshot(
      normalizeAAResponse(
        syntheticBody([
          syntheticEntry({ id: "synthetic-aa-1001" }),
          {
            ...syntheticEntry({ id: "synthetic-aa-1002" }),
            evaluations: undefined,
          },
        ]),
        FETCHED_AT,
      ),
    );
    expect(parsed.models).toHaveLength(2);
    expect(parsed.models[1]?.evaluations).toEqual({});
  });

  test("rejects malformed response envelopes", () => {
    expect(asError(normalizeAAResponse(null, FETCHED_AT))).toContain("object");
    expect(asError(normalizeAAResponse({}, FETCHED_AT))).toContain("data");
    expect(asError(normalizeAAResponse({ data: [] }, FETCHED_AT))).toContain(
      "empty",
    );
    expect(
      asError(normalizeAAResponse(syntheticBody(), "not-a-date")),
    ).toContain("fetchedAt");
  });

  test("rejects entries with missing identities or duplicate IDs", () => {
    expect(
      asError(
        normalizeAAResponse(
          syntheticBody([syntheticEntry({ id: " " })]),
          FETCHED_AT,
        ),
      ),
    ).toContain("entry 0");
    expect(
      asError(
        normalizeAAResponse(
          syntheticBody([syntheticEntry({ model_creator: {} })]),
          FETCHED_AT,
        ),
      ),
    ).toContain("entry 0");
    expect(
      asError(
        normalizeAAResponse(
          syntheticBody([syntheticEntry(), syntheticEntry()]),
          FETCHED_AT,
        ),
      ),
    ).toContain("duplicate");
  });

  test("rejects invalid recognized scores and scoreless datasets", () => {
    expect(
      asError(
        normalizeAAResponse(
          syntheticBody([
            syntheticEntry({
              evaluations: { artificial_analysis_coding_index: "lots" },
            }),
          ]),
          FETCHED_AT,
        ),
      ),
    ).toContain("artificial_analysis_coding_index");
    expect(
      asError(
        normalizeAAResponse(
          syntheticBody([
            syntheticEntry({ id: "synthetic-aa-1001", evaluations: {} }),
          ]),
          FETCHED_AT,
        ),
      ),
    ).toContain("usable");
  });

  test("produces deterministic hashes for identical content", () => {
    const first = asSnapshot(normalizeAAResponse(syntheticBody(), FETCHED_AT));
    const reordered = asSnapshot(
      normalizeAAResponse(
        {
          data: [
            {
              evaluations: {
                gpqa: null,
                hle: 0.25,
                artificial_analysis_intelligence_index: 51.75,
                artificial_analysis_coding_index: 50.25,
              },
              model_creator: {
                slug: "synthetic-lab",
                name: "Synthetic Lab",
                id: "synthetic-creator-9",
              },
              slug: "synthetic-model-one",
              name: "Synthetic Model One",
              id: "synthetic-aa-1001",
            },
          ],
        },
        "2026-10-02T00:00:00.000Z",
      ),
    );
    expect(reordered.contentHash).toBe(first.contentHash);
    expect(reordered.fetchedAt).not.toBe(first.fetchedAt);
  });
});
