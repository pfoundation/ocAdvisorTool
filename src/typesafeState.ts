// Bounded decision state for the optional TypeSafe preflight.
//
// The gate receives a compact, structured view of the advisor request and
// the surrounding session chain — never the full transcript. State is built
// from the same SQLite records the advisor reads, trimmed at message
// boundaries to a byte budget, and reported with explicit coverage flags so
// the gate can treat omitted context as uncertainty rather than evidence.
import { Database } from "bun:sqlite";
import type {
  EvidenceBenchmarks,
  EvidenceModels,
} from "./benchmarkEvidence.js";

export interface TypeSafeSettings {
  model?: string;
  timeoutMs: number;
  skipBelow: number;
  minEffortConfidence: number;
  maxStateBytes: number;
  efforts: string[];
}

export type TypeSafeOptions =
  | boolean
  | {
      model?: string;
      timeoutMs?: number;
      skipBelow?: number;
      minEffortConfidence?: number;
      maxStateBytes?: number;
      efforts?: string[];
    }
  | null;

export interface TypeSafeConfig {
  enabled: boolean;
  settings: TypeSafeSettings | null;
  keyPresent: boolean;
}

export const TYPESAFE_DEFAULTS: TypeSafeSettings = {
  timeoutMs: 3000,
  skipBelow: 0.2,
  minEffortConfidence: 0.6,
  maxStateBytes: 16384,
  efforts: ["high", "xhigh", "max"],
};

// Discriminated result so a typed `false` can be told apart from "absent"
// during config merging; `true`/`null`/undefined all mean "use defaults".
export type NormalizedTypeSafeOptions =
  | { disabled: true }
  | { disabled: false; overrides: Partial<TypeSafeSettings> };

export type TypeSafeValidationError = { error: string };

function parseBoundedPositiveInt(
  value: unknown,
  name: string,
): number | TypeSafeValidationError {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return { error: `typesafe.${name} must be a positive integer` };
  }
  return parsed;
}

function parseClosedProbability(
  value: unknown,
  name: string,
): number | TypeSafeValidationError {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return { error: `typesafe.${name} must be a number between 0 and 1` };
  }
  return parsed;
}

// Normalizes the `typesafe` plugin option. `true`/`null`/omitted mean
// "enabled with defaults"; `false` is a complete bypass; an object enables
// the gate and validates its overrides. Invalid explicit values return a
// validation error instead of silently enabling a different policy.
export function normalizeTypeSafeOptions(
  value: unknown,
): NormalizedTypeSafeOptions | TypeSafeValidationError {
  if (value === undefined || value === null || value === true) {
    return { disabled: false, overrides: {} };
  }
  if (value === false) return { disabled: true };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "typesafe must be true, false, or an options object" };
  }
  const raw = value as Record<string, unknown>;
  const overrides: Partial<TypeSafeSettings> = {};

  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !raw.model.trim()) {
      return { error: "typesafe.model must be a non-empty string" };
    }
    overrides.model = raw.model.trim();
  }
  for (const key of ["timeoutMs", "maxStateBytes"] as const) {
    if (raw[key] === undefined) continue;
    const parsed = parseBoundedPositiveInt(raw[key], key);
    if (typeof parsed === "object") return parsed;
    overrides[key] = parsed;
  }
  for (const key of ["skipBelow", "minEffortConfidence"] as const) {
    if (raw[key] === undefined) continue;
    const parsed = parseClosedProbability(raw[key], key);
    if (typeof parsed === "object") return parsed;
    overrides[key] = parsed;
  }
  if (raw.efforts !== undefined) {
    const list = Array.isArray(raw.efforts)
      ? raw.efforts
      : typeof raw.efforts === "string" && raw.efforts.trim()
        ? raw.efforts.split(",")
        : null;
    if (!list) {
      return { error: "typesafe.efforts must be an array of effort names" };
    }
    const seen = new Set<string>();
    for (const entry of list) {
      if (typeof entry !== "string" || !entry.trim()) {
        return {
          error: "typesafe.efforts must contain non-empty effort names",
        };
      }
      seen.add(entry.trim());
    }
    overrides.efforts = [...seen];
  }
  return { disabled: false, overrides };
}

export function resolveTypeSafeSettings(
  source: NormalizedTypeSafeOptions,
): TypeSafeSettings {
  if (source.disabled) return { ...TYPESAFE_DEFAULTS };
  return { ...TYPESAFE_DEFAULTS, ...source.overrides };
}

// `TYPESAFE_API_KEY` (whitespace-only counts as absent) is the SDK's own
// environment variable. Bypass means no client construction and no network
// request; a missing key alone never disables the advisor itself.
export function resolveTypeSafeConfig(
  source: NormalizedTypeSafeOptions | undefined,
  env: Record<string, string | undefined> = process.env,
): TypeSafeConfig {
  const key = env.TYPESAFE_API_KEY;
  const keyPresent = typeof key === "string" && key.trim().length > 0;
  if (!source || source.disabled || !keyPresent) {
    // No key means no client and no request; settings stay unconstructed.
    return { enabled: false, settings: null, keyPresent };
  }
  return {
    enabled: true,
    settings: resolveTypeSafeSettings(source),
    keyPresent,
  };
}

export const TYPE_SAFE_ENV_KEY = "TYPESAFE_API_KEY";

const MAX_CHAIN_DEPTH = 10;
const MAX_MESSAGE_CHARS = 4000;

interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string;
}

interface SessionMessageRow {
  type: string;
  data: string;
}

export interface DecisionState {
  request: {
    question: string | null;
    mode: string;
    trigger: string;
    explicitEffort: string | null;
    caller: string | null;
    directory: string | null;
  };
  user: { latestRequest: string | null };
  context: {
    messages: string[];
    latestUserIncluded: boolean;
  };
  history: {
    priorConsultations: number;
    priorModes: string[];
    repeatedQuestion: boolean;
  };
  availability: {
    supportedEfforts: string[];
    defaultEffort: string | null;
  };
  // Invocation-correct model identities. Durable header content: trimming
  // never drops these while a consultation proceeds.
  models: EvidenceModels | null;
  // Benchmark evidence for the same consultation, or null when enrichment
  // was unavailable. Score detail trims before task context under budget
  // pressure; `omitted` marks detail dropped this way, while
  // `coverage.benchmarksOmitted` marks the whole block dropped.
  benchmarks: EvidenceBenchmarks | null;
  coverage: {
    truncated: boolean;
    droppedMessages: number;
    includedMessages: number;
    totalMessages: number;
    stateBytes: number;
    maxStateBytes: number;
    benchmarksOmitted: boolean;
  };
}

export interface BuildDecisionStateOptions {
  question?: string | null;
  mode: string;
  trigger: string;
  explicitEffort?: string | null;
  caller?: string | null;
  directory?: string | null;
  priorConsultations: number;
  priorModes: string[];
  priorQuestions?: string[];
  supportedEfforts: string[];
  defaultEffort?: string | null;
  maxStateBytes?: number;
  models?: EvidenceModels | null;
  benchmarks?: EvidenceBenchmarks | null;
  formatMessage?: (type: string, data: Record<string, any>) => string | null;
}

// Assembles the decision state shell without reading any session records;
// the builder below fills `context` from the session chain. Exported so the
// evaluation and tests can construct representative state directly.
export function makeDecisionState(
  options: BuildDecisionStateOptions,
): DecisionState {
  return {
    request: {
      question: options.question ?? null,
      mode: options.mode,
      trigger: options.trigger,
      explicitEffort: options.explicitEffort ?? null,
      caller: options.caller ?? null,
      directory: options.directory ?? null,
    },
    user: { latestRequest: null },
    context: { messages: [], latestUserIncluded: false },
    history: {
      priorConsultations: options.priorConsultations,
      priorModes: options.priorModes,
      repeatedQuestion: isRepeatedQuestion(
        options.question ?? null,
        options.priorQuestions ?? [],
      ),
    },
    availability: {
      supportedEfforts: [...options.supportedEfforts],
      defaultEffort: options.defaultEffort ?? null,
    },
    models: options.models ?? null,
    benchmarks: options.benchmarks ?? null,
    coverage: {
      truncated: false,
      droppedMessages: 0,
      includedMessages: 0,
      totalMessages: 0,
      stateBytes: 0,
      maxStateBytes: options.maxStateBytes ?? 0,
      benchmarksOmitted: false,
    },
  };
}

function getChainRow(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionRow | null {
  try {
    return db
      .query<SessionRow, [string]>(
        "SELECT id, parent_id, title FROM session_v2 WHERE id = ?",
      )
      .get(sessionId);
  } catch {
    // Legacy databases without session_v2 have no chain to read.
    return null;
  }
}

// Collects the session and its parents (oldest first) within the same chain
// cap the advisor transcript uses.
function collectChain(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionRow[] {
  const chain: SessionRow[] = [];
  const visited = new Set<string>();
  let current: string | null = sessionId;
  while (current && !visited.has(current) && chain.length < MAX_CHAIN_DEPTH) {
    visited.add(current);
    const row = getChainRow(db, current);
    if (!row) break;
    chain.push(row);
    current = row.parent_id;
  }
  return chain.reverse();
}

function readChainMessages(
  db: InstanceType<typeof Database>,
  chain: SessionRow[],
): Array<{ type: string; data: Record<string, any> }> {
  const out: Array<{ type: string; data: Record<string, any> }> = [];
  for (const session of chain) {
    let rows: SessionMessageRow[] = [];
    try {
      rows = db
        .query<SessionMessageRow, [string]>(
          "SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq ASC LIMIT 400",
        )
        .all(session.id);
    } catch {
      rows = [];
    }
    for (const row of rows) {
      try {
        out.push({ type: row.type, data: JSON.parse(row.data) });
      } catch {}
    }
  }
  return out;
}

function messageText(
  entry: { type: string; data: Record<string, any> },
  formatMessage: (type: string, data: Record<string, any>) => string | null,
): string | null {
  const formatted = formatMessage(entry.type, entry.data);
  if (!formatted) return null;
  return formatted.length > MAX_MESSAGE_CHARS
    ? formatted.slice(-MAX_MESSAGE_CHARS)
    : formatted;
}

function latestUserRequest(
  entries: Array<{ type: string; data: Record<string, any> }>,
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "user") continue;
    const text = typeof entry.data.text === "string" ? entry.data.text : "";
    if (text.trim()) return text.slice(-MAX_MESSAGE_CHARS);
  }
  return null;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// Repeats are only flagged when the current question covers the same ground
// as a previous one; the gate treats this as context, never as a quota.
function isRepeatedQuestion(
  question: string | null,
  priorQuestions: string[],
): boolean {
  if (!question) return false;
  const normalize = (text: string) =>
    text.toLowerCase().replace(/\s+/g, " ").trim();
  const target = normalize(question);
  if (!target) return false;
  return priorQuestions.some((prior) => {
    const candidate = normalize(prior);
    if (!candidate) return false;
    return (
      candidate === target ||
      candidate.includes(target) ||
      target.includes(candidate)
    );
  });
}

export function buildDecisionState(
  db: InstanceType<typeof Database>,
  sessionId: string,
  options: BuildDecisionStateOptions,
): DecisionState {
  const chain = collectChain(db, sessionId);
  const entries = chain.length > 0 ? readChainMessages(db, chain) : [];
  const latestRequest = latestUserRequest(entries);

  const base = makeDecisionState({ ...options, formatMessage: undefined });
  base.user.latestRequest = latestRequest;
  base.context.latestUserIncluded = latestRequest !== null;
  base.coverage.totalMessages = entries.length;
  const maxBytes = options.maxStateBytes ?? Infinity;
  // Verbose benchmark detail yields before task context: score comparisons
  // drop first (identities and match coverage stay), then the whole
  // benchmark block with an explicit omission flag.
  if (base.benchmarks && byteLength(base) > maxBytes) {
    base.benchmarks = { ...base.benchmarks, comparisons: [], omitted: true };
  }
  if (base.benchmarks && byteLength(base) > maxBytes) {
    base.benchmarks = null;
    base.coverage.benchmarksOmitted = true;
  }
  if (!options.formatMessage) return base;
  const rendered: Array<string | null> = entries.map((entry) =>
    messageText(entry, options.formatMessage ?? (() => null)),
  );
  // The latest user request is the intent under review; keep it even when
  // older context must be dropped.
  let latestUserIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "user" && rendered[i]) {
      latestUserIndex = i;
      break;
    }
  }
  // Walk backwards from the newest message, stopping at the first message
  // that no longer fits so kept context stays contiguous. The budget counts
  // the serialized state, so the measured value is what the gate sends.
  let dropped = 0;
  const keptIndices: number[] = [];
  let blocked = false;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const text = rendered[i];
    if (!text) continue;
    if (i === latestUserIndex) continue;
    const candidate = [text, ...keptIndices.map((index) => rendered[index]!)];
    const probe = {
      ...base,
      context: { ...base.context, messages: candidate },
    };
    if (blocked || byteLength(probe) > maxBytes) {
      blocked = true;
      dropped++;
      continue;
    }
    keptIndices.unshift(i);
  }
  const withLatest =
    latestUserIndex >= 0 ? [latestUserIndex, ...keptIndices] : keptIndices;
  withLatest.sort((a, b) => a - b);
  const kept = withLatest.map((index) => rendered[index]!);

  base.context.messages = kept;
  base.context.latestUserIncluded =
    latestUserIndex >= 0 && keptIndices.concat(latestUserIndex).length > 0;
  base.coverage.includedMessages = kept.length;
  base.coverage.droppedMessages = dropped;
  base.coverage.truncated = dropped > 0;
  base.coverage.stateBytes = byteLength(base);
  return base;
}
