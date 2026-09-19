// Optional TypeSafe preflight for advisor invocations.
//
// One System One request decides whether this specific consultation is
// worth the expensive advisor generation, and — when effort selection is
// available — which effort fits. The gate never blocks on its own failures:
// timeouts, transport errors, malformed answers, and missing credentials all
// fall back to the ordinary advisor behavior.
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import type { DecisionState, TypeSafeSettings } from "./typesafeState.js";

export const GATE_NEEDED_QUESTION = "needed";
export const GATE_EFFORT_QUESTION = "effort";

// Leaves headroom for state plus the longest question inside the documented
// 32k state+question and 64k overall context limits.
export const TYPESAFE_STATE_TOKEN_BUDGET = 16000;
const BYTES_PER_TOKEN = 4;
const MIN_STATE_BYTES = 1024;
const MAX_QUESTION_CHARS = 2000;

// Built-in effort criteria. Custom variant names fall back to a generic
// description; the effort decision never changes whether consultation
// happens, so a coarser description only affects level choice.
const EFFORT_CRITERIA: Record<string, string> = {
  high: "Focused question, clear evidence, limited scope, and few interacting constraints",
  xhigh:
    "Meaningful design tradeoffs, cross-component behavior, or several interacting correctness concerns",
  max: "Difficult unresolved failures, conflicting evidence, or deeply interconnected high-consequence decisions",
};
const DEFAULT_EFFORT_CRITERION =
  "This level fits a consultation more demanding than the lower levels and less demanding than the higher ones";

export const NEEDED_INSTRUCTIONS = `Given the request below, would an independent senior advisor materially improve the approach, help resolve a problem, or strengthen review at this point?
A consultation can help at several different checkpoints; prior consultations are context, not a quota.
Repeat consultations are useful when evidence, the approach, or the concern under review has changed.
Judge the evidence actually present. Missing or truncated context is uncertainty, not evidence that consultation is unnecessary.
A concrete question awaiting an independent second opinion usually qualifies, even when the agent is not stuck.`;

export const EFFORT_INSTRUCTIONS = `Assuming this consultation proceeds, which effort level is appropriate for this specific decision or review?
Choose from the supplied levels based on reasoning difficulty, uncertainty, interacting components, and consequences, not transcript length.
This question is independent of whether consultation should happen.`;

export class TypeSafeGateError extends Error {
  readonly kind: "caller_abort" | "gate_error";
  readonly type: string;

  constructor(kind: "caller_abort" | "gate_error", type: string) {
    super(kind);
    this.name = "TypeSafeGateError";
    this.kind = kind;
    this.type = type;
  }
}

export type TypeSafeCallOutcome =
  | { kind: "response"; result: Record<string, unknown> }
  | {
      kind: "aborted_by_caller" | "timeout" | "error";
      type: string;
    };

export interface SystemOneCall {
  state: unknown;
  questions: Record<string, unknown>;
  model?: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface GateClient {
  systemOne(call: SystemOneCall): Promise<TypeSafeCallOutcome>;
}

export type CreateClientOptions = {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  fetch?: typeof fetch;
};

export function createSdkClient(options: CreateClientOptions = {}): GateClient {
  const client = new TypeSafeClient({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.defaultModel !== undefined
      ? { defaultModel: options.defaultModel }
      : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    // The gate owns its deadline; SDK retries could exceed it.
    retry: { maxRetries: 0 },
  });
  return {
    async systemOne(call) {
      try {
        const result = (await client.systemOne(
          {
            state: call.state as never,
            questions: call.questions as never,
            ...(call.model ? { model: call.model } : {}),
          },
          { signal: call.signal, timeout: call.timeoutMs },
        )) as unknown as Record<string, unknown>;
        return { kind: "response", result };
      } catch (error) {
        return { kind: "error", type: classifyFailure(error) };
      }
    },
  };
}

// Fixed reason codes instead of raw SDK errors: exception messages can carry
// transport details and are not stable across SDK releases.
export function classifyFailure(error: unknown): string {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  switch (name) {
    case "AuthenticationError":
      return "auth";
    case "RateLimitError":
      return "rate_limit";
    case "APITimeoutError":
      return "timeout";
    case "APIConnectionError":
      return "connection";
    case "BadRequestError":
    case "UnprocessableEntityError":
      return "invalid_request";
    case "InternalServerError":
      return "server_error";
    case "APIUserAbortError":
      return "aborted";
    case "NotFoundError":
      return "not_found";
    case "PermissionDeniedError":
      return "permission_denied";
    default:
      return "unknown";
  }
}

export interface GateInput {
  mode: string;
  trigger: string;
  question: string | null;
  explicitEffort: string | null;
  // Effort candidates that are both plugin-allowed and model-supported;
  // empty means effort selection is unavailable.
  supportedEfforts: string[];
  defaultEffort: string | null;
}

export type GateDecision =
  | { status: "disabled" }
  | {
      status: "skip";
      reason: "consultation_not_useful";
      metrics: GateMetrics;
    }
  | {
      status: "proceed";
      reason: "allowed" | "caller_effort" | "effort_unknown";
      neededProbability: number;
      suggestedEffort: string | null;
      effortConfidence: number | null;
      effectiveEffort: string | null;
      effortSource: "caller" | "typesafe" | "config";
      metrics: GateMetrics;
    }
  | {
      status: "fallback";
      reason:
        | "timeout"
        | "aborted"
        | "error"
        | "malformed_answer"
        | "state_unavailable";
      errorType?: string;
      metrics: GateMetrics;
    };

export interface GateMetrics {
  model: string | null;
  neededProbability: number | null;
  suggestedEffort: string | null;
  effortConfidence: number | null;
  latencyMs: number;
  stateBytes: number;
  truncated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RunGateOptions {
  state: DecisionState;
  input: GateInput;
  settings: TypeSafeSettings;
  keyPresent: boolean;
  client?: GateClient;
  createClient?: () => GateClient;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function proceedReason(
  input: GateInput,
  availableEffortLevels: string[],
  source: "caller" | "typesafe" | "config",
): "allowed" | "caller_effort" | "effort_unknown" {
  if (input.explicitEffort) return "caller_effort";
  // A valid need judgment with no candidate levels keeps the configured
  // effort; that is still an allowed consultation.
  if (source === "typesafe" || availableEffortLevels.length > 0) {
    return "allowed";
  }
  return "effort_unknown";
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function questionText(question: string | null): string | null {
  if (!question) return null;
  return question.length > MAX_QUESTION_CHARS
    ? question.slice(-MAX_QUESTION_CHARS)
    : question;
}

function buildStatePayload(state: DecisionState): Record<string, unknown> {
  return {
    request: {
      question: questionText(state.request.question),
      mode: state.request.mode,
      trigger: state.request.trigger,
      explicitEffort: state.request.explicitEffort,
      caller: state.request.caller,
    },
    latest_user_request: state.user.latestRequest,
    recent_messages: state.context.messages,
    prior_consultations: {
      count: state.history.priorConsultations,
      modes: state.history.priorModes,
      repeated_question: state.history.repeatedQuestion,
    },
    coverage: {
      messages_dropped: state.coverage.droppedMessages,
      messages_included: state.coverage.includedMessages,
      total_messages: state.coverage.totalMessages,
      latest_user_included: state.context.latestUserIncluded,
    },
  };
}

// Fits the payload into the byte budget by dropping the oldest messages
// first and reporting the coverage loss so the gate can treat omission as
// uncertainty. The latest user request is state.user and is never dropped.
function fitStatePayload(
  state: DecisionState,
  maxBytes: number,
): { payload: Record<string, unknown>; truncated: boolean } | null {
  const payload = buildStatePayload(state);
  if (byteLength(payload) <= maxBytes) return { payload, truncated: false };

  const messages = [...state.context.messages];
  let dropped = 0;
  while (messages.length > 0) {
    messages.shift();
    dropped++;
    const candidate = {
      ...payload,
      recent_messages: messages,
      coverage: {
        ...(payload.coverage as Record<string, unknown>),
        messages_dropped_extra: dropped,
      },
    };
    if (byteLength(candidate) <= maxBytes) {
      return { payload: candidate, truncated: true };
    }
  }
  const minimal = {
    ...payload,
    recent_messages: [],
    coverage: {
      ...(payload.coverage as Record<string, unknown>),
      messages_dropped_extra: dropped,
    },
  };
  if (byteLength(minimal) > maxBytes) return null;
  return { payload: minimal, truncated: true };
}

function effortCriteria(efforts: string[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const effort of efforts) {
    criteria[effort] = EFFORT_CRITERIA[effort] ?? DEFAULT_EFFORT_CRITERION;
  }
  return criteria;
}

function isNeededAnswer(value: unknown): value is { noul: number } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { noul?: unknown }).noul === "number" &&
    Number.isFinite((value as { noul: number }).noul)
  );
}

function isEffortAnswer(
  value: unknown,
  efforts: string[],
): value is { choice: string; confidence: number } {
  if (!value || typeof value !== "object") return false;
  const answer = value as { choice?: unknown; confidence?: unknown };
  return (
    typeof answer.choice === "string" &&
    efforts.includes(answer.choice) &&
    typeof answer.confidence === "number" &&
    Number.isFinite(answer.confidence)
  );
}

function metricsFrom(
  result: Record<string, unknown>,
  started: number,
  truncated: boolean,
  stateBytes: number,
): GateMetrics {
  const usage = result.usage as
    { input_tokens?: unknown; output_tokens?: unknown } | undefined;
  return {
    model: typeof result.model === "string" ? result.model : null,
    neededProbability: null,
    suggestedEffort: null,
    effortConfidence: null,
    latencyMs: Date.now() - started,
    stateBytes,
    truncated,
    inputTokens:
      typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
    outputTokens:
      typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
  };
}

function selectDecision(
  input: GateInput,
  settings: TypeSafeSettings,
  neededProbability: number,
  effortAnswer: { choice: string; confidence: number } | null,
): {
  skip: boolean;
  effectiveEffort: string | null;
  suggestedEffort: string | null;
  effortConfidence: number | null;
  source: "caller" | "typesafe" | "config";
} {
  if (neededProbability < settings.skipBelow) {
    return {
      skip: true,
      effectiveEffort: null,
      suggestedEffort: effortAnswer?.choice ?? null,
      effortConfidence: effortAnswer?.confidence ?? null,
      source: "config",
    };
  }
  if (input.explicitEffort) {
    return {
      skip: false,
      effectiveEffort: input.explicitEffort,
      suggestedEffort: effortAnswer?.choice ?? null,
      effortConfidence: effortAnswer?.confidence ?? null,
      source: "caller",
    };
  }
  if (effortAnswer && effortAnswer.confidence >= settings.minEffortConfidence) {
    return {
      skip: false,
      effectiveEffort: effortAnswer.choice,
      suggestedEffort: effortAnswer.choice,
      effortConfidence: effortAnswer.confidence,
      source: "typesafe",
    };
  }
  return {
    skip: false,
    effectiveEffort: input.defaultEffort,
    suggestedEffort: effortAnswer?.choice ?? null,
    effortConfidence: effortAnswer?.confidence ?? null,
    source: "config",
  };
}

export async function runTypeSafeGate(
  options: RunGateOptions,
): Promise<GateDecision> {
  const { state, input, settings, signal } = options;
  if (!options.keyPresent) return { status: "disabled" };

  const started = Date.now();
  const availableEffortLevels =
    input.explicitEffort === null ? input.supportedEfforts : [];
  const maxStateBytes = Math.max(
    MIN_STATE_BYTES,
    Math.min(
      settings.maxStateBytes,
      TYPESAFE_STATE_TOKEN_BUDGET * BYTES_PER_TOKEN,
    ),
  );
  const fitted = fitStatePayload(state, maxStateBytes);
  if (!fitted) {
    return {
      status: "fallback",
      reason: "state_unavailable",
      metrics: {
        model: null,
        neededProbability: null,
        suggestedEffort: null,
        effortConfidence: null,
        latencyMs: Date.now() - started,
        stateBytes: 0,
        truncated: true,
        inputTokens: null,
        outputTokens: null,
      },
    };
  }

  const questions: Record<string, unknown> = {
    [GATE_NEEDED_QUESTION]: noul(NEEDED_INSTRUCTIONS),
  };
  if (availableEffortLevels.length > 0) {
    questions[GATE_EFFORT_QUESTION] = choice(
      EFFORT_INSTRUCTIONS,
      effortCriteria(availableEffortLevels),
    );
  }

  const controller = new AbortController();
  let callerAborted = false;
  const onCallerAbort = () => {
    callerAborted = true;
    controller.abort();
  };
  if (signal?.aborted) {
    callerAborted = true;
  } else {
    signal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const stateBytes = byteLength(fitted.payload);

  const emptyMetrics = (): GateMetrics => ({
    model: null,
    neededProbability: null,
    suggestedEffort: null,
    effortConfidence: null,
    latencyMs: Date.now() - started,
    stateBytes,
    truncated: fitted.truncated,
    inputTokens: null,
    outputTokens: null,
  });

  try {
    if (callerAborted) {
      return { status: "fallback", reason: "aborted", metrics: emptyMetrics() };
    }
    let client: GateClient;
    try {
      client =
        options.client ??
        (options.createClient
          ? options.createClient()
          : createSdkClient({
              ...(options.env?.TYPESAFE_API_KEY
                ? { apiKey: options.env.TYPESAFE_API_KEY }
                : {}),
              ...(options.env?.TYPESAFE_BASE_URL
                ? { baseURL: options.env.TYPESAFE_BASE_URL }
                : {}),
              ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
            }));
    } catch {
      return { status: "fallback", reason: "error", metrics: emptyMetrics() };
    }

    const outcome = await client.systemOne({
      state: fitted.payload,
      questions,
      ...(settings.model ? { model: settings.model } : {}),
      signal: controller.signal,
      timeoutMs: settings.timeoutMs,
    });

    if (callerAborted) {
      return { status: "fallback", reason: "aborted", metrics: emptyMetrics() };
    }
    if (outcome.kind !== "response") {
      return {
        status: "fallback",
        reason: outcome.kind === "timeout" ? "timeout" : "error",
        ...(outcome.kind === "error" ? { errorType: outcome.type } : {}),
        metrics: emptyMetrics(),
      };
    }

    const result = outcome.result;
    const answers = result.answers as Record<string, unknown> | undefined;
    const needed = answers?.[GATE_NEEDED_QUESTION];
    if (!isNeededAnswer(needed)) {
      return {
        status: "fallback",
        reason: "malformed_answer",
        metrics: {
          ...metricsFrom(result, started, fitted.truncated, stateBytes),
        },
      };
    }
    const neededProbability = Math.min(1, Math.max(0, needed.noul));
    const rawEffort = answers?.[GATE_EFFORT_QUESTION];
    const effortAnswer = isEffortAnswer(rawEffort, availableEffortLevels)
      ? rawEffort
      : null;
    const decision = selectDecision(
      input,
      settings,
      neededProbability,
      effortAnswer,
    );
    const metrics: GateMetrics = {
      ...metricsFrom(result, started, fitted.truncated, stateBytes),
      neededProbability,
      suggestedEffort: decision.suggestedEffort,
      effortConfidence: decision.effortConfidence,
    };

    if (decision.skip) {
      return {
        status: "skip",
        reason: "consultation_not_useful",
        metrics,
      };
    }
    return {
      status: "proceed",
      reason: proceedReason(input, availableEffortLevels, decision.source),
      neededProbability,
      suggestedEffort: decision.suggestedEffort,
      effortConfidence: decision.effortConfidence,
      effectiveEffort: decision.effectiveEffort,
      effortSource: decision.source,
      metrics,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
