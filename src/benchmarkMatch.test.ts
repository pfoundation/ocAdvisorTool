import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  compareBenchmarks,
  createBenchmarkMatcher,
  parseModelMappings,
  selectGateMetrics,
  type ModelMappings,
} from "./benchmarkMatch";
import {
  computeSnapshotHash,
  type BenchmarkModel,
  type BenchmarkSnapshot,
} from "./benchmarkTypes";

// Synthetic fixtures: fake stable IDs and scores. Never published data.
const AA_A = "synthetic-aa-1001";
const AA_B = "synthetic-aa-2001";

function syntheticRecord(
  id: string,
  evaluations: Record<string, number | null>,
): BenchmarkModel {
  return {
    id,
    creatorID: "synthetic-creator-9",
    name: `Synthetic Model ${id}`,
    slug: `synthetic-${id}`,
    evaluatedEffort: null,
    evaluatedAt: null,
    evaluations,
  };
}

function syntheticSnapshot(): BenchmarkSnapshot {
  const models = [
    syntheticRecord(AA_A, {
      artificial_analysis_coding_index: 60,
      artificial_analysis_intelligence_index: 62,
      hle: 0.3,
      gpqa: 0.7,
    }),
    syntheticRecord(AA_B, {
      artificial_analysis_coding_index: 80,
      artificial_analysis_intelligence_index: 82,
      hle: 0.6,
      gpqa: null,
    }),
  ];
  return {
    schemaVersion: 1,
    source: "artificial-analysis",
    sourceURL: "https://artificialanalysis.ai/",
    endpoint: "https://artificialanalysis.ai/api/v2/data/llms/models",
    fetchedAt: "2026-09-19T00:00:00.000Z",
    contentHash: computeSnapshotHash({
      source: "artificial-analysis",
      endpoint: "https://artificialanalysis.ai/api/v2/data/llms/models",
      methodologyVersion: null,
      models,
    }),
    methodologyVersion: null,
    metricDefinitions: [],
    models,
  };
}

function bundledMappings(): ModelMappings {
  return {
    schemaVersion: 1,
    bindings: [
      {
        providerID: "test-provider",
        modelID: "model-a",
        variant: "high",
        aaModelID: AA_A,
        evaluatedEffort: "high",
        evidenceURL: "https://artificialanalysis.ai/synthetic-evidence",
      },
      {
        providerID: "test-provider",
        modelID: "nested/model-b",
        variant: null,
        aaModelID: AA_B,
        evaluatedEffort: null,
        evidenceURL: "https://artificialanalysis.ai/synthetic-evidence",
      },
    ],
  };
}

function localMappings(): ModelMappings {
  return {
    schemaVersion: 1,
    bindings: [
      {
        providerID: "test-provider",
        modelID: "model-a",
        variant: "high",
        aaModelID: AA_B,
        evaluatedEffort: "max",
        evidenceURL: "https://artificialanalysis.ai/synthetic-local",
      },
      {
        providerID: "test-provider",
        modelID: "model-c",
        variant: "max",
        aaModelID: AA_A,
        evaluatedEffort: "max",
        evidenceURL: "https://artificialanalysis.ai/synthetic-local",
      },
      {
        providerID: "test-provider",
        modelID: "model-d",
        variant: "high",
        aaModelID: AA_B,
        evaluatedEffort: "high",
        evidenceURL: "https://artificialanalysis.ai/synthetic-local",
      },
    ],
  };
}

function asMappings(value: unknown): ModelMappings {
  if (typeof value !== "object" || value === null || "error" in value) {
    throw new Error(`expected mappings: ${JSON.stringify(value)}`);
  }
  return value as ModelMappings;
}

function asError(value: unknown): string {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    throw new Error(`expected a validation error: ${JSON.stringify(value)}`);
  }
  return (value as { error: string }).error;
}

describe("parseModelMappings", () => {
  test("accepts named and unset variants", () => {
    const parsed = asMappings(parseModelMappings(bundledMappings()));
    expect(parsed.bindings).toHaveLength(2);
    expect(parsed.bindings[1]?.variant).toBeNull();
  });

  test("accepts an empty binding list", () => {
    const parsed = asMappings(
      parseModelMappings({ schemaVersion: 1, bindings: [] }),
    );
    expect(parsed.bindings).toEqual([]);
  });

  test("trims surrounding whitespace on identity fields", () => {
    const parsed = asMappings(
      parseModelMappings({
        schemaVersion: 1,
        bindings: [
          {
            providerID: "  test-provider ",
            modelID: "model-a",
            variant: " high ",
            aaModelID: AA_A,
            evaluatedEffort: " high ",
            evidenceURL: "https://artificialanalysis.ai/synthetic-evidence",
          },
        ],
      }),
    );
    expect(parsed.bindings[0]).toMatchObject({
      providerID: "test-provider",
      variant: "high",
      evaluatedEffort: "high",
    });
  });

  test("treats omitted variant and effort as unset", () => {
    const parsed = asMappings(
      parseModelMappings({
        schemaVersion: 1,
        bindings: [
          {
            providerID: "test-provider",
            modelID: "model-a",
            aaModelID: AA_A,
            evidenceURL: "https://artificialanalysis.ai/synthetic-evidence",
          },
        ],
      }),
    );
    expect(parsed.bindings[0]?.variant).toBeNull();
    expect(parsed.bindings[0]?.evaluatedEffort).toBeNull();
  });

  test("rejects malformed files and bindings", () => {
    expect(asError(parseModelMappings(null))).toContain("object");
    expect(
      asError(parseModelMappings({ schemaVersion: 2, bindings: [] })),
    ).toContain("schema version");
    expect(
      asError(parseModelMappings({ schemaVersion: 1, bindings: {} })),
    ).toContain("array");
    const bad = (binding: Record<string, unknown>, fragment: string) =>
      expect(
        asError(parseModelMappings({ schemaVersion: 1, bindings: [binding] })),
      ).toContain(fragment);
    const good = bundledMappings().bindings[0]!;
    bad({ ...good, providerID: "  " }, "providerID");
    bad({ ...good, modelID: "" }, "modelID");
    bad({ ...good, variant: 42 }, "variant");
    bad({ ...good, variant: "" }, "variant");
    bad({ ...good, aaModelID: "" }, "aaModelID");
    bad({ ...good, evaluatedEffort: "" }, "evaluatedEffort");
    bad({ ...good, evidenceURL: "not-a-url" }, "evidenceURL");
  });

  test("rejects duplicate tuples including unset variants", () => {
    const bundled = bundledMappings();
    expect(
      asError(
        parseModelMappings({
          schemaVersion: 1,
          bindings: [bundled.bindings[0], { ...bundled.bindings[0] }],
        }),
      ),
    ).toContain("duplicate");
    expect(
      asError(
        parseModelMappings({
          schemaVersion: 1,
          bindings: [bundled.bindings[1], { ...bundled.bindings[1] }],
        }),
      ),
    ).toContain("duplicate");
  });
});

describe("benchmark matching", () => {
  test("matches exact tuples including nested gateway model IDs", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: bundledMappings(),
      local: null,
    });
    const direct = matcher.match({
      providerID: "test-provider",
      modelID: "model-a",
      variant: "high",
    });
    expect(direct.status).toBe("matched");
    expect(direct.source).toBe("bundled");
    expect(direct.aaModelID).toBe(AA_A);
    expect(direct.record?.evaluations.artificial_analysis_coding_index).toBe(
      60,
    );

    const nested = matcher.match({
      providerID: "test-provider",
      modelID: "nested/model-b",
      variant: null,
    });
    expect(nested.status).toBe("effort_unknown");
    expect(nested.record?.id).toBe(AA_B);
  });

  test("treats an unset variant as its own key, never a wildcard", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: bundledMappings(),
      local: null,
    });
    // model-a is bound only for "high".
    expect(
      matcher.match({
        providerID: "test-provider",
        modelID: "model-a",
        variant: null,
      }).status,
    ).toBe("unmapped");
    // nested/model-b is bound only for unset.
    expect(
      matcher.match({
        providerID: "test-provider",
        modelID: "nested/model-b",
        variant: "high",
      }).status,
    ).toBe("unmapped");
  });

  test("matches case-sensitively without prefix stripping", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: bundledMappings(),
      local: null,
    });
    expect(
      matcher.match({
        providerID: "Test-Provider",
        modelID: "model-a",
        variant: "high",
      }).status,
    ).toBe("unmapped");
    expect(
      matcher.match({
        providerID: "test-provider",
        modelID: "model-b",
        variant: null,
      }).status,
    ).toBe("unmapped");
  });

  test("prefers local bindings over bundled ones for the same tuple", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: bundledMappings(),
      local: localMappings(),
    });
    const overridden = matcher.match({
      providerID: "test-provider",
      modelID: "model-a",
      variant: "high",
    });
    expect(overridden.status).toBe("matched");
    expect(overridden.source).toBe("local");
    expect(overridden.aaModelID).toBe(AA_B);
    // Untouched bundled tuples still resolve from the bundle.
    const kept = matcher.match({
      providerID: "test-provider",
      modelID: "nested/model-b",
      variant: null,
    });
    expect(kept.source).toBe("bundled");
    expect(
      matcher.bindings().filter((entry) => entry.source === "local"),
    ).toHaveLength(3);
  });

  test("covers new models locally with no source change", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: { schemaVersion: 1, bindings: [] },
      local: localMappings(),
    });
    const added = matcher.match({
      providerID: "test-provider",
      modelID: "model-c",
      variant: "max",
    });
    expect(added.status).toBe("matched");
    expect(added.source).toBe("local");
    expect(added.record?.id).toBe(AA_A);
  });

  test("reports bindings that point at missing snapshot records", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: {
        schemaVersion: 1,
        bindings: [
          {
            providerID: "test-provider",
            modelID: "model-gone",
            variant: "high",
            aaModelID: "synthetic-aa-9999",
            evaluatedEffort: "high",
            evidenceURL: "https://artificialanalysis.ai/synthetic-evidence",
          },
        ],
      },
      local: null,
    });
    const missing = matcher.match({
      providerID: "test-provider",
      modelID: "model-gone",
      variant: "high",
    });
    expect(missing.status).toBe("missing_record");
    expect(missing.aaModelID).toBe("synthetic-aa-9999");
    expect(missing.record).toBeNull();
  });

  test("reports unavailable when no snapshot is loaded", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: null,
      bundled: bundledMappings(),
      local: null,
    });
    const match = matcher.match({
      providerID: "test-provider",
      modelID: "model-a",
      variant: "high",
    });
    expect(match.status).toBe("unavailable");
    expect(match.aaModelID).toBe(AA_A);
    expect(match.record).toBeNull();
  });
});

describe("benchmark comparisons", () => {
  function matchedPair() {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: { schemaVersion: 1, bindings: [] },
      local: localMappings(),
    });
    // model-c/max -> AA_A evaluated at max; model-a/high -> AA_B at max
    // after the local override. Same evaluated effort, different records.
    const requester = matcher.match({
      providerID: "test-provider",
      modelID: "model-c",
      variant: "max",
    });
    const advisor = matcher.match({
      providerID: "test-provider",
      modelID: "model-a",
      variant: "high",
    });
    expect(requester.status).toBe("matched");
    expect(advisor.status).toBe("matched");
    return { requester, advisor };
  }

  test("computes oriented deltas without strength labels", () => {
    const { requester, advisor } = matchedPair();
    const compared = compareBenchmarks(requester, advisor);
    expect(compared.map((entry) => entry.key)).toEqual([
      "artificial_analysis_coding_index",
      "artificial_analysis_intelligence_index",
      "hle",
      "gpqa",
      "artificial_analysis_math_index",
    ]);
    const coding = compared[0]!;
    expect(coding).toMatchObject({
      requester: 60,
      advisor: 80,
      advisorMinusRequester: 20,
      comparable: true,
      reason: null,
    });
    const hle = compared[2]!;
    expect(hle.requester).toBe(0.3);
    expect(hle.advisor).toBe(0.6);
    expect(hle.advisorMinusRequester).toBeCloseTo(0.3, 10);
    expect(hle.comparable).toBe(true);
  });

  test("keeps scores while flagging missing sides", () => {
    const { requester, advisor } = matchedPair();
    const compared = compareBenchmarks(requester, advisor);
    const gpqa = compared.find((entry) => entry.key === "gpqa")!;
    expect(gpqa.requester).toBe(0.7);
    expect(gpqa.advisor).toBeNull();
    expect(gpqa.advisorMinusRequester).toBeNull();
    expect(gpqa.comparable).toBe(false);
    expect(gpqa.reason).toBe("missing_advisor");
    const math = compared.find(
      (entry) => entry.key === "artificial_analysis_math_index",
    )!;
    expect(math.reason).toBe("missing_requester");
  });

  test("withholds deltas on effort mismatches and unknown efforts", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: bundledMappings(),
      local: localMappings(),
    });
    // Bundled model-a/high (effort high) vs local model-c/max (effort max).
    const bundledOnly = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: bundledMappings(),
      local: null,
    });
    const high = bundledOnly.match({
      providerID: "test-provider",
      modelID: "model-a",
      variant: "high",
    });
    const max = matcher.match({
      providerID: "test-provider",
      modelID: "model-c",
      variant: "max",
    });
    const mismatched = compareBenchmarks(high, max);
    expect(mismatched.every((entry) => entry.comparable === false)).toBe(true);
    expect(
      mismatched.every((entry) => entry.reason === "effort_mismatch"),
    ).toBe(true);
    expect(mismatched[0]?.requester).toBe(60);

    const unknown = matcher.match({
      providerID: "test-provider",
      modelID: "nested/model-b",
      variant: null,
    });
    const unlabeled = compareBenchmarks(unknown, max);
    expect(unlabeled.every((entry) => entry.reason === "effort_unknown")).toBe(
      true,
    );
    expect(unlabeled[0]?.requester).toBe(80);
    expect(unlabeled[0]?.advisorMinusRequester).toBeNull();
  });

  test("compares through the matcher convenience helper", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: { schemaVersion: 1, bindings: [] },
      local: localMappings(),
    });
    const direct = matcher.compare(
      { providerID: "test-provider", modelID: "model-c", variant: "max" },
      { providerID: "test-provider", modelID: "model-a", variant: "high" },
    );
    const { requester, advisor } = matchedPair();
    expect(direct).toEqual(compareBenchmarks(requester, advisor));
  });
});

describe("gate metric selection", () => {
  test("keeps both indexes plus the first two metrics with data", () => {
    const matcher = createBenchmarkMatcher({
      snapshot: syntheticSnapshot(),
      bundled: { schemaVersion: 1, bindings: [] },
      local: localMappings(),
    });
    const { requester, advisor } = {
      requester: matcher.match({
        providerID: "test-provider",
        modelID: "model-c",
        variant: "max",
      }),
      advisor: matcher.match({
        providerID: "test-provider",
        modelID: "model-a",
        variant: "high",
      }),
    };
    const selected = selectGateMetrics(compareBenchmarks(requester, advisor));
    expect(selected.map((entry) => entry.key)).toEqual([
      "artificial_analysis_coding_index",
      "artificial_analysis_intelligence_index",
      "hle",
      "gpqa",
    ]);
  });

  test("skips empty reasoning metrics while keeping the indexes", () => {
    const empty: BenchmarkSnapshot = {
      ...syntheticSnapshot(),
      models: [
        syntheticRecord("synthetic-aa-3001", {
          artificial_analysis_coding_index: 10,
        }),
        syntheticRecord("synthetic-aa-3002", {
          artificial_analysis_intelligence_index: 20,
        }),
      ],
    };
    const rescored = createBenchmarkMatcher({
      snapshot: empty,
      bundled: { schemaVersion: 1, bindings: [] },
      local: {
        schemaVersion: 1,
        bindings: [
          {
            providerID: "t",
            modelID: "r",
            variant: "h",
            aaModelID: "synthetic-aa-3001",
            evaluatedEffort: "h",
            evidenceURL: "https://artificialanalysis.ai/s",
          },
          {
            providerID: "t",
            modelID: "a",
            variant: "h",
            aaModelID: "synthetic-aa-3002",
            evaluatedEffort: "h",
            evidenceURL: "https://artificialanalysis.ai/s",
          },
        ],
      },
    });
    const selected = selectGateMetrics(
      rescored.compare(
        { providerID: "t", modelID: "r", variant: "h" },
        { providerID: "t", modelID: "a", variant: "h" },
      ),
    );
    expect(selected.map((entry) => entry.key)).toEqual([
      "artificial_analysis_coding_index",
      "artificial_analysis_intelligence_index",
    ]);
  });
});

describe("bundled mappings", () => {
  test("ships a valid mapping file where every binding carries evidence", () => {
    const raw = readFileSync(
      join(import.meta.dir, "data/artificialAnalysis.mappings.json"),
      "utf8",
    );
    const parsed = asMappings(parseModelMappings(JSON.parse(raw)));
    for (const binding of parsed.bindings) {
      expect(binding.evidenceURL).toMatch(/^https:\/\//);
    }
  });
});
