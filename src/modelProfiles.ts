// Requester and advisor model profiles for the benchmark-aware gate.
//
// The requester is the model that produced the tool call, resolved from the
// originating assistant message — never from the parent transcript and never
// from whatever the session row points at after a later switch. The advisor
// profile carries the configured identity plus the effort policy in force
// for this consultation: a pinned caller effort, gate-selectable candidates
// with their fallback, or a fixed default.
import type { Database } from "bun:sqlite";

export type RequesterProvenance =
  "invocation_message" | "latest_message" | "session_fallback" | "unknown";

export interface RequesterProfile {
  providerID: string | null;
  modelID: string | null;
  variant: string | null;
  provenance: RequesterProvenance;
}

export interface SessionModelRef {
  providerID?: string;
  provider?: string;
  id?: string;
  modelID?: string;
  variant?: string;
}

export type AdvisorEffortPolicy =
  | { kind: "pinned"; effort: string }
  | { kind: "candidates"; candidates: string[]; fallback: string | null }
  | { kind: "fixed"; effort: string | null };

export interface AdvisorProfile {
  providerID: string;
  modelID: string;
  policy: AdvisorEffortPolicy;
}

interface ParsedModel {
  providerID: string;
  modelID: string;
  variant: string | null;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Normalizes a model id for cross-route comparison: the last path segment
// (gateway routes nest the vendor id, e.g.
// `openrouter/anthropic/claude-opus-5-5`), lowercased, with dots treated as
// dashes (`deepseek-v4.1-flash` vs `deepseek-v4-1-flash`). Shared by the
// plugin's self-consultation guard and the usage report so both agree on
// what "the advisor model" means.
export function normalizeModelID(id: string): string {
  const segments = id.split("/");
  const last = segments[segments.length - 1] ?? id;
  return last.trim().toLowerCase().replace(/\./g, "-");
}

function parseModelShape(value: unknown): ParsedModel | null {
  if (!value || typeof value !== "object") return null;
  const shape = value as Record<string, unknown>;
  const providerID = clean(shape.providerID ?? shape.provider);
  const modelID = clean(shape.id ?? shape.modelID);
  if (!providerID || !modelID) return null;
  let variant = clean(shape.variant);
  // OpenCode records an unset effort as "default" on some routes; treat it
  // as unknown so matching falls back to the null-variant binding.
  if (variant.toLowerCase() === "default") variant = "";
  return { providerID, modelID, variant: variant ? variant : null };
}

function parseMessageData(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return null;
}

function tableExists(db: InstanceType<typeof Database>, name: string): boolean {
  try {
    const row = db
      .query(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) as { ok?: number } | null;
    return Boolean(row);
  } catch {
    return false;
  }
}

// A call identifier pins the exact tool block when the message carries tool
// calls; messages without tool blocks (still streaming, older shapes) keep
// their message-level model either way.
function callMatchesMessage(
  data: Record<string, unknown>,
  callID: string,
): boolean {
  if (!Array.isArray(data.content)) return true;
  const toolBlocks = data.content.filter(
    (block): block is Record<string, unknown> =>
      !!block &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      (block as Record<string, unknown>).type === "tool",
  );
  if (toolBlocks.length === 0) return true;
  return toolBlocks.some((block) => {
    const id = clean(block.id ?? (block as Record<string, unknown>).callID);
    return id !== "" && id === callID;
  });
}

function messageModel(
  db: InstanceType<typeof Database>,
  sessionId: string,
  messageID: string,
  callID: string | null,
): ParsedModel | null {
  try {
    const row = db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM session_message WHERE id = ? AND session_id = ?",
      )
      .get(messageID, sessionId);
    if (!row) return null;
    const data = parseMessageData(row.data);
    if (!data) return null;
    if (callID && !callMatchesMessage(data, callID)) return null;
    return parseModelShape(data.model);
  } catch {
    // Legacy databases without an id column fall through to the latest
    // message scan below.
    return null;
  }
}

function latestMessageModel(
  db: InstanceType<typeof Database>,
  sessionId: string,
): ParsedModel | null {
  try {
    const rows = db
      .query<{ data: string }, [string]>(
        "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 8",
      )
      .all(sessionId);
    for (const row of rows) {
      const data = parseMessageData(row.data);
      if (!data) continue;
      const model = parseModelShape(data.model);
      if (model) return model;
    }
  } catch {}
  return null;
}

export function resolveRequesterProfile(
  db: InstanceType<typeof Database>,
  input: {
    sessionId: string;
    messageID?: string | null;
    callID?: string | null;
    sessionModel?: SessionModelRef | null;
  },
): RequesterProfile {
  const unknown: RequesterProfile = {
    providerID: null,
    modelID: null,
    variant: null,
    provenance: "unknown",
  };
  if (!tableExists(db, "session_message")) {
    const fallback = parseModelShape(input.sessionModel ?? null);
    return fallback ? { ...fallback, provenance: "session_fallback" } : unknown;
  }
  const messageID = clean(input.messageID ?? null);
  const callID = clean(input.callID ?? null);
  if (messageID) {
    const direct = messageModel(
      db,
      input.sessionId,
      messageID,
      callID ? callID : null,
    );
    if (direct) return { ...direct, provenance: "invocation_message" };
  }
  const latest = latestMessageModel(db, input.sessionId);
  if (latest) return { ...latest, provenance: "latest_message" };
  const fallback = parseModelShape(input.sessionModel ?? null);
  if (fallback) return { ...fallback, provenance: "session_fallback" };
  return unknown;
}

export function resolveAdvisorProfile(input: {
  providerID: string;
  modelID: string;
  requestedEffort?: string;
  supportedEfforts: string[];
  defaultEffort?: string | null;
}): AdvisorProfile {
  if (input.requestedEffort !== undefined) {
    return {
      providerID: input.providerID,
      modelID: input.modelID,
      policy: { kind: "pinned", effort: input.requestedEffort },
    };
  }
  if (input.supportedEfforts.length > 0) {
    return {
      providerID: input.providerID,
      modelID: input.modelID,
      policy: {
        kind: "candidates",
        candidates: [...input.supportedEfforts],
        fallback: input.defaultEffort ?? null,
      },
    };
  }
  return {
    providerID: input.providerID,
    modelID: input.modelID,
    policy: { kind: "fixed", effort: input.defaultEffort ?? null },
  };
}
