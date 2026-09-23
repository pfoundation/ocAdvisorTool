/**
 * advisor usage report.
 *
 * Combines the plugin metrics log
 * (~/.local/share/opencode/ocAdvisor-metrics.jsonl, written by new calls;
 * filename kept across the ocAdvisor → advisor rename)
 * with the OpenCode session database (all recorded history) to answer:
 * how often is advisor consulted, with what outcome, and how many
 * eligible sessions never consult it?
 *
 * Run: bun src/usageReport.ts [--days N] [--advisor-model ID]
 *
 * The eligibility proxy excludes the advisor model itself (it cannot consult
 * itself); --advisor-model overrides which id that is. A window spanning an
 * advisor-model change counts pre-switch advisor sessions as eligible, which
 * slightly understates coverage for those days.
 */
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import {
  countCallers,
  countGenerations,
  queryAdvisorHistory,
  sessionsWithAdvice,
} from "./advisorHistory.js";
import { normalizeModelID } from "./modelProfiles.js";

const DB_PATH = join(homedir(), ".local/share/opencode/opencode.db");
const METRICS_PATH = join(
  homedir(),
  ".local/share/opencode/ocAdvisor-metrics.jsonl",
);

const DAY_MS = 24 * 60 * 60 * 1000;

interface MetricsRow {
  ts?: string;
  sessionId?: string | null;
  callerModel?: string | null;
  mode?: string;
  trigger?: string;
  effort?: string | null;
  outcome?: string;
  errorType?: string | null;
  latencyMs?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  gate?: {
    status?: string;
    reason?: string;
    neededProbability?: number | null;
    effectiveEffort?: string | null;
    effortSource?: string | null;
    latencyMs?: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
  };
  benchmarks?: {
    source?: string;
    contentHash?: string | null;
    fetchedAt?: string | null;
    hashVerified?: boolean;
    requester?: string | null;
    requesterMatch?: string | null;
    advisorPolicy?: string | null;
    advisorMatch?: string | null;
    finalEffort?: string | null;
    finalMatch?: string | null;
  };
}

function parseArgs(): { days: number; advisorModel: string } {
  const args = process.argv.slice(2);
  let days = 30;
  // Must match ADVISOR_MODEL in src/ocAdvisor.ts until the report learns to
  // read the plugin config.
  let advisorModel = "claude-opus-5-5";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) days = Math.floor(parsed);
      i++;
    } else if (args[i] === "--advisor-model" && args[i + 1]) {
      advisorModel = args[i + 1];
      i++;
    }
  }
  return { days, advisorModel };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function readMetrics(sinceMs: number): Promise<MetricsRow[]> {
  const file = Bun.file(METRICS_PATH);
  if (!(await file.exists())) return [];
  const rows: MetricsRow[] = [];
  const endMs = Date.now();
  for (const line of (await file.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as MetricsRow;
      if (!row.ts) continue;
      const ts = Date.parse(row.ts);
      if (ts >= sinceMs && ts <= endMs) rows.push(row);
    } catch {}
  }
  return rows;
}

function countBy<T>(
  items: T[],
  key: (item: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const label = key(item);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

// Pure benchmark summary for reports and tests. Rows without benchmark
// evidence (older plugin versions, bypassed gates) are ignored.
export function benchmarkSummaryLines(
  rows: MetricsRow[],
  nowMs: number = Date.now(),
): string[] {
  const enriched = rows.filter((row) => row.benchmarks);
  if (enriched.length === 0) return [];
  const lines = [
    `- Benchmark sources: ${JSON.stringify(countBy(enriched, (row) => row.benchmarks?.source || "unknown"))}`,
    `- Requester matches: ${JSON.stringify(countBy(enriched, (row) => row.benchmarks?.requesterMatch || "unknown"))}`,
    `- Advisor default matches: ${JSON.stringify(countBy(enriched, (row) => row.benchmarks?.advisorMatch || "unknown"))}`,
  ];
  const finals = enriched.filter((row) => row.benchmarks?.finalMatch);
  if (finals.length > 0) {
    lines.push(
      `- Final effort matches: ${JSON.stringify(countBy(finals, (row) => row.benchmarks?.finalMatch || "unknown"))}`,
    );
  }
  const hashes = new Set(
    enriched
      .map((row) => row.benchmarks?.contentHash)
      .filter((hash): hash is string => !!hash),
  );
  if (hashes.size > 0) {
    lines.push(`- Benchmark snapshots seen: ${hashes.size}`);
  }
  const ages = enriched
    .map((row) => {
      const fetchedAt = row.benchmarks?.fetchedAt;
      if (!fetchedAt) return NaN;
      const parsed = Date.parse(fetchedAt);
      if (!Number.isFinite(parsed)) return NaN;
      const days = (nowMs - parsed) / DAY_MS;
      return days >= 0 ? days : NaN;
    })
    .filter((days) => Number.isFinite(days));
  if (ages.length > 0) {
    lines.push(`- Median benchmark data age: ${median(ages)?.toFixed(1)} days`);
  }
  const unverified = enriched.filter(
    (row) => row.benchmarks?.hashVerified === false,
  ).length;
  if (unverified > 0) {
    lines.push(`- Snapshots failing hash verification: ${unverified}`);
  }
  return lines;
}

function queryEligibility(
  db: Database,
  startMs: number,
  endMs: number,
  consulted: Set<string>,
  advisorModel: string,
): {
  activeRootSessions: number;
  eligibleRoots: number;
  eligibleConsulted: number;
  eligibleWithWrites: number;
} {
  const parents = new Map<string, string | null>();
  for (const row of db
    .query<{ id: string; parent_id: string | null }, []>(
      "SELECT id, parent_id FROM session_v2",
    )
    .all()) {
    parents.set(row.id, row.parent_id);
  }
  const stats = new Map<string, { nonAdvisorTools: number; writes: boolean }>();
  const rows = db
    .query<{ session_id: string; data: string }, [number, number]>(
      "SELECT session_id, data FROM session_message WHERE type = 'assistant' AND time_created >= ? AND time_created < ?",
    )
    .all(startMs, endMs);
  for (const row of rows) {
    let data: Record<string, any>;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    const model = data.model || {};
    const id = String(model.id || model.modelID || "");
    // Advisor-model sessions cannot consult the advisor; they are ineligible.
    if (id && normalizeModelID(id) === normalizeModelID(advisorModel)) continue;
    let entry = stats.get(row.session_id);
    if (!entry) {
      entry = { nonAdvisorTools: 0, writes: false };
      stats.set(row.session_id, entry);
    }
    for (const block of data.content || []) {
      if (!block || typeof block !== "object" || block.type !== "tool")
        continue;
      entry.nonAdvisorTools++;
      const name = String(block.name || block.tool || "");
      if (["edit", "write", "patch", "apply_patch"].includes(name)) {
        entry.writes = true;
      }
    }
  }
  let activeRootSessions = 0;
  let eligibleRoots = 0;
  let eligibleConsulted = 0;
  let eligibleWithWrites = 0;
  for (const [sessionId, entry] of stats) {
    if (parents.get(sessionId)) continue;
    activeRootSessions++;
    if (entry.nonAdvisorTools < 10) continue;
    eligibleRoots++;
    if (consulted.has(sessionId)) eligibleConsulted++;
    if (entry.writes) eligibleWithWrites++;
  }
  return {
    activeRootSessions,
    eligibleRoots,
    eligibleConsulted,
    eligibleWithWrites,
  };
}

async function main(): Promise<void> {
  const { days, advisorModel } = parseArgs();
  const endMs = Date.now();
  const startMs = endMs - days * DAY_MS;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const metrics = await readMetrics(startMs);
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const history = queryAdvisorHistory(db, startMs, endMs);
    const consulted = sessionsWithAdvice(history.calls);
    const eligibility = queryEligibility(
      db,
      startMs,
      endMs,
      consulted,
      advisorModel,
    );

    console.log(`# advisor usage — last ${days} days`);
    console.log(`Window: ${startIso} → ${endIso}\n`);

    console.log("## Recorded invocations (session database)");
    console.log(`- Total invocations: ${history.calls.length}`);
    console.log(`- Distinct sessions: ${history.distinctSessions.size}`);
    console.log(
      `- By generation: ${JSON.stringify(countGenerations(history.calls))}`,
    );
    console.log(
      `- By caller result: ${JSON.stringify(countCallers(history.calls))}`,
    );
    const interrupted = history.calls.filter(
      (call) =>
        call.caller === "error" && call.generation === "advisor_response",
    ).length;
    if (interrupted > 0) {
      console.log(
        `- Generated advice whose caller entry failed or was interrupted: ${interrupted}`,
      );
    }
    const unknown = history.calls.filter(
      (call) => call.generation === "unknown",
    ).length;
    if (unknown > 0) {
      console.log(
        `- Completed without visible output (metrics may still record a generated response): ${unknown}`,
      );
    }
    console.log(
      `- By mode: ${JSON.stringify(countBy(history.calls, (call) => call.mode))}`,
    );

    console.log("\n## Metrics log (new calls only)");
    if (metrics.length === 0) {
      console.log(
        `- No entries yet at ${METRICS_PATH} (written by the updated plugin).`,
      );
    } else {
      const latencies = metrics
        .map((row) => row.latencyMs)
        .filter((value): value is number => typeof value === "number");
      const inputTokens = metrics
        .map((row) => row.inputTokens)
        .filter((value): value is number => typeof value === "number");
      console.log(`- Logged calls: ${metrics.length}`);
      console.log(
        `- By outcome: ${JSON.stringify(countBy(metrics, (row) => row.outcome || "unknown"))}`,
      );
      console.log(
        `- By trigger: ${JSON.stringify(countBy(metrics, (row) => row.trigger || "unknown"))}`,
      );
      console.log(
        `- By effort: ${JSON.stringify(countBy(metrics, (row) => row.effort || "unset"))}`,
      );
      const gated = metrics.filter((row) => row.gate);
      if (gated.length > 0) {
        console.log(
          `- Gate decisions: ${JSON.stringify(countBy(gated, (row) => row.gate?.status || "unknown"))}`,
        );
        console.log(
          `- Gate reasons: ${JSON.stringify(countBy(gated, (row) => row.gate?.reason || "unknown"))}`,
        );
        const needed = gated
          .map((row) => row.gate?.neededProbability)
          .filter((value): value is number => typeof value === "number");
        if (needed.length > 0) {
          console.log(`- Median need probability: ${median(needed)}`);
        }
        const gateLatencies = gated
          .map((row) => row.gate?.latencyMs)
          .filter((value): value is number => typeof value === "number");
        if (gateLatencies.length > 0) {
          console.log(
            `- Median gate latency: ${median(gateLatencies) ?? "n/a"} ms`,
          );
        }
        console.log(
          `- TypeSafe tokens: in ${gated.reduce((sum, row) => sum + (row.gate?.inputTokens || 0), 0).toLocaleString()}, out ${gated.reduce((sum, row) => sum + (row.gate?.outputTokens || 0), 0).toLocaleString()}`,
        );
      }
      console.log(`- Median latency: ${median(latencies) ?? "n/a"} ms`);
      for (const line of benchmarkSummaryLines(metrics)) {
        console.log(line);
      }
      if (inputTokens.length === 0) {
        console.log(
          "- Token usage: unavailable (OpenCode session generation returns text only)",
        );
      } else {
        console.log(`- Median input tokens: ${median(inputTokens) ?? "n/a"}`);
        const totalOut = metrics.reduce(
          (sum, row) => sum + (row.outputTokens || 0),
          0,
        );
        console.log(`- Total output tokens: ${totalOut.toLocaleString()}`);
      }
      console.log(
        "- Database and metrics views are independent; do not sum them.",
      );
    }

    console.log(
      `\n## Eligibility coverage (proxy: ≥10 non-advisor tool calls, advisor model ${advisorModel})`,
    );
    console.log(`- Active root sessions: ${eligibility.activeRootSessions}`);
    console.log(`- Eligible sessions: ${eligibility.eligibleRoots}`);
    console.log(
      `- Eligible with generated advice: ${eligibility.eligibleConsulted}`,
    );
    console.log(
      `- Eligible with file writes: ${eligibility.eligibleWithWrites}`,
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
