import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  computeSnapshotHash,
  type BenchmarkModel,
  type BenchmarkSnapshot,
} from "./benchmarkTypes";
import {
  createBenchmarkStore,
  type BenchmarkFileIdentity,
  type BenchmarkFileSystem,
  type BenchmarkStore,
  type BenchmarkStoreOptions,
  type BenchmarkView,
} from "./benchmarkStore";

// Synthetic fixtures with fake IDs and scores. Never published data.
const SNAP_A = "synthetic-aa-1001";
const SNAP_B = "synthetic-aa-2001";

function syntheticRecord(id: string, coding: number | null): BenchmarkModel {
  return {
    id,
    creatorID: "synthetic-creator-9",
    name: `Synthetic Model ${id}`,
    slug: `synthetic-${id}`,
    evaluatedEffort: null,
    evaluatedAt: null,
    evaluations:
      coding === null
        ? { artificial_analysis_coding_index: null }
        : { artificial_analysis_coding_index: coding },
  };
}

function snapshotJson(
  models: BenchmarkModel[],
  fetchedAt = "2026-09-19T00:00:00.000Z",
): string {
  return JSON.stringify({
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
  });
}

function mappingsJson(bindings: Array<Record<string, unknown>> = []): string {
  return JSON.stringify({ schemaVersion: 1, bindings });
}

function binding(modelID: string, aaModelID: string, variant = "high") {
  return {
    providerID: "test-provider",
    modelID,
    variant,
    aaModelID,
    evaluatedEffort: variant,
    evidenceURL: "https://artificialanalysis.ai/synthetic-evidence",
  };
}

const DIRS: string[] = [];
afterEach(() => {
  while (DIRS.length > 0) {
    try {
      rmSync(DIRS.pop()!, { recursive: true, force: true });
    } catch {}
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocadvisor-bench-store-"));
  DIRS.push(dir);
  return dir;
}

interface StoreFiles {
  dir: string;
  snapshotPath: string;
  mappingsPath: string;
  seedSnapshotPath: string;
  seedMappingsPath: string;
}

function storeFiles(): StoreFiles {
  const dir = tempDir();
  return {
    dir,
    snapshotPath: join(dir, "artificial-analysis.json"),
    mappingsPath: join(dir, "model-mappings.json"),
    seedSnapshotPath: join(dir, "seed-snapshot.json"),
    seedMappingsPath: join(dir, "seed-mappings.json"),
  };
}

async function createTestStore(
  files: StoreFiles,
  extra: Partial<BenchmarkStoreOptions> = {},
): Promise<BenchmarkStore> {
  return createBenchmarkStore({
    snapshotPath: files.snapshotPath,
    mappingsPath: files.mappingsPath,
    seedSnapshotPath: files.seedSnapshotPath,
    seedMappingsPath: files.seedMappingsPath,
    ...extra,
  });
}

function modelIds(view: BenchmarkView): Array<string | undefined> {
  return (view.snapshot?.models ?? []).map((model) => model.id);
}

describe("benchmark store precedence", () => {
  test("prefers the user snapshot over the seed", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(
      files.seedSnapshotPath,
      snapshotJson([syntheticRecord(SNAP_B, 80)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.snapshotSource).toBe("user");
    expect(modelIds(view)).toEqual([SNAP_A]);
    expect(view.snapshotNote).toBeNull();
    expect(view.snapshotHashVerified).toBe(true);
  });

  test("falls back to the seed when no user file exists", async () => {
    const files = storeFiles();
    writeFileSync(
      files.seedSnapshotPath,
      snapshotJson([syntheticRecord(SNAP_B, 80)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.snapshotSource).toBe("seed");
    expect(modelIds(view)).toEqual([SNAP_B]);
    expect(view.snapshotNote).toBeNull();
  });

  test("reports unavailable data without throwing", async () => {
    const files = storeFiles();
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.snapshotSource).toBe("unavailable");
    expect(view.snapshot).toBeNull();
    const match = view.matcher.match({
      providerID: "test-provider",
      modelID: "model-a",
      variant: "high",
    });
    expect(match.status).toBe("unmapped");
  });

  test("uses default seed paths when none are configured", async () => {
    const dir = tempDir();
    const store = await createBenchmarkStore({
      snapshotPath: join(dir, "artificial-analysis.json"),
      mappingsPath: join(dir, "model-mappings.json"),
    });
    const view = await store.view();
    // The bundled mappings and genuine seed ship with the package; the
    // store must resolve them relative to its own module.
    expect(view.snapshotSource).toBe("seed");
    expect(view.snapshotHashVerified).toBe(true);
    expect(view.snapshot?.models.length).toBeGreaterThan(100);
    expect(view.bundledMappings.bindings.length).toBeGreaterThan(0);
  });
});

describe("benchmark store caching and reloads", () => {
  test("returns the cached snapshot while the file is unchanged", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const first = await store.view();
    const second = await store.view();
    expect(second.snapshot).toBe(first.snapshot);
  });

  test("detects an atomic replacement on the next load", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);
    expect(modelIds(await store.view())).toEqual([SNAP_A]);

    const staged = join(files.dir, "staged.json");
    writeFileSync(staged, snapshotJson([syntheticRecord(SNAP_B, 80)]));
    renameSync(staged, files.snapshotPath);

    const reloaded = await store.view();
    expect(reloaded.snapshotSource).toBe("user");
    expect(modelIds(reloaded)).toEqual([SNAP_B]);
  });

  test("detects equal-size replacements even with equal mtimes", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);
    expect(modelIds(await store.view())).toEqual([SNAP_A]);

    const before = statSync(files.snapshotPath);
    // Same byte length, different content: pad the slug to equalize.
    let replacement = snapshotJson([syntheticRecord(SNAP_B, 80)]);
    const target = before.size;
    let pad = "";
    while (
      Buffer.byteLength(
        snapshotJson([{ ...syntheticRecord(SNAP_B, 80), slug: `pad-${pad}` }]),
      ) < target
    ) {
      pad += "p";
    }
    replacement = snapshotJson([
      { ...syntheticRecord(SNAP_B, 80), slug: `pad-${pad}` },
    ]);
    // Trim or extend to hit the exact byte length.
    const current = Buffer.byteLength(replacement);
    if (current > target) {
      throw new Error("test fixture cannot shrink to the target size");
    }
    pad += "q".repeat(target - current);
    replacement = snapshotJson([
      { ...syntheticRecord(SNAP_B, 80), slug: `pad-${pad}` },
    ]);
    expect(Buffer.byteLength(replacement)).toBe(target);

    const staged = join(files.dir, "staged.json");
    writeFileSync(staged, replacement);
    utimesSync(staged, before.atime, before.mtime);
    renameSync(staged, files.snapshotPath);

    const after = statSync(files.snapshotPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);

    const reloaded = await store.view();
    expect(modelIds(reloaded)).toEqual([SNAP_B]);
  });

  test("reloads mappings without reparsing an unchanged snapshot", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(
      files.mappingsPath,
      mappingsJson([binding("model-a", SNAP_A)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const first = await store.view();
    expect(
      first.matcher.match({
        providerID: "test-provider",
        modelID: "model-a",
        variant: "high",
      }).status,
    ).toBe("matched");

    writeFileSync(
      files.mappingsPath,
      mappingsJson([binding("model-b", SNAP_A)]),
    );
    const second = await store.view();
    expect(second.snapshot).toBe(first.snapshot);
    expect(
      second.matcher.match({
        providerID: "test-provider",
        modelID: "model-a",
        variant: "high",
      }).status,
    ).toBe("unmapped");
    expect(
      second.matcher.match({
        providerID: "test-provider",
        modelID: "model-b",
        variant: "high",
      }).status,
    ).toBe("matched");
  });

  test("keeps per-instance views isolated", async () => {
    const firstFiles = storeFiles();
    const secondFiles = storeFiles();
    writeFileSync(
      firstFiles.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(
      secondFiles.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_B, 80)]),
    );
    const first = await createTestStore(firstFiles);
    const second = await createTestStore(secondFiles);

    expect(modelIds(await first.view())).toEqual([SNAP_A]);
    expect(modelIds(await second.view())).toEqual([SNAP_B]);
  });

  test("holds one view stable while a replacement lands", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const during = await store.view();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([
        syntheticRecord(SNAP_B, 80),
        syntheticRecord("synthetic-aa-3003", 70),
      ]),
    );
    // The captured view still sees the old data.
    expect(modelIds(during)).toEqual([SNAP_A]);
    // The next view sees the replacement.
    expect(modelIds(await store.view())).toEqual([SNAP_B, "synthetic-aa-3003"]);
  });

  test("performs no network I/O on the read path", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network access is forbidden on the read path");
    }) as unknown as typeof fetch;
    try {
      const view = await store.view();
      expect(modelIds(view)).toEqual([SNAP_A]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes the cross-provider option through to matching", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(
      files.seedMappingsPath,
      mappingsJson([binding("model-a", SNAP_A)]),
    );
    const strict = await createTestStore(files);
    expect(
      (await strict.view()).matcher.match({
        providerID: "other-provider",
        modelID: "model-a",
        variant: "high",
      }).status,
    ).toBe("unmapped");

    const relaxed = await createTestStore(files, { matchAnyProvider: true });
    const routed = (await relaxed.view()).matcher.match({
      providerID: "other-provider",
      modelID: "model-a",
      variant: "high",
    });
    expect(routed.status).toBe("matched");
    expect(routed.aaModelID).toBe(SNAP_A);
  });
});

describe("benchmark store fallback and recovery", () => {
  test("falls back to the seed on an initially corrupt user file", async () => {
    const files = storeFiles();
    writeFileSync(files.snapshotPath, "not-json{{{");
    writeFileSync(
      files.seedSnapshotPath,
      snapshotJson([syntheticRecord(SNAP_B, 80)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.snapshotSource).toBe("seed");
    expect(modelIds(view)).toEqual([SNAP_B]);
    expect(view.snapshotNote).toContain("not valid JSON");
  });

  test("falls back to the seed on unsupported schema versions", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      JSON.stringify({ schemaVersion: 99, bindings: undefined, models: [] }),
    );
    writeFileSync(
      files.seedSnapshotPath,
      snapshotJson([syntheticRecord(SNAP_B, 80)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.snapshotSource).toBe("seed");
    expect(view.snapshotNote).toContain("schema version");
  });

  test("retains last good data across an invalid replacement", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);
    const good = await store.view();
    expect(modelIds(good)).toEqual([SNAP_A]);

    writeFileSync(files.snapshotPath, "corrupt{{{");
    const retained = await store.view();
    expect(retained.snapshotSource).toBe("user");
    expect(retained.snapshot).toBe(good.snapshot);
    expect(retained.snapshotNote).toContain("not valid JSON");

    // A repeat read does not reparse or lose the retained data.
    const again = await store.view();
    expect(again.snapshot).toBe(good.snapshot);

    // Recovery: a subsequent valid file loads normally.
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_B, 80)]),
    );
    const recovered = await store.view();
    expect(modelIds(recovered)).toEqual([SNAP_B]);
    expect(recovered.snapshotNote).toBeNull();
  });

  test("retains last good data when the user file disappears", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);
    const good = await store.view();

    rmSync(files.snapshotPath);
    const retained = await store.view();
    expect(retained.snapshot).toBe(good.snapshot);
    expect(retained.snapshotNote).toContain("removed");

    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_B, 80)]),
    );
    expect(modelIds(await store.view())).toEqual([SNAP_B]);
  });

  test("rejects oversized user files without reading them fully", async () => {
    const files = storeFiles();
    writeFileSync(files.snapshotPath, "x".repeat(1024));
    writeFileSync(
      files.seedSnapshotPath,
      snapshotJson([syntheticRecord(SNAP_B, 80)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    // Tiny bound rejects both the user file and the seed fixture; the user
    // leg reports first. Seed fallback on oversize shares the corrupt-file
    // fallback path covered above.
    const store = await createTestStore(files, { maxBytes: 64 });

    const view = await store.view();
    expect(view.snapshotSource).toBe("unavailable");
    expect(view.snapshotNote).toContain("exceeds");
  });

  test("loads tampered content while flagging the hash mismatch", async () => {
    const files = storeFiles();
    const parsed = JSON.parse(
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    ) as BenchmarkSnapshot;
    parsed.models[0]!.evaluations.artificial_analysis_coding_index = 100;
    writeFileSync(files.snapshotPath, JSON.stringify(parsed));
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.snapshotSource).toBe("user");
    expect(
      view.snapshot?.models[0]?.evaluations.artificial_analysis_coding_index,
    ).toBe(100);
    expect(view.snapshotHashVerified).toBe(false);
  });

  test("reports an invalid seed instead of throwing", async () => {
    const files = storeFiles();
    writeFileSync(files.seedSnapshotPath, "broken{{{");
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.snapshotSource).toBe("unavailable");
    expect(view.snapshotNote).toContain("seed");
  });
});

describe("benchmark store mappings", () => {
  test("merges local mappings over bundled ones", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(
      files.seedMappingsPath,
      mappingsJson([binding("model-a", SNAP_A)]),
    );
    writeFileSync(
      files.mappingsPath,
      mappingsJson([binding("model-b", SNAP_A)]),
    );
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.localMappingsNote).toBeNull();
    expect(
      view.matcher.match({
        providerID: "test-provider",
        modelID: "model-a",
        variant: "high",
      }).source,
    ).toBe("bundled");
    expect(
      view.matcher.match({
        providerID: "test-provider",
        modelID: "model-b",
        variant: "high",
      }).source,
    ).toBe("local");
  });

  test("keeps bundled mappings when the local file is invalid", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(
      files.seedMappingsPath,
      mappingsJson([binding("model-a", SNAP_A)]),
    );
    writeFileSync(files.mappingsPath, "broken{{{");
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.localMappings).toBeNull();
    expect(view.localMappingsNote).toContain("not valid JSON");
    expect(
      view.matcher.match({
        providerID: "test-provider",
        modelID: "model-a",
        variant: "high",
      }).source,
    ).toBe("bundled");
  });

  test("treats a missing local file as no overrides, not an error", async () => {
    const files = storeFiles();
    writeFileSync(
      files.snapshotPath,
      snapshotJson([syntheticRecord(SNAP_A, 60)]),
    );
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const store = await createTestStore(files);

    const view = await store.view();
    expect(view.localMappings).toBeNull();
    expect(view.localMappingsNote).toBeNull();
  });
});

describe("benchmark store read races", () => {
  function identity(overrides: Partial<BenchmarkFileIdentity> = {}) {
    return {
      dev: 1,
      ino: 100,
      size: 128,
      mtimeMs: 1000,
      ...overrides,
    };
  }

  // Scripted filesystem routing per path: each entry consumes its queues in
  // order, so creation order never matters. Unlisted paths read as missing.
  function routingFs(
    entries: Record<
      string,
      { stats: Array<BenchmarkFileIdentity | null>; reads: string[] }
    >,
  ): BenchmarkFileSystem {
    return {
      stat: async (path) => entries[path]?.stats.shift() ?? null,
      read: async (path) => {
        const next = entries[path]?.reads.shift();
        if (next === undefined) throw new Error(`unexpected read of ${path}`);
        return next;
      },
    };
  }

  test("retries until a read observes a stable identity", async () => {
    const first = snapshotJson([syntheticRecord(SNAP_A, 60)]);
    const second = snapshotJson([syntheticRecord(SNAP_B, 80)]);
    const idA = identity({ ino: 100 });
    const idB = identity({ ino: 101 });
    const seedId = identity({ ino: 200 });
    const files = storeFiles();
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const seedMappings = readFileSync(files.seedMappingsPath, "utf8");
    // stat -> read -> stat sees a change, then the retry is stable.
    const fs = routingFs({
      [files.snapshotPath]: {
        stats: [idA, idB, idB, idB],
        reads: [first, second],
      },
      [files.seedMappingsPath]: {
        stats: [seedId, seedId],
        reads: [seedMappings],
      },
    });
    const store = await createTestStore(files, { fs });

    const view = await store.view();
    expect(view.snapshotSource).toBe("user");
    expect(modelIds(view)).toEqual([SNAP_B]);
  });

  test("keeps last good data when the file never settles", async () => {
    const stable = snapshotJson([syntheticRecord(SNAP_A, 60)]);
    const changed = snapshotJson([syntheticRecord(SNAP_B, 80)]);
    const seedId = identity({ ino: 200 });
    const files = storeFiles();
    writeFileSync(files.seedMappingsPath, mappingsJson());
    const seedMappings = readFileSync(files.seedMappingsPath, "utf8");
    // Initial load is stable; the next view races forever.
    const fs = routingFs({
      [files.snapshotPath]: {
        stats: [
          identity({ ino: 100 }),
          identity({ ino: 100 }),
          identity({ ino: 101 }),
          identity({ ino: 102 }),
          identity({ ino: 102 }),
          identity({ ino: 103 }),
          identity({ ino: 103 }),
          identity({ ino: 104 }),
        ],
        reads: [stable, changed, changed, changed],
      },
      [files.seedMappingsPath]: {
        stats: [seedId, seedId],
        reads: [seedMappings],
      },
    });
    const store = await createTestStore(files, { fs });

    const good = await store.view();
    expect(modelIds(good)).toEqual([SNAP_A]);
    const retained = await store.view();
    expect(retained.snapshot).toBe(good.snapshot);
    expect(retained.snapshotNote).toContain("settled");
  });
});
