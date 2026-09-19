import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { resolveRelease } from "./releaseVersion";

const SCRIPT = resolve(import.meta.dir, "releaseVersion.ts");

describe("resolveRelease", () => {
  test("maps a stable CalVer tag to latest", () => {
    expect(resolveRelease("v26.9.2", false)).toEqual({
      version: "26.9.2",
      distTag: "latest",
    });
  });

  test("maps a prerelease suffix to next even when the GitHub flag is off", () => {
    expect(resolveRelease("v26.9.2-rc.1", false)).toEqual({
      version: "26.9.2-rc.1",
      distTag: "next",
    });
  });

  test("maps a GitHub prerelease flag to next for a stable-looking tag", () => {
    expect(resolveRelease("v26.9.3", true)).toEqual({
      version: "26.9.3",
      distTag: "next",
    });
  });

  test("accepts two-digit months 10 through 12", () => {
    expect(resolveRelease("v26.12.0", false)).toEqual({
      version: "26.12.0",
      distTag: "latest",
    });
  });

  test("rejects a missing v prefix", () => {
    expect(() => resolveRelease("26.9.2", false)).toThrow(/CalVer/);
  });

  test("rejects a leading-zero month", () => {
    expect(() => resolveRelease("v26.09.2", false)).toThrow(/CalVer/);
  });

  test("rejects month 13", () => {
    expect(() => resolveRelease("v26.13.0", false)).toThrow(/CalVer/);
  });

  test("rejects a four-digit year", () => {
    expect(() => resolveRelease("v2026.9.2", false)).toThrow(/CalVer/);
  });

  test("rejects build metadata", () => {
    expect(() => resolveRelease("v26.9.2+1", false)).toThrow(/CalVer/);
  });

  test("rejects a leading-zero patch", () => {
    expect(() => resolveRelease("v26.9.01", false)).toThrow(/CalVer/);
  });
});

describe("releaseVersion CLI", () => {
  test("prints VERSION and DIST_TAG for a stable release", async () => {
    const result = await runCli({
      RELEASE_TAG: "v26.9.2",
      PRERELEASE: "false",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("VERSION=26.9.2\nDIST_TAG=latest\n");
  });

  test("prints next when GitHub marks the release as a prerelease", async () => {
    const result = await runCli({
      RELEASE_TAG: "v26.9.3",
      PRERELEASE: "true",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("VERSION=26.9.3\nDIST_TAG=next\n");
  });

  test("exits non-zero when RELEASE_TAG is missing", async () => {
    const result = await runCli({ PRERELEASE: "false" });
    expect(result.exit).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  test("exits non-zero for an invalid tag", async () => {
    const result = await runCli({
      RELEASE_TAG: "v26.9.2+build",
      PRERELEASE: "false",
    });
    expect(result.exit).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

async function runCli(
  env: Record<string, string>,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", SCRIPT], {
    env: {
      ...process.env,
      RELEASE_TAG: undefined,
      PRERELEASE: undefined,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, stdout, stderr };
}
