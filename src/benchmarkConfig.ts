// Shared benchmark file locations for the plugin and the CLI. Explicit
// values win per field, then environment, then the data-directory default.
// Explicit paths must be absolute so refreshes never depend on the process
// working directory.
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { BenchmarkValidationError } from "./benchmarkTypes.js";

export const BENCHMARKS_PATH_ENV = "OCADVISOR_BENCHMARKS_PATH";
export const BENCHMARK_MAPPINGS_PATH_ENV = "OCADVISOR_BENCHMARK_MAPPINGS_PATH";
export const BENCHMARK_MATCH_ANY_PROVIDER_ENV =
  "OCADVISOR_BENCHMARKS_MATCH_ANY_PROVIDER";
export const DEFAULT_SNAPSHOT_FILENAME = "artificial-analysis.json";
export const DEFAULT_MAPPINGS_FILENAME = "model-mappings.json";

export interface BenchmarkPathOptions {
  path?: string;
  mappingsPath?: string;
  // Opt-in cross-provider fallback for model matching. Off by default.
  matchAnyProvider?: boolean;
}

export interface ResolvedBenchmarkPaths {
  snapshotPath: string;
  mappingsPath: string;
}

export function defaultBenchmarkSnapshotPath(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && isAbsolute(xdg)) {
    return join(xdg, "opencode/ocadvisor", DEFAULT_SNAPSHOT_FILENAME);
  }
  return join(
    homeDir,
    ".local/share/opencode/ocadvisor",
    DEFAULT_SNAPSHOT_FILENAME,
  );
}

function selectAbsolutePath(
  field: string,
  candidates: unknown[],
): string | BenchmarkValidationError {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== "string") {
      return { error: `${field} must be an absolute path` };
    }
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (!isAbsolute(trimmed)) {
      return { error: `${field} must be an absolute path` };
    }
    return trimmed;
  }
  return { error: `${field} has no usable value` };
}

export function resolveBenchmarkPaths(
  explicit: { path?: unknown; mappingsPath?: unknown } | null | undefined,
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
): ResolvedBenchmarkPaths | BenchmarkValidationError {
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== "object" || Array.isArray(explicit)) {
      return { error: "benchmarks must be an object with path options" };
    }
  }
  const wanted = explicit ?? {};
  const snapshotPath = selectAbsolutePath("benchmarks.path", [
    wanted.path,
    env[BENCHMARKS_PATH_ENV],
    defaultBenchmarkSnapshotPath(env, homeDir),
  ]);
  if (typeof snapshotPath !== "string") return snapshotPath;
  const mappingsPath = selectAbsolutePath("benchmarks.mappingsPath", [
    wanted.mappingsPath,
    env[BENCHMARK_MAPPINGS_PATH_ENV],
    join(dirname(snapshotPath), DEFAULT_MAPPINGS_FILENAME),
  ]);
  if (typeof mappingsPath !== "string") return mappingsPath;
  return { snapshotPath, mappingsPath };
}
