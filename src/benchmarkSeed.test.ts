import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBenchmarkMatcher, parseModelMappings } from "./benchmarkMatch";
import { parseBenchmarkSnapshot, verifySnapshotHash } from "./benchmarkTypes";

const DATA_DIR = join(import.meta.dir, "data");

describe("bundled benchmark seed", () => {
  test("ships a valid snapshot with a verified content hash", () => {
    const parsed = parseBenchmarkSnapshot(
      JSON.parse(
        readFileSync(
          join(DATA_DIR, "artificialAnalysis.snapshot.json"),
          "utf8",
        ),
      ),
    );
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(verifySnapshotHash(parsed)).toBe(true);
  });

  test("every bundled binding resolves to a snapshot record", () => {
    const snapshot = parseBenchmarkSnapshot(
      JSON.parse(
        readFileSync(
          join(DATA_DIR, "artificialAnalysis.snapshot.json"),
          "utf8",
        ),
      ),
    );
    expect("error" in snapshot).toBe(false);
    if ("error" in snapshot) return;
    const mappings = parseModelMappings(
      JSON.parse(
        readFileSync(
          join(DATA_DIR, "artificialAnalysis.mappings.json"),
          "utf8",
        ),
      ),
    );
    expect("error" in mappings).toBe(false);
    if ("error" in mappings) return;
    expect(mappings.bindings.length).toBeGreaterThan(0);
    const matcher = createBenchmarkMatcher({
      snapshot,
      bundled: mappings,
      local: null,
    });
    const failures: string[] = [];
    for (const binding of mappings.bindings) {
      const match = matcher.match({
        providerID: binding.providerID,
        modelID: binding.modelID,
        variant: binding.variant,
      });
      if (match.status !== "matched" || !match.record) {
        failures.push(
          `${binding.providerID}/${binding.modelID}#${binding.variant ?? "(unset)"}: ${match.status}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
