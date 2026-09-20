import { describe, expect, test } from "bun:test";
import { benchmarkSummaryLines } from "./usageReport";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");

function row(benchmarks?: Record<string, unknown>) {
  return benchmarks === undefined
    ? { ts: "2026-09-19T00:00:00.000Z", outcome: "advisor_response" }
    : {
        ts: "2026-09-19T00:00:00.000Z",
        outcome: "advisor_response",
        benchmarks,
      };
}

describe("benchmarkSummaryLines", () => {
  test("reports nothing without enriched rows", () => {
    expect(benchmarkSummaryLines([], NOW)).toEqual([]);
    expect(benchmarkSummaryLines([row(), row()], NOW)).toEqual([]);
  });

  test("summarizes sources, matches, snapshots, age, and verification", () => {
    const lines = benchmarkSummaryLines(
      [
        row(),
        row({
          source: "user",
          contentHash: "aa",
          fetchedAt: "2026-09-18T12:00:00.000Z",
          hashVerified: true,
          requesterMatch: "matched",
          advisorMatch: "matched",
          finalMatch: "matched",
        }),
        row({
          source: "user",
          contentHash: "aa",
          fetchedAt: "2026-09-17T12:00:00.000Z",
          hashVerified: true,
          requesterMatch: "unmapped",
          advisorMatch: "matched",
        }),
        row({
          source: "seed",
          contentHash: "bb",
          fetchedAt: "2026-09-10T12:00:00.000Z",
          hashVerified: false,
          requesterMatch: "matched",
          advisorMatch: "effort_unknown",
          finalMatch: "missing_record",
        }),
        row({
          source: "unavailable",
          requesterMatch: "unmapped",
          advisorMatch: "unmapped",
        }),
      ],
      NOW,
    );
    expect(lines).toContain(
      '- Benchmark sources: {"user":2,"seed":1,"unavailable":1}',
    );
    expect(lines).toContain('- Requester matches: {"matched":2,"unmapped":2}');
    expect(lines).toContain(
      '- Advisor default matches: {"matched":2,"effort_unknown":1,"unmapped":1}',
    );
    expect(lines).toContain(
      '- Final effort matches: {"matched":1,"missing_record":1}',
    );
    expect(lines).toContain("- Benchmark snapshots seen: 2");
    // Ages are 1, 2, and 9 days; the median of three is 2.0.
    expect(lines).toContain("- Median benchmark data age: 2.0 days");
    expect(lines).toContain("- Snapshots failing hash verification: 1");
  });

  test("ignores invalid and future timestamps in age math", () => {
    const lines = benchmarkSummaryLines(
      [
        row({
          source: "user",
          contentHash: "aa",
          fetchedAt: "not-a-date",
          requesterMatch: "matched",
          advisorMatch: "matched",
        }),
        row({
          source: "user",
          contentHash: "aa",
          fetchedAt: "2026-09-20T12:00:00.000Z",
          requesterMatch: "matched",
          advisorMatch: "matched",
        }),
      ],
      NOW,
    );
    expect(
      lines.some((line) => line.startsWith("- Median benchmark data age:")),
    ).toBe(false);
    expect(lines).toContain('- Benchmark sources: {"user":2}');
  });
});
