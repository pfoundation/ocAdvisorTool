import { describe, expect, test } from "bun:test";
import {
  GATE_EFFORT_QUESTION,
  GATE_NEEDED_QUESTION,
  classifyFailure,
  createSdkClient,
  runTypeSafeGate,
  type GateClient,
  type GateInput,
  type RunGateOptions,
  type SystemOneCall,
} from "./typesafeGate";
import {
  TYPESAFE_DEFAULTS,
  buildDecisionState,
  type DecisionState,
  type TypeSafeSettings,
} from "./typesafeState";
import { Database } from "bun:sqlite";
import { formatV2Message } from "./ocAdvisor";

const SETTINGS: TypeSafeSettings = { ...TYPESAFE_DEFAULTS };

function fixtureState(overrides: Partial<DecisionState> = {}): DecisionState {
  return {
    request: {
      question: "Should the gate run before generation?",
      mode: "plan",
      trigger: "before_approach",
      explicitEffort: null,
      caller: "meta/muse-spark-1.3",
      directory: "/home/ubuntu/dev/ocAdvisor",
    },
    user: { latestRequest: "Add the TypeSafe gate" },
    context: {
      messages: ["## User\nAdd the TypeSafe gate"],
      latestUserIncluded: true,
    },
    history: {
      priorConsultations: 0,
      priorModes: [],
      repeatedQuestion: false,
    },
    availability: {
      supportedEfforts: ["high", "xhigh", "max"],
      defaultEffort: "xhigh",
    },
    models: null,
    benchmarks: null,
    coverage: {
      truncated: false,
      droppedMessages: 0,
      includedMessages: 1,
      totalMessages: 1,
      stateBytes: 0,
      maxStateBytes: 16384,
      benchmarksOmitted: false,
    },
    ...overrides,
  };
}

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    mode: "plan",
    trigger: "before_approach",
    question: "Should the gate run before generation?",
    explicitEffort: null,
    supportedEfforts: ["high", "xhigh", "max"],
    defaultEffort: "xhigh",
    ...overrides,
  };
}

function response(
  noulValue: number,
  effort?: { choice: string; confidence: number },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const answers: Record<string, unknown> = {
    [GATE_NEEDED_QUESTION]: { type: "noul", noul: noulValue },
  };
  if (effort) {
    answers[GATE_EFFORT_QUESTION] = {
      type: "choice",
      choice: effort.choice,
      confidence: effort.confidence,
      probabilities: { [effort.choice]: effort.confidence },
    };
  }
  return {
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 1200, output_tokens: 30 },
    ...extra,
  };
}

function stubClient(
  outcome:
    | { kind: "response"; result: Record<string, unknown> }
    | { kind: "timeout" | "error"; type: string }
    | { kind: "aborted_by_caller"; type: string },
): { client: GateClient; calls: SystemOneCall[] } {
  const calls: SystemOneCall[] = [];
  return {
    calls,
    client: {
      async systemOne(call) {
        calls.push(call);
        return outcome as never;
      },
    },
  };
}

function runGate(
  overrides: Partial<RunGateOptions> & { state?: DecisionState },
): ReturnType<typeof runTypeSafeGate> {
  return runTypeSafeGate({
    state: overrides.state ?? fixtureState(),
    input: overrides.input ?? input(),
    settings: overrides.settings ?? SETTINGS,
    keyPresent: overrides.keyPresent ?? true,
    client: overrides.client,
    createClient: overrides.createClient,
    env: overrides.env ?? { TYPESAFE_API_KEY: "ts_test_key" },
    signal: overrides.signal,
    fetchImpl: overrides.fetchImpl,
  });
}

describe("runTypeSafeGate", () => {
  test("bypasses without a key and sends nothing", async () => {
    const decision = await runGate({ keyPresent: false });
    expect(decision).toEqual({ status: "disabled" });
  });

  test("skips only clearly unnecessary consultations", async () => {
    const { client, calls } = stubClient({
      kind: "response",
      result: response(0.05, { choice: "high", confidence: 0.9 }),
    });
    const decision = await runGate({ client });
    expect(decision.status).toBe("skip");
    expect(calls.length).toBe(1);
    expect(calls[0].questions[GATE_NEEDED_QUESTION]).toBeDefined();
  });

  test("ambiguous need preserves consultation", async () => {
    const { client } = stubClient({
      kind: "response",
      result: response(0.5, { choice: "xhigh", confidence: 0.8 }),
    });
    const decision = await runGate({ client });
    expect(decision.status).toBe("proceed");
    if (decision.status === "proceed") {
      expect(decision.neededProbability).toBe(0.5);
      expect(decision.effectiveEffort).toBe("xhigh");
      expect(decision.effortSource).toBe("typesafe");
    }
  });

  test("proceeds at the top boundary and skips below the threshold", async () => {
    const boundary = stubClient({
      kind: "response",
      result: response(SETTINGS.skipBelow),
    });
    expect((await runGate({ client: boundary.client })).status).toBe("proceed");
    const below = stubClient({
      kind: "response",
      result: response(SETTINGS.skipBelow - 0.01),
    });
    expect((await runGate({ client: below.client })).status).toBe("skip");
  });

  test("caller effort wins over the gate and omits the effort question", async () => {
    const { client, calls } = stubClient({
      kind: "response",
      result: response(0.9, { choice: "high", confidence: 1 }),
    });
    const decision = await runGate({
      client,
      input: input({ explicitEffort: "max" }),
    });
    expect(decision.status).toBe("proceed");
    if (decision.status === "proceed") {
      expect(decision.effectiveEffort).toBe("max");
      expect(decision.effortSource).toBe("caller");
      expect(decision.reason).toBe("caller_effort");
    }
    expect(calls[0].questions[GATE_EFFORT_QUESTION]).toBeUndefined();
  });

  test("low effort confidence keeps the configured default", async () => {
    const { client } = stubClient({
      kind: "response",
      result: response(0.9, { choice: "max", confidence: 0.2 }),
    });
    const decision = await runGate({ client });
    expect(decision.status).toBe("proceed");
    if (decision.status === "proceed") {
      expect(decision.effectiveEffort).toBe("xhigh");
      expect(decision.effortSource).toBe("config");
      expect(decision.suggestedEffort).toBe("max");
    }
  });

  test("omits effort selection when no supported candidates exist", async () => {
    const { client, calls } = stubClient({
      kind: "response",
      result: response(0.9),
    });
    const decision = await runGate({
      client,
      input: input({ supportedEfforts: [] }),
    });
    expect(decision.status).toBe("proceed");
    if (decision.status === "proceed") {
      expect(decision.reason).toBe("effort_unknown");
      expect(decision.effectiveEffort).toBe("xhigh");
    }
    expect(calls[0].questions[GATE_EFFORT_QUESTION]).toBeUndefined();
  });

  test("falls back on timeout, transport errors, and malformed answers", async () => {
    const timeout = stubClient({ kind: "timeout", type: "timeout" });
    const timeoutDecision = await runGate({ client: timeout.client });
    expect(timeoutDecision.status).toBe("fallback");
    if (timeoutDecision.status === "fallback") {
      expect(timeoutDecision.reason).toBe("timeout");
    }

    const error = stubClient({ kind: "error", type: "auth" });
    const errorDecision = await runGate({ client: error.client });
    expect(errorDecision.status).toBe("fallback");
    if (errorDecision.status === "fallback") {
      expect(errorDecision.reason).toBe("error");
      expect(errorDecision.errorType).toBe("auth");
    }

    const malformed = stubClient({
      kind: "response",
      result: { model: "jev-1.13.0", answers: {}, usage: {} },
    });
    const malformedDecision = await runGate({ client: malformed.client });
    expect(malformedDecision.status).toBe("fallback");
    if (malformedDecision.status === "fallback") {
      expect(malformedDecision.reason).toBe("malformed_answer");
    }
  });

  test("ignores an unsupported effort answer but keeps the need judgment", async () => {
    const { client } = stubClient({
      kind: "response",
      result: response(0.9, { choice: "ultra", confidence: 1 }),
    });
    const decision = await runGate({ client });
    expect(decision.status).toBe("proceed");
    if (decision.status === "proceed") {
      expect(decision.effectiveEffort).toBe("xhigh");
      expect(decision.effortSource).toBe("config");
    }
  });

  test("preserves normal behavior when a caller aborts or state cannot fit", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await runGate({
      client: stubClient({ kind: "response", result: response(0.9) }).client,
      signal: controller.signal,
    });
    expect(aborted.status).toBe("fallback");
    if (aborted.status === "fallback") expect(aborted.reason).toBe("aborted");

    const tiny = await runGate({
      client: stubClient({ kind: "response", result: response(0.9) }).client,
      settings: { ...SETTINGS, maxStateBytes: 1 },
      state: fixtureState({
        context: {
          messages: ["x".repeat(5000)],
          latestUserIncluded: true,
        },
      }),
    });
    // A too-small budget still fits the minimal payload; if it cannot, it falls back.
    expect(["fallback", "proceed"]).toContain(tiny.status);
  });

  test("records gate metrics on skip and proceed", async () => {
    const proceed = stubClient({
      kind: "response",
      result: response(0.9, { choice: "high", confidence: 0.95 }),
    });
    const decision = await runGate({ client: proceed.client });
    expect(decision.status).toBe("proceed");
    if (decision.status === "proceed") {
      expect(decision.metrics.model).toBe("jev-1.13.0");
      expect(decision.metrics.inputTokens).toBe(1200);
      expect(decision.metrics.outputTokens).toBe(30);
      expect(decision.metrics.stateBytes).toBeGreaterThan(0);
      expect(decision.metrics.latencyMs).toBeGreaterThanOrEqual(0);
      expect(decision.metrics.truncated).toBe(false);
    }
  });
});

describe("createSdkClient", () => {
  test("sends one request with the expected shape", async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const resolvedUrl =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      captured.push({ url: resolvedUrl, body });
      return new Response(
        JSON.stringify(response(0.9, { choice: "high", confidence: 0.9 })),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = createSdkClient({
      apiKey: "ts_test_key",
      baseURL: "https://api.typesafe.test",
      defaultModel: "jev-1.13.0",
      fetch: fetchImpl,
    });
    const outcome = await client.systemOne({
      state: { note: "state" },
      questions: {
        [GATE_NEEDED_QUESTION]: { type: "noul", instructions: "needed?" },
      },
      signal: new AbortController().signal,
      timeoutMs: SETTINGS.timeoutMs,
    });

    expect(outcome.kind).toBe("response");
    expect(captured.length).toBe(1);
    expect(captured[0].url).toContain("/v1/systemone");
    expect(captured[0].body.model).toBe("jev-1.13.0");
    expect(
      (captured[0].body.questions as Record<string, unknown>)[
        GATE_NEEDED_QUESTION
      ],
    ).toBeDefined();
    expect(captured[0].body.state).toEqual({ note: "state" });
  });

  test("maps HTTP failures to stable error types without retrying", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "nope" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = createSdkClient({
      apiKey: "ts_test_key",
      baseURL: "https://api.typesafe.test",
      fetch: fetchImpl,
    });
    const outcome = await client.systemOne({
      state: {},
      questions: { [GATE_NEEDED_QUESTION]: { type: "noul" } },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.type).toBe("auth");
    expect(calls).toBe(1);
  });

  test("classifies SDK error names to fixed codes", () => {
    class FakeNamed extends Error {}
    const cases: Array<[string, string]> = [
      ["AuthenticationError", "auth"],
      ["RateLimitError", "rate_limit"],
      ["APITimeoutError", "timeout"],
      ["APIConnectionError", "connection"],
      ["InternalServerError", "server_error"],
      ["APIUserAbortError", "aborted"],
      ["SomethingElse", "unknown"],
    ];
    for (const [name, expected] of cases) {
      const error = new FakeNamed("boom");
      error.name = name;
      expect(classifyFailure(error)).toBe(expected);
    }
  });
});

describe("integration with the session fixture", () => {
  test("builds a real decision state and proceeds", async () => {
    const db = new Database(":memory:");
    db.run(
      "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT)",
    );
    db.run(
      "CREATE TABLE session_message (session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
    );
    db.query(
      "INSERT INTO session_v2 (id, parent_id, title) VALUES (?,?,?)",
    ).run("ses_root", null, "Root");
    db.query(
      "INSERT INTO session_message (session_id, type, seq, data) VALUES (?,?,?,?)",
    ).run(
      "ses_root",
      "user",
      1,
      JSON.stringify({ text: "Please gate the advisor" }),
    );
    const state = buildDecisionState(db, "ses_root", {
      mode: "plan",
      trigger: "before_approach",
      question: "Should the gate run?",
      priorConsultations: 0,
      priorModes: [],
      supportedEfforts: ["high", "xhigh", "max"],
      defaultEffort: "xhigh",
      maxStateBytes: SETTINGS.maxStateBytes,
      formatMessage: formatV2Message,
    });
    const { client } = stubClient({
      kind: "response",
      result: response(0.85, { choice: "high", confidence: 0.9 }),
    });
    const decision = await runGate({ client, state });
    expect(decision.status).toBe("proceed");
    if (decision.status === "proceed") {
      expect(decision.effectiveEffort).toBe("high");
      expect(decision.effortSource).toBe("typesafe");
    }
  });
});

describe("gate benchmark wire payload", () => {
  function evidenceState(): DecisionState {
    return fixtureState({
      models: {
        requester: {
          providerID: "test-provider",
          modelID: "requester-model",
          variant: "high",
          provenance: "invocation_message",
        },
        advisor: {
          providerID: "test-provider",
          modelID: "advisor-model",
          policy: {
            kind: "candidates",
            candidates: ["high", "xhigh"],
            fallback: "xhigh",
          },
        },
      },
      benchmarks: {
        source: "user",
        fetchedAt: "2026-09-10T00:00:00.000Z",
        ageDays: 9,
        contentHash: "cc".repeat(32),
        hashVerified: true,
        requesterMatch: {
          status: "matched",
          source: "local",
          aaModelID: "synthetic-aa-1",
          evaluatedEffort: "max",
        },
        advisorDefaultMatch: {
          status: "matched",
          source: "local",
          aaModelID: "synthetic-aa-2",
          evaluatedEffort: "max",
        },
        advisorCandidates: [
          {
            effort: "high",
            status: "matched",
            source: "local",
            aaModelID: "synthetic-aa-2",
            evaluatedEffort: "max",
          },
          {
            effort: "xhigh",
            status: "effort_unknown",
            source: "local",
            aaModelID: "synthetic-aa-2",
            evaluatedEffort: null,
          },
        ],
        comparisons: [
          {
            key: "artificial_analysis_coding_index",
            label: "Artificial Analysis Coding Index",
            unit: "index_points",
            requester: 60,
            advisor: 80,
            advisorMinusRequester: 20,
            comparable: true,
            reason: null,
          },
          {
            key: "hle",
            label: "HLE (Humanity's Last Exam)",
            unit: "fraction",
            requester: 0.3,
            advisor: null,
            advisorMinusRequester: null,
            comparable: false,
            reason: "missing_advisor",
          },
        ],
        omitted: false,
      },
    });
  }

  test("sends profiles, matches, and shared deltas in one payload", async () => {
    const { client, calls } = stubClient({
      kind: "response",
      result: response(0.9),
    });
    await runGate({ client, state: evidenceState() });
    expect(calls).toHaveLength(1);
    const sent = calls[0]?.state as Record<string, any>;

    expect(sent.models.requester).toEqual({
      provider: "test-provider",
      model: "requester-model",
      effort: "high",
      provenance: "invocation_message",
    });
    expect(sent.models.advisor).toEqual({
      provider: "test-provider",
      model: "advisor-model",
      effort_policy: {
        kind: "candidates",
        candidates: ["high", "xhigh"],
        fallback: "xhigh",
      },
    });

    expect(sent.benchmarks.source).toBe("user");
    expect(sent.benchmarks.fetched_at).toBe("2026-09-10T00:00:00.000Z");
    expect(sent.benchmarks.age_days).toBe(9);
    expect(sent.benchmarks.content_hash).toBe("cc".repeat(32));
    expect(sent.benchmarks.hash_verified).toBe(true);
    expect(sent.benchmarks.requester_match).toEqual({
      status: "matched",
      source: "local",
      aa_model: "synthetic-aa-1",
      evaluated_effort: "max",
    });
    expect(sent.benchmarks.advisor_default_match.status).toBe("matched");
    expect(
      sent.benchmarks.advisor_candidates.map(
        (entry: { effort: string }) => entry.effort,
      ),
    ).toEqual(["high", "xhigh"]);
    expect(sent.benchmarks.advisor_candidates[1].status).toBe("effort_unknown");
    expect(sent.benchmarks.comparisons).toEqual([
      {
        metric: "artificial_analysis_coding_index",
        label: "Artificial Analysis Coding Index",
        unit: "index_points",
        requester: 60,
        advisor: 80,
        advisor_minus_requester: 20,
        comparable: true,
        reason: null,
      },
      {
        metric: "hle",
        label: "HLE (Humanity's Last Exam)",
        unit: "fraction",
        requester: 0.3,
        advisor: null,
        advisor_minus_requester: null,
        comparable: false,
        reason: "missing_advisor",
      },
    ]);
    expect(sent.benchmarks.omitted).toBe(false);
    expect(sent.coverage.benchmarks_omitted).toBe(false);
  });

  test("sends explicit nulls without evidence", async () => {
    const { client, calls } = stubClient({
      kind: "response",
      result: response(0.9),
    });
    await runGate({ client, state: fixtureState() });
    expect(calls).toHaveLength(1);
    const sent = calls[0]?.state as Record<string, any>;
    expect(sent.models).toBeNull();
    expect(sent.benchmarks).toBeNull();
    expect(sent.coverage.benchmarks_omitted).toBe(false);
  });

  test("serializes structured need instructions and both criteria through the SDK", async () => {
    let sent: Record<string, any> | undefined;
    const client = createSdkClient({
      apiKey: "ts_test_key",
      baseURL: "https://api.typesafe.test",
      fetch: (async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify(response(0.34, { choice: "high", confidence: 0.9 })),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const decision = await runGate({ client });
    expect(decision.status).toBe("proceed");
    expect(Object.keys(sent!.questions).sort()).toEqual(["effort", "needed"]);
    expect(sent!.questions.needed).toMatchObject({
      type: "noul",
      instructions: {
        question: expect.any(String),
        judge: expect.any(Array),
      },
      criteria: { true: expect.any(String), false: expect.any(String) },
    });
    expect(sent!.questions.effort.type).toBe("choice");
  });
});
