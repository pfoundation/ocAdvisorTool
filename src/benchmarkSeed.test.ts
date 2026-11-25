import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBenchmarkMatcher, parseModelMappings } from "./benchmarkMatch";
import { parseBenchmarkSnapshot, verifySnapshotHash } from "./benchmarkTypes";

const DATA_DIR = join(import.meta.dir, "data");

// Claude Fable 5.2 records pinned in scripts/buildBenchmarkData.ts: published
// after the bundled snapshot, so their bindings resolve only after a refresh.
// Drop entries here once a refreshed snapshot contains them.
const PENDING_RECORDS = new Set([
  "593f2d23-247b-41c9-a679-cebd225f0a9a",
  "76942526-cc96-46b0-bc27-29561c53ed70",
  "fdc1913b-9497-45ef-83f7-17dae756f37e",
  "0c9b4e05-9259-42cc-b40e-d6acbbeaa7e8",
  "cfc7acb1-d903-4858-9b6c-6c7776caf8f9",
]);

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

  test("every bundled binding resolves to a snapshot record or is pending", () => {
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
      if (PENDING_RECORDS.has(binding.aaModelID)) {
        if (match.status !== "missing_record") {
          failures.push(
            `${binding.providerID}/${binding.modelID}#${binding.variant ?? "(unset)"}: pending record is now ${match.status}; drop it from PENDING_RECORDS`,
          );
        }
        continue;
      }
      if (match.status !== "matched" || !match.record) {
        failures.push(
          `${binding.providerID}/${binding.modelID}#${binding.variant ?? "(unset)"}: ${match.status}`,
        );
      }
    }
    expect(failures).toEqual([]);
    expect(
      mappings.bindings.some((binding) =>
        PENDING_RECORDS.has(binding.aaModelID),
      ),
    ).toBe(true);
  });
});
