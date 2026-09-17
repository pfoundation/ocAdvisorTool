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
 * Run: bun src/usageReport.ts [--days N]
 */
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";

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
}

function parseArgs(): { days: number } {
  const args = process.argv.slice(2);
  let days = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) days = Math.floor(parsed);
      i++;
    }
  }
  return { days };
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
  for (const line of (await file.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as MetricsRow;
      if (row.ts && Date.parse(row.ts) >= sinceMs) rows.push(row);
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

interface HistoryCall {
  timeUtc: string;
  sessionId: string;
  mode: string;
  outcome: "advisor_response" | "skipped_fable" | "error";
}

// Matches the current "advisor" tool name and the pre-rename "ocAdvisor" name.
function isAdvisorToolName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "advisor" || normalized === "ocadvisor";
}

function isDisabledNotice(output: string): boolean {
  return (
    output.startsWith("advisor is disabled") ||
    output.startsWith("ocAdvisor is disabled")
  );
}

function isFailureFooter(output: string): boolean {
  return (
    /^Error calling (Opus )?advisor:/.test(output) ||
    output.startsWith("advisor failed") ||
    output.startsWith("ocAdvisor failed")
  );
}

function queryHistory(
  db: Database,
  startMs: number,
  endMs: number,
): { calls: HistoryCall[]; distinctSessions: Set<string> } {
  const calls: HistoryCall[] = [];
  const distinctSessions = new Set<string>();
  const seen = new Set<string>();
  const rows = db
    .query<{ id: string; session_id: string; data: string }, [number, number]>(
      "SELECT id, session_id, data FROM session_message WHERE type = 'assistant' AND time_created >= ? AND time_created < ? AND data LIKE '%advisor%'",
    )
    .all(startMs, endMs);
  for (const row of rows) {
    let data: Record<string, any>;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    for (const block of data.content || []) {
      if (!block || typeof block !== "object" || block.type !== "tool")
        continue;
      const name = String(block.name || block.tool || "");
      const state = block.state || {};
      const nested = state.metadata?.toolCalls || [];
      const matches: Array<{ input: any }> = isAdvisorToolName(name)
        ? [{ input: state.input }]
        : nested
            .map((call: any, index: number) => ({ call, index }))
            .filter(({ call }: { call: any }) =>
              isAdvisorToolName(call.tool || call.name),
            )
            .map(({ call }: { call: any }) => ({ input: call.input }));
      if (matches.length === 0) continue;
      const output = (state.content || [])
        .filter((item: any) => item && item.type === "text")
        .map((item: any) => item.text || "")
        .join("\n");
      const outcome = isDisabledNotice(output)
        ? "skipped_fable"
        : isFailureFooter(output)
          ? "error"
          : "advisor_response";
      const stamp = block.time?.ran || block.time?.created || startMs;
      matches.forEach((match, matchIndex) => {
        const key = `${block.id || row.id}#${matchIndex}`;
        if (seen.has(key)) return;
        seen.add(key);
        distinctSessions.add(row.session_id);
        calls.push({
          timeUtc: new Date(stamp).toISOString(),
          sessionId: row.session_id,
          mode: String(match.input?.mode || "general"),
          outcome,
        });
      });
    }
  }
  calls.sort((a, b) => a.timeUtc.localeCompare(b.timeUtc));
  return { calls, distinctSessions };
}

function queryEligibility(
  db: Database,
  startMs: number,
  endMs: number,
  consulted: Set<string>,
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
  const stats = new Map<string, { nonFableTools: number; writes: boolean }>();
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
    const provider = String(
      model.providerID || model.provider || "",
    ).toLowerCase();
    const id = String(model.id || model.modelID || "").toLowerCase();
    if (provider.includes("anthropic") && id.includes("fable")) continue;
    let entry = stats.get(row.session_id);
    if (!entry) {
      entry = { nonFableTools: 0, writes: false };
      stats.set(row.session_id, entry);
    }
    for (const block of data.content || []) {
      if (!block || typeof block !== "object" || block.type !== "tool")
        continue;
      entry.nonFableTools++;
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
    if (entry.nonFableTools < 10) continue;
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
  const { days } = parseArgs();
  const endMs = Date.now();
  const startMs = endMs - days * DAY_MS;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const metrics = await readMetrics(startMs);
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const history = queryHistory(db, startMs, endMs);
    const consulted = new Set(
      history.calls
        .filter((call) => call.outcome === "advisor_response")
        .map((call) => call.sessionId),
    );
    const eligibility = queryEligibility(db, startMs, endMs, consulted);

    console.log(`# advisor usage — last ${days} days`);
    console.log(`Window: ${startIso} → ${endIso}\n`);

    console.log("## Recorded invocations (session database)");
    console.log(`- Total invocations: ${history.calls.length}`);
    console.log(`- Distinct sessions: ${history.distinctSessions.size}`);
    console.log(
      `- By outcome: ${JSON.stringify(countBy(history.calls, (c) => c.outcome))}`,
    );
    console.log(
      `- By mode: ${JSON.stringify(countBy(history.calls, (c) => c.mode))}`,
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
      console.log(`- Median latency: ${median(latencies) ?? "n/a"} ms`);
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
    }

    console.log("\n## Eligibility coverage (proxy: ≥10 non-Fable tool calls)");
    console.log(`- Active root sessions: ${eligibility.activeRootSessions}`);
    console.log(`- Eligible sessions: ${eligibility.eligibleRoots}`);
    console.log(
      `- Eligible with an advisor response: ${eligibility.eligibleConsulted}`,
    );
    console.log(
      `- Eligible with file writes: ${eligibility.eligibleWithWrites}`,
    );
  } finally {
    db.close();
  }
}

await main();
