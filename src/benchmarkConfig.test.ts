import { describe, expect, test } from "bun:test";
import {
  BENCHMARK_MAPPINGS_PATH_ENV,
  BENCHMARKS_PATH_ENV,
  defaultBenchmarkSnapshotPath,
  resolveBenchmarkPaths,
  type ResolvedBenchmarkPaths,
} from "./benchmarkConfig";

const HOME = "/tmp/ocadvisor-test-home";

function asResolved(value: unknown): ResolvedBenchmarkPaths {
  if (typeof value !== "object" || value === null || "error" in value) {
    throw new Error(`expected resolved paths: ${JSON.stringify(value)}`);
  }
  return value as ResolvedBenchmarkPaths;
}

function asError(value: unknown): string {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    throw new Error(`expected a validation error: ${JSON.stringify(value)}`);
  }
  return (value as { error: string }).error;
}

describe("defaultBenchmarkSnapshotPath", () => {
  test("uses the home data directory when XDG is absent", () => {
    expect(defaultBenchmarkSnapshotPath({}, HOME)).toBe(
      `${HOME}/.local/share/opencode/ocadvisor/artificial-analysis.json`,
    );
  });

  test("honors an absolute XDG data directory", () => {
    expect(
      defaultBenchmarkSnapshotPath({ XDG_DATA_HOME: "/tmp/xdg" }, HOME),
    ).toBe("/tmp/xdg/opencode/ocadvisor/artificial-analysis.json");
  });

  test("ignores relative or blank XDG values", () => {
    expect(
      defaultBenchmarkSnapshotPath({ XDG_DATA_HOME: "relative/dir" }, HOME),
    ).toBe(`${HOME}/.local/share/opencode/ocadvisor/artificial-analysis.json`);
    expect(defaultBenchmarkSnapshotPath({ XDG_DATA_HOME: "  " }, HOME)).toBe(
      `${HOME}/.local/share/opencode/ocadvisor/artificial-analysis.json`,
    );
  });
});

describe("resolveBenchmarkPaths", () => {
  test("resolves defaults and derives mappings beside the snapshot", () => {
    const resolved = asResolved(resolveBenchmarkPaths(undefined, {}, HOME));
    expect(resolved.snapshotPath).toBe(
      `${HOME}/.local/share/opencode/ocadvisor/artificial-analysis.json`,
    );
    expect(resolved.mappingsPath).toBe(
      `${HOME}/.local/share/opencode/ocadvisor/model-mappings.json`,
    );
  });

  test("prefers explicit values over environment and defaults per field", () => {
    const resolved = asResolved(
      resolveBenchmarkPaths(
        { path: "/tmp/explicit/snapshot.json" },
        {
          [BENCHMARKS_PATH_ENV]: "/tmp/env/snapshot.json",
          [BENCHMARK_MAPPINGS_PATH_ENV]: "/tmp/env/mappings.json",
        },
        HOME,
      ),
    );
    expect(resolved.snapshotPath).toBe("/tmp/explicit/snapshot.json");
    expect(resolved.mappingsPath).toBe("/tmp/env/mappings.json");
  });

  test("prefers environment over defaults", () => {
    const resolved = asResolved(
      resolveBenchmarkPaths(
        {},
        { [BENCHMARKS_PATH_ENV]: "/tmp/env/snapshot.json" },
        HOME,
      ),
    );
    expect(resolved.snapshotPath).toBe("/tmp/env/snapshot.json");
    expect(resolved.mappingsPath).toBe("/tmp/env/model-mappings.json");
  });

  test("derives default mappings from a custom snapshot directory", () => {
    const resolved = asResolved(
      resolveBenchmarkPaths({ path: "/tmp/custom/snapshot.json" }, {}, HOME),
    );
    expect(resolved.mappingsPath).toBe("/tmp/custom/model-mappings.json");
  });

  test("accepts an explicit mappings path with a default snapshot", () => {
    const resolved = asResolved(
      resolveBenchmarkPaths({ mappingsPath: "/tmp/maps.json" }, {}, HOME),
    );
    expect(resolved.snapshotPath).toBe(
      `${HOME}/.local/share/opencode/ocadvisor/artificial-analysis.json`,
    );
    expect(resolved.mappingsPath).toBe("/tmp/maps.json");
  });

  test("treats blank values as unset and trims the rest", () => {
    const resolved = asResolved(
      resolveBenchmarkPaths(
        { path: "  ", mappingsPath: "  /tmp/maps.json  " },
        { [BENCHMARKS_PATH_ENV]: "	" },
        HOME,
      ),
    );
    expect(resolved.snapshotPath).toBe(
      `${HOME}/.local/share/opencode/ocadvisor/artificial-analysis.json`,
    );
    expect(resolved.mappingsPath).toBe("/tmp/maps.json");
  });

  test("rejects non-string and relative explicit paths", () => {
    expect(asError(resolveBenchmarkPaths({ path: 42 }, {}, HOME))).toContain(
      "absolute path",
    );
    expect(
      asError(resolveBenchmarkPaths({ path: "relative/file.json" }, {}, HOME)),
    ).toContain("absolute path");
    expect(
      asError(
        resolveBenchmarkPaths({ mappingsPath: "../maps.json" }, {}, HOME),
      ),
    ).toContain("absolute path");
    expect(
      asError(resolveBenchmarkPaths("/tmp/x.json" as unknown as {}, {}, HOME)),
    ).toContain("object");
    expect(
      asError(resolveBenchmarkPaths([] as unknown as {}, {}, HOME)),
    ).toContain("object");
  });

  test("rejects relative environment paths instead of resolving from cwd", () => {
    expect(
      asError(
        resolveBenchmarkPaths(
          {},
          { [BENCHMARKS_PATH_ENV]: "relative/snapshot.json" },
          HOME,
        ),
      ),
    ).toContain("absolute path");
  });
});
