import { describe, expect, test } from "bun:test";
import { buildBenchmarkEvidence } from "./benchmarkEvidence";
import {
  createBenchmarkMatcher,
  type BenchmarkMatcher,
  type ModelBinding,
  type ModelMappings,
} from "./benchmarkMatch";
import {
  computeSnapshotHash,
  type BenchmarkModel,
  type BenchmarkSnapshot,
} from "./benchmarkTypes";
import type { BenchmarkView } from "./benchmarkStore";
import type { AdvisorProfile, RequesterProfile } from "./modelProfiles";

// Synthetic fixtures with fake IDs and scores. Never published data.
const AA_REQUESTER = "synthetic-aa-1001";
const AA_ADVISOR = "synthetic-aa-2001";

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

function syntheticSnapshot(
  fetchedAt = "2026-09-10T00:00:00.000Z",
): BenchmarkSnapshot {
  const models = [
    syntheticRecord(AA_REQUESTER, {
      artificial_analysis_coding_index: 60,
      artificial_analysis_intelligence_index: 62,
      hle: 0.3,
      gpqa: 0.7,
    }),
    syntheticRecord(AA_ADVISOR, {
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
    fetchedAt,
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

function binding(
  modelID: string,
  variant: string | null,
  aaModelID: string,
  evaluatedEffort: string | null = "max",
): ModelBinding {
  return {
    providerID: "test-provider",
    modelID,
    variant,
    aaModelID,
    evaluatedEffort,
    evidenceURL: "https://artificialanalysis.ai/synthetic-evidence",
  };
}

function testView(
  snapshot: BenchmarkSnapshot | null,
  bindings: ModelBinding[] = [],
): BenchmarkView {
  const bundled: ModelMappings = { schemaVersion: 1, bindings: [] };
  const local: ModelMappings = { schemaVersion: 1, bindings };
  const matcher: BenchmarkMatcher = createBenchmarkMatcher({
    snapshot,
    bundled,
    local,
  });
  return {
    snapshot,
    snapshotSource: snapshot ? "user" : "unavailable",
    snapshotPath: snapshot ? "/tmp/synthetic.json" : null,
    snapshotNote: null,
    snapshotHashVerified: true,
    localMappings: bindings.length > 0 ? local : null,
    localMappingsNote: null,
    bundledMappings: bundled,
    bundledMappingsNote: null,
    matcher,
  };
}

function requester(
  overrides: Partial<RequesterProfile> = {},
): RequesterProfile {
  return {
    providerID: "test-provider",
    modelID: "requester-model",
    variant: "high",
    provenance: "invocation_message",
    ...overrides,
  };
}

function advisor(overrides: Partial<AdvisorProfile> = {}): AdvisorProfile {
  return {
    providerID: "test-provider",
    modelID: "advisor-model",
    policy: {
      kind: "candidates",
      candidates: ["high", "xhigh"],
      fallback: "xhigh",
    },
    ...overrides,
  };
}

describe("buildBenchmarkEvidence", () => {
  test("builds profiles, matches, and default-effort comparisons", () => {
    const view = testView(syntheticSnapshot(), [
      binding("requester-model", "high", AA_REQUESTER),
      binding("advisor-model", "high", AA_ADVISOR),
      binding("advisor-model", "xhigh", AA_ADVISOR),
    ]);
    const inputRequester = requester();
    const inputAdvisor = advisor();
    const evidence = buildBenchmarkEvidence({
      requester: inputRequester,
      advisor: inputAdvisor,
      view,
      nowMs: Date.parse("2026-09-19T12:00:00.000Z"),
    });

    expect(evidence.models.requester).toBe(inputRequester);
    expect(evidence.models.advisor).toBe(inputAdvisor);
    expect(evidence.benchmarks.source).toBe("user");
    expect(evidence.benchmarks.fetchedAt).toBe("2026-09-10T00:00:00.000Z");
    expect(evidence.benchmarks.ageDays).toBe(9);
    expect(evidence.benchmarks.contentHash).toBe(
      view.snapshot?.contentHash ?? null,
    );
    expect(evidence.benchmarks.hashVerified).toBe(true);
    expect(evidence.benchmarks.omitted).toBe(false);
    expect(evidence.benchmarks.requesterMatch).toMatchObject({
      status: "matched",
      source: "local",
      aaModelID: AA_REQUESTER,
      evaluatedEffort: "max",
    });
    expect(evidence.benchmarks.advisorDefaultMatch).toMatchObject({
      status: "matched",
      aaModelID: AA_ADVISOR,
    });
    expect(
      evidence.benchmarks.advisorCandidates.map((entry) => entry.effort),
    ).toEqual(["high", "xhigh"]);
    expect(
      evidence.benchmarks.advisorCandidates.every(
        (entry) => entry.status === "matched",
      ),
    ).toBe(true);

    const comparisons = evidence.benchmarks.comparisons;
    expect(comparisons.map((entry) => entry.key)).toEqual([
      "artificial_analysis_coding_index",
      "artificial_analysis_intelligence_index",
      "hle",
      "gpqa",
    ]);
    expect(comparisons[0]).toMatchObject({
      label: "Artificial Analysis Coding Index",
      requester: 60,
      advisor: 80,
      advisorMinusRequester: 20,
      comparable: true,
      reason: null,
    });
    expect(comparisons[3]).toMatchObject({
      requester: 0.7,
      advisor: null,
      comparable: false,
      reason: "missing_advisor",
    });
  });

  test("clamps future download timestamps to zero age", () => {
    const view = testView(syntheticSnapshot("2026-09-25T00:00:00.000Z"), [
      binding("requester-model", "high", AA_REQUESTER),
    ]);
    const evidence = buildBenchmarkEvidence({
      requester: requester(),
      advisor: advisor(),
      view,
      nowMs: Date.parse("2026-09-19T00:00:00.000Z"),
    });
    expect(evidence.benchmarks.ageDays).toBe(0);
  });

  test("represents a pinned effort as its own default", () => {
    const view = testView(syntheticSnapshot(), [
      binding("requester-model", "high", AA_REQUESTER),
      binding("advisor-model", "max", AA_ADVISOR),
    ]);
    const evidence = buildBenchmarkEvidence({
      requester: requester(),
      advisor: advisor({ policy: { kind: "pinned", effort: "max" } }),
      view,
    });
    expect(
      evidence.benchmarks.advisorCandidates.map((entry) => entry.effort),
    ).toEqual(["max"]);
    expect(evidence.benchmarks.advisorDefaultMatch.status).toBe("matched");
  });

  test("matches fixed efforts including an unset variant", () => {
    const view = testView(syntheticSnapshot(), [
      binding("requester-model", "high", AA_REQUESTER),
      binding("advisor-model", null, AA_ADVISOR, null),
    ]);
    const evidence = buildBenchmarkEvidence({
      requester: requester(),
      advisor: advisor({ policy: { kind: "fixed", effort: null } }),
      view,
    });
    expect(evidence.benchmarks.advisorCandidates).toHaveLength(1);
    expect(evidence.benchmarks.advisorCandidates[0]?.effort).toBeNull();
    expect(evidence.benchmarks.advisorDefaultMatch.status).toBe(
      "effort_unknown",
    );
    expect(
      evidence.benchmarks.comparisons.every(
        (entry) => entry.reason === "effort_unknown",
      ),
    ).toBe(true);
  });

  test("keeps identities while reporting missing coverage", () => {
    const view = testView(syntheticSnapshot(), [
      binding("advisor-model", "xhigh", AA_ADVISOR),
    ]);
    const evidence = buildBenchmarkEvidence({
      requester: requester({ providerID: null, modelID: null, variant: null }),
      advisor: advisor(),
      view,
    });
    expect(evidence.models.requester).toEqual({
      providerID: null,
      modelID: null,
      variant: null,
      provenance: "invocation_message",
    });
    expect(evidence.benchmarks.requesterMatch.status).toBe("unmapped");
    expect(
      evidence.benchmarks.comparisons.every(
        (entry) => entry.reason === "missing_requester",
      ),
    ).toBe(true);
    expect(
      evidence.benchmarks.advisorCandidates.map((entry) => entry.status),
    ).toEqual(["unmapped", "matched"]);
  });

  test("reports unavailable snapshots without scores", () => {
    const view = testView(null, [
      binding("requester-model", "high", AA_REQUESTER),
    ]);
    const evidence = buildBenchmarkEvidence({
      requester: requester(),
      advisor: advisor(),
      view,
    });
    expect(evidence.benchmarks.source).toBe("unavailable");
    expect(evidence.benchmarks.fetchedAt).toBeNull();
    expect(evidence.benchmarks.ageDays).toBeNull();
    expect(evidence.benchmarks.contentHash).toBeNull();
    expect(evidence.benchmarks.hashVerified).toBe(false);
    expect(evidence.benchmarks.requesterMatch.status).toBe("unavailable");
    expect(
      evidence.benchmarks.comparisons.every(
        (entry) =>
          entry.requester === null &&
          entry.advisor === null &&
          entry.comparable === false,
      ),
    ).toBe(true);
  });

  test("withholds deltas when evaluated efforts differ", () => {
    const view = testView(syntheticSnapshot(), [
      binding("requester-model", "high", AA_REQUESTER, "high"),
      binding("advisor-model", "xhigh", AA_ADVISOR, "max"),
      binding("advisor-model", "high", AA_ADVISOR, "high"),
    ]);
    const evidence = buildBenchmarkEvidence({
      requester: requester(),
      advisor: advisor(),
      view,
    });
    // Default effort xhigh was evaluated at max; the requester at high.
    expect(
      evidence.benchmarks.comparisons.every(
        (entry) => entry.reason === "effort_mismatch",
      ),
    ).toBe(true);
    expect(evidence.benchmarks.comparisons[0]?.requester).toBe(60);
    expect(
      evidence.benchmarks.comparisons[0]?.advisorMinusRequester,
    ).toBeNull();
  });
});
