import { describe, expect, test } from "bun:test";
import {
  BENCHMARK_SCHEMA_VERSION,
  BENCHMARK_SOURCE,
  BENCHMARK_SOURCE_URL,
  GATE_METRIC_ORDER,
  RECOGNIZED_METRICS,
  computeSnapshotHash,
  parseBenchmarkModel,
  parseBenchmarkSnapshot,
  verifySnapshotHash,
  type BenchmarkModel,
  type BenchmarkSnapshot,
} from "./benchmarkTypes";

// All fixtures below are synthetic: fake stable IDs, names, and scores that
// must never be mistaken for published Artificial Analysis data.
const SYNTHETIC_ID_A = "synthetic-aa-0001";
const SYNTHETIC_ID_B = "synthetic-aa-0002";

function syntheticModel(
  overrides: Partial<BenchmarkModel> = {},
): BenchmarkModel {
  return {
    id: SYNTHETIC_ID_A,
    creatorID: "synthetic-creator-1",
    name: "Synthetic Model A",
    slug: "synthetic-model-a",
    evaluatedEffort: null,
    evaluatedAt: null,
    evaluations: {
      artificial_analysis_coding_index: 42.5,
      artificial_analysis_intelligence_index: 43.5,
      hle: 0.123,
      gpqa: null,
    },
    ...overrides,
  };
}

function syntheticSnapshot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const models = (overrides.models as BenchmarkModel[] | undefined) ?? [
    syntheticModel(),
  ];
  const base = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    source: BENCHMARK_SOURCE,
    sourceURL: BENCHMARK_SOURCE_URL,
    endpoint: "https://artificialanalysis.ai/api/v2/data/llms/models",
    fetchedAt: "2026-09-19T00:00:00.000Z",
    methodologyVersion: null,
    metricDefinitions: [...RECOGNIZED_METRICS],
    models,
    ...overrides,
  };
  const hash = computeSnapshotHash({
    source: base.source as string,
    endpoint: base.endpoint as string,
    methodologyVersion: base.methodologyVersion as string | null,
    models: base.models as BenchmarkModel[],
  });
  return "contentHash" in overrides
    ? { ...base, contentHash: overrides.contentHash }
    : { ...base, contentHash: hash };
}

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

describe("recognized metrics", () => {
  test("orders coding, intelligence, then reasoning/math metrics", () => {
    expect(RECOGNIZED_METRICS.map((metric) => metric.key)).toEqual([
      "artificial_analysis_coding_index",
      "artificial_analysis_intelligence_index",
      "hle",
      "gpqa",
      "artificial_analysis_math_index",
    ]);
    expect([...GATE_METRIC_ORDER]).toEqual(
      RECOGNIZED_METRICS.map((metric) => metric.key),
    );
  });

  test("keeps published labels with separate index and fraction units", () => {
    const byKey = new Map(
      RECOGNIZED_METRICS.map((metric) => [metric.key, metric]),
    );
    expect(byKey.get("artificial_analysis_coding_index")).toMatchObject({
      label: "Artificial Analysis Coding Index",
      category: "coding",
      unit: "index_points",
      higherIsBetter: true,
    });
    expect(byKey.get("artificial_analysis_intelligence_index")).toMatchObject({
      label: "Artificial Analysis Intelligence Index",
      category: "general",
      unit: "index_points",
      higherIsBetter: true,
    });
    expect(byKey.get("hle")).toMatchObject({
      category: "reasoning",
      unit: "fraction",
    });
    expect(byKey.get("gpqa")).toMatchObject({
      category: "reasoning",
      unit: "fraction",
    });
  });
});

describe("parseBenchmarkSnapshot", () => {
  test("accepts a complete snapshot", () => {
    const parsed = asSnapshot(parseBenchmarkSnapshot(syntheticSnapshot()));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]?.evaluations).toEqual({
      artificial_analysis_coding_index: 42.5,
      artificial_analysis_intelligence_index: 43.5,
      hle: 0.123,
      gpqa: null,
    });
  });

  test("preserves zero scores instead of dropping them", () => {
    const parsed = asSnapshot(
      parseBenchmarkSnapshot(
        syntheticSnapshot({
          models: [
            syntheticModel({
              evaluations: {
                artificial_analysis_coding_index: 0,
                hle: 0,
              },
            }),
          ],
        }),
      ),
    );
    expect(parsed.models[0]?.evaluations).toEqual({
      artificial_analysis_coding_index: 0,
      hle: 0,
    });
  });

  test("preserves unknown finite evaluation fields for forward compatibility", () => {
    const parsed = asSnapshot(
      parseBenchmarkSnapshot(
        syntheticSnapshot({
          models: [
            syntheticModel({
              evaluations: {
                artificial_analysis_coding_index: 42.5,
                synthetic_future_benchmark: 0.77,
                synthetic_future_missing: null,
              },
            }),
          ],
        }),
      ),
    );
    expect(parsed.models[0]?.evaluations).toEqual({
      artificial_analysis_coding_index: 42.5,
      synthetic_future_benchmark: 0.77,
      synthetic_future_missing: null,
    });
  });

  test("ignores unknown evaluation values that are not finite numbers", () => {
    const parsed = asSnapshot(
      parseBenchmarkSnapshot(
        syntheticSnapshot({
          models: [
            syntheticModel({
              evaluations: {
                artificial_analysis_coding_index: 42.5,
                synthetic_string_field: "n/a",
                synthetic_nan_field: Number.NaN,
              } as unknown as Record<string, number | null>,
            }),
          ],
        }),
      ),
    );
    expect(parsed.models[0]?.evaluations).toEqual({
      artificial_analysis_coding_index: 42.5,
    });
  });

  test("rejects non-objects and unsupported schema versions", () => {
    expect(asError(parseBenchmarkSnapshot(null))).toContain("object");
    expect(asError(parseBenchmarkSnapshot([]))).toContain("object");
    expect(
      asError(parseBenchmarkSnapshot(syntheticSnapshot({ schemaVersion: 2 }))),
    ).toContain("schema version");
    expect(
      asError(
        parseBenchmarkSnapshot(syntheticSnapshot({ schemaVersion: "1" })),
      ),
    ).toContain("schema version");
  });

  test("rejects wrong source and malformed envelope fields", () => {
    expect(
      asError(parseBenchmarkSnapshot(syntheticSnapshot({ source: "other" }))),
    ).toContain("artificial-analysis");
    expect(
      asError(parseBenchmarkSnapshot(syntheticSnapshot({ endpoint: "  " }))),
    ).toContain("endpoint");
    expect(
      asError(parseBenchmarkSnapshot(syntheticSnapshot({ fetchedAt: "soon" }))),
    ).toContain("fetchedAt");
    expect(
      asError(
        parseBenchmarkSnapshot(syntheticSnapshot({ contentHash: "abc" })),
      ),
    ).toContain("contentHash");
  });

  test("rejects empty and duplicate model datasets", () => {
    expect(
      asError(parseBenchmarkSnapshot(syntheticSnapshot({ models: [] }))),
    ).toContain("empty");
    expect(
      asError(
        parseBenchmarkSnapshot(
          syntheticSnapshot({
            models: [syntheticModel(), syntheticModel()],
          }),
        ),
      ),
    ).toContain("duplicate");
  });

  test("rejects datasets with no usable recognized scores", () => {
    expect(
      asError(
        parseBenchmarkSnapshot(
          syntheticSnapshot({
            models: [
              syntheticModel({ id: SYNTHETIC_ID_A, evaluations: {} }),
              syntheticModel({
                id: SYNTHETIC_ID_B,
                evaluations: { gpqa: null },
              }),
            ],
          }),
        ),
      ),
    ).toContain("usable");
  });

  test("rejects malformed model identities", () => {
    expect(
      asError(
        parseBenchmarkSnapshot(
          syntheticSnapshot({ models: [syntheticModel({ id: "" })] }),
        ),
      ),
    ).toContain("id");
    expect(
      asError(
        parseBenchmarkSnapshot(
          syntheticSnapshot({ models: [syntheticModel({ creatorID: " " })] }),
        ),
      ),
    ).toContain("creator");
  });

  test("rejects invalid recognized scores", () => {
    expect(
      asError(
        parseBenchmarkSnapshot(
          syntheticSnapshot({
            models: [
              syntheticModel({
                evaluations: {
                  artificial_analysis_coding_index: "high" as unknown as number,
                },
              }),
            ],
          }),
        ),
      ),
    ).toContain("artificial_analysis_coding_index");
    expect(
      asError(
        parseBenchmarkSnapshot(
          syntheticSnapshot({
            models: [
              syntheticModel({
                evaluations: { hle: Number.POSITIVE_INFINITY },
              }),
            ],
          }),
        ),
      ),
    ).toContain("hle");
  });

  test("rejects malformed metric definitions", () => {
    expect(
      asError(
        parseBenchmarkSnapshot(
          syntheticSnapshot({
            metricDefinitions: [
              ...RECOGNIZED_METRICS,
              { ...RECOGNIZED_METRICS[0], label: "Duplicate key" },
            ],
          }),
        ),
      ),
    ).toContain("duplicate");
    expect(
      asError(
        parseBenchmarkSnapshot(
          syntheticSnapshot({
            metricDefinitions: [{ ...RECOGNIZED_METRICS[0], unit: "stars" }],
          }),
        ),
      ),
    ).toContain("unit");
  });
});

describe("parseBenchmarkModel", () => {
  test("names the failing entry in errors", () => {
    expect(asError(parseBenchmarkModel(null, "entry 3"))).toContain("entry 3");
    expect(
      asError(parseBenchmarkModel(syntheticModel({ id: "" }), "entry 3")),
    ).toContain("entry 3");
  });
});

describe("snapshot hashing", () => {
  test("is deterministic across key order and formatting", () => {
    const model = syntheticModel();
    // Same content, reverse insertion order at every level.
    const reordered: BenchmarkModel = {
      evaluations: Object.fromEntries(
        Object.entries(model.evaluations).reverse(),
      ),
      evaluatedAt: model.evaluatedAt,
      evaluatedEffort: model.evaluatedEffort,
      slug: model.slug,
      name: model.name,
      creatorID: model.creatorID,
      id: model.id,
    };
    const input = {
      source: BENCHMARK_SOURCE,
      endpoint: "https://artificialanalysis.ai/api/v2/data/llms/models",
      methodologyVersion: null,
    };
    expect(computeSnapshotHash({ ...input, models: [model] })).toBe(
      computeSnapshotHash({ ...input, models: [reordered] }),
    );
  });

  test("changes when scores change but ignores download time", () => {
    const first = asSnapshot(parseBenchmarkSnapshot(syntheticSnapshot()));
    const rescored = asSnapshot(
      parseBenchmarkSnapshot(
        syntheticSnapshot({
          models: [
            syntheticModel({
              evaluations: { artificial_analysis_coding_index: 99.9 },
            }),
          ],
        }),
      ),
    );
    expect(rescored.contentHash).not.toBe(first.contentHash);
    const refetchedAt = { ...first, fetchedAt: "2026-10-01T00:00:00.000Z" };
    expect(verifySnapshotHash(refetchedAt)).toBe(true);
  });

  test("detects tampered snapshot content", () => {
    const parsed = asSnapshot(parseBenchmarkSnapshot(syntheticSnapshot()));
    expect(verifySnapshotHash(parsed)).toBe(true);
    const tampered: BenchmarkSnapshot = {
      ...parsed,
      models: [{ ...parsed.models[0]!, evaluations: { hle: 0.999 } }],
    };
    expect(verifySnapshotHash(tampered)).toBe(false);
  });
});
