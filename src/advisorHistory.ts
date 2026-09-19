// Shared advisor-call history parsing.
//
// Counts and reports previously inferred success from output text alone, so
// interrupted or errored tool calls could be counted as generated advice. A
// call now carries:
//
// - `generation`: what the plugin recorded — a generated advisor response, a
//   Fable/TypeSafe skip notice, or a real failure. "unknown" means the tool
//   completed without visible output.
// - `caller`: what the tool entry recorded. An `error` entry can still have
//   produced advice (for example the caller was interrupted while the plugin
//   generated), so the two views stay separate instead of being summed.
import { Database } from "bun:sqlite";

export type AdvisorGeneration =
  | "advisor_response"
  | "skipped_fable"
  | "skipped_typesafe"
  | "error"
  | "running"
  | "unknown";

export type AdvisorCaller = "completed" | "error" | "running" | "unknown";

export interface AdvisorCallRecord {
  callId: string;
  sessionId: string;
  timeUtc: string;
  mode: string;
  questionChars: number;
  generation: AdvisorGeneration;
  caller: AdvisorCaller;
  /** True when structured state already reported advice for this call. */
  hadOutput: boolean;
}

export interface AdvisorHistory {
  calls: AdvisorCallRecord[];
  distinctSessions: Set<string>;
}

// Matches the current "advisor" tool name and the pre-rename "ocAdvisor" name.
export function isAdvisorToolName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "advisor" || normalized === "ocadvisor";
}

export function isDisabledNotice(output: string): boolean {
  return (
    output.startsWith("advisor is disabled") ||
    output.startsWith("ocAdvisor is disabled")
  );
}

export function isSkipNotice(output: string): boolean {
  return output.startsWith("advisor consultation skipped");
}

export function isFailureFooter(output: string): boolean {
  return (
    /^Error calling (Opus )?advisor:/.test(output) ||
    output.startsWith("advisor failed") ||
    output.startsWith("ocAdvisor failed")
  );
}

function isTerminal(status: unknown): boolean {
  return status === "completed" || status === "error";
}

function callerFrom(status: unknown): AdvisorCaller {
  if (status === "completed") return "completed";
  if (status === "error") return "error";
  if (status === "running" || status === "streaming" || status === "pending") {
    return "running";
  }
  return "unknown";
}

// Classifies the recorded output. Missing output is "unknown", never a
// success: structured tool state, not text, decides what the caller saw.
function generationFrom(
  status: unknown,
  output: string,
  hadOutput: boolean,
): AdvisorGeneration {
  if (status === "running" || status === "streaming" || status === "pending") {
    return "running";
  }
  if (!hadOutput || !output.trim()) return "unknown";
  if (isDisabledNotice(output)) return "skipped_fable";
  if (isSkipNotice(output)) return "skipped_typesafe";
  if (isFailureFooter(output)) return "error";
  return "advisor_response";
}

function outputText(state: Record<string, any> | undefined): {
  text: string;
  hadOutput: boolean;
} {
  const content = Array.isArray(state?.content) ? state.content : [];
  const texts = content
    .filter((item: any) => item && item.type === "text")
    .map((item: any) => String(item.text ?? ""));
  const joined = texts.join("\n");
  return { text: joined, hadOutput: joined.trim().length > 0 };
}

interface RawMatch {
  input: Record<string, any> | undefined;
  state: Record<string, any>;
  outputText: string | null;
}

// Extracts advisor matches from one tool block, including calls nested inside
// the Code Mode `execute` tool's recorded metadata.
function matchesForBlock(name: string, state: Record<string, any>): RawMatch[] {
  if (isAdvisorToolName(name))
    return [{ input: state.input, state, outputText: null }];
  const nested = Array.isArray(state.metadata?.toolCalls)
    ? state.metadata.toolCalls
    : [];
  return nested
    .filter((call: any) => call && isAdvisorToolName(call.tool || call.name))
    .map((call: any) => {
      const nestedState =
        call.state ??
        (typeof call.status === "string" ? { status: call.status } : {});
      const nestedOutput =
        typeof call.output === "string" && call.output.trim().length > 0
          ? call.output
          : null;
      // Older nested entries may omit status entirely; recorded nested
      // output still means the call ran to completion.
      if (nestedState.status === undefined && nestedOutput) {
        nestedState.status = "completed";
      }
      return {
        input: call.input,
        state: nestedState,
        outputText: nestedOutput,
      };
    });
}

export function queryAdvisorHistory(
  db: Database,
  startMs: number,
  endMs: number,
): AdvisorHistory {
  const calls = new Map<string, AdvisorCallRecord>();
  const distinctSessions = new Set<string>();
  const consider = (record: AdvisorCallRecord) => {
    const existing = calls.get(record.callId);
    // Keep the most informative record when the same call appears in more
    // than one retained representation.
    if (!existing || rank(record) > rank(existing)) {
      calls.set(record.callId, record);
      distinctSessions.add(record.sessionId);
    }
  };

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
      const matches = matchesForBlock(name, state);
      if (matches.length === 0) continue;
      // Only terminal entries describe a finished call; running ones are
      // reported separately rather than as advice.
      const caller = callerFrom(state.status);
      if (!isTerminal(state.status) && caller !== "running") continue;
      const blockTime = block.time?.ran || block.time?.created;
      const time = new Date(
        typeof blockTime === "number"
          ? blockTime
          : rowTime(row.id, data, startMs),
      ).toISOString();
      matches.forEach((match, index) => {
        const callId = String(
          index === 0
            ? block.id || block.callID || row.id
            : `${block.id || row.id}#${index}`,
        );
        const direct = outputText(state);
        const output = match.outputText ?? direct.text;
        const hadOutput = direct.hadOutput || !!match.outputText;
        consider({
          callId,
          sessionId: row.session_id,
          timeUtc: time,
          mode: String(match.input?.mode || "general"),
          questionChars:
            typeof match.input?.question === "string"
              ? match.input.question.length
              : 0,
          generation: generationFrom(match.state.status, output, hadOutput),
          caller,
          hadOutput,
        });
      });
    }
  }

  const sorted = [...calls.values()].sort((a, b) =>
    a.timeUtc.localeCompare(b.timeUtc),
  );
  return { calls: sorted, distinctSessions };
}

// Message rows do not always carry a usable block time; the window start is
// the safest lower bound.
function rowTime(
  _id: string,
  _data: Record<string, any>,
  startMs: number,
): number {
  return startMs;
}

function rank(record: AdvisorCallRecord): number {
  let score = 0;
  if (record.hadOutput) score += 4;
  if (record.generation === "advisor_response") score += 2;
  if (
    record.generation === "skipped_fable" ||
    record.generation === "skipped_typesafe"
  ) {
    score += 1;
  }
  return score;
}

export function countGenerations(
  calls: readonly AdvisorCallRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    counts[call.generation] = (counts[call.generation] ?? 0) + 1;
  }
  return counts;
}

export function countCallers(
  calls: readonly AdvisorCallRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    counts[call.caller] = (counts[call.caller] ?? 0) + 1;
  }
  return counts;
}

export function distinctSessions(
  calls: readonly AdvisorCallRecord[],
): Set<string> {
  return new Set(calls.map((call) => call.sessionId));
}

export function sessionsWithAdvice(
  calls: readonly AdvisorCallRecord[],
): Set<string> {
  return new Set(
    calls
      .filter((call) => call.generation === "advisor_response")
      .map((call) => call.sessionId),
  );
}
