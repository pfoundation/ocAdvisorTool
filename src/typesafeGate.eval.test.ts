import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureState, liveEvidenceState } from "./typesafeGate.eval";

// The eval fixtures are synthetic: fake model IDs and scores for exercising
// the gate's wire-format evidence path. They are never shipped data.
const file = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures/typesafeGate.cases.json"),
    "utf8",
  ),
) as {
  note?: string;
  cases: Array<{
    id: string;
    expectation: "skip" | "proceed";
    state: { benchmarks?: unknown; liveEvidence?: unknown };
  }>;
};

describe("gate evaluation fixtures", () => {
  test("declares synthetic fixtures and covers benchmark scenarios", () => {
    expect(file.note ?? "").toContain("synthetic");
    const withBenchmarks = file.cases.filter((entry) => entry.state.benchmarks);
    const ids = withBenchmarks.map((entry) => entry.id);
    expect(ids).toContain("stronger-requester-review");
    expect(ids).toContain("weaker-requester-trivial");
    expect(ids).toContain("unknown-scores-stuck");
    expect(ids).toContain("stale-snapshot-review");
    expect(withBenchmarks.length).toBe(4);
  });

  test("keeps the original must-consult cases", () => {
    const ids = file.cases.map((entry) => entry.id);
    for (const id of [
      "routine-factual",
      "focused-review",
      "consequential-design",
      "difficult-debug",
      "ambiguous",
      "repeat-with-new-evidence",
    ]) {
      expect(ids).toContain(id);
    }
  });

  test("builds state with profiles and explicit coverage", () => {
    const caseEntry = file.cases.find(
      (entry) => entry.id === "unknown-scores-stuck",
    )!;
    const state = fixtureState(caseEntry as never);
    expect(state.models?.requester.modelID).toBe("synthetic-unmapped");
    expect(state.models?.advisor.policy.kind).toBe("candidates");
    expect(state.benchmarks?.source).toBe("user");
    expect(state.benchmarks?.requesterMatch.status).toBe("unmapped");
    expect(
      state.benchmarks?.comparisons.every(
        (entry) => entry.reason === "missing_requester",
      ),
    ).toBe(true);
    expect(state.benchmarks?.omitted).toBe(false);
  });

  test("resolves live-evidence cases against the Fable 5.2 advisor", async () => {
    const live = file.cases.filter((entry) => entry.state.liveEvidence);
    expect(live.length).toBe(5);
    expect(live.some((entry) => entry.expectation === "skip")).toBe(true);
    expect(live.some((entry) => entry.expectation === "proceed")).toBe(true);
    const opus = live.find(
      (entry) => entry.id === "fable-advisor-opus-design",
    )!;
    const state = await liveEvidenceState(opus as never);
    expect(state.models?.advisor.modelID).toBe("claude-fable-5-2");
    expect(state.models?.requester.modelID).toBe("claude-opus-5-5");
    expect(state.benchmarks?.source).toBe("seed");
    expect(state.benchmarks?.requesterMatch.status).toBe("matched");
    // Bound to the published record but awaiting a snapshot refresh.
    expect(state.benchmarks?.advisorDefaultMatch.status).toBe("missing_record");
    expect(state.benchmarks?.advisorDefaultMatch.aaModelID).toBe(
      "76942526-cc96-46b0-bc27-29561c53ed70",
    );
  });

  test("carries stale snapshot provenance", () => {
    const caseEntry = file.cases.find(
      (entry) => entry.id === "stale-snapshot-review",
    )!;
    const state = fixtureState(caseEntry as never);
    expect(state.benchmarks?.ageDays).toBe(141);
    expect(state.benchmarks?.comparisons[0]?.comparable).toBe(true);
  });

  test("leaves unenriched cases without benchmark evidence", () => {
    const caseEntry = file.cases.find(
      (entry) => entry.id === "routine-factual",
    )!;
    const state = fixtureState(caseEntry as never);
    expect(state.models).toBeNull();
    expect(state.benchmarks).toBeNull();
    expect(state.coverage.benchmarksOmitted).toBe(false);
  });
});
