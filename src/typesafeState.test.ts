import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { formatV2Message, resolveAdvisorConfig } from "./ocAdvisor";
import {
  TYPESAFE_DEFAULTS,
  buildDecisionState,
  normalizeTypeSafeOptions,
  resolveTypeSafeConfig,
  resolveTypeSafeSettings,
  type NormalizedTypeSafeOptions,
} from "./typesafeState";

import type { EvidenceBenchmarks, EvidenceModels } from "./benchmarkEvidence";

function asNormalized(value: unknown): NormalizedTypeSafeOptions {
  if (typeof value !== "object" || value === null || "error" in value) {
    throw new Error(`expected a normalized option: ${JSON.stringify(value)}`);
  }
  return value as NormalizedTypeSafeOptions;
}

function openFixtureDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT)",
  );
  db.run(
    "CREATE TABLE session_message (session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
  );
  return db;
}

function addSession(
  db: InstanceType<typeof Database>,
  id: string,
  title: string,
  parentId: string | null = null,
): void {
  db.query(
    "INSERT INTO session_v2 (id, parent_id, title) VALUES (?, ?, ?)",
  ).run(id, parentId, title);
}

function addMessage(
  db: InstanceType<typeof Database>,
  sessionId: string,
  type: string,
  seq: number,
  data: Record<string, unknown>,
): void {
  db.query(
    "INSERT INTO session_message (session_id, type, seq, data) VALUES (?, ?, ?, ?)",
  ).run(sessionId, type, seq, JSON.stringify(data));
}

function buildState(
  db: InstanceType<typeof Database>,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  const options = {
    mode: "plan",
    trigger: "before_approach",
    priorConsultations: 0,
    priorModes: [] as string[],
    supportedEfforts: ["high", "xhigh", "max"],
    maxStateBytes: TYPESAFE_DEFAULTS.maxStateBytes,
    formatMessage: formatV2Message as (
      type: string,
      data: Record<string, any>,
    ) => string | null,
    ...overrides,
  };
  // Cast keeps the test callable readable while preserving the real signature.
  return buildDecisionState(
    db,
    sessionId,
    options as Parameters<typeof buildDecisionState>[2],
  );
}

describe("normalizeTypeSafeOptions", () => {
  test("treats omitted, null, and true as enabled with defaults", () => {
    for (const value of [undefined, null, true]) {
      const result = normalizeTypeSafeOptions(value);
      expect("disabled" in result && result.disabled).toBe(false);
      expect(resolveTypeSafeSettings(asNormalized(result))).toEqual(
        TYPESAFE_DEFAULTS,
      );
    }
  });

  test("false disables the gate completely", () => {
    const result = normalizeTypeSafeOptions(false);
    expect("disabled" in result && result.disabled).toBe(true);
    expect(resolveTypeSafeConfig(asNormalized(result)).enabled).toBe(false);
  });

  test("accepts valid overrides", () => {
    const result = normalizeTypeSafeOptions({
      model: "jev-1.13.0",
      timeoutMs: 1500,
      skipBelow: 0.1,
      minEffortConfidence: 0.7,
      maxStateBytes: 4096,
      efforts: ["high", " max ", "high"],
    });
    expect("error" in result).toBe(false);
    const settings = resolveTypeSafeSettings(asNormalized(result));
    expect(settings.model).toBe("jev-1.13.0");
    expect(settings.timeoutMs).toBe(1500);
    expect(settings.skipBelow).toBe(0.1);
    expect(settings.minEffortConfidence).toBe(0.7);
    expect(settings.maxStateBytes).toBe(4096);
    expect(settings.efforts).toEqual(["high", "max"]);
  });

  test("accepts an empty object as enabled with defaults", () => {
    const result = normalizeTypeSafeOptions({});
    expect("error" in result).toBe(false);
    expect(resolveTypeSafeSettings(asNormalized(result))).toEqual(
      TYPESAFE_DEFAULTS,
    );
  });

  test("rejects invalid explicit values", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["yes", /typesafe must be/],
      [{ model: "" }, /typesafe.model/],
      [{ timeoutMs: 0 }, /timeoutMs/],
      [{ timeoutMs: 1.5 }, /timeoutMs/],
      [{ maxStateBytes: -1 }, /maxStateBytes/],
      [{ skipBelow: 1.5 }, /skipBelow/],
      [{ minEffortConfidence: -1 }, /minEffortConfidence/],
      [{ efforts: [" "] }, /efforts/],
      [{ efforts: 7 }, /efforts/],
    ];
    for (const [value, pattern] of cases) {
      const result = normalizeTypeSafeOptions(value);
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.error).toMatch(pattern);
    }
  });
});

describe("resolveTypeSafeConfig", () => {
  const enabled = asNormalized(normalizeTypeSafeOptions(true));

  test("is disabled without a key and never constructs settings", () => {
    expect(resolveTypeSafeConfig(enabled, {}).enabled).toBe(false);
    expect(
      resolveTypeSafeConfig(enabled, { TYPESAFE_API_KEY: "   " }).enabled,
    ).toBe(false);
    expect(resolveTypeSafeConfig(enabled, {}).settings).toBeNull();
    expect(resolveTypeSafeConfig(enabled, {}).keyPresent).toBe(false);
  });

  test("is enabled with a nonempty key", () => {
    const config = resolveTypeSafeConfig(enabled, {
      TYPESAFE_API_KEY: "ts_test_key",
    });
    expect(config.enabled).toBe(true);
    expect(config.keyPresent).toBe(true);
    expect(config.settings).toEqual(TYPESAFE_DEFAULTS);
  });

  test("stays disabled when the option is false even with a key", () => {
    const config = resolveTypeSafeConfig(
      asNormalized(normalizeTypeSafeOptions(false)),
      {
        TYPESAFE_API_KEY: "ts_test_key",
      },
    );
    expect(config.enabled).toBe(false);
    expect(config.settings).toBeNull();
    expect(config.keyPresent).toBe(true);
  });
});

describe("advisor config typesafe option", () => {
  test("is disabled by default and enabled by option when keyed", () => {
    const off = resolveAdvisorConfig(undefined, {});
    expect(off.typesafe.enabled).toBe(false);

    const keyed = resolveAdvisorConfig(undefined, {
      TYPESAFE_API_KEY: "ts_test_key",
    });
    expect(keyed.typesafe.enabled).toBe(true);
    expect(keyed.typesafeSettings).toEqual(TYPESAFE_DEFAULTS);

    const keyedOff = resolveAdvisorConfig(
      { typesafe: false },
      { TYPESAFE_API_KEY: "ts_test_key" },
    );
    expect(keyedOff.typesafe.enabled).toBe(false);
    expect(keyedOff.typesafeSettings).toBeNull();
  });

  test("accepts overrides and rejects invalid settings", () => {
    const config = resolveAdvisorConfig(
      { typesafe: { model: "jev-1.13.0", timeoutMs: 1200 } },
      { TYPESAFE_API_KEY: "ts_test_key" },
    );
    expect(config.typesafeSettings?.model).toBe("jev-1.13.0");
    expect(config.typesafeSettings?.timeoutMs).toBe(1200);
    expect(config.typesafeSettings?.skipBelow).toBe(
      TYPESAFE_DEFAULTS.skipBelow,
    );

    expect(() =>
      resolveAdvisorConfig({ typesafe: { timeoutMs: -5 } }, {}),
    ).toThrow(/timeoutMs/);
  });
});

describe("buildDecisionState", () => {
  test("includes the latest user request and recent messages", () => {
    const db = openFixtureDb();
    addSession(db, "ses_root", "Root");
    addMessage(db, "ses_root", "user", 1, {
      text: "Please add a TypeSafe gate",
    });
    addMessage(db, "ses_root", "assistant", 2, {
      content: [{ type: "text", text: "Working on the plan" }],
    });
    const state = buildState(db, "ses_root", {
      question: "Should the gate run inside advisor()?",
    });
    expect(state.user.latestRequest).toBe("Please add a TypeSafe gate");
    expect(state.context.latestUserIncluded).toBe(true);
    expect(state.context.messages.length).toBe(2);
    expect(state.coverage.totalMessages).toBe(2);
    expect(state.coverage.droppedMessages).toBe(0);
    expect(state.coverage.stateBytes).toBeGreaterThan(0);
    expect(state.request.question).toBe(
      "Should the gate run inside advisor()?",
    );
  });

  test("includes parent-session context for subagents", () => {
    const db = openFixtureDb();
    addSession(db, "ses_parent", "Parent");
    addSession(db, "ses_child", "Child", "ses_parent");
    addMessage(db, "ses_parent", "user", 1, {
      text: "Investigate the plugin loading bug",
    });
    addMessage(db, "ses_child", "user", 1, { text: "Run the resolver check" });
    const state = buildState(db, "ses_child");
    const joined = state.context.messages.join("\n");
    expect(joined).toContain("plugin loading bug");
    expect(joined).toContain("resolver check");
    expect(state.coverage.totalMessages).toBe(2);
  });

  test("trims oldest context at the byte budget but keeps the user request", () => {
    const db = openFixtureDb();
    addSession(db, "ses_root", "Root");
    addMessage(db, "ses_root", "user", 1, {
      text: "LATEST intent that must survive",
    });
    for (let i = 0; i < 40; i++) {
      addMessage(db, "ses_root", "assistant", i + 2, {
        content: [{ type: "text", text: "detail ".repeat(300) }],
      });
    }
    const state = buildState(db, "ses_root", { maxStateBytes: 5000 });
    expect(state.coverage.truncated).toBe(true);
    expect(state.coverage.droppedMessages).toBeGreaterThan(0);
    expect(state.coverage.stateBytes).toBeLessThanOrEqual(5000);
    expect(state.user.latestRequest).toBe("LATEST intent that must survive");
    expect(state.context.messages.join("\n")).toContain(
      "LATEST intent that must survive",
    );
  });

  test("counts multi-byte content against the byte budget", () => {
    const db = openFixtureDb();
    addSession(db, "ses_root", "Root");
    addMessage(db, "ses_root", "user", 1, { text: "قرار مهم" });
    for (let i = 0; i < 20; i++) {
      addMessage(db, "ses_root", "assistant", i + 2, {
        content: [{ type: "text", text: "سبب ".repeat(200) }],
      });
    }
    const state = buildState(db, "ses_root", { maxStateBytes: 4000 });
    expect(state.coverage.stateBytes).toBeLessThanOrEqual(4000);
  });

  test("flags a repeat only when the question matches settled ground", () => {
    const db = openFixtureDb();
    addSession(db, "ses_root", "Root");
    const repeated = buildState(db, "ses_root", {
      question: "Review the migration plan",
      priorConsultations: 1,
      priorModes: ["plan"],
      priorQuestions: ["Review the migration plan for ordering risks"],
    });
    expect(repeated.history.repeatedQuestion).toBe(true);
    const fresh = buildState(db, "ses_root", {
      question: "Review the cache invalidation fix",
      priorConsultations: 1,
      priorModes: ["plan"],
      priorQuestions: ["Review the migration plan for ordering risks"],
    });
    expect(fresh.history.repeatedQuestion).toBe(false);
  });

  test("survives missing sessions and legacy databases", () => {
    const db = openFixtureDb();
    const state = buildState(db, "ses_missing");
    expect(state.user.latestRequest).toBeNull();
    expect(state.context.messages).toEqual([]);
    expect(state.coverage.totalMessages).toBe(0);
    const legacy = new Database(":memory:");
    const legacyState = buildState(legacy, "ses_old");
    expect(legacyState.context.messages).toEqual([]);
    expect(legacyState.request.mode).toBe("plan");
  });
});

describe("buildDecisionState benchmark evidence", () => {
  function evidenceFixture(): {
    models: EvidenceModels;
    benchmarks: EvidenceBenchmarks;
  } {
    const match = (status: "matched") => ({
      status,
      source: "local" as const,
      aaModelID: "synthetic-aa-1",
      evaluatedEffort: "max",
    });
    return {
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
            candidates: ["high", "xhigh", "max"],
            fallback: "xhigh",
          },
        },
      },
      benchmarks: {
        source: "user",
        fetchedAt: "2026-09-10T00:00:00.000Z",
        ageDays: 9,
        contentHash: "ab".repeat(32),
        hashVerified: true,
        requesterMatch: match("matched"),
        advisorDefaultMatch: match("matched"),
        advisorCandidates: ["high", "xhigh", "max"].map((effort) => ({
          effort,
          ...match("matched"),
        })),
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
            advisor: 0.6,
            advisorMinusRequester: 0.3,
            comparable: true,
            reason: null,
          },
        ],
        omitted: false,
      },
    };
  }

  function evidenceDb(): InstanceType<typeof Database> {
    const db = openFixtureDb();
    addSession(db, "ses_evd", "Evidence");
    addMessage(db, "ses_evd", "user", 1, { text: "Do the thing" });
    addMessage(db, "ses_evd", "assistant", 2, {
      content: [{ type: "text", text: "Working on it" }],
    });
    return db;
  }

  test("keeps models and benchmarks within budget alongside messages", () => {
    const db = evidenceDb();
    const { models, benchmarks } = evidenceFixture();
    const state = buildState(db, "ses_evd", {
      question: "Should we ship?",
      models,
      benchmarks,
      maxStateBytes: 8000,
    });
    expect(state.models).toEqual(models);
    expect(state.benchmarks?.comparisons).toHaveLength(2);
    expect(state.benchmarks?.omitted).toBe(false);
    expect(state.coverage.benchmarksOmitted).toBe(false);
    expect(state.coverage.stateBytes).toBeLessThanOrEqual(8000);
  });

  test("treats absent benchmarks as unavailable, not omitted", () => {
    const db = evidenceDb();
    const state = buildState(db, "ses_evd", { question: "Should we ship?" });
    expect(state.models).toBeNull();
    expect(state.benchmarks).toBeNull();
    expect(state.coverage.benchmarksOmitted).toBe(false);
  });

  test("drops comparisons before task context under header pressure", () => {
    const db = evidenceDb();
    const { models, benchmarks } = evidenceFixture();
    const bare = buildDecisionState(db, "ses_evd", {
      mode: "plan",
      trigger: "before_approach",
      question: "Should we ship?",
      priorConsultations: 0,
      priorModes: [],
      supportedEfforts: [],
      maxStateBytes: 1000000,
      models,
      benchmarks,
    });
    const strippedBytes = Buffer.byteLength(
      JSON.stringify({
        ...bare,
        benchmarks: { ...bare.benchmarks!, comparisons: [] },
      }),
    );
    const pressured = buildState(db, "ses_evd", {
      question: "Should we ship?",
      models,
      benchmarks,
      maxStateBytes: strippedBytes + 50,
    });
    expect(pressured.benchmarks?.comparisons).toEqual([]);
    expect(pressured.benchmarks?.omitted).toBe(true);
    expect(pressured.models).toEqual(models);
    expect(pressured.benchmarks?.requesterMatch).toBeDefined();
    expect(pressured.request.question).toBe("Should we ship?");
    expect(pressured.user.latestRequest).toBe("Do the thing");
    expect(pressured.coverage.benchmarksOmitted).toBe(false);
  });

  test("nulls benchmarks with explicit omission under extreme budgets", () => {
    const db = evidenceDb();
    const { models, benchmarks } = evidenceFixture();
    const bare = buildDecisionState(db, "ses_evd", {
      mode: "plan",
      trigger: "before_approach",
      question: "Should we ship?",
      priorConsultations: 0,
      priorModes: [],
      supportedEfforts: [],
      maxStateBytes: 1000000,
      models,
      benchmarks,
    });
    const nulledBytes = Buffer.byteLength(
      JSON.stringify({ ...bare, benchmarks: null }),
    );
    const pressured = buildState(db, "ses_evd", {
      question: "Should we ship?",
      models,
      benchmarks,
      maxStateBytes: nulledBytes + 50,
    });
    expect(pressured.benchmarks).toBeNull();
    expect(pressured.coverage.benchmarksOmitted).toBe(true);
    expect(pressured.models).toEqual(models);
    expect(pressured.request.question).toBe("Should we ship?");
    expect(pressured.user.latestRequest).toBe("Do the thing");
  });

  test("holds long IDs, many candidates, and multi-byte text in budget", () => {
    const db = openFixtureDb();
    addSession(db, "ses_wide", "Wide");
    addMessage(db, "ses_wide", "user", 1, { text: "Ship it" });
    for (let seq = 2; seq < 12; seq++) {
      addMessage(db, "ses_wide", "assistant", seq, {
        content: [{ type: "text", text: "大约の内容 ".repeat(200) }],
      });
    }
    const longID = `model-${"x".repeat(200)}`;
    const candidates = Array.from(
      { length: 10 },
      (_, index) => `effort-${index}`,
    );
    const state = buildState(db, "ses_wide", {
      question: "Should we ship?",
      models: {
        requester: {
          providerID: "test-provider",
          modelID: longID,
          variant: "high",
          provenance: "invocation_message",
        },
        advisor: {
          providerID: "test-provider",
          modelID: longID,
          policy: { kind: "candidates", candidates, fallback: "effort-9" },
        },
      },
      benchmarks: {
        ...evidenceFixture().benchmarks,
        advisorCandidates: candidates.map((effort) => ({
          effort,
          status: "matched",
          source: "local",
          aaModelID: "synthetic-aa-1",
          evaluatedEffort: "max",
        })),
      },
      maxStateBytes: 8000,
    });
    expect(state.coverage.stateBytes).toBeLessThanOrEqual(8000);
    expect(state.models?.requester.modelID).toBe(longID);
    expect(state.models?.advisor.policy).toEqual({
      kind: "candidates",
      candidates,
      fallback: "effort-9",
    });
    expect(state.benchmarks?.comparisons).toHaveLength(2);
    expect(state.coverage.truncated).toBe(true);
    expect(state.user.latestRequest).toBe("Ship it");
  });
});
