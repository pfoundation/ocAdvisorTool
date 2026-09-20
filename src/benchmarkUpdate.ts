// Transactional Artificial Analysis snapshot refresh: one bounded,
// authenticated fetch is validated, staged next to the target, and
// atomically renamed over it. Any failure before the rename leaves the
// previous file byte-for-byte intact. A per-target PID lock coordinates
// concurrent updaters; stale locks from dead processes are recovered,
// live locks fail promptly with `busy`.
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  AA_LLM_MODELS_ENDPOINT,
  normalizeAAResponse,
} from "./artificialAnalysis.js";
import {
  RECOGNIZED_METRICS,
  type BenchmarkSnapshot,
} from "./benchmarkTypes.js";

export const AA_API_KEY_ENV = "ARTIFICIAL_ANALYSIS_API_KEY";
export const BENCHMARK_UPDATE_TIMEOUT_MS = 30_000;
export const BENCHMARK_UPDATE_MAX_BYTES = 16 * 1024 * 1024;

export type BenchmarkUpdateErrorCode =
  | "missing_key"
  | "invalid_path"
  | "timeout"
  | "too_large"
  | "http"
  | "transport"
  | "invalid_response"
  | "busy"
  | "write_failed";

export interface BenchmarkUpdateSuccess {
  ok: true;
  path: string;
  fetchedAt: string;
  modelCount: number;
  contentHash: string;
  unchanged: boolean;
  metricCoverage: Record<string, number>;
}

export interface BenchmarkUpdateFailure {
  ok: false;
  code: BenchmarkUpdateErrorCode;
  message: string;
  status?: number;
}

export type BenchmarkUpdateResult =
  BenchmarkUpdateSuccess | BenchmarkUpdateFailure;

export interface BenchmarkUpdateDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  apiKey?: string;
  now?: () => string;
  timeoutMs?: number;
  maxBytes?: number;
  randomId?: () => string;
  currentPid?: number;
  processAlive?: (pid: number) => boolean;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultRandomId(): string {
  return `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
}

function lockPathFor(targetPath: string): string {
  return `${targetPath}.lock`;
}

function stagePrefixFor(targetPath: string): string {
  return `.${basename(targetPath)}.`;
}

// Removes interrupted staging files for this target left by crashed runs.
// Other targets sharing the directory use a different prefix and are kept.
async function reapStaleStaging(targetPath: string): Promise<void> {
  const dir = dirname(targetPath);
  const prefix = stagePrefixFor(targetPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    try {
      await rm(join(dir, name), { force: true });
    } catch {}
  }
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0
      ? pid
      : null;
  } catch {
    return null;
  }
}

// Acquires the per-target lock. Returns true when held; a live holder means
// `busy`, while a dead or corrupt holder is removed and acquisition retried
// once (losing a takeover race still reports `busy`).
async function acquireLock(
  lockPath: string,
  currentPid: number,
  processAlive: (pid: number) => boolean,
  fetchedAt: string,
): Promise<boolean> {
  const payload = JSON.stringify({ pid: currentPid, createdAt: fetchedAt });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, payload, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    const holder = await readLockPid(lockPath);
    if (holder !== null && processAlive(holder)) return false;
    try {
      await rm(lockPath, { force: true });
    } catch {
      return false;
    }
  }
  return false;
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { force: true });
  } catch {}
}

function classifyFetchError(error: unknown): BenchmarkUpdateErrorCode {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  return name === "TimeoutError" || name === "AbortError"
    ? "timeout"
    : "transport";
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string | BenchmarkUpdateFailure> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {}
    return {
      ok: false,
      code: "too_large",
      message: `Artificial Analysis response exceeds the ${maxBytes} byte limit.`,
    };
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        return {
          ok: false,
          code: "too_large",
          message: `Artificial Analysis response exceeds the ${maxBytes} byte limit.`,
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function httpFailure(status: number): BenchmarkUpdateFailure {
  let hint = `Artificial Analysis request failed with HTTP ${status}.`;
  if (status === 401 || status === 403) {
    hint += " Check that ARTIFICIAL_ANALYSIS_API_KEY is valid.";
  } else if (status === 429) {
    hint += " Rate limit exceeded; retry later.";
  }
  return { ok: false, code: "http", message: hint, status };
}

function metricCoverage(snapshot: BenchmarkSnapshot): Record<string, number> {
  const coverage: Record<string, number> = {};
  for (const metric of RECOGNIZED_METRICS) {
    coverage[metric.key] = snapshot.models.filter(
      (model) => typeof model.evaluations[metric.key] === "number",
    ).length;
  }
  return coverage;
}

// Best-effort read of the previous snapshot hash for unchanged detection.
// Any failure means "treat as changed", never an update failure.
async function previousContentHash(targetPath: string): Promise<string | null> {
  try {
    const raw = await readFile(targetPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const hash = (parsed as { contentHash?: unknown }).contentHash;
    return typeof hash === "string" ? hash : null;
  } catch {
    return null;
  }
}

export async function updateBenchmarkSnapshot(
  targetPath: string,
  deps: BenchmarkUpdateDeps = {},
): Promise<BenchmarkUpdateResult> {
  if (typeof targetPath !== "string" || !isAbsolute(targetPath)) {
    return {
      ok: false,
      code: "invalid_path",
      message: "Benchmark snapshot path must be an absolute path.",
    };
  }
  const env = deps.env ?? process.env;
  const apiKey = (deps.apiKey ?? env[AA_API_KEY_ENV] ?? "").trim();
  if (!apiKey) {
    return {
      ok: false,
      code: "missing_key",
      message: `Set ${AA_API_KEY_ENV} to refresh Artificial Analysis benchmarks.`,
    };
  }
  const timeoutMs = deps.timeoutMs ?? BENCHMARK_UPDATE_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? BENCHMARK_UPDATE_MAX_BYTES;
  const now = deps.now ?? (() => new Date().toISOString());
  const randomId = deps.randomId ?? defaultRandomId;
  const currentPid = deps.currentPid ?? process.pid;
  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const dir = dirname(targetPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return {
      ok: false,
      code: "write_failed",
      message: `Cannot create the benchmark directory for ${targetPath}.`,
    };
  }

  const lockPath = lockPathFor(targetPath);
  const fetchedAt = now();
  let locked = false;
  try {
    locked = await acquireLock(lockPath, currentPid, processAlive, fetchedAt);
  } catch {
    return {
      ok: false,
      code: "write_failed",
      message: `Cannot coordinate the benchmark update for ${targetPath}.`,
    };
  }
  if (!locked) {
    return {
      ok: false,
      code: "busy",
      message:
        `Another benchmarks update is already running for ${targetPath}. ` +
        `If no updater is running, remove ${lockPath} and retry.`,
    };
  }

  const stagePath = join(
    dir,
    `${stagePrefixFor(targetPath)}${currentPid}.${randomId()}.tmp`,
  );
  try {
    await reapStaleStaging(targetPath);

    let response: Response;
    try {
      response = await fetchImpl(AA_LLM_MODELS_ENDPOINT, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const code = classifyFetchError(error);
      return {
        ok: false,
        code,
        message:
          code === "timeout"
            ? `Artificial Analysis request timed out after ${timeoutMs} ms.`
            : "Artificial Analysis request failed before a response arrived.",
      };
    }
    if (!response.ok) return httpFailure(response.status);

    const text = await readBoundedBody(response, maxBytes);
    if (typeof text !== "string") return text;

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ok: false,
        code: "invalid_response",
        message: "Artificial Analysis response was not valid JSON.",
      };
    }
    const snapshot = normalizeAAResponse(body, fetchedAt);
    if ("error" in snapshot) {
      return { ok: false, code: "invalid_response", message: snapshot.error };
    }

    const unchanged =
      (await previousContentHash(targetPath)) === snapshot.contentHash;
    const serialized = JSON.stringify(snapshot, null, 2);
    try {
      const handle = await open(stagePath, "w");
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(stagePath, targetPath);
    } catch {
      return {
        ok: false,
        code: "write_failed",
        message: `Cannot publish the benchmark snapshot to ${targetPath}.`,
      };
    }
    return {
      ok: true,
      path: targetPath,
      fetchedAt: snapshot.fetchedAt,
      modelCount: snapshot.models.length,
      contentHash: snapshot.contentHash,
      unchanged,
      metricCoverage: metricCoverage(snapshot),
    };
  } finally {
    try {
      await rm(stagePath, { force: true });
    } catch {}
    await releaseLock(lockPath);
  }
}
