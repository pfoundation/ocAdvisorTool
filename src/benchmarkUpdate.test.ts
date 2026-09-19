import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parseBenchmarkSnapshot } from "./benchmarkTypes";
import {
  updateBenchmarkSnapshot,
  type BenchmarkUpdateResult,
} from "./benchmarkUpdate";

// Synthetic API fixtures shaped like the documented Artificial Analysis
// response. Fake IDs and scores; never published data.
function syntheticEntry(id: string) {
  return {
    id,
    name: `Synthetic Model ${id}`,
    slug: `synthetic-model-${id}`,
    model_creator: { id: "synthetic-creator-9", name: "Synthetic Lab" },
    evaluations: {
      artificial_analysis_coding_index: 50 + id.length,
      artificial_analysis_intelligence_index: 51,
      hle: 0.25,
      gpqa: null,
    },
  };
}

function syntheticBody() {
  return {
    status: 200,
    data: [
      syntheticEntry("synthetic-aa-1001"),
      syntheticEntry("synthetic-aa-1002"),
    ],
  };
}

const DIRS: string[] = [];
afterEach(() => {
  while (DIRS.length > 0) {
    const dir = DIRS.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocadvisor-bench-update-"));
  DIRS.push(dir);
  return dir;
}

function jsonFetch(
  body: unknown,
  status = 200,
): { fetchImpl: typeof fetch; calls: Array<{ url: unknown; init: unknown }> } {
  const calls: Array<{ url: unknown; init: unknown }> = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({ url, init });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function okResult(
  result: BenchmarkUpdateResult,
): Extract<BenchmarkUpdateResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected success: ${result.code} ${result.message}`);
  }
  return result;
}

function failResult(
  result: BenchmarkUpdateResult,
): Extract<BenchmarkUpdateResult, { ok: false }> {
  if (result.ok) {
    throw new Error(`expected failure, got success for ${result.path}`);
  }
  return result;
}

describe("updateBenchmarkSnapshot", () => {
  test("publishes a complete parseable snapshot on success", async () => {
    const dir = tempDir();
    const target = join(dir, "nested", "artificial-analysis.json");
    const mappingsPath = join(dir, "nested", "model-mappings.json");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(mappingsPath, '{"bindings":[]}');
    const { fetchImpl, calls } = jsonFetch(syntheticBody());

    const result = okResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
        now: () => "2026-09-19T00:00:00.000Z",
      }),
    );

    expect(result.path).toBe(target);
    expect(result.fetchedAt).toBe("2026-09-19T00:00:00.000Z");
    expect(result.modelCount).toBe(2);
    expect(result.unchanged).toBe(false);
    expect(result.metricCoverage).toEqual({
      artificial_analysis_coding_index: 2,
      artificial_analysis_intelligence_index: 2,
      hle: 2,
      gpqa: 0,
      artificial_analysis_math_index: 0,
    });
    const stored = parseBenchmarkSnapshot(
      JSON.parse(readFileSync(target, "utf8")),
    );
    if ("error" in stored) throw new Error(stored.error);
    expect(stored.contentHash).toBe(result.contentHash);
    expect(stored.models).toHaveLength(2);
    // The updater never touches local model mappings.
    expect(readFileSync(mappingsPath, "utf8")).toBe('{"bindings":[]}');
    // Credentials travel only in the request header.
    const headers = (calls[0]?.init as { headers?: Record<string, string> })
      ?.headers;
    expect(headers?.["x-api-key"]).toBe("SYNTHETIC-KEY-1");
  });

  test("requires an API key and never repeats it in messages", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    const { fetchImpl, calls } = jsonFetch(syntheticBody());

    const missing = failResult(
      await updateBenchmarkSnapshot(target, { fetchImpl, env: {} }),
    );
    expect(missing.code).toBe("missing_key");
    expect(calls).toHaveLength(0);

    const blank = failResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl,
        apiKey: "   ",
        env: {},
      }),
    );
    expect(blank.code).toBe("missing_key");
    expect(calls).toHaveLength(0);
    expect(() => readFileSync(target)).toThrow();
  });

  test("reports a timeout when the response never arrives", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    writeFileSync(target, '{"old":true}');
    const hangingFetch = ((url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () =>
          reject(new DOMException("The operation timed out.", "TimeoutError"));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      })) as typeof fetch;

    const result = failResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl: hangingFetch,
        apiKey: "SYNTHETIC-KEY-1",
        timeoutMs: 25,
      }),
    );
    expect(result.code).toBe("timeout");
    expect(result.message).not.toContain("SYNTHETIC-KEY-1");
    expect(readFileSync(target, "utf8")).toBe('{"old":true}');
  });

  test("rejects oversized responses without touching the target", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    writeFileSync(target, '{"old":true}');
    const { fetchImpl } = jsonFetch(syntheticBody());

    const result = failResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
        maxBytes: 64,
      }),
    );
    expect(result.code).toBe("too_large");
    expect(readFileSync(target, "utf8")).toBe('{"old":true}');
  });

  test("maps HTTP failures to sanitized codes", async () => {
    for (const [status, hint] of [
      [401, "ARTIFICIAL_ANALYSIS_API_KEY"],
      [403, "ARTIFICIAL_ANALYSIS_API_KEY"],
      [429, "Rate limit"],
      [500, "HTTP 500"],
    ] as const) {
      const dir = tempDir();
      const target = join(dir, "artificial-analysis.json");
      writeFileSync(target, '{"old":true}');
      const { fetchImpl } = jsonFetch({ status, error: "nope" }, status);
      const result = failResult(
        await updateBenchmarkSnapshot(target, {
          fetchImpl,
          apiKey: "SYNTHETIC-KEY-1",
        }),
      );
      expect(result.code).toBe("http");
      expect(result.status).toBe(status);
      expect(result.message).toContain(hint);
      expect(result.message).not.toContain("SYNTHETIC-KEY-1");
      expect(readFileSync(target, "utf8")).toBe('{"old":true}');
    }
  });

  test("rejects malformed and invalid payloads before activation", async () => {
    const bodies: unknown[] = [
      "not json at all {{{",
      { status: 200 },
      { data: [] },
      { data: [{ id: "only-id" }] },
    ];
    for (const body of bodies) {
      const dir = tempDir();
      const target = join(dir, "artificial-analysis.json");
      writeFileSync(target, '{"old":true}');
      const { fetchImpl } = jsonFetch(body);
      const result = failResult(
        await updateBenchmarkSnapshot(target, {
          fetchImpl,
          apiKey: "SYNTHETIC-KEY-1",
        }),
      );
      expect(result.code).toBe("invalid_response");
      expect(readFileSync(target, "utf8")).toBe('{"old":true}');
    }
  });

  test("maps transport failures without leaking details", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    writeFileSync(target, '{"old":true}');
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443");
    }) as unknown as typeof fetch;
    const result = failResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl: failing,
        apiKey: "SYNTHETIC-KEY-1",
      }),
    );
    expect(result.code).toBe("transport");
    expect(result.message).not.toContain("10.0.0.1");
    expect(readFileSync(target, "utf8")).toBe('{"old":true}');
    // The lock is released on failure.
    expect(() => readFileSync(`${target}.lock`)).toThrow();
  });

  test("rejects non-absolute target paths", async () => {
    const { fetchImpl, calls } = jsonFetch(syntheticBody());
    const result = failResult(
      await updateBenchmarkSnapshot("relative/snapshot.json", {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
      }),
    );
    expect(result.code).toBe("invalid_path");
    expect(calls).toHaveLength(0);
  });

  test("fails writes cleanly when the destination is unusable", async () => {
    const dir = tempDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const { fetchImpl } = jsonFetch(syntheticBody());
    const nested = failResult(
      await updateBenchmarkSnapshot(join(blocker, "snapshot.json"), {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
      }),
    );
    expect(nested.code).toBe("write_failed");

    const dirTarget = join(dir, "as-directory");
    mkdirSync(dirTarget);
    const { fetchImpl: fetchImpl2 } = jsonFetch(syntheticBody());
    const isDir = failResult(
      await updateBenchmarkSnapshot(dirTarget, {
        fetchImpl: fetchImpl2,
        apiKey: "SYNTHETIC-KEY-1",
      }),
    );
    expect(isDir.code).toBe("write_failed");
    // No staging files are left behind.
    const leftovers = readdirSync(dir).filter((name: string) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  test("refuses a second concurrent updater for the same target", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const gated = (async () => {
      fetches++;
      await gate;
      return new Response(JSON.stringify(syntheticBody()), { status: 200 });
    }) as unknown as typeof fetch;
    const options = { fetchImpl: gated, apiKey: "SYNTHETIC-KEY-1" };
    const pending = Promise.all([
      updateBenchmarkSnapshot(target, options),
      updateBenchmarkSnapshot(target, options),
    ]);
    await Bun.sleep(50);
    release();
    const [first, second] = await pending;
    const codes = [first, second].map((result) =>
      result.ok ? "ok" : result.code,
    );
    expect(codes.sort()).toEqual(["busy", "ok"]);
    expect(fetches).toBe(1);
    const stored = parseBenchmarkSnapshot(
      JSON.parse(readFileSync(target, "utf8")),
    );
    if ("error" in stored) throw new Error(stored.error);
    expect(stored.models).toHaveLength(2);
  });

  test("refuses when a live lock holder exists and never fetches", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    const { fetchImpl, calls } = jsonFetch(syntheticBody());
    const result = failResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
      }),
    );
    expect(result.code).toBe("busy");
    expect(calls).toHaveLength(0);
    expect(() => readFileSync(target)).toThrow();
  });

  test("recovers a stale lock from a dead process", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: 2 ** 30, createdAt: "2020-01-01T00:00:00.000Z" }),
    );
    const { fetchImpl } = jsonFetch(syntheticBody());
    const result = okResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
      }),
    );
    expect(result.modelCount).toBe(2);
    expect(() => readFileSync(`${target}.lock`)).toThrow();
  });

  test("recovers a corrupt lock file instead of blocking forever", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    writeFileSync(`${target}.lock`, "not-json{{{");
    const { fetchImpl } = jsonFetch(syntheticBody());
    const result = okResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
      }),
    );
    expect(result.modelCount).toBe(2);
    expect(() => readFileSync(`${target}.lock`)).toThrow();
  });

  test("reaps interrupted staging files for the same target only", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    writeFileSync(
      join(dir, ".artificial-analysis.json.99999.stale.tmp"),
      '{"partial":true}',
    );
    writeFileSync(join(dir, ".other.json.99999.stale.tmp"), '{"partial":true}');
    const { fetchImpl } = jsonFetch(syntheticBody());
    const result = okResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
      }),
    );
    expect(result.modelCount).toBe(2);
    const names = readdirSync(dir) as string[];
    expect(names).not.toContain(".artificial-analysis.json.99999.stale.tmp");
    expect(names).toContain(".other.json.99999.stale.tmp");
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([
      ".other.json.99999.stale.tmp",
    ]);
  });

  test("reports unchanged data while still refreshing the timestamp", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");
    const { fetchImpl } = jsonFetch(syntheticBody());
    const first = okResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
        now: () => "2026-09-19T00:00:00.000Z",
      }),
    );
    expect(first.unchanged).toBe(false);
    const second = okResult(
      await updateBenchmarkSnapshot(target, {
        fetchImpl,
        apiKey: "SYNTHETIC-KEY-1",
        now: () => "2026-09-20T00:00:00.000Z",
      }),
    );
    expect(second.unchanged).toBe(true);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.fetchedAt).toBe("2026-09-20T00:00:00.000Z");
    const stored = JSON.parse(readFileSync(target, "utf8")) as {
      fetchedAt: string;
    };
    expect(stored.fetchedAt).toBe("2026-09-20T00:00:00.000Z");
  });
});
