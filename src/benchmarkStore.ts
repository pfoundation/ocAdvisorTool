// Local benchmark reader with hot reload: one store per plugin setup
// watches the user snapshot and mappings files, serves a consistent
// immutable view per consultation, and falls back through last-good data
// to the bundled seed. Reload detection keys on file identity
// (device/inode/size/mtime), so atomic replacements are observed even
// when size and mtime are unchanged. The read path performs no network
// I/O and never throws for missing or invalid data.
import { open, stat as nodeStat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBenchmarkMatcher,
  parseModelMappings,
  type BenchmarkMatcher,
  type ModelMappings,
} from "./benchmarkMatch.js";
import {
  parseBenchmarkSnapshot,
  verifySnapshotHash,
  type BenchmarkSnapshot,
  type BenchmarkValidationError,
} from "./benchmarkTypes.js";

export const BENCHMARK_READ_MAX_BYTES = 16 * 1024 * 1024;
export const BENCHMARK_FILE_TOO_LARGE = "BENCHMARK_FILE_TOO_LARGE";
const READ_ATTEMPTS = 3;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEED_SNAPSHOT_PATH = join(
  MODULE_DIR,
  "data",
  "artificialAnalysis.snapshot.json",
);
export const DEFAULT_SEED_MAPPINGS_PATH = join(
  MODULE_DIR,
  "data",
  "artificialAnalysis.mappings.json",
);

export interface BenchmarkFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface BenchmarkFileSystem {
  stat(path: string): Promise<BenchmarkFileIdentity | null>;
  read(path: string): Promise<string>;
}

export type BenchmarkDataSource = "user" | "seed" | "unavailable";

export interface BenchmarkView {
  snapshot: BenchmarkSnapshot | null;
  snapshotSource: BenchmarkDataSource;
  snapshotPath: string | null;
  snapshotNote: string | null;
  snapshotHashVerified: boolean;
  localMappings: ModelMappings | null;
  localMappingsNote: string | null;
  bundledMappings: ModelMappings;
  bundledMappingsNote: string | null;
  matcher: BenchmarkMatcher;
}

export interface BenchmarkStoreOptions {
  snapshotPath: string;
  mappingsPath: string;
  seedSnapshotPath?: string;
  seedMappingsPath?: string;
  fs?: BenchmarkFileSystem;
  maxBytes?: number;
  matchAnyProvider?: boolean;
}

export interface BenchmarkStore {
  readonly snapshotPath: string;
  readonly mappingsPath: string;
  view(): Promise<BenchmarkView>;
}

function defaultFileSystem(maxBytes: number): BenchmarkFileSystem {
  return {
    async stat(path) {
      try {
        const stats = await nodeStat(path);
        return {
          dev: stats.dev,
          ino: stats.ino,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
      }
    },
    async read(path) {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
        if (bytesRead > maxBytes) {
          const error = new Error(`benchmark file exceeds ${maxBytes} bytes`);
          (error as NodeJS.ErrnoException).code = BENCHMARK_FILE_TOO_LARGE;
          throw error;
        }
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    },
  };
}

function sameIdentity(
  a: BenchmarkFileIdentity,
  b: BenchmarkFileIdentity,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}

function signature(identity: BenchmarkFileIdentity): string {
  return `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeMs}`;
}

function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && code ? code : null;
}

type StableRead =
  | { kind: "ok"; identity: BenchmarkFileIdentity; text: string }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string }
  | { kind: "too_large" }
  | { kind: "unstable" };

// Reads a file only when two surrounding stats agree, so the bytes are
// never cached under the wrong file identity. Atomic renames always yield
// complete files; the loop only resolves which version was read.
async function readStableFile(
  fs: BenchmarkFileSystem,
  path: string,
  maxBytes: number,
): Promise<StableRead> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    let before: BenchmarkFileIdentity | null;
    try {
      before = await fs.stat(path);
    } catch (error) {
      return {
        kind: "unreadable",
        reason: errorCode(error) ?? "unknown error",
      };
    }
    if (before === null) return { kind: "missing" };
    if (before.size > maxBytes) return { kind: "too_large" };
    let text: string;
    try {
      text = await fs.read(path);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") continue;
      if (code === BENCHMARK_FILE_TOO_LARGE) return { kind: "too_large" };
      return { kind: "unreadable", reason: code ?? "unknown error" };
    }
    let after: BenchmarkFileIdentity | null;
    try {
      after = await fs.stat(path);
    } catch (error) {
      return {
        kind: "unreadable",
        reason: errorCode(error) ?? "unknown error",
      };
    }
    if (after !== null && sameIdentity(before, after)) {
      return { kind: "ok", identity: before, text };
    }
  }
  return { kind: "unstable" };
}

function isValidationError(value: unknown): value is BenchmarkValidationError {
  return typeof value === "object" && value !== null && "error" in value;
}

interface TrackedFile<T> {
  cached: { signature: string; value: T } | null;
  rejected: { signature: string; reason: string } | null;
}

function freshTrackedFile<T>(): TrackedFile<T> {
  return { cached: null, rejected: null };
}

// Refreshes one watched user file. Unchanged and already-rejected
// identities skip parsing; anything unusable retains the last good value
// (or falls through to the seed leg) with an explicit diagnostic.
async function refreshUserFile<T>(args: {
  fs: BenchmarkFileSystem;
  path: string;
  label: string;
  maxBytes: number;
  state: TrackedFile<T>;
  parse: (value: unknown) => T | BenchmarkValidationError;
}): Promise<{ value: T | null; note: string | null }> {
  const { fs, path, label, maxBytes, state, parse } = args;
  const read = await readStableFile(fs, path, maxBytes);
  if (read.kind === "missing") {
    if (state.cached) {
      return {
        value: state.cached.value,
        note: `${label} file was removed; retained last loaded data`,
      };
    }
    return { value: null, note: null };
  }
  if (read.kind === "unstable") {
    const note = `${label} file changed during read and never settled`;
    if (state.cached) return { value: state.cached.value, note };
    return { value: null, note };
  }
  if (read.kind === "unreadable") {
    const note = `${label} file is unreadable (${read.reason})`;
    if (state.cached) return { value: state.cached.value, note };
    return { value: null, note };
  }
  if (read.kind === "too_large") {
    const note = `${label} file exceeds the ${maxBytes} byte limit`;
    if (state.cached) return { value: state.cached.value, note };
    return { value: null, note };
  }
  const sig = signature(read.identity);
  if (state.cached && state.cached.signature === sig) {
    return { value: state.cached.value, note: null };
  }
  if (state.rejected && state.rejected.signature === sig) {
    if (state.cached) {
      return { value: state.cached.value, note: state.rejected.reason };
    }
    return { value: null, note: state.rejected.reason };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    const reason = `${label} file is not valid JSON`;
    state.rejected = { signature: sig, reason };
    if (state.cached) return { value: state.cached.value, note: reason };
    return { value: null, note: reason };
  }
  const validated = parse(parsed);
  if (isValidationError(validated)) {
    const reason = `${label} file rejected: ${validated.error}`;
    state.rejected = { signature: sig, reason };
    if (state.cached) return { value: state.cached.value, note: reason };
    return { value: null, note: reason };
  }
  state.cached = { signature: sig, value: validated };
  state.rejected = null;
  return { value: validated, note: null };
}

async function loadSeedSnapshot(
  fs: BenchmarkFileSystem,
  path: string,
  maxBytes: number,
): Promise<{ value: BenchmarkSnapshot | null; note: string | null }> {
  const read = await readStableFile(fs, path, maxBytes);
  // A missing seed is quiet: presence is a packaging assertion, and the
  // store must work identically with user data or unavailable data.
  if (read.kind === "missing" || read.kind === "unstable") {
    return { value: null, note: null };
  }
  if (read.kind === "too_large") {
    return {
      value: null,
      note: `seed snapshot exceeds the ${maxBytes} byte limit`,
    };
  }
  if (read.kind === "unreadable") {
    return {
      value: null,
      note: `seed snapshot is unreadable (${read.reason})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { value: null, note: "seed snapshot is not valid JSON" };
  }
  const validated = parseBenchmarkSnapshot(parsed);
  if (isValidationError(validated)) {
    return { value: null, note: `seed snapshot rejected: ${validated.error}` };
  }
  if (!verifySnapshotHash(validated)) {
    return { value: validated, note: "seed snapshot hash mismatch" };
  }
  return { value: validated, note: null };
}

async function loadSeedMappings(
  fs: BenchmarkFileSystem,
  path: string,
  maxBytes: number,
): Promise<{ value: ModelMappings; note: string | null }> {
  const empty: ModelMappings = { schemaVersion: 1, bindings: [] };
  const read = await readStableFile(fs, path, maxBytes);
  if (read.kind === "missing" || read.kind === "unstable") {
    return { value: empty, note: null };
  }
  if (read.kind === "too_large") {
    return {
      value: empty,
      note: `seed mappings exceed the ${maxBytes} byte limit`,
    };
  }
  if (read.kind === "unreadable") {
    return {
      value: empty,
      note: `seed mappings are unreadable (${read.reason})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { value: empty, note: "seed mappings are not valid JSON" };
  }
  const validated = parseModelMappings(parsed);
  if (isValidationError(validated)) {
    return { value: empty, note: `seed mappings rejected: ${validated.error}` };
  }
  return { value: validated, note: null };
}

export async function createBenchmarkStore(
  options: BenchmarkStoreOptions,
): Promise<BenchmarkStore> {
  const maxBytes = options.maxBytes ?? BENCHMARK_READ_MAX_BYTES;
  const fs = options.fs ?? defaultFileSystem(maxBytes);
  const seedSnapshotPath =
    options.seedSnapshotPath ?? DEFAULT_SEED_SNAPSHOT_PATH;
  const seedMappingsPath =
    options.seedMappingsPath ?? DEFAULT_SEED_MAPPINGS_PATH;
  const seedSnapshot = await loadSeedSnapshot(fs, seedSnapshotPath, maxBytes);
  const seedMappings = await loadSeedMappings(fs, seedMappingsPath, maxBytes);
  const snapshotState = freshTrackedFile<BenchmarkSnapshot>();
  const mappingsState = freshTrackedFile<ModelMappings>();

  return {
    snapshotPath: options.snapshotPath,
    mappingsPath: options.mappingsPath,
    async view(): Promise<BenchmarkView> {
      const snapshotLeg = await refreshUserFile({
        fs,
        path: options.snapshotPath,
        label: "benchmark snapshot",
        maxBytes,
        state: snapshotState,
        parse: parseBenchmarkSnapshot,
      });
      const mappingsLeg = await refreshUserFile({
        fs,
        path: options.mappingsPath,
        label: "model mappings",
        maxBytes,
        state: mappingsState,
        parse: parseModelMappings,
      });
      const snapshot = snapshotLeg.value ?? seedSnapshot.value;
      const snapshotSource: BenchmarkDataSource = snapshotLeg.value
        ? "user"
        : seedSnapshot.value
          ? "seed"
          : "unavailable";
      const snapshotNote =
        snapshotLeg.note ?? (snapshot ? null : seedSnapshot.note);
      return {
        snapshot,
        snapshotSource,
        snapshotPath: snapshotLeg.value ? options.snapshotPath : null,
        snapshotNote,
        snapshotHashVerified: snapshot ? verifySnapshotHash(snapshot) : false,
        localMappings: mappingsLeg.value,
        localMappingsNote: mappingsLeg.note,
        bundledMappings: seedMappings.value,
        bundledMappingsNote: seedMappings.note,
        matcher: createBenchmarkMatcher({
          snapshot,
          bundled: seedMappings.value,
          local: mappingsLeg.value,
          matchAnyProvider: options.matchAnyProvider ?? false,
        }),
      };
    },
  };
}
