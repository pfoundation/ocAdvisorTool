import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeSnapshotHash } from "./benchmarkTypes";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DIST_CLI = resolve(REPO_ROOT, "dist/cli.js");
const DIST_DATA = resolve(REPO_ROOT, "dist/data");

async function distBuilt(): Promise<boolean> {
  return Bun.file(DIST_CLI).exists();
}

describe("packaged CLI", () => {
  test("ships an executable CLI entrypoint with a bun shebang", async () => {
    // CI runs `bun test` before `bun run build`; skip dist assertions until
    // the build has run and let the post-build package run cover them.
    if (!(await distBuilt())) return;
    const file = Bun.file(DIST_CLI);
    const text = await file.text();
    expect(text.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    const stat = (await import("node:fs/promises")).stat(DIST_CLI);
    const mode = (await stat).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  test("keeps the CLI graph off the plugin and TypeSafe client", async () => {
    if (!(await distBuilt())) return;
    const text = await Bun.file(DIST_CLI).text();
    for (const forbidden of [
      "@typesafe-ai",
      "ocAdvisor",
      "modelProfiles",
      "benchmarkEvidence",
      "typesafeGate",
      "typesafeState",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("runs --help from the compiled binary", async () => {
    if (!(await distBuilt())) return;
    const proc = Bun.spawn([DIST_CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("benchmarks update");
    expect(stdout).toContain("benchmarks status");
  });

  test("reports fixture data through the compiled binary", async () => {
    if (!(await distBuilt())) return;
    const dir = mkdtempSync(join(tmpdir(), "ocadvisor-pkg-"));
    try {
      const models = [
        {
          id: "synthetic-aa-1",
          creatorID: "synthetic-creator",
          name: "Synthetic Model One",
          slug: "synthetic-model-one",
          evaluatedEffort: null,
          evaluatedAt: null,
          evaluations: { artificial_analysis_coding_index: 60 },
        },
      ];
      const endpoint = "https://artificialanalysis.ai/api/v2/data/llms/models";
      const snapshotPath = join(dir, "artificial-analysis.json");
      writeFileSync(
        snapshotPath,
        JSON.stringify({
          schemaVersion: 1,
          source: "artificial-analysis",
          sourceURL: "https://artificialanalysis.ai/",
          endpoint,
          fetchedAt: "2026-09-10T00:00:00.000Z",
          contentHash: computeSnapshotHash({
            source: "artificial-analysis",
            endpoint,
            methodologyVersion: null,
            models,
          }),
          methodologyVersion: null,
          metricDefinitions: [],
          models,
        }),
      );
      const proc = Bun.spawn(
        [DIST_CLI, "benchmarks", "status", "--path", snapshotPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("models: 1");
      expect(stdout).toContain("coding_index: 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("packaged benchmark data", () => {
  test("ships validated bundled mappings", async () => {
    const path = join(DIST_DATA, "artificialAnalysis.mappings.json");
    if (!(await Bun.file(path).exists())) return;
    const { parseModelMappings } = await import("./benchmarkMatch");
    const parsed = parseModelMappings(JSON.parse(await Bun.file(path).text()));
    expect("error" in parsed).toBe(false);
  });

  test("ships a validated seed snapshot when one exists", async () => {
    const path = join(DIST_DATA, "artificialAnalysis.snapshot.json");
    if (!(await Bun.file(path).exists())) return;
    const { parseBenchmarkSnapshot } = await import("./benchmarkTypes");
    const parsed = parseBenchmarkSnapshot(
      JSON.parse(await Bun.file(path).text()),
    );
    expect("error" in parsed).toBe(false);
  });
});

describe("packaged plugin", () => {
  test("imports the compiled plugin entrypoint", async () => {
    const dist = resolve(REPO_ROOT, "dist/index.js");
    if (!(await Bun.file(dist).exists())) return;
    const plugin = (await import(dist)).default;
    expect(plugin.id).toBe("oc-advisor");
    expect(typeof plugin.setup).toBe("function");
  });
});
