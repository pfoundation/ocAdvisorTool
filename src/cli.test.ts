import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parseModelCoordinate, runCli } from "./cli";
import { computeSnapshotHash } from "./benchmarkTypes";

const DIRS: string[] = [];
afterEach(() => {
  while (DIRS.length > 0) {
    try {
      rmSync(DIRS.pop()!, { recursive: true, force: true });
    } catch {}
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocadvisor-cli-"));
  DIRS.push(dir);
  return dir;
}

interface Captured {
  out: string[];
  err: string[];
  text(): string;
}

function capture(): Captured & {
  deps: {
    out: (line: string) => void;
    err: (line: string) => void;
    env: Record<string, string | undefined>;
  };
} {
  const captured: Captured = {
    out: [],
    err: [],
    text() {
      return [...this.out, ...this.err].join("\n");
    },
  };
  return {
    ...captured,
    text: captured.text.bind(captured),
    deps: {
      out: (line: string) => captured.out.push(line),
      err: (line: string) => captured.err.push(line),
      env: {},
    },
  };
}

// Synthetic API body shaped like the documented response.
function syntheticBody() {
  return {
    status: 200,
    data: [
      {
        id: "synthetic-aa-1",
        name: "Synthetic Model One",
        slug: "synthetic-model-one",
        model_creator: { id: "synthetic-creator" },
        evaluations: {
          artificial_analysis_coding_index: 60,
          artificial_analysis_intelligence_index: 62,
          hle: 0.3,
          gpqa: 0.7,
        },
      },
    ],
  };
}

function writeSnapshot(
  dir: string,
  name = "artificial-analysis.json",
): { path: string; contentHash: string } {
  const models = [
    {
      id: "synthetic-aa-1",
      creatorID: "synthetic-creator",
      name: "Synthetic Model One",
      slug: "synthetic-model-one",
      evaluatedEffort: null,
      evaluatedAt: null,
      evaluations: {
        artificial_analysis_coding_index: 60,
        artificial_analysis_intelligence_index: 62,
        hle: 0.3,
        gpqa: 0.7,
      },
    },
  ];
  const endpoint = "https://artificialanalysis.ai/api/v2/data/llms/models";
  const contentHash = computeSnapshotHash({
    source: "artificial-analysis",
    endpoint,
    methodologyVersion: null,
    models,
  });
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      source: "artificial-analysis",
      sourceURL: "https://artificialanalysis.ai/",
      endpoint,
      fetchedAt: "2026-09-10T00:00:00.000Z",
      contentHash,
      methodologyVersion: null,
      metricDefinitions: [],
      models,
    }),
  );
  return { path, contentHash };
}

function writeMappings(
  dir: string,
  name = "model-mappings.json",
  bindings: Array<Record<string, unknown>> = [
    {
      providerID: "test-provider",
      modelID: "requester-model",
      variant: "high",
      aaModelID: "synthetic-aa-1",
      evaluatedEffort: "max",
      evidenceURL: "https://artificialanalysis.ai/synthetic",
    },
  ],
): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, bindings }));
  return path;
}

describe("parseModelCoordinate", () => {
  test("parses provider, nested model IDs, and optional variants", () => {
    expect(parseModelCoordinate("test-provider/requester-model#high")).toEqual({
      providerID: "test-provider",
      modelID: "requester-model",
      variant: "high",
    });
    expect(parseModelCoordinate("openrouter/openai/gpt-6-astra")).toEqual({
      providerID: "openrouter",
      modelID: "openai/gpt-6-astra",
      variant: null,
    });
  });

  test("rejects malformed coordinates", () => {
    for (const bad of [
      "",
      "bare-model",
      "/model",
      "provider/",
      "a/b#",
      "a#v",
    ]) {
      const parsed = parseModelCoordinate(bad);
      expect("error" in parsed).toBe(true);
    }
  });
});

describe("runCli help", () => {
  test("shows help for help flags and bare invocations", async () => {
    for (const argv of [[], ["--help"], ["-h"], ["help"], ["benchmarks"]]) {
      const captured = capture();
      const code = await runCli(argv, captured.deps);
      expect(code).toBe(0);
      expect(captured.text()).toContain("benchmarks update");
      expect(captured.text()).toContain("benchmarks status");
    }
  });

  test("shows command help", async () => {
    const update = capture();
    expect(await runCli(["benchmarks", "update", "--help"], update.deps)).toBe(
      0,
    );
    expect(update.text()).toContain("--path");
    const status = capture();
    expect(await runCli(["benchmarks", "status", "--help"], status.deps)).toBe(
      0,
    );
    expect(status.text()).toContain("--model");
  });

  test("reports a version", async () => {
    const captured = capture();
    expect(await runCli(["--version"], captured.deps)).toBe(0);
    expect(captured.text()).toMatch(/ocadvisor \S+/);
  });

  test("rejects unknown commands and flags", async () => {
    const command = capture();
    expect(await runCli(["frobnicate"], command.deps)).toBe(2);
    expect(command.text()).toContain("Usage");

    const subcommand = capture();
    expect(await runCli(["benchmarks", "prune"], subcommand.deps)).toBe(2);

    const flag = capture();
    expect(await runCli(["benchmarks", "status", "--bogus"], flag.deps)).toBe(
      2,
    );

    const positional = capture();
    expect(
      await runCli(["benchmarks", "update", "extra"], positional.deps),
    ).toBe(2);
  });
});

describe("runCli benchmarks update", () => {
  function updateFetch(body: unknown = syntheticBody(), status = 200) {
    return (async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;
  }

  test("publishes a snapshot to an explicit path", async () => {
    const dir = tempDir();
    const captured = capture();
    const target = join(dir, "nested", "artificial-analysis.json");
    const code = await runCli(["benchmarks", "update", "--path", target], {
      ...captured.deps,
      env: { ARTIFICIAL_ANALYSIS_API_KEY: "SYNTHETIC-KEY-1" },
      fetchImpl: updateFetch(),
    });
    expect(code).toBe(0);
    expect(captured.text()).toContain(target);
    expect(captured.text()).toContain("models: 1");
    expect(captured.text()).toContain("content_hash:");
    const stored = JSON.parse(readFileSync(target, "utf8"));
    expect(stored.models).toHaveLength(1);
  });

  test("maps failures to exit 1 without leaking the key", async () => {
    const dir = tempDir();
    const target = join(dir, "artificial-analysis.json");

    const denied = capture();
    expect(
      await runCli(["benchmarks", "update", "--path", target], {
        ...denied.deps,
        env: { ARTIFICIAL_ANALYSIS_API_KEY: "SYNTHETIC-KEY-9" },
        fetchImpl: updateFetch({ error: "nope" }, 401),
      }),
    ).toBe(1);
    expect(denied.text()).toContain("401");
    expect(denied.text()).not.toContain("SYNTHETIC-KEY-9");

    const keyless = capture();
    expect(
      await runCli(["benchmarks", "update", "--path", target], {
        ...keyless.deps,
        fetchImpl: updateFetch(),
      }),
    ).toBe(1);
    expect(keyless.text()).toContain("ARTIFICIAL_ANALYSIS_API_KEY");
  });

  test("rejects unusable paths as usage errors", async () => {
    const captured = capture();
    expect(
      await runCli(["benchmarks", "update", "--path", "relative.json"], {
        ...captured.deps,
        env: { ARTIFICIAL_ANALYSIS_API_KEY: "SYNTHETIC-KEY-1" },
        fetchImpl: updateFetch(),
      }),
    ).toBe(2);
    expect(captured.text()).toContain("absolute path");
  });
});

describe("runCli benchmarks status", () => {
  function seedlessArgs(...args: string[]): string[] {
    const dir = tempDir();
    return [
      ...args,
      "--seed-snapshot",
      join(dir, "no-seed.json"),
      "--seed-mappings",
      join(dir, "no-seed-mappings.json"),
    ];
  }

  test("reports on-disk data without credentials or network", async () => {
    const dir = tempDir();
    const { path, contentHash } = writeSnapshot(dir);
    writeMappings(dir);
    const captured = capture();
    const throwingFetch = (async (): Promise<never> => {
      throw new Error("status must stay offline");
    }) as unknown as typeof fetch;
    const code = await runCli(
      seedlessArgs("benchmarks", "status", "--path", path),
      {
        ...captured.deps,
        fetchImpl: throwingFetch,
        nowMs: Date.parse("2026-09-19T12:00:00.000Z"),
      },
    );
    expect(code).toBe(0);
    expect(captured.text()).toContain(`snapshot: user ${path}`);
    expect(captured.text()).toContain("models: 1");
    expect(captured.text()).toContain("coding_index: 1");
    expect(captured.text()).toContain(`content_hash: ${contentHash}`);
    expect(captured.text()).toContain("9.5 days ago");
    expect(captured.text()).toContain("mappings: 1 local, 0 bundled");
    expect(captured.text()).toContain("https://artificialanalysis.ai/");
  });

  test("uses the bundled seed when the user file is missing", async () => {
    const dir = tempDir();
    const captured = capture();
    const code = await runCli(
      ["benchmarks", "status", "--path", join(dir, "missing.json")],
      captured.deps,
    );
    expect(code).toBe(0);
    expect(captured.text()).toContain("snapshot: bundled seed");
    expect(captured.text()).toMatch(/mappings: 0 local, \d+ bundled/);
  });

  test("returns nonzero when neither user nor seed data is usable", async () => {
    const dir = tempDir();
    const captured = capture();
    const code = await runCli(
      seedlessArgs("benchmarks", "status", "--path", join(dir, "missing.json")),
      captured.deps,
    );
    expect(code).toBe(1);
    expect(captured.text()).toContain("unavailable");
  });

  test("resolves an exact model or explains why not", async () => {
    const dir = tempDir();
    const { path } = writeSnapshot(dir);
    writeMappings(dir);

    const matched = capture();
    expect(
      await runCli(
        seedlessArgs(
          "benchmarks",
          "status",
          "--path",
          path,
          "--model",
          "test-provider/requester-model#high",
        ),
        matched.deps,
      ),
    ).toBe(0);
    expect(matched.text()).toContain("match: matched (local)");
    expect(matched.text()).toContain("aa_model: synthetic-aa-1");
    expect(matched.text()).toContain("coding_index=60");

    const missing = capture();
    expect(
      await runCli(
        seedlessArgs(
          "benchmarks",
          "status",
          "--path",
          path,
          "--model",
          "test-provider/other-model#high",
        ),
        missing.deps,
      ),
    ).toBe(1);
    expect(missing.text()).toContain("match: unmapped");
  });

  test("rejects malformed model filters", async () => {
    const dir = tempDir();
    const { path } = writeSnapshot(dir);
    const captured = capture();
    expect(
      await runCli(
        seedlessArgs(
          "benchmarks",
          "status",
          "--path",
          path,
          "--model",
          "bare-model",
        ),
        captured.deps,
      ),
    ).toBe(2);
    expect(captured.text()).toContain("provider/model");
  });

  test("honors an explicit mappings path", async () => {
    const dir = tempDir();
    const { path } = writeSnapshot(dir);
    const custom = writeMappings(dir, "custom-mappings.json", []);
    const captured = capture();
    const code = await runCli(
      seedlessArgs(
        "benchmarks",
        "status",
        "--path",
        path,
        "--mappings-path",
        custom,
      ),
      captured.deps,
    );
    expect(code).toBe(0);
    expect(captured.text()).toContain("mappings: 0 local, 0 bundled");
  });

  test("mirrors the cross-provider matching option", async () => {
    const dir = tempDir();
    const { path } = writeSnapshot(dir);
    writeMappings(dir);
    const argv = (flag: string[]) =>
      seedlessArgs(
        "benchmarks",
        "status",
        "--path",
        path,
        "--model",
        "opencode/requester-model#high",
        ...flag,
      );

    const strict = capture();
    expect(await runCli(argv([]), strict.deps)).toBe(1);
    expect(strict.text()).toContain("match: unmapped");

    const relaxed = capture();
    expect(await runCli(argv(["--match-any-provider", "true"]), relaxed.deps)).toBe(
      0,
    );
    expect(relaxed.text()).toContain("match: matched (local)");
    expect(relaxed.text()).toContain("aa_model: synthetic-aa-1");

    const bad = capture();
    expect(
      await runCli(argv(["--match-any-provider", "sometimes"]), bad.deps),
    ).toBe(2);
    expect(bad.text()).toContain("--match-any-provider");
  });
});
