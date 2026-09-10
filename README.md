# ocAdvisor

OpenCode V2 plugin: consult Claude Fable as a senior advisor with your full
session transcript (including parent sessions for subagents).

Installed globally via symlink:
`~/.config/opencode/plugin/ocAdvisor.ts` → `src/ocAdvisor.ts`.

Requires OpenCode V2 with a configured connection for the advisor provider.
The 1.x raw Anthropic HTTPS path (and its API-key handling) was removed in 2.0.

## Configuration

The advisor model and limits are configurable. Defaults are unchanged:
`anthropic/claude-fable-5-1#max`, a 300 s generation timeout, and no
transcript cap.

| Option | Default | Meaning |
|---|---|---|
| `model` | `claude-fable-5-1` | Model id, or a full `provider/model#variant` reference |
| `provider` | `anthropic` | Provider id (overrides the provider in `model`) |
| `variant` | `max` | Reasoning-effort variant; `null` or `"none"` pins no variant |
| `timeoutMs` | `300000` | Per-consultation generation timeout, in milliseconds |
| `maxTranscriptChars` | `0` | Cap on transcript size (`0` = unlimited); the most recent tail is kept |

Set them as plugin options in `opencode.json`. Because a plugin loaded from
the auto-discovered `plugin/` directory cannot receive options, either list it
explicitly in the `plugins` array (and remove the `plugin/ocAdvisor.ts`
symlink to avoid a duplicate-ID load), or use the environment fallback below.

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/dev/ocAdvisor/src/ocAdvisor.ts",
      "options": { "model": "anthropic/claude-opus-5#max", "maxTranscriptChars": 120000 }
    }
  ]
}
```

Environment variables work for any install, including the symlink, and take
lower precedence than plugin options: `OCADVISOR_MODEL` (accepts
`provider/model#variant`), `OCADVISOR_PROVIDER`, `OCADVISOR_VARIANT`,
`OCADVISOR_TIMEOUT_MS`, `OCADVISOR_MAX_TRANSCRIPT_CHARS`.

The "already the advisor model" skip is still keyed to Fable
(`anthropic/claude-fable-*`); if you point the advisor at a different model,
that self-consultation guard no longer matches it.

## Usage policy (what agents are told)

On substantial, non-trivial work, consult `ocAdvisor` at three checkpoints:

| Checkpoint | When | Mode / trigger |
|---|---|---|
| Before committing to an approach | Architectural decisions, cross-component changes, migrations, competing approaches with real tradeoffs | `plan` / `before_approach` |
| When stuck | Same problem failing twice, contradictory evidence, recurring unexplained failure | `debug` / `stuck` |
| Before declaring done | After code and checks are done; focused review of correctness, regressions, and cases tests do not establish | `review` / `pre_complete` |

Rules enforced by the tool description and an injected session instruction:

- Always pass a concrete `question` naming the decision or artifact.
- Typically 1–2 consultations per task; repeat only on material change or
  new evidence (`followup` trigger to reconcile conflicts).
- Give the advice serious weight; a passing self-test alone is not
  counter-evidence.
- The tool is hidden in `anthropic/claude-fable-*` sessions (the current
  model is already Fable); calls there return a disabled notice.

## How it works

- `src/ocAdvisor.ts` — the plugin. Registers the `ocAdvisor` tool, injects a
  short checkpoint instruction into eligible sessions via the `context` hook,
  and builds the transcript from the OpenCode SQLite database.
- Before each consultation it checks OpenCode for support of the configured
  advisor model: the provider is enabled (`catalog.provider.get`), the model
  is available (`catalog.model.list`, configured variant when listed), and a
  connection exists (`integration.connection.active`).
- Consultations run as transient generations on a dedicated, reusable
  `ocAdvisor` session pinned to the configured model (default
  `anthropic/claude-fable-5-1#max`) via `session.create` +
  `session.switchModel` once, then `session.generate` per call. Transient
  generations do not mutate session history, so the advisor session stays
  empty while its stats attribute advisor spend.
- The generation timeout wraps only the model call, not the time a call
  spends queued behind another consultation. Oversized transcripts are
  capped to the configured `maxTranscriptChars` (keeping the recent tail)
  because transcript size drives latency and can otherwise exhaust the
  timeout.
  Session instructions are folded into the prompt because the generation
  APIs accept prompt text only.
- Why a pinned session instead of one-shot `POST /api/generate`? One-shot
  generation returns 503 for Anthropic (OAuth credential not resolved on
  that path) while the session path works. Revisit if that changes.
- Repeat control is advisory, not blocking: the plugin counts prior
  consultations in the session chain and tells the advisor to focus on
  what is new since then.
- Real failures (provider/model/connection issues, missing
  transcript/session) throw so OpenCode records them as errors instead of
  silent `completed` results. Fable skips still return the disabled notice.

## Metrics

Every invocation appends one JSON line to
`~/.local/share/opencode/ocAdvisor-metrics.jsonl` with timestamp, session,
caller model/agent, mode, trigger, outcome (`advisor_response`,
`skipped_fable`, `error`, `no_transcript`, `no_session`), error type
(`provider_unavailable`, `model_unavailable`, `auth`, …), latency,
transcript size, prior-consultation count, and transport (`via`).
Token usage is `null`: OpenCode generation returns text only.
Logging is best-effort and never breaks a call.

## Activation

The server loads plugin files once per process, so after changing the
plugin restart the background service (`opencode2 service restart`) or the
old code keeps running. Location eviction does not reload plugin files.

## Evaluation

```sh
bun test              # unit tests
tsc --noEmit          # typecheck (or: bun run typecheck)
bun run report        # usage over the last 30 days
bun src/usageReport.ts --days 7
```

The report combines the metrics log with the session database and shows
invocation counts by outcome/mode/trigger plus eligibility coverage
(sessions with ≥10 non-Fable tool calls vs. sessions that consulted).
Re-run it after a few weeks of the new checkpoints to judge coverage and
whether advice is changing outcomes.
