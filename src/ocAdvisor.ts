import { Database } from "bun:sqlite";
import { appendFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const DB_PATH = join(homedir(), ".local/share/opencode/opencode.db");
const METRICS_PATH = join(
  homedir(),
  ".local/share/opencode/ocAdvisor-metrics.jsonl",
);
const ADVISOR_PROVIDER = "anthropic";
const ADVISOR_MODEL = "claude-fable-5-1";
const ADVISOR_VARIANT = "xhigh";
const ADVISOR_SESSION_TITLE = "advisor";
// Sessions created before the ocAdvisor → advisor rename keep working: title
// discovery accepts both, and the storage key below is unchanged.
const LEGACY_ADVISOR_SESSION_TITLE = "ocAdvisor";
const ADVISOR_STORAGE_KEY = "advisorSessionID";
const ADVISOR_TIMEOUT_MS = 300_000;
// Effort levels the agent may request per call when `agentEffort: true`
// (subset of the model's catalog variants; validated per consultation).
const AGENT_EFFORT_DEFAULTS = ["high", "xhigh", "max"];
const FABLE_DISABLED =
  "advisor is disabled for anthropic/claude-fable-* sessions — the current model is already Fable.";

// The advisor model is configurable via plugin options in opencode.json
// (`{ "package": "...", "options": { "model": "anthropic/claude-fable-5-1#xhigh" } }`)
// or, for symlink/auto-discovered installs that cannot receive options,
// via environment variables (OCADVISOR_MODEL, OCADVISOR_PROVIDER,
// OCADVISOR_VARIANT, OCADVISOR_TIMEOUT_MS, OCADVISOR_MAX_TRANSCRIPT_CHARS,
// OCADVISOR_AGENT_EFFORT).
// Defaults preserve the original behavior: anthropic/claude-fable-5-1#xhigh.
interface AdvisorConfig {
  provider: string;
  model: string;
  variant: string | undefined;
  timeoutMs: number;
  maxTranscriptChars: number;
  agentEffort: string[] | null;
}

const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  provider: ADVISOR_PROVIDER,
  model: ADVISOR_MODEL,
  variant: ADVISOR_VARIANT,
  timeoutMs: ADVISOR_TIMEOUT_MS,
  maxTranscriptChars: 0,
  agentEffort: null,
};

interface AdvisorConfigSource {
  model?: unknown;
  provider?: unknown;
  variant?: unknown;
  timeoutMs?: unknown;
  timeout_ms?: unknown;
  maxTranscriptChars?: unknown;
  max_transcript_chars?: unknown;
  agentEffort?: unknown;
  agent_effort?: unknown;
}

function normalizeVariant(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === "none") return undefined;
  return text;
}

function dedupeEfforts(items: string[]): string[] | null {
  const seen = new Set<string>();
  for (const item of items) {
    const text = item.trim();
    if (text) seen.add(text);
  }
  return seen.size > 0 ? [...seen] : null;
}

// `true` enables the default levels, `false`/`null` disables the feature,
// and an array or comma-separated string sets an explicit allow-list.
// Returns undefined for unrecognized types so the caller keeps the base.
function normalizeAgentEffort(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === true) return [...AGENT_EFFORT_DEFAULTS];
  if (value === false) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const lowered = text.toLowerCase();
    if (lowered === "true") return [...AGENT_EFFORT_DEFAULTS];
    if (lowered === "false" || lowered === "none") return null;
    return dedupeEfforts(text.split(","));
  }
  if (Array.isArray(value)) {
    return dedupeEfforts(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .flatMap((entry) => entry.split(",")),
    );
  }
  return undefined;
}

function toBoundedInt(value: unknown, min: number): number | undefined {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : undefined;
}

// Splits a "provider/model#variant" reference. All three parts are optional;
// a bare "claude-opus-5" (no slash) is treated as a model id.
function parseModelRef(ref: string): {
  provider?: string;
  model?: string;
  variant?: string;
} {
  const out: { provider?: string; model?: string; variant?: string } = {};
  let rest = ref.trim();
  if (!rest) return out;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    const variant = rest.slice(hash + 1).trim();
    if (variant) out.variant = variant;
    rest = rest.slice(0, hash).trim();
  }
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    const provider = rest.slice(0, slash).trim();
    const model = rest.slice(slash + 1).trim();
    if (provider) out.provider = provider;
    if (model) out.model = model;
  } else if (rest) {
    out.model = rest;
  }
  return out;
}

function applyAdvisorConfigSource(
  base: AdvisorConfig,
  src: AdvisorConfigSource | null | undefined,
): AdvisorConfig {
  if (!src || typeof src !== "object") return base;
  const next: AdvisorConfig = { ...base };
  if (typeof src.model === "string" && src.model.trim()) {
    const parsed = parseModelRef(src.model);
    if (parsed.provider) next.provider = parsed.provider;
    if (parsed.model) next.model = parsed.model;
    if (parsed.variant !== undefined) {
      next.variant = normalizeVariant(parsed.variant);
    }
  }
  if (typeof src.provider === "string" && src.provider.trim()) {
    next.provider = src.provider.trim();
  }
  // An explicit `variant` (including null / "none") overrides the pin.
  if (src.variant !== undefined) {
    next.variant = normalizeVariant(src.variant);
  }
  const agentEffort = src.agentEffort ?? src.agent_effort;
  if (agentEffort !== undefined) {
    const normalized = normalizeAgentEffort(agentEffort);
    if (normalized !== undefined) next.agentEffort = normalized;
  }
  const timeout = toBoundedInt(src.timeoutMs ?? src.timeout_ms, 1);
  if (timeout !== undefined) next.timeoutMs = timeout;
  const cap = toBoundedInt(
    src.maxTranscriptChars ?? src.max_transcript_chars,
    0,
  );
  if (cap !== undefined) next.maxTranscriptChars = cap;
  return next;
}

function envAdvisorConfigSource(
  env: Record<string, string | undefined> = process.env,
): AdvisorConfigSource {
  return {
    model: env.OCADVISOR_MODEL,
    provider: env.OCADVISOR_PROVIDER,
    variant: env.OCADVISOR_VARIANT,
    timeoutMs: env.OCADVISOR_TIMEOUT_MS,
    maxTranscriptChars: env.OCADVISOR_MAX_TRANSCRIPT_CHARS,
    agentEffort: env.OCADVISOR_AGENT_EFFORT,
  };
}

// Precedence (low to high): built-in defaults, environment variables,
// plugin options from opencode.json.
function resolveAdvisorConfig(
  options?: Record<string, unknown> | null,
  env: Record<string, string | undefined> = process.env,
): AdvisorConfig {
  let config = applyAdvisorConfigSource(
    DEFAULT_ADVISOR_CONFIG,
    envAdvisorConfigSource(env),
  );
  config = applyAdvisorConfigSource(config, options as AdvisorConfigSource);
  return config;
}

const SYSTEM_BASE = `You are a senior advisor reviewing a coding agent's work. You have the full session transcript.
Respond in 500-750 words with structured analysis and enumerated steps. Be direct and actionable.`;

const SYSTEM_PROMPTS: Record<string, string> = {
  general: `${SYSTEM_BASE}
You are a senior software engineer. Analyze the conversation, identify issues, misunderstandings, or missed opportunities. Suggest corrections and improvements. If the agent is on the right track, confirm and suggest optimizations.`,
  review: `${SYSTEM_BASE}
You are a code reviewer. Focus on correctness, edge cases, security vulnerabilities, performance issues, and adherence to best practices. Evaluate the code changes in context of the broader codebase patterns visible in the transcript.`,
  plan: `${SYSTEM_BASE}
You are a software architect. Evaluate the current approach and plan. Identify risks, suggest alternatives, flag missing considerations. Assess whether the scope is appropriate and dependencies are accounted for.`,
  debug: `${SYSTEM_BASE}
You are a debugger. Analyze error patterns, stack traces, and failed attempts in the transcript. Identify root causes, explain why previous fixes didn't work, and propose targeted solutions.`,
};

const TOOL_DESCRIPTION = `Consult a senior advisor model with your full session transcript — including parent sessions for subagents — for high-quality analysis.

Use advisor selectively on substantial, non-trivial work. Straightforward tasks normally need no consultation.

- Normally make AT MOST ONE consultation per task, at the point where a second opinion has the most value: a consequential unresolved design decision (mode "plan"), a blocker after two substantially different attempts (mode "debug"), or a high-risk change with a specific unresolved correctness concern (mode "review"). Pick one stage, not all three.
- mode "general": a second opinion that does not fit the above.

Rules:
- Always pass a concrete "question" naming the decision or artifact under review.
- A second consultation requires material new evidence, a distinct unresolved issue, or an explicit user request. Reconcile an advisor conflict with primary-source evidence via one "followup" call stating both sides.
- Give the advice serious weight. A passing self-test alone is not counter-evidence; primary-source evidence (the file says X) is. Clear factual corrections do not need another confirmation call.

Args: "mode" (general, review, plan, debug), "trigger" (before_approach, stuck, pre_complete, followup, other), "question" (concrete question focusing the advisor).
`;

// When `agentEffort` is enabled the tool advertises an optional `effort`
// argument; otherwise the description is exactly TOOL_DESCRIPTION.
function buildToolDescription(
  config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG,
): string {
  if (!config.agentEffort || config.agentEffort.length === 0) {
    return TOOL_DESCRIPTION;
  }
  return (
    TOOL_DESCRIPTION +
    `Optional "effort" (one of: ${config.agentEffort.join(", ")}): reasoning effort for this consultation; omit to use the configured variant.\n`
  );
}

const CHECKPOINT_INSTRUCTION = `[advisor] Use advisor selectively on substantial work: normally 0-1 consultations per task, at most one unless material new evidence, a distinct unresolved issue, or an explicit user request. Consult for a consequential undecided design (mode "plan"), a blocker after 2+ different attempts (mode "debug"), or a high-risk change with a specific correctness concern (mode "review"). Always pass a concrete question.`;

const ADVISOR_TRIGGERS = [
  "before_approach",
  "stuck",
  "pre_complete",
  "followup",
  "other",
] as const;
type AdvisorTrigger = (typeof ADVISOR_TRIGGERS)[number];

type AdvisorOutcome =
  | "advisor_response"
  | "skipped_fable"
  | "error"
  | "no_transcript"
  | "no_session";

interface AdvisorMetrics {
  ts: string;
  sessionId: string | null;
  callerModel: string | null;
  callerAgent: string | null;
  directory: string | null;
  mode: string;
  trigger: AdvisorTrigger;
  questionChars: number;
  effort: string | null;
  outcome: AdvisorOutcome;
  errorType: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  transcriptChars: number;
  priorConsultations: number;
  via: string;
}

const ADVISOR_INPUT_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["general", "review", "plan", "debug"],
      description: "Advisory mode: general, review, plan, or debug",
    },
    trigger: {
      type: "string",
      enum: ["before_approach", "stuck", "pre_complete", "followup", "other"],
      description:
        "Why you are consulting now: before_approach, stuck, pre_complete, followup, or other",
    },
    question: {
      type: "string",
      description:
        "Concrete question naming the decision or artifact under review",
    },
  },
};

// When `agentEffort` is enabled the schema gains an optional `effort`
// argument restricted to the allowed levels.
function buildAdvisorInputSchema(
  config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG,
) {
  if (!config.agentEffort || config.agentEffort.length === 0) {
    return ADVISOR_INPUT_SCHEMA;
  }
  return {
    ...ADVISOR_INPUT_SCHEMA,
    properties: {
      ...ADVISOR_INPUT_SCHEMA.properties,
      effort: {
        type: "string",
        enum: [...config.agentEffort],
        description:
          "Reasoning effort for this consultation (omit to use the configured variant)",
      },
    },
  };
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string;
  directory: string;
}

interface MessageRow {
  id: string;
  data: string;
  time_created: number;
}

interface PartRow {
  data: string;
  time_created: number;
}

interface SessionMessageRow {
  type: string;
  data: string;
}

interface SessionModel {
  id?: string;
  modelID?: string;
  providerID?: string;
  provider?: string;
}

interface SessionInfo {
  model: SessionModel | null;
  agent: string | null;
  directory: string | null;
  parentId: string | null;
}

interface V2PluginContext {
  tool?: { transform?: Function };
  session?: {
    hook?: Function;
    create?: Function;
    get?: Function;
    list?: Function;
    switchModel?: Function;
    generate?: Function;
  };
  catalog?: {
    provider?: { get?: Function; list?: Function };
    model?: { list?: Function };
  };
  integration?: { connection?: { active?: Function } };
  storage?: { get?: Function; set?: Function };
}

function openDb(): InstanceType<typeof Database> {
  return new Database(DB_PATH, { readonly: true });
}

function tableExists(db: InstanceType<typeof Database>, name: string): boolean {
  const row = db
    .query(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name) as { ok?: number } | null;
  return Boolean(row);
}

function parseModelJson(raw: string | null | undefined): SessionModel | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as SessionModel;
  } catch {}
  return null;
}

function isFableModel(
  model:
    | {
        providerID?: string;
        provider?: string;
        id?: string;
        modelID?: string;
      }
    | null
    | undefined,
): boolean {
  if (!model) return false;
  const provider = String(
    model.providerID || model.provider || "",
  ).toLowerCase();
  const id = String(model.id || model.modelID || "").toLowerCase();
  return provider.includes("anthropic") && id.includes("fable");
}

function inferTrigger(
  mode: string | undefined,
  trigger: string | undefined,
): AdvisorTrigger {
  if (trigger && (ADVISOR_TRIGGERS as readonly string[]).includes(trigger)) {
    return trigger as AdvisorTrigger;
  }
  switch ((mode || "general").toLowerCase()) {
    case "plan":
      return "before_approach";
    case "debug":
      return "stuck";
    case "review":
      return "pre_complete";
    default:
      return "other";
  }
}

// Validates a per-call effort request against the plugin's allow-list.
// Returns undefined when the agent omitted it or the feature is disabled
// (a stray value is ignored then, since the schema never advertised it).
function resolveRequestedEffort(
  config: AdvisorConfig,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const allowed = config.agentEffort;
  if (!allowed || allowed.length === 0) return undefined;
  if (!allowed.includes(text)) {
    throw new Error(
      `Effort "${text}" is not allowed (allowed: ${allowed.join(", ")}).`,
    );
  }
  return text;
}

function classifyAdvisorError(message: string): string {
  const text = message.toLowerCase();
  if (
    text.includes("credit balance is too low") ||
    text.includes("insufficient")
  ) {
    return "insufficient_credit";
  }
  if (text.includes("rate_limit") || text.includes(" 429")) {
    return "rate_limit";
  }
  if (text.includes("not a variant of") || text.includes("is not allowed")) {
    return "invalid_effort";
  }
  if (
    text.includes("failed to parse json") ||
    text.includes("unexpected token")
  ) {
    return "json_parse";
  }
  if (text.includes("aborted") || text.includes("abort")) {
    return "aborted";
  }
  if (text.includes("timeout") || text.includes("timed out")) {
    return "timeout";
  }
  if (
    text.includes(" 401") ||
    text.includes("unauthorized") ||
    text.includes("invalid x-api-key") ||
    text.includes("authentication") ||
    text.includes("no anthropic connection") ||
    text.includes("connection configured") ||
    text.includes("not connected") ||
    text.includes("needs authentication") ||
    text.includes("missing credential")
  ) {
    return "auth";
  }
  if (
    text.includes("model unavailable") ||
    text.includes("model not found") ||
    (text.includes("model") &&
      (text.includes("not enabled") || text.includes("disabled")))
  ) {
    return "model_unavailable";
  }
  if (
    text.includes("provider") &&
    (text.includes("unavailable") ||
      text.includes("disabled") ||
      text.includes("not found") ||
      text.includes("service unavailable"))
  ) {
    return "provider_unavailable";
  }
  if (text.includes("no transcript")) return "no_transcript";
  if (text.includes("no session")) return "no_session";
  return "api_error";
}

function callerLabel(model: SessionModel | null): string | null {
  if (!model) return null;
  const provider = model.providerID || model.provider || "unknown";
  const id = model.id || model.modelID || "unknown";
  return `${provider}/${id}`;
}

function getSessionInfo(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionInfo | null {
  for (const table of ["session_v2", "session"]) {
    if (!tableExists(db, table)) continue;
    try {
      const row = db
        .query<
          {
            model: string | null;
            agent: string | null;
            directory: string | null;
            parent_id: string | null;
          },
          [string]
        >(
          `SELECT model, agent, directory, parent_id FROM ${table} WHERE id = ?`,
        )
        .get(sessionId);
      if (row) {
        return {
          model: parseModelJson(row.model),
          agent: row.agent ?? null,
          directory: row.directory ?? null,
          parentId: row.parent_id ?? null,
        };
      }
    } catch {}
  }
  return null;
}

function collectSessionChain(
  db: InstanceType<typeof Database>,
  sessionId: string,
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | null = sessionId;
  while (current && !visited.has(current) && chain.length < 10) {
    visited.add(current);
    chain.push(current);
    current = getSessionInfo(db, current)?.parentId ?? null;
  }
  return chain;
}

function isTerminalToolStatus(status: unknown): boolean {
  return status === "completed" || status === "error";
}

// Matches the current "advisor" tool name and the pre-rename "ocAdvisor"
// name so history counting and the context hook keep working across the
// rename. Normalization mirrors the hook: lowercase, letters only.
function isAdvisorToolName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "advisor" || normalized === "ocadvisor";
}

function countPriorAdvisorCalls(
  db: InstanceType<typeof Database>,
  sessionId: string,
): { count: number; modes: string[] } {
  const callIds = new Set<string>();
  const modes: string[] = [];
  try {
    for (const sid of collectSessionChain(db, sessionId)) {
      if (tableExists(db, "session_message")) {
        const rows = db
          .query<{ id: string; data: string }, [string]>(
            "SELECT id, data FROM session_message WHERE session_id = ? AND type = 'assistant'",
          )
          .all(sid);
        for (const row of rows) {
          let data: Record<string, any>;
          try {
            data = JSON.parse(row.data);
          } catch {
            continue;
          }
          for (const block of data.content || []) {
            if (!block || typeof block !== "object") continue;
            if (block.type !== "tool") continue;
            const name = String(block.name || block.tool || "");
            const state = block.state || {};
            if (!isTerminalToolStatus(state.status)) continue;
            const nested = state.metadata?.toolCalls || [];
            if (isAdvisorToolName(name)) {
              const cid = String(block.id || block.callID || row.id);
              if (!callIds.has(cid)) {
                callIds.add(cid);
                modes.push(String(state.input?.mode || "general"));
              }
            }
            nested.forEach((call: Record<string, any>, index: number) => {
              if (isAdvisorToolName(call.tool || call.name)) {
                const cid = `${block.id || row.id}#${index}`;
                if (!callIds.has(cid)) {
                  callIds.add(cid);
                  modes.push(String(call.input?.mode || "general"));
                }
              }
            });
          }
        }
      }
      if (tableExists(db, "part")) {
        const rows = db
          .query<{ data: string }, [string]>(
            "SELECT data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'",
          )
          .all(sid);
        for (const row of rows) {
          let block: Record<string, any>;
          try {
            block = JSON.parse(row.data);
          } catch {
            continue;
          }
          const name = String(block.tool || block.name || "");
          if (!isAdvisorToolName(name)) continue;
          if (!isTerminalToolStatus(block.state?.status)) continue;
          const cid = String(block.callID || block.id || "");
          if (!cid || callIds.has(cid)) continue;
          callIds.add(cid);
          modes.push(String(block.state?.input?.mode || "general"));
        }
      }
    }
  } catch {}
  return { count: callIds.size, modes };
}

async function logAdvisorMetrics(metrics: AdvisorMetrics): Promise<void> {
  try {
    await appendFile(METRICS_PATH, JSON.stringify(metrics) + "\n", "utf-8");
  } catch {
    // Metrics must never break the advisor call.
  }
}

function getSession(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionRow | null {
  return db
    .query<SessionRow, [string]>(
      "SELECT id, parent_id, title, directory FROM session WHERE id = ?",
    )
    .get(sessionId);
}

function getSessionV2(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionRow | null {
  return db
    .query<SessionRow, [string]>(
      "SELECT id, parent_id, title, directory FROM session_v2 WHERE id = ?",
    )
    .get(sessionId);
}

function getMessages(
  db: InstanceType<typeof Database>,
  sessionId: string,
): MessageRow[] {
  return db
    .query<MessageRow, [string]>(
      "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC",
    )
    .all(sessionId);
}

function getParts(
  db: InstanceType<typeof Database>,
  messageId: string,
): PartRow[] {
  return db
    .query<PartRow, [string]>(
      "SELECT data, time_created FROM part WHERE message_id = ? ORDER BY time_created ASC",
    )
    .all(messageId);
}

function getSessionMessages(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionMessageRow[] {
  return db
    .query<SessionMessageRow, [string]>(
      "SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq ASC",
    )
    .all(sessionId);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "\n... (truncated)" : value;
}

function stringifyUnknown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatPartContent(part: Record<string, any>): string | null {
  switch (part.type) {
    case "text":
      return part.text || null;
    case "tool": {
      const name = part.tool || part.name || "unknown";
      const status = part.state?.status || "unknown";
      const lines: string[] = [`[Tool: ${name}] (${status})`];
      if (part.state?.input) {
        lines.push(
          `Input: ${truncate(stringifyUnknown(part.state.input), 2000)}`,
        );
      }
      const output = part.state?.output ?? part.state?.content;
      if (output) {
        lines.push(`Output: ${truncate(stringifyUnknown(output), 3000)}`);
      }
      if (part.state?.error) lines.push(`Error: ${part.state.error}`);
      return lines.join("\n");
    }
    case "compaction":
      return `[Context compaction occurred${part.auto ? " (auto)" : " (manual)"}]`;
    default:
      return null;
  }
}

function formatV2Content(block: Record<string, any>): string | null {
  switch (block.type) {
    case "text":
      return block.text || null;
    case "reasoning":
      return null;
    case "tool":
      return formatPartContent({
        type: "tool",
        tool: block.name || block.tool,
        state: block.state,
      });
    default:
      return typeof block.text === "string" && block.text ? block.text : null;
  }
}

function formatV2Message(
  type: string,
  data: Record<string, any>,
): string | null {
  if (type === "user") {
    const text = typeof data.text === "string" ? data.text : "";
    return text ? `## User\n${text}` : null;
  }
  if (type === "assistant") {
    const agent = data.agent ? ` (agent: ${data.agent})` : "";
    const modelId = data.model?.id || data.model?.modelID;
    const model = modelId ? ` [${modelId}]` : "";
    const parts: string[] = [];
    for (const block of data.content || []) {
      if (!block || typeof block !== "object") continue;
      const content = formatV2Content(block);
      if (content) parts.push(content);
    }
    if (parts.length === 0) return null;
    return `## Assistant${agent}${model}\n${parts.join("\n\n")}`;
  }
  if (type === "compaction") {
    const auto = data.reason === "auto" || data.auto;
    const summary =
      typeof data.summary === "string" && data.summary
        ? `\n${truncate(data.summary, 2000)}`
        : "";
    return `[Context compaction occurred${auto ? " (auto)" : " (manual)"}]${summary}`;
  }
  if (type === "synthetic" && typeof data.text === "string" && data.text) {
    return `## Synthetic\n${truncate(data.text, 3000)}`;
  }
  if (type === "system" && typeof data.text === "string" && data.text) {
    return `## System\n${truncate(data.text, 2000)}`;
  }
  return null;
}

function buildTranscriptV1(
  db: InstanceType<typeof Database>,
  sessionId: string,
  visited = new Set<string>(),
): string {
  if (visited.has(sessionId)) return "";
  visited.add(sessionId);

  const session = getSession(db, sessionId);
  if (!session) return "";

  const sections: string[] = [];

  if (session.parent_id && !visited.has(session.parent_id)) {
    const parentTranscript = buildTranscriptV1(db, session.parent_id, visited);
    if (parentTranscript) {
      sections.push(
        `═══ Parent Session: ${getSession(db, session.parent_id)?.title || session.parent_id} ═══\n`,
        parentTranscript,
        `\n═══ Current Subagent Session: ${session.title} ═══\n`,
      );
    }
  }

  const messages = getMessages(db, sessionId);
  for (const msg of messages) {
    let msgData: Record<string, any>;
    try {
      msgData = JSON.parse(msg.data);
    } catch {
      continue;
    }

    const role = msgData.role === "assistant" ? "Assistant" : "User";
    const agent = msgData.agent ? ` (agent: ${msgData.agent})` : "";
    const model = msgData.model?.modelID ? ` [${msgData.model.modelID}]` : "";

    const parts = getParts(db, msg.id);
    const partTexts: string[] = [];
    for (const part of parts) {
      let partData: Record<string, any>;
      try {
        partData = JSON.parse(part.data);
      } catch {
        continue;
      }
      const content = formatPartContent(partData);
      if (content) partTexts.push(content);
    }

    if (partTexts.length > 0) {
      sections.push(`## ${role}${agent}${model}\n${partTexts.join("\n\n")}`);
    }
  }

  return sections.join("\n\n");
}

function buildTranscriptV2(
  db: InstanceType<typeof Database>,
  sessionId: string,
  visited = new Set<string>(),
): string {
  if (visited.has(sessionId)) return "";
  visited.add(sessionId);

  const session = getSessionV2(db, sessionId);
  if (!session) return "";

  const sections: string[] = [];

  if (session.parent_id && !visited.has(session.parent_id)) {
    const parentTranscript = buildTranscriptV2(db, session.parent_id, visited);
    if (parentTranscript) {
      sections.push(
        `═══ Parent Session: ${getSessionV2(db, session.parent_id)?.title || session.parent_id} ═══\n`,
        parentTranscript,
        `\n═══ Current Subagent Session: ${session.title} ═══\n`,
      );
    }
  }

  for (const msg of getSessionMessages(db, sessionId)) {
    let data: Record<string, any>;
    try {
      data = JSON.parse(msg.data);
    } catch {
      continue;
    }
    const formatted = formatV2Message(msg.type, data);
    if (formatted) sections.push(formatted);
  }

  return sections.join("\n\n");
}

function buildTranscript(
  db: InstanceType<typeof Database>,
  sessionId: string,
): string {
  if (tableExists(db, "session_message")) {
    const row = db
      .query("SELECT 1 AS ok FROM session_message WHERE session_id = ? LIMIT 1")
      .get(sessionId) as { ok?: number } | null;
    if (row) return buildTranscriptV2(db, sessionId);
  }
  return buildTranscriptV1(db, sessionId);
}

function buildAdvisorPrompt(
  systemPrompt: string,
  transcript: string,
  question: string | undefined,
  priorNote: string | null,
): string {
  const body = priorNote ? `${transcript}\n\n---\n${priorNote}` : transcript;
  const task = question
    ? `Specific question: ${question}`
    : "Please analyze the above session and provide your advisory guidance.";
  return `${systemPrompt}\n\nHere is the full session transcript:\n\n${body}\n\n---\n\n${task}`;
}

function unwrapData<T>(value: T | { data: T } | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "object" &&
    "data" in (value as Record<string, unknown>)
  ) {
    return (value as { data: T }).data ?? null;
  }
  return value as T;
}

function extractGeneratedText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  return extractGeneratedText(record.data);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface CatalogModelRef {
  providerID?: string;
  id?: string;
  modelID?: string;
  enabled?: boolean;
  status?: string;
  variants?: Array<{ id?: string }>;
}

function isProviderUsable(
  provider: { activation?: string } | null | undefined,
): boolean {
  if (!provider) return false;
  return provider.activation !== "disabled";
}

function findAdvisorModel(
  models: CatalogModelRef[] | null | undefined,
  config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG,
): CatalogModelRef | null {
  if (!Array.isArray(models)) return null;
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    if (model.providerID !== config.provider) continue;
    if (model.id !== config.model && model.modelID !== config.model) continue;
    if (model.enabled === false) continue;
    return model;
  }
  return null;
}

function resolveAdvisorVariant(
  model: CatalogModelRef | null | undefined,
  config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG,
  requestedVariant?: string,
): string | undefined {
  // An agent-requested effort must be a real variant of the model; unlike
  // the configured default it never silently falls back.
  if (requestedVariant !== undefined) {
    if (!model || !Array.isArray(model.variants)) return requestedVariant;
    const ids = model.variants.map((variant) => variant?.id);
    if (!ids.includes(requestedVariant)) {
      const available =
        ids.filter((id): id is string => !!id).join(", ") || "none";
      throw new Error(
        `Effort "${requestedVariant}" is not a variant of ${config.provider}/${config.model} (available: ${available}).`,
      );
    }
    return requestedVariant;
  }
  if (config.variant === undefined) return undefined;
  if (!model || !Array.isArray(model.variants)) return config.variant;
  const ids = model.variants.map((variant) => variant?.id);
  return ids.includes(config.variant) ? config.variant : undefined;
}

function hasAdvisorConnection(connection: unknown): boolean {
  if (connection === null || connection === undefined) return false;
  if (typeof connection === "object" && !Array.isArray(connection)) {
    const record = connection as Record<string, unknown>;
    if (record.active === false || record.available === false) return false;
    if (record.status === "disconnected" || record.status === "expired") {
      return false;
    }
  }
  return true;
}

type AdvisorSupport =
  | { supported: true; variant: string | undefined }
  | { supported: false; reason: string };

async function checkAdvisorSupport(
  runtime: V2PluginContext,
  config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG,
  requestedVariant?: string,
): Promise<AdvisorSupport> {
  if (typeof runtime.catalog?.provider?.get === "function") {
    let provider: { activation?: string } | null = null;
    try {
      provider = unwrapData(
        (await runtime.catalog.provider.get({
          providerID: config.provider,
        })) as { activation?: string } | { data: { activation?: string } },
      );
    } catch (err) {
      return {
        supported: false,
        reason: `Provider ${config.provider} unavailable in OpenCode: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!isProviderUsable(provider)) {
      return {
        supported: false,
        reason: `Advisor provider is disabled or unavailable in OpenCode (provider: ${config.provider}).`,
      };
    }
  }

  let variant: string | undefined = requestedVariant ?? config.variant;
  if (typeof runtime.catalog?.model?.list === "function") {
    let models: CatalogModelRef[] | null = null;
    try {
      models = unwrapData(
        (await runtime.catalog.model.list()) as
          CatalogModelRef[] | { data: CatalogModelRef[] },
      );
    } catch (err) {
      return {
        supported: false,
        reason: `Could not list OpenCode models: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const model = findAdvisorModel(models, config);
    if (!model) {
      return {
        supported: false,
        reason: `Model unavailable: ${config.provider}/${config.model}`,
      };
    }
    try {
      variant = resolveAdvisorVariant(model, config, requestedVariant);
    } catch (err) {
      return {
        supported: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (typeof runtime.integration?.connection?.active === "function") {
    let connection: unknown = null;
    try {
      connection = await runtime.integration.connection.active(config.provider);
    } catch (err) {
      return {
        supported: false,
        reason: `Could not check the ${config.provider} connection in OpenCode: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!hasAdvisorConnection(connection)) {
      return {
        supported: false,
        reason: `No ${config.provider} connection configured in OpenCode (sign in or connect an API key first).`,
      };
    }
  }

  return { supported: true, variant };
}

let cachedAdvisorSessionId: string | null = null;
// Last variant pinned by this process (tri-state: unknown until a session
// is pinned or reports its variant).
let cachedAdvisorVariant: string | undefined;
let cachedAdvisorVariantKnown = false;
let advisorQueue: Promise<unknown> = Promise.resolve();

function resetAdvisorSessionCache(): void {
  cachedAdvisorSessionId = null;
  cachedAdvisorVariant = undefined;
  cachedAdvisorVariantKnown = false;
}

function enqueueAdvisor<T>(task: () => Promise<T>): Promise<T> {
  const next = advisorQueue.then(task, task);
  advisorQueue = next.catch(() => {});
  return next;
}

function readSessionId(value: unknown): string | null {
  const session = unwrapData(
    value as { id?: string } | { data: { id?: string } },
  );
  return typeof session?.id === "string" ? session.id : null;
}

function readSessionList(value: unknown): Array<Record<string, unknown>> {
  const list = unwrapData(value as unknown[] | { data: unknown[] });
  return Array.isArray(list)
    ? list.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object",
      )
    : [];
}

async function readStoredAdvisorSessionId(
  runtime: V2PluginContext,
): Promise<string | null> {
  if (typeof runtime.storage?.get !== "function") return null;
  try {
    const stored = await runtime.storage.get(ADVISOR_STORAGE_KEY);
    return typeof stored === "string" && stored.startsWith("ses")
      ? stored
      : null;
  } catch {
    return null;
  }
}

async function storeAdvisorSessionId(
  runtime: V2PluginContext,
  sessionId: string,
): Promise<void> {
  if (typeof runtime.storage?.set !== "function") return;
  try {
    await runtime.storage.set(ADVISOR_STORAGE_KEY, sessionId);
  } catch {}
}

async function getAdvisorSession(
  runtime: V2PluginContext,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  if (typeof runtime.session?.get !== "function") return null;
  try {
    const session = unwrapData(
      (await runtime.session.get({ sessionID: sessionId })) as
        Record<string, unknown> | { data: Record<string, unknown> },
    );
    return session && typeof session === "object" ? session : null;
  } catch {
    return null;
  }
}

function advisorSessionNeedsModel(
  session: Record<string, unknown> | null,
  variant: string | undefined,
  allowCacheFallback: boolean,
  config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG,
): boolean {
  if (!session) return true;
  const model = session.model as
    | {
        providerID?: string;
        id?: string;
        modelID?: string;
        variant?: string;
      }
    | undefined;
  if (!model || typeof model !== "object") return true;
  const provider = String(model.providerID || "").toLowerCase();
  const id = String(model.id || model.modelID || "").toLowerCase();
  if (
    provider !== config.provider.toLowerCase() ||
    id !== config.model.toLowerCase()
  ) {
    return true;
  }
  // Re-pin when the requested effort differs from the session's variant. The
  // session payload may not report a variant; then fall back to the last
  // pinned value — but only for the session it was pinned on.
  if (typeof model.variant === "string" && model.variant) {
    return model.variant !== variant;
  }
  if (allowCacheFallback && cachedAdvisorVariantKnown) {
    return cachedAdvisorVariant !== variant;
  }
  return false;
}

// Records the variant a reused session reports so later requests for a
// different effort re-pin even when a future payload omits it.
function syncCachedAdvisorVariant(
  session: Record<string, unknown> | null,
): void {
  const model = (session as { model?: { variant?: unknown } } | null)?.model;
  if (
    model &&
    typeof model === "object" &&
    typeof model.variant === "string" &&
    model.variant
  ) {
    cachedAdvisorVariant = model.variant;
    cachedAdvisorVariantKnown = true;
  }
}

async function switchAdvisorSessionModel(
  runtime: V2PluginContext,
  sessionId: string,
  variant: string | undefined,
  config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG,
): Promise<void> {
  if (typeof runtime.session?.switchModel !== "function") {
    throw new Error(
      "OpenCode runtime cannot switch the advisor session model (session.switchModel unavailable).",
    );
  }
  const model: { providerID: string; id: string; variant?: string } = {
    providerID: config.provider,
    id: config.model,
  };
  if (variant) model.variant = variant;
  await runtime.session.switchModel({ sessionID: sessionId, model });
}

async function ensureAdvisorSession(
  runtime: V2PluginContext,
  variant: string | undefined,
  config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG,
): Promise<string> {
  const candidates: Array<string | null> = [
    cachedAdvisorSessionId,
    await readStoredAdvisorSessionId(runtime),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const session = await getAdvisorSession(runtime, candidate);
    if (!session) continue;
    if (
      advisorSessionNeedsModel(
        session,
        variant,
        candidate === cachedAdvisorSessionId,
        config,
      )
    ) {
      await switchAdvisorSessionModel(runtime, candidate, variant, config);
      cachedAdvisorVariant = variant;
      cachedAdvisorVariantKnown = true;
    } else {
      syncCachedAdvisorVariant(session);
    }
    cachedAdvisorSessionId = candidate;
    return candidate;
  }

  if (typeof runtime.session?.list === "function") {
    try {
      const sessions = readSessionList(await runtime.session.list());
      const existing = sessions.find(
        (session) =>
          session.title === ADVISOR_SESSION_TITLE ||
          session.title === LEGACY_ADVISOR_SESSION_TITLE,
      );
      const existingId = typeof existing?.id === "string" ? existing.id : null;
      if (existing && existingId) {
        if (
          advisorSessionNeedsModel(
            existing,
            variant,
            existingId === cachedAdvisorSessionId,
            config,
          )
        ) {
          await switchAdvisorSessionModel(runtime, existingId, variant, config);
          cachedAdvisorVariant = variant;
          cachedAdvisorVariantKnown = true;
        } else {
          syncCachedAdvisorVariant(existing);
        }
        cachedAdvisorSessionId = existingId;
        await storeAdvisorSessionId(runtime, existingId);
        return existingId;
      }
    } catch {}
  }

  if (typeof runtime.session?.create !== "function") {
    throw new Error(
      "OpenCode runtime cannot create the advisor session (session.create unavailable).",
    );
  }
  const created = await runtime.session.create({
    title: ADVISOR_SESSION_TITLE,
  });
  const sessionId = readSessionId(created);
  if (!sessionId) {
    throw new Error("OpenCode did not return an advisor session id.");
  }
  await switchAdvisorSessionModel(runtime, sessionId, variant, config);
  cachedAdvisorSessionId = sessionId;
  cachedAdvisorVariant = variant;
  cachedAdvisorVariantKnown = true;
  await storeAdvisorSessionId(runtime, sessionId);
  return sessionId;
}

async function callAdvisor(opts: {
  runtime: V2PluginContext | null | undefined;
  systemPrompt: string;
  transcript: string;
  question: string | undefined;
  priorNote: string | null;
  effort?: string;
  signal?: AbortSignal;
  config?: AdvisorConfig;
}): Promise<{
  text: string;
  inputTokens: null;
  outputTokens: null;
  variant: string | undefined;
}> {
  const runtime = opts.runtime;
  const config = opts.config ?? DEFAULT_ADVISOR_CONFIG;
  if (typeof runtime?.session?.generate !== "function") {
    throw new Error(
      "advisor requires the OpenCode V2 plugin runtime (session.generate unavailable).",
    );
  }

  const support = await checkAdvisorSupport(runtime, config, opts.effort);
  if (!support.supported) {
    throw new Error(support.reason);
  }

  const prompt = buildAdvisorPrompt(
    opts.systemPrompt,
    opts.transcript,
    opts.question,
    opts.priorNote,
  );
  const generate = runtime.session.generate.bind(runtime.session);
  // The timeout wraps only the generation, not the time spent waiting in the
  // queue behind other advisor calls — otherwise a backlog guarantees timeouts.
  const text = await enqueueAdvisor(() =>
    withTimeout(
      (async () => {
        const sessionId = await ensureAdvisorSession(
          runtime,
          support.variant,
          config,
        );
        const request = { sessionID: sessionId, prompt };
        const result = opts.signal
          ? await generate(request, { signal: opts.signal })
          : await generate(request);
        const output = extractGeneratedText(result);
        if (!output?.trim()) {
          throw new Error("Advisor returned an empty response.");
        }
        return output;
      })(),
      config.timeoutMs,
      "Advisor generation",
    ),
  );

  const modelLabel = support.variant
    ? `${config.provider}/${config.model} (effort=${support.variant})`
    : `${config.provider}/${config.model}`;
  return {
    text: `${text}\n\n---\n_advisor via OpenCode: ${modelLabel} (token usage unavailable via session generation)_`,
    inputTokens: null,
    outputTokens: null,
    variant: support.variant,
  };
}

async function runAdvisor(opts: {
  runtime: V2PluginContext | null | undefined;
  sessionId?: string;
  mode?: string;
  trigger?: string;
  question?: string;
  effort?: unknown;
  signal?: AbortSignal;
  callerAgent?: string;
  callerDirectory?: string;
  config?: AdvisorConfig;
}): Promise<string> {
  const started = Date.now();
  const config = opts.config ?? DEFAULT_ADVISOR_CONFIG;
  const mode = opts.mode || "general";
  const trigger = inferTrigger(opts.mode, opts.trigger);
  const sessionId = opts.sessionId;
  const questionChars = opts.question?.length ?? 0;

  if (!sessionId) {
    await logAdvisorMetrics({
      ts: new Date().toISOString(),
      sessionId: null,
      callerModel: null,
      callerAgent: opts.callerAgent || null,
      directory: opts.callerDirectory || null,
      mode,
      trigger,
      questionChars,
      effort: null,
      outcome: "no_session",
      errorType: "no_session",
      latencyMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      transcriptChars: 0,
      priorConsultations: 0,
      via: "opencode-session",
    });
    throw new Error(
      "advisor requires a valid OpenCode session context (no session ID available).",
    );
  }

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = openDb();
    const info = getSessionInfo(db, sessionId);
    const callerModel = callerLabel(info?.model ?? null);
    const callerAgent = opts.callerAgent || info?.agent || null;
    const directory = opts.callerDirectory || info?.directory || null;

    if (isFableModel(info?.model)) {
      await logAdvisorMetrics({
        ts: new Date().toISOString(),
        sessionId,
        callerModel,
        callerAgent,
        directory,
        mode,
        trigger,
        questionChars,
        effort: null,
        outcome: "skipped_fable",
        errorType: null,
        latencyMs: Date.now() - started,
        inputTokens: null,
        outputTokens: null,
        transcriptChars: 0,
        priorConsultations: 0,
        via: "opencode-session",
      });
      console.log(
        `[advisor] session=${sessionId} mode=${mode} outcome=skipped_fable (already Fable)`,
      );
      return FABLE_DISABLED;
    }

    let transcript = buildTranscript(db, sessionId);
    if (!transcript?.trim()) {
      await logAdvisorMetrics({
        ts: new Date().toISOString(),
        sessionId,
        callerModel,
        callerAgent,
        directory,
        mode,
        trigger,
        questionChars,
        effort: null,
        outcome: "no_transcript",
        errorType: "no_transcript",
        latencyMs: Date.now() - started,
        inputTokens: null,
        outputTokens: null,
        transcriptChars: 0,
        priorConsultations: 0,
        via: "opencode-session",
      });
      throw new Error(`No transcript found for session ${sessionId}.`);
    }

    // Cap oversized transcripts, keeping the most recent tail. Large
    // transcripts drive advisor latency and can blow the generation timeout.
    if (
      config.maxTranscriptChars > 0 &&
      transcript.length > config.maxTranscriptChars
    ) {
      transcript =
        "... (older transcript trimmed to fit maxTranscriptChars) ...\n\n" +
        transcript.slice(-config.maxTranscriptChars);
    }

    const prior = countPriorAdvisorCalls(db, sessionId);
    const priorNote =
      prior.count > 0
        ? `Note: this session chain already has ${prior.count} recorded advisor consultation(s) (modes: ${prior.modes.join(", ") || "unknown"}). Focus on what is new since then; do not repeat settled advice unless new evidence changes it.`
        : null;

    const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.general;
    let requestedEffort: string | undefined;
    try {
      requestedEffort = resolveRequestedEffort(config, opts.effort);
      const result = await callAdvisor({
        runtime: opts.runtime,
        systemPrompt,
        transcript,
        question: opts.question,
        priorNote,
        effort: requestedEffort,
        signal: opts.signal,
        config,
      });
      const latencyMs = Date.now() - started;
      await logAdvisorMetrics({
        ts: new Date().toISOString(),
        sessionId,
        callerModel,
        callerAgent,
        directory,
        mode,
        trigger,
        questionChars,
        effort: result.variant ?? null,
        outcome: "advisor_response",
        errorType: null,
        latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        transcriptChars: transcript.length,
        priorConsultations: prior.count,
        via: "opencode-session",
      });
      console.log(
        `[advisor] session=${sessionId} mode=${mode} trigger=${trigger} outcome=advisor_response latencyMs=${latencyMs}`,
      );
      return (
        result.text +
        `\n\n_advisor consultation #${prior.count + 1} in this session chain (trigger=${trigger})_`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorType = classifyAdvisorError(message);
      const latencyMs = Date.now() - started;
      await logAdvisorMetrics({
        ts: new Date().toISOString(),
        sessionId,
        callerModel,
        callerAgent,
        directory,
        mode,
        trigger,
        questionChars,
        effort: requestedEffort ?? null,
        outcome: "error",
        errorType,
        latencyMs,
        inputTokens: null,
        outputTokens: null,
        transcriptChars: transcript.length,
        priorConsultations: prior.count,
        via: "opencode-session",
      });
      console.log(
        `[advisor] session=${sessionId} mode=${mode} trigger=${trigger} outcome=error errorType=${errorType} latencyMs=${latencyMs}`,
      );
      throw new Error(`advisor failed (${errorType}): ${message}`);
    }
  } finally {
    db?.close();
  }
}

export async function setupOcAdvisorV2(
  ctx: V2PluginContext,
): Promise<(() => void) | void> {
  const registrations: Array<{ dispose?: () => Promise<void> | void }> = [];
  const advisorConfig = resolveAdvisorConfig(
    (ctx as { options?: Record<string, unknown> }).options,
  );

  if (typeof ctx.tool?.transform === "function") {
    const reg = await ctx.tool.transform(
      (draft: { add: (tool: unknown) => void }) => {
        draft.add({
          name: "advisor",
          description: buildToolDescription(advisorConfig),
          input: buildAdvisorInputSchema(advisorConfig),
          // Register as a direct tool, not a Code Mode tool. OpenCode 2 only
          // exposes tools with `codemode: false` to the model directly; every
          // other tool is reachable solely through `execute`, whose tool log
          // records just the nested call's input and hides the script output
          // on success — so the advisor's answer never appeared in the TUI.
          // A direct call renders as the input fields (mode, trigger,
          // question) followed by `output:` with the answer, and it also
          // avoids Code Mode's output-size truncation.
          options: { codemode: false },
          async execute(
            input: {
              mode?: string;
              trigger?: string;
              question?: string;
              effort?: string;
            },
            context: {
              sessionID?: string;
              sessionId?: string;
              agent?: string;
              directory?: string;
              abort?: AbortSignal;
            },
          ) {
            const text = await runAdvisor({
              runtime: ctx,
              sessionId: context.sessionID ?? context.sessionId,
              mode: input?.mode,
              trigger: input?.trigger,
              question: input?.question,
              effort: input?.effort,
              signal: context.abort,
              callerAgent: context.agent,
              callerDirectory: context.directory,
              config: advisorConfig,
            });
            return { content: text };
          },
        });
      },
    );
    if (reg) registrations.push(reg);
  }

  if (typeof ctx.session?.hook === "function") {
    const reg = await ctx.session.hook(
      "context",
      (event: {
        model?: { providerID?: string; id?: string; modelID?: string };
        tools?: Record<string, { description: string; input: unknown }>;
        system?: Array<{ type: "text"; text: string }>;
      }) => {
        if (!event.tools) return;
        // `event.tools` lists the direct tools available to this request.
        // OpenCode drops entries a hook adds for tools it did not register,
        // so the hook can only hide the tool (Fable sessions), never add it.
        // The checkpoint instruction is injected only when the tool is
        // actually available, e.g. not when a permission rule removed it.
        let available = false;
        for (const key of Object.keys(event.tools)) {
          if (!isAdvisorToolName(key)) {
            continue;
          }
          if (isFableModel(event.model)) {
            delete event.tools[key];
          } else {
            available = true;
          }
        }
        if (!available || !Array.isArray(event.system)) return;
        event.system.push({ type: "text", text: CHECKPOINT_INSTRUCTION });
      },
    );
    if (reg) registrations.push(reg);
  }

  return () => {
    for (const reg of registrations) {
      try {
        reg.dispose?.();
      } catch {}
    }
  };
}

const plugin = {
  // Plugin id intentionally unchanged by the ocAdvisor → advisor rename:
  // plugin storage (the pinned advisor session id) is scoped to it.
  id: "oc-advisor",
  setup: setupOcAdvisorV2,
};

export const OcAdvisorPluginV2 = plugin;
export default plugin;

// Named exports for unit tests (bun test). The plugin entrypoint is the
// default export above.
export {
  ADVISOR_TRIGGERS,
  CHECKPOINT_INSTRUCTION,
  DEFAULT_ADVISOR_CONFIG,
  TOOL_DESCRIPTION,
  buildAdvisorInputSchema,
  buildAdvisorPrompt,
  buildToolDescription,
  checkAdvisorSupport,
  classifyAdvisorError,
  ensureAdvisorSession,
  extractGeneratedText,
  findAdvisorModel,
  hasAdvisorConnection,
  inferTrigger,
  isAdvisorToolName,
  isFableModel,
  isProviderUsable,
  parseModelRef,
  resolveAdvisorConfig,
  resolveAdvisorVariant,
  resolveRequestedEffort,
  resetAdvisorSessionCache,
  unwrapData,
  withTimeout,
};
export type { AdvisorConfig, AdvisorOutcome, AdvisorTrigger, V2PluginContext };
