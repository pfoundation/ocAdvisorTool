// Regression: OpenCode V2 loads a configured local plugin directory by
// resolving a root-level "server" or "index" entrypoint (Bun's directory
// resolution), not this package's main/exports fields. Without a root
// entrypoint the directory imports fine as a package but is silently skipped
// by the plugin loader. See plan 2026-09-19-ocadvisor-typesafe-gate.md (T2).
import { describe, expect, test } from "bun:test";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");

function resolvePluginEntrypoint(directory: string): string | null {
  // Mirrors the loader's candidate order: server, then index.
  for (const name of ["server", "index"]) {
    try {
      return Bun.resolveSync(resolve(directory, name), directory);
    } catch {}
  }
  return null;
}

describe("local plugin directory loading", () => {
  test("the configured directory exposes a root entrypoint", () => {
    const entrypoint = resolvePluginEntrypoint(REPO_ROOT);
    expect(entrypoint).not.toBeNull();
  });

  test("the root entrypoint forwards the compiled plugin", async () => {
    const dist = resolve(REPO_ROOT, "dist/index.js");
    // CI runs `bun test` before `bun run build`; the import assertion needs
    // the compiled output, so skip it when the build has not run yet and let
    // the CI entrypoint check cover it after building.
    if (!(await Bun.file(dist).exists())) return;
    const entrypoint = resolvePluginEntrypoint(REPO_ROOT);
    expect(entrypoint).not.toBeNull();
    const plugin = (await import(entrypoint!)).default;
    expect(plugin.id).toBe("oc-advisor");
    expect(typeof plugin.setup).toBe("function");
  });

  test("resolving a directory without an entrypoint fails", async () => {
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const bare = await mkdtemp(resolve(tmpdir(), "ocadvisor-no-entry-"));
    try {
      expect(resolvePluginEntrypoint(bare)).toBeNull();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
