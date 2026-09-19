// Local-development entrypoint for OpenCode's plugin-directory loader.
//
// OpenCode V2 resolves a configured local plugin directory through the
// directory's root `server`/`index` entrypoint (Bun directory resolution)
// rather than through this package's `main`/`exports` fields. This shim
// forwards the compiled plugin so the repository root can be configured
// directly. Run `bun run build` after changing src/, then restart the
// background service (location eviction does not reload plugin files).
//
// Published installs use `dist/index.js` via package `main`/`exports`; this
// file is intentionally excluded from the npm `files` allowlist.
export { default } from "./dist/index.js";
