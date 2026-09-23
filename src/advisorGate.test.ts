// Integration coverage for the TypeSafe gate inside runAdvisor. These tests
// drive the real code path with a fixture session database, a fixture metrics
// file, and a stub gate client, so no network or production state is touched.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computeSnapshotHash } from "./benchmarkTypes";
import {
  resetBenchmarkStores,
  runAdvisor,
  type AdvisorConfig,
  type V2PluginContext,
} from "./ocAdvisor";
import {
  GATE_EFFORT_QUESTION,
  GATE_NEEDED_QUESTION,
  type GateClient,
  type SystemOneCall,
} from "./typesafeGate";
import type { AdvisorProfile, RequesterProfile } from "./modelProfiles";
import { TYPESAFE_DEFAULTS } from "./typesafeState";

let dir: string;
let dbPath: string;
let metricsPath: string;

function writeFixtureDb(): void {
  const db = new Database(dbPath);
  db.run(
    "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT)",
  );
  db.run(
    "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
  );
  db.query(
    "INSERT INTO session_v2 (id, parent_id, title, model, agent, directory) VALUES (?,?,?,?,?,?)",
  ).run(
    "ses_fixture",
    null,
    "Fixture",
    JSON.stringify({ providerID: "meta", id: "muse-spark-1.3" }),
    "build",
    dir,
  );
  db.query(
    "INSERT INTO session_message (session_id, type, seq, data) VALUES (?,?,?,?)",
  ).run(
    "ses_fixture",
    "user",
    1,
    JSON.stringify({ text: "Implement the TypeSafe gate" }),
  );
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocadvisor-gate-"));
  dbPath = join(dir, "fixture.db");
  metricsPath = join(dir, "metrics.jsonl");
  writeFixtureDb();
  resetBenchmarkStores();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gateResponse(
  needed: number,
  effort?: { choice: string; confidence: number },
): Record<string, unknown> {
  const answers: Record<string, unknown> = {
    [GATE_NEEDED_QUESTION]: { type: "noul", noul: needed },
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
    usage: { input_tokens: 900, output_tokens: 20 },
  };
}

function stubGate(result: Record<string, unknown>): {
  client: GateClient;
  calls: SystemOneCall[];
} {
  const calls: SystemOneCall[] = [];
  return {
    calls,
    client: {
      async systemOne(call) {
        calls.push(call);
        return { kind: "response", result };
      },
    },
  };
}

function runtimeWith(options: {
  gateClient?: GateClient;
  gateEnv?: Record<string, string | undefined>;
  generate?: (request: Record<string, unknown>) => Promise<unknown>;
  agentEffort?: string[] | null;
  variant?: string | undefined;
  omitCatalog?: boolean;
  v2ModelList?: Array<Record<string, unknown>>;
}): {
  runtime: V2PluginContext;
  generated: Array<Record<string, unknown>>;
  counts: {
    providerGet: number;
    modelList: number;
    connectionActive: number;
    sessionCreate: number;
    switchModel: number;
  };
} {
  const generated: Array<Record<string, unknown>> = [];
  const counts = {
    providerGet: 0,
    modelList: 0,
    connectionActive: 0,
    sessionCreate: 0,
    switchModel: 0,
  };
  const runtime = {
    __advisorTest: {
      gateClient: options.gateClient,
      gateEnv: options.gateEnv ?? {},
      dbPath,
      metricsPath,
    },
    catalog: {
      provider: {
        get: async () => {
          counts.providerGet++;
          return { activation: "enabled" };
        },
      },
      model: {
        list: async () => {
          counts.modelList++;
          return [
            {
              providerID: "anthropic",
              id: "claude-opus-5-5",
              enabled: true,
              variants: [{ id: "high" }, { id: "xhigh" }, { id: "max" }],
            },
          ];
        },
      },
    },
    integration: {
      connection: {
        active: async () => {
          counts.connectionActive++;
          return { status: "connected" };
        },
      },
    },
    session: {
      create: async () => {
        counts.sessionCreate++;
        return { id: "ses_advisor_fixture" };
      },
      get: async () => ({
        id: "ses_advisor_fixture",
        model: {
          providerID: "anthropic",
          id: "claude-opus-5-5",
          variant: "xhigh",
        },
      }),
      switchModel: async () => {
        counts.switchModel++;
      },
      generate: async (request: Record<string, unknown>) => {
        generated.push(request);
        return options.generate
          ? await options.generate(request)
          : { text: "advisor answer" };
      },
    },
  } as unknown as V2PluginContext;
  if (options.omitCatalog) delete runtime.catalog;
  if (options.v2ModelList !== undefined) {
    const models = options.v2ModelList;
    runtime.model = {
      list: async () => {
        counts.modelList++;
        return { data: models };
      },
    };
  }
  return { runtime, generated, counts };
}

function setSessionModel(
  sessionId: string,
  model: { providerID: string; id: string },
): void {
  const db = new Database(dbPath);
  db.query("UPDATE session_v2 SET model = ? WHERE id = ?").run(
    JSON.stringify(model),
    sessionId,
  );
  db.close();
}

function insertChildSession(
  sessionId: string,
  parentId: string,
  model: { providerID: string; id: string },
): void {
  const db = new Database(dbPath);
  db.query(
    "INSERT INTO session_v2 (id, parent_id, title, model, agent, directory) VALUES (?,?,?,?,?,?)",
  ).run(sessionId, parentId, "Child", JSON.stringify(model), "explore", dir);
  db.query(
    "INSERT INTO session_message (session_id, type, seq, data) VALUES (?,?,?,?)",
  ).run(sessionId, "user", 1, JSON.stringify({ text: "Child question" }));
  db.close();
}

function baseConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    variant: "xhigh",
    timeoutMs: 5000,
    maxTranscriptChars: 0,
    agentEffort: ["high", "xhigh", "max"],
    disabledForModels: [],
    benchmarks: {},
    typesafeSource: { disabled: false, overrides: {} },
    typesafe: {
      enabled: true,
      settings: { ...TYPESAFE_DEFAULTS },
      keyPresent: true,
    },
    typesafeSettings: { ...TYPESAFE_DEFAULTS },
    ...overrides,
  };
}

function metricRecords(): Array<Record<string, any>> {
  try {
    return readFileSync(metricsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe("runAdvisor with the TypeSafe gate", () => {
  test("skips generation and reports the skip when the gate declines", async () => {
    const { client, calls } = stubGate(gateResponse(0.05));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "plan",
      trigger: "before_approach",
      question: "Should the gate run before generation?",
      config: baseConfig(),
    });
    expect(text).toContain("advisor consultation skipped (typesafe)");
    expect(generated.length).toBe(0);
    expect(calls.length).toBe(1);
    const records = metricRecords();
    expect(records.length).toBe(1);
    expect(records[0].outcome).toBe("skipped_typesafe");
    expect(records[0].gate.status).toBe("skip");
    expect(records[0].gate.neededProbability).toBe(0.05);
    expect(records[0].gate.model).toBe("jev-1.13.0");
  });

  test("falls back to exactly one generation on a gate failure", async () => {
    const calls: SystemOneCall[] = [];
    const client: GateClient = {
      async systemOne(call) {
        calls.push(call);
        return { kind: "timeout", type: "timeout" };
      },
    };
    const { runtime, generated } = runtimeWith({ gateClient: client });
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "review",
      trigger: "pre_complete",
      question: "Review the gate integration",
      config: baseConfig(),
    });
    expect(text).toContain("advisor answer");
    expect(generated.length).toBe(1);
    const records = metricRecords();
    expect(records[0].outcome).toBe("advisor_response");
    expect(records[0].gate.status).toBe("fallback");
    expect(records[0].gate.reason).toBe("timeout");
  });

  test("uses the gate-selected effort when the caller omits one", async () => {
    const { client } = stubGate(
      gateResponse(0.9, { choice: "high", confidence: 0.95 }),
    );
    const { runtime } = runtimeWith({ gateClient: client });
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "plan",
      question: "Design the gate",
      config: baseConfig(),
    });
    expect(text).toContain("advisor answer");
    const records = metricRecords();
    expect(records[0].gate.status).toBe("proceed");
    expect(records[0].gate.effectiveEffort).toBe("high");
    expect(records[0].gate.effortSource).toBe("typesafe");
    expect(records[0].effort).toBe("high");
    expect(records[0].advisorProvider).toBe("anthropic");
  });

  test("keeps an explicit caller effort over the gate suggestion", async () => {
    const { client, calls } = stubGate(
      gateResponse(0.9, { choice: "high", confidence: 1 }),
    );
    const { runtime } = runtimeWith({ gateClient: client });
    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "plan",
      question: "Design the gate",
      effort: "max",
      config: baseConfig(),
    });
    // The caller pinned effort, so the effort question is not asked.
    expect(calls[0].questions[GATE_EFFORT_QUESTION]).toBeUndefined();
    const records = metricRecords();
    expect(records[0].gate.effortSource).toBe("caller");
    expect(records[0].effort).toBe("max");
  });

  test("bypasses the gate entirely when disabled or keyless", async () => {
    const { client, calls } = stubGate(gateResponse(0.01));
    const disabled = runtimeWith({ gateClient: client });
    await runAdvisor({
      runtime: disabled.runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Anything",
      config: baseConfig({
        typesafeSource: { disabled: true },
        typesafe: { enabled: false, settings: null, keyPresent: true },
        typesafeSettings: null,
      }),
    });
    expect(calls.length).toBe(0);
    expect(disabled.generated.length).toBe(1);

    const keyless = runtimeWith({ gateClient: client });
    await runAdvisor({
      runtime: keyless.runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Anything",
      config: baseConfig({
        typesafe: {
          enabled: false,
          settings: null,
          keyPresent: false,
        },
        typesafeSettings: null,
      }),
    });
    expect(calls.length).toBe(0);
    expect(keyless.generated.length).toBe(1);
    const records = metricRecords();
    expect(records.every((record) => record.gate === undefined)).toBe(true);
  });

  test("retries once when a generation comes back empty", async () => {
    let calls = 0;
    const { runtime } = runtimeWith({
      gateClient: stubGate(gateResponse(0.9)).client,
      generate: async () => {
        calls++;
        return calls === 1 ? { text: "" } : { text: "advisor answer" };
      },
    });
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Anything",
      config: baseConfig(),
    });
    expect(calls).toBe(2);
    expect(text).toContain("advisor answer");
    const records = metricRecords();
    expect(records[0].outcome).toBe("advisor_response");
  });

  test("still fails when the retry is empty too", async () => {
    let calls = 0;
    const { runtime } = runtimeWith({
      gateClient: stubGate(gateResponse(0.9)).client,
      generate: async () => {
        calls++;
        return { text: "" };
      },
    });
    await expect(
      runAdvisor({
        runtime,
        sessionId: "ses_fixture",
        mode: "general",
        question: "Anything",
        config: baseConfig(),
      }),
    ).rejects.toThrow(/empty response/);
    expect(calls).toBe(2);
    const records = metricRecords();
    expect(records[0].outcome).toBe("error");
  });

  test("shows the gate decision in the advisor footer", async () => {
    const { client } = stubGate(
      gateResponse(0.72, { choice: "high", confidence: 0.95 }),
    );
    const { runtime } = runtimeWith({ gateClient: client });
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "plan",
      question: "Design the gate",
      config: baseConfig(),
    });
    expect(text).toContain(
      "gate: need=0.72, effort=high (gate), decision=proceed",
    );
    const records = metricRecords();
    expect(records[0].gate.status).toBe("proceed");
  });

  test("shows the gate decision on a skip and a fallback", async () => {
    const skipped = runtimeWith({
      gateClient: stubGate(gateResponse(0.05)).client,
    });
    const skipText = await runAdvisor({
      runtime: skipped.runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Anything",
      config: baseConfig(),
    });
    expect(skipText).toContain("advisor consultation skipped (typesafe)");
    expect(skipText).toContain(
      "gate: need=0.05, decision=skip, consultation_not_useful",
    );

    const failing: GateClient = {
      async systemOne() {
        return { kind: "timeout", type: "timeout" };
      },
    };
    const fallback = runtimeWith({ gateClient: failing });
    const fallbackText = await runAdvisor({
      runtime: fallback.runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Anything",
      config: baseConfig(),
    });
    expect(fallbackText).toContain("advisor answer");
    expect(fallbackText).toContain("gate: decision=fallback, timeout");
  });

  test("omits the gate line when screening is bypassed", async () => {
    const { runtime } = runtimeWith({});
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Anything",
      config: baseConfig({
        typesafe: { enabled: false, settings: null, keyPresent: false },
        typesafeSettings: null,
      }),
    });
    expect(text).not.toContain("gate:");
  });

  test("keeps the self-consultation guard ahead of the gate", async () => {
    const { client, calls } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    // Point the fixture session at the configured advisor model.
    const db = new Database(dbPath);
    db.query("UPDATE session_v2 SET model = ? WHERE id = ?").run(
      JSON.stringify({ providerID: "anthropic", id: "claude-opus-5-5" }),
      "ses_fixture",
    );
    db.close();
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Anything",
      config: baseConfig(),
    });
    expect(text).toContain("already the advisor model");
    expect(calls.length).toBe(0);
    expect(generated.length).toBe(0);
    const records = metricRecords();
    expect(records[0].outcome).toBe("skipped_self");
  });

  test("skips configured caller models before TypeSafe or generation", async () => {
    const { client, calls } = stubGate(gateResponse(0.9));
    const { runtime, generated, counts } = runtimeWith({
      gateClient: client,
    });
    setSessionModel("ses_fixture", {
      providerID: "openai",
      id: "gpt-6-astra",
    });
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "plan",
      trigger: "before_approach",
      question: "Should we consult?",
      config: baseConfig({
        disabledForModels: ["openai/gpt-6-astra"],
      }),
    });
    expect(text).toBe(
      "advisor is disabled (model opt-out): openai/gpt-6-astra is listed in disabledForModels.",
    );
    expect(calls.length).toBe(0);
    expect(generated.length).toBe(0);
    expect(counts).toEqual({
      providerGet: 0,
      modelList: 0,
      connectionActive: 0,
      sessionCreate: 0,
      switchModel: 0,
    });
    const records = metricRecords();
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("skipped_model");
    expect(records[0].errorType).toBeNull();
    expect(records[0].effort).toBeNull();
    expect(records[0].transcriptChars).toBe(0);
    expect(records[0].priorConsultations).toBe(0);
    expect(records[0].gate).toBeUndefined();
    expect(records[0].callerModel).toBe("openai/gpt-6-astra");
  });

  test("blocks an excluded caller even when the transcript is empty", async () => {
    const { client, calls } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    setSessionModel("ses_fixture", {
      providerID: "openai",
      id: "gpt-6-astra",
    });
    const db = new Database(dbPath);
    db.query("DELETE FROM session_message WHERE session_id = ?").run(
      "ses_fixture",
    );
    db.close();
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Anything",
      config: baseConfig({
        disabledForModels: ["openai/gpt-6-astra"],
      }),
    });
    expect(text).toContain("model opt-out");
    expect(calls.length).toBe(0);
    expect(generated.length).toBe(0);
    expect(metricRecords()[0].outcome).toBe("skipped_model");
  });

  test("uses each session's own caller model, not the parent", async () => {
    const { client, calls } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    setSessionModel("ses_fixture", {
      providerID: "openai",
      id: "gpt-6-astra",
    });
    insertChildSession("ses_child", "ses_fixture", {
      providerID: "meta",
      id: "muse-spark-1.3",
    });
    const config = baseConfig({
      disabledForModels: ["openai/gpt-6-astra"],
    });
    const parentText = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Parent",
      config,
    });
    expect(parentText).toContain("model opt-out");
    const childText = await runAdvisor({
      runtime,
      sessionId: "ses_child",
      mode: "general",
      question: "Child",
      config,
    });
    expect(childText).toContain("advisor answer");
    expect(calls.length).toBe(1);
    expect(generated.length).toBe(1);
    expect(metricRecords().map((row) => row.outcome)).toEqual([
      "skipped_model",
      "advisor_response",
    ]);
  });

  test("blocks a child whose own model is excluded", async () => {
    const { client, calls } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    insertChildSession("ses_child", "ses_fixture", {
      providerID: "openai",
      id: "gpt-6-astra",
    });
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_child",
      mode: "general",
      question: "Child",
      config: baseConfig({
        disabledForModels: ["openai/gpt-6-astra"],
      }),
    });
    expect(text).toContain("model opt-out");
    expect(calls.length).toBe(0);
    expect(generated.length).toBe(0);
    expect(metricRecords()[0].outcome).toBe("skipped_model");
  });

  test("rereads the caller model after a session switch", async () => {
    const { client, calls } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    const config = baseConfig({
      disabledForModels: ["openai/gpt-6-astra"],
    });
    setSessionModel("ses_fixture", {
      providerID: "openai",
      id: "gpt-6-astra",
    });
    const blocked = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "First",
      config,
    });
    expect(blocked).toContain("model opt-out");
    setSessionModel("ses_fixture", {
      providerID: "meta",
      id: "muse-spark-1.3",
    });
    const allowed = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Second",
      config,
    });
    expect(allowed).toContain("advisor answer");
    expect(calls.length).toBe(1);
    expect(generated.length).toBe(1);
    expect(metricRecords().map((row) => row.outcome)).toEqual([
      "skipped_model",
      "advisor_response",
    ]);
  });
});

describe("runAdvisor provider fallback", () => {
  test("retries through opencode when the anthropic route is unavailable", async () => {
    const { client } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    const catalog = runtime.catalog!;
    catalog.provider!.get = async (args: { providerID?: string }) => {
      if (args?.providerID === "anthropic")
        throw new Error("provider disabled");
      return { activation: "enabled" };
    };
    catalog.model!.list = async () => [
      {
        providerID: "opencode",
        id: "claude-opus-5-5",
        enabled: true,
        variants: [{ id: "xhigh" }, { id: "max" }],
      },
    ];
    const switches: Array<Record<string, unknown>> = [];
    runtime.session!.switchModel = async (args: Record<string, unknown>) => {
      switches.push(args);
    };
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Fallback check",
      config: baseConfig(),
    });
    expect(text).toContain("advisor answer");
    expect(text).toContain("opencode/claude-opus-5-5");
    expect(generated.length).toBe(1);
    expect(switches.length).toBe(1);
    expect(switches[0]).toMatchObject({
      model: {
        providerID: "opencode",
        id: "claude-opus-5-5",
        variant: "xhigh",
      },
    });
    expect(metricRecords()[0].outcome).toBe("advisor_response");
    expect(metricRecords()[0].advisorProvider).toBe("opencode");
  });

  test("reports the primary reason when the fallback also fails", async () => {
    const { client } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    runtime.catalog!.model!.list = async () => [];
    await expect(
      runAdvisor({
        runtime,
        sessionId: "ses_fixture",
        mode: "general",
        question: "Fallback check",
        config: baseConfig(),
      }),
    ).rejects.toThrow(
      "Model unavailable: anthropic/claude-opus-5-5 (fallback opencode: Model unavailable: opencode/claude-opus-5-5)",
    );
    expect(generated.length).toBe(0);
    expect(metricRecords()[0].outcome).toBe("error");
    expect(metricRecords()[0].errorType).toBe("model_unavailable");
    // No route was chosen, so the row names none.
    expect(metricRecords()[0].advisorProvider).toBeUndefined();
  });

  test("falls back on the V2 discovery path with effort selection on", async () => {
    const { client } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({
      gateClient: client,
      omitCatalog: true,
      v2ModelList: [
        {
          providerID: "opencode",
          id: "claude-opus-5-5",
          enabled: true,
          variants: [{ id: "xhigh" }, { id: "max" }],
        },
      ],
    });
    runtime.provider = {
      get: async (args: { providerID?: string }) => {
        if (args?.providerID === "anthropic") {
          throw new Error("provider disabled");
        }
        return { activation: "enabled" };
      },
    };
    const switches: Array<Record<string, unknown>> = [];
    runtime.session!.switchModel = async (args: Record<string, unknown>) => {
      switches.push(args);
    };
    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Fallback check",
      config: baseConfig(),
    });
    expect(text).toContain("advisor answer");
    expect(text).toContain("opencode/claude-opus-5-5");
    expect(generated.length).toBe(1);
    expect(switches[0]).toMatchObject({
      model: {
        providerID: "opencode",
        id: "claude-opus-5-5",
        variant: "xhigh",
      },
    });
    expect(metricRecords()[0].advisorProvider).toBe("opencode");
  });

  test("names the fallback route when generation fails after it", async () => {
    const { client } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({
      gateClient: client,
      generate: async () => {
        throw new Error("boom");
      },
    });
    const catalog = runtime.catalog!;
    catalog.provider!.get = async (args: { providerID?: string }) => {
      if (args?.providerID === "anthropic")
        throw new Error("provider disabled");
      return { activation: "enabled" };
    };
    catalog.model!.list = async () => [
      {
        providerID: "opencode",
        id: "claude-opus-5-5",
        enabled: true,
        variants: [{ id: "xhigh" }],
      },
    ];
    await expect(
      runAdvisor({
        runtime,
        sessionId: "ses_fixture",
        mode: "general",
        question: "Failure check",
        config: baseConfig(),
      }),
    ).rejects.toThrow("advisor failed (api_error): boom");
    expect(generated.length).toBe(1);
    expect(metricRecords()[0].outcome).toBe("error");
    expect(metricRecords()[0].advisorProvider).toBe("opencode");
  });

  test("re-pins the shared session when the primary recovers", async () => {
    const { client } = stubGate(gateResponse(0.9));
    const { runtime } = runtimeWith({ gateClient: client });
    let anthropicDown = true;
    const catalog = runtime.catalog!;
    catalog.provider!.get = async (args: { providerID?: string }) => {
      if (anthropicDown && args?.providerID === "anthropic") {
        throw new Error("provider disabled");
      }
      return { activation: "enabled" };
    };
    const anthropicModel = {
      providerID: "anthropic",
      id: "claude-opus-5-5",
      enabled: true,
      variants: [{ id: "xhigh" }, { id: "max" }],
    };
    const opencodeModel = {
      providerID: "opencode",
      id: "claude-opus-5-5",
      enabled: true,
      variants: [{ id: "xhigh" }, { id: "max" }],
    };
    catalog.model!.list = async () =>
      anthropicDown ? [opencodeModel] : [anthropicModel, opencodeModel];
    let pinned = {
      providerID: "anthropic",
      id: "claude-opus-5-5",
      variant: "xhigh",
    };
    const switches: Array<Record<string, unknown>> = [];
    runtime.session!.get = async () => ({
      id: "ses_advisor_fixture",
      model: { ...pinned },
    });
    runtime.session!.switchModel = async (args: Record<string, unknown>) => {
      switches.push(args);
      pinned = { ...(args.model as typeof pinned) };
    };
    const config = baseConfig();
    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "First",
      config,
    });
    anthropicDown = false;
    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Second",
      config,
    });
    expect(
      switches.map((args) => (args.model as { providerID: string }).providerID),
    ).toEqual(["opencode", "anthropic"]);
    expect(metricRecords().map((row) => row.advisorProvider)).toEqual([
      "opencode",
      "anthropic",
    ]);
  });
});

describe("runAdvisor resolves model profiles", () => {
  function insertAssistantMessage(row: {
    id: string;
    sessionId: string;
    seq: number;
    model: Record<string, unknown>;
    toolBlocks?: Array<{ id: string; name: string }>;
  }): void {
    const db = new Database(dbPath);
    db.query(
      "INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?,?,?,?,?)",
    ).run(
      row.id,
      row.sessionId,
      "assistant",
      row.seq,
      JSON.stringify({
        agent: "build",
        model: row.model,
        content: (row.toolBlocks ?? []).map((block) => ({
          type: "tool",
          id: block.id,
          name: block.name,
          state: { status: "running", input: {} },
        })),
      }),
    );
    db.close();
  }

  function captureProfiles(runtime: V2PluginContext): Array<{
    requester: RequesterProfile;
    advisor: AdvisorProfile;
  }> {
    const seen: Array<{
      requester: RequesterProfile;
      advisor: AdvisorProfile;
    }> = [];
    runtime.__advisorTest!.profileSink = (profiles) => {
      seen.push(profiles);
    };
    return seen;
  }

  test("correlates the requester to the originating message", async () => {
    insertAssistantMessage({
      id: "msg_req",
      sessionId: "ses_fixture",
      seq: 10,
      model: { providerID: "openai", id: "gpt-6-astra", variant: "xhigh" },
      toolBlocks: [{ id: "call_req", name: "advisor" }],
    });
    const { client } = stubGate(gateResponse(0.05));
    const { runtime } = runtimeWith({ gateClient: client });
    const seen = captureProfiles(runtime);

    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Profile check",
      callerMessageID: "msg_req",
      callerCallID: "call_req",
      config: baseConfig(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.requester).toEqual({
      providerID: "openai",
      modelID: "gpt-6-astra",
      variant: "xhigh",
      provenance: "invocation_message",
    });
  });

  test("falls back to the latest message without identifiers", async () => {
    insertAssistantMessage({
      id: "msg_latest",
      sessionId: "ses_fixture",
      seq: 10,
      model: { providerID: "test", id: "latest-model", variant: "high" },
    });
    const { client } = stubGate(gateResponse(0.05));
    const { runtime } = runtimeWith({ gateClient: client });
    const seen = captureProfiles(runtime);

    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Profile check",
      config: baseConfig(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.requester).toEqual({
      providerID: "test",
      modelID: "latest-model",
      variant: "high",
      provenance: "latest_message",
    });
  });

  test("isolates subagent requesters from parents", async () => {
    insertChildSession("ses_child", "ses_fixture", {
      providerID: "meta",
      id: "muse-spark-1.3",
    });
    insertAssistantMessage({
      id: "msg_child",
      sessionId: "ses_child",
      seq: 2,
      model: { providerID: "test", id: "child-model", variant: "max" },
    });
    const { client } = stubGate(gateResponse(0.05));
    const { runtime } = runtimeWith({ gateClient: client });
    const seen = captureProfiles(runtime);

    await runAdvisor({
      runtime,
      sessionId: "ses_child",
      mode: "general",
      question: "Profile check",
      config: baseConfig(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.requester.modelID).toBe("child-model");
    expect(seen[0]?.requester.provenance).toBe("latest_message");
  });

  test("pins an explicit caller effort over candidates", async () => {
    const { client } = stubGate(gateResponse(0.05));
    const { runtime } = runtimeWith({ gateClient: client });
    const seen = captureProfiles(runtime);

    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Profile check",
      effort: "max",
      config: baseConfig(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.advisor).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-5-5",
      policy: { kind: "pinned", effort: "max" },
    });
  });

  test("exposes gate candidates with a validated fallback", async () => {
    const { client } = stubGate(gateResponse(0.05));
    const { runtime } = runtimeWith({ gateClient: client });
    const seen = captureProfiles(runtime);

    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Profile check",
      config: baseConfig(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.advisor.policy).toEqual({
      kind: "candidates",
      candidates: ["high", "xhigh", "max"],
      fallback: "xhigh",
    });
  });

  test("fixes the effort when selection is unavailable", async () => {
    const { client } = stubGate(gateResponse(0.05));
    const { runtime } = runtimeWith({ gateClient: client });
    const seen = captureProfiles(runtime);

    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Profile check",
      config: baseConfig({ agentEffort: null }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.advisor.policy).toEqual({
      kind: "fixed",
      effort: "xhigh",
    });
  });

  test("keeps guards on the session model ahead of profiles", async () => {
    setSessionModel("ses_fixture", {
      providerID: "opencode",
      id: "claude-opus-5-5",
    });
    insertAssistantMessage({
      id: "msg_other",
      sessionId: "ses_fixture",
      seq: 10,
      model: { providerID: "openai", id: "gpt-6-astra" },
    });
    const { client, calls } = stubGate(gateResponse(0.9));
    const { runtime } = runtimeWith({ gateClient: client });
    const seen = captureProfiles(runtime);

    const result = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Profile check",
      callerMessageID: "msg_other",
      config: baseConfig(),
    });

    expect(result).toContain("already the advisor model");
    expect(calls).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  test("prefers V2 model discovery with validated defaults", async () => {
    const { client } = stubGate(gateResponse(0.05));
    const { runtime, counts } = runtimeWith({
      gateClient: client,
      omitCatalog: true,
      v2ModelList: [
        {
          providerID: "anthropic",
          id: "claude-opus-5-5",
          enabled: true,
          variants: [{ id: "high" }, { id: "max" }],
        },
      ],
    });
    const seen = captureProfiles(runtime);

    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Profile check",
      config: baseConfig(),
    });

    expect(counts.modelList).toBe(1);
    expect(seen).toHaveLength(1);
    // xhigh is neither a candidate nor the fallback: discovery says the
    // configured default is unsupported.
    expect(seen[0]?.advisor.policy).toEqual({
      kind: "candidates",
      candidates: ["high", "max"],
      fallback: null,
    });
  });

  test("prefers V2 discovery over catalog when both exist", async () => {
    const { client } = stubGate(gateResponse(0.05));
    const { runtime } = runtimeWith({
      gateClient: client,
      v2ModelList: [
        {
          providerID: "anthropic",
          id: "claude-opus-5-5",
          enabled: true,
          variants: [{ id: "max" }],
        },
      ],
    });
    const seen = captureProfiles(runtime);

    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Profile check",
      config: baseConfig(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.advisor.policy).toEqual({
      kind: "candidates",
      candidates: ["max"],
      fallback: null,
    });
  });
});

describe("runAdvisor benchmark evidence", () => {
  // Synthetic snapshot and mappings with fake IDs and scores.
  function writeBenchmarkFiles(scores: {
    requesterCoding: number;
    advisorCoding: number;
  }): { snapshotPath: string; mappingsPath: string; contentHash: string } {
    const endpoint = "https://artificialanalysis.ai/api/v2/data/llms/models";
    const models = [
      {
        id: "synthetic-aa-r",
        creatorID: "synthetic-creator",
        name: "Synthetic Requester",
        slug: "synthetic-requester",
        evaluatedEffort: null,
        evaluatedAt: null,
        evaluations: {
          artificial_analysis_coding_index: scores.requesterCoding,
          artificial_analysis_intelligence_index: 62,
          hle: 0.3,
          gpqa: 0.7,
        },
      },
      {
        id: "synthetic-aa-a",
        creatorID: "synthetic-creator",
        name: "Synthetic Advisor",
        slug: "synthetic-advisor",
        evaluatedEffort: null,
        evaluatedAt: null,
        evaluations: {
          artificial_analysis_coding_index: scores.advisorCoding,
          artificial_analysis_intelligence_index: 82,
          hle: 0.6,
          gpqa: null,
        },
      },
    ];
    const contentHash = computeSnapshotHash({
      source: "artificial-analysis",
      endpoint,
      methodologyVersion: null,
      models,
    });
    const snapshotPath = join(dir, "artificial-analysis.json");
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        source: "artificial-analysis",
        sourceURL: "https://artificialanalysis.ai/",
        endpoint,
        fetchedAt: "2026-09-10T00:00:00.000Z",
        contentHash,
        methodologyVersion: null,
        metricDefinitions: [],
        models,
      }),
    );
    const mappingsPath = join(dir, "model-mappings.json");
    writeFileSync(
      mappingsPath,
      JSON.stringify({
        schemaVersion: 1,
        bindings: [
          {
            providerID: "meta",
            modelID: "muse-spark-1.3",
            variant: null,
            aaModelID: "synthetic-aa-r",
            evaluatedEffort: "max",
            evidenceURL: "https://artificialanalysis.ai/synthetic",
          },
          ...["high", "xhigh", "max"].map((variant) => ({
            providerID: "anthropic",
            modelID: "claude-opus-5-5",
            variant,
            aaModelID: "synthetic-aa-a",
            evaluatedEffort: "max",
            evidenceURL: "https://artificialanalysis.ai/synthetic",
          })),
        ],
      }),
    );
    return { snapshotPath, mappingsPath, contentHash };
  }

  function benchmarkSeams(paths: {
    snapshotPath: string;
    mappingsPath: string;
  }): {
    config: { path: string; mappingsPath: string };
    storeOptions: {
      env: Record<string, string | undefined>;
      seedSnapshotPath: string;
      seedMappingsPath: string;
    };
  } {
    const seedMappingsPath = join(dir, "seed-mappings.json");
    writeFileSync(
      seedMappingsPath,
      JSON.stringify({ schemaVersion: 1, bindings: [] }),
    );
    return {
      config: { path: paths.snapshotPath, mappingsPath: paths.mappingsPath },
      storeOptions: {
        env: {},
        seedSnapshotPath: join(dir, "seed-missing.json"),
        seedMappingsPath,
      },
    };
  }

  test("sends profiles, scores, and deltas to the gate", async () => {
    const written = writeBenchmarkFiles({
      requesterCoding: 60,
      advisorCoding: 80,
    });
    const seams = benchmarkSeams(written);
    const { client, calls } = stubGate(gateResponse(0.05));
    const { runtime } = runtimeWith({ gateClient: client });
    runtime.__advisorTest!.benchmarkStoreOptions = seams.storeOptions;

    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Evidence check",
      config: baseConfig({ benchmarks: seams.config }),
    });

    expect(calls).toHaveLength(1);
    const sent = calls[0]?.state as Record<string, any>;
    expect(sent.models.requester).toEqual({
      provider: "meta",
      model: "muse-spark-1.3",
      effort: null,
      provenance: "session_fallback",
    });
    expect(sent.models.advisor.effort_policy).toEqual({
      kind: "candidates",
      candidates: ["high", "xhigh", "max"],
      fallback: "xhigh",
    });
    expect(sent.benchmarks.source).toBe("user");
    expect(sent.benchmarks.content_hash).toBe(written.contentHash);
    expect(sent.benchmarks.comparisons[0]).toMatchObject({
      metric: "artificial_analysis_coding_index",
      requester: 60,
      advisor: 80,
      advisor_minus_requester: 20,
      comparable: true,
    });
    expect(
      sent.benchmarks.advisor_candidates.map(
        (entry: { effort: string }) => entry.effort,
      ),
    ).toEqual(["high", "xhigh", "max"]);
    expect(
      sent.benchmarks.advisor_candidates.every(
        (entry: { status: string }) => entry.status === "matched",
      ),
    ).toBe(true);

    const row = metricRecords()[0]!;
    expect(row.outcome).toBe("skipped_typesafe");
    expect(row.benchmarks).toMatchObject({
      source: "user",
      requesterMatch: "matched",
      advisorMatch: "matched",
      advisorPolicy: "candidates:high,xhigh,max>xhigh",
      finalEffort: null,
      finalMatch: null,
      hashVerified: true,
    });
    expect(row.benchmarks.requester).toBe(
      "meta/muse-spark-1.3 (session_fallback)",
    );
    expect(row.benchmarks.contentHash).toBe(written.contentHash);
  });

  test("resolves the final advisor match after selection", async () => {
    const written = writeBenchmarkFiles({
      requesterCoding: 60,
      advisorCoding: 80,
    });
    const seams = benchmarkSeams(written);
    const { client } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    runtime.__advisorTest!.benchmarkStoreOptions = seams.storeOptions;

    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Evidence check",
      config: baseConfig({ benchmarks: seams.config }),
    });

    expect(text).toContain("advisor answer");
    expect(generated).toHaveLength(1);
    const row = metricRecords()[0]!;
    expect(row.outcome).toBe("advisor_response");
    expect(row.benchmarks).toMatchObject({
      source: "user",
      finalEffort: "xhigh",
      finalMatch: "matched",
    });
  });

  test("preserves consultation when benchmarks are malformed", async () => {
    const written = writeBenchmarkFiles({
      requesterCoding: 60,
      advisorCoding: 80,
    });
    writeFileSync(written.snapshotPath, "broken{{{");
    const seams = benchmarkSeams(written);
    const { client, calls } = stubGate(gateResponse(0.9));
    const { runtime } = runtimeWith({ gateClient: client });
    runtime.__advisorTest!.benchmarkStoreOptions = seams.storeOptions;

    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Evidence check",
      config: baseConfig({ benchmarks: seams.config }),
    });

    expect(text).toContain("advisor answer");
    const sent = calls[0]?.state as Record<string, any>;
    expect(sent.models.requester.provider).toBe("meta");
    expect(sent.benchmarks.source).toBe("unavailable");
    expect(
      sent.benchmarks.comparisons.every(
        (entry: { reason: string }) => entry.reason === "missing_requester",
      ),
    ).toBe(true);
    expect(metricRecords()[0]?.benchmarks).toMatchObject({
      source: "unavailable",
    });
  });

  test("loads no benchmarks when the gate is bypassed", async () => {
    const throwingFs = {
      stat: async (): Promise<never> => {
        throw new Error("benchmark loading is disabled on this path");
      },
      read: async (): Promise<never> => {
        throw new Error("benchmark loading is disabled on this path");
      },
    };
    const storeOptions = { env: {}, fs: throwingFs };

    const keyless = runtimeWith({
      gateClient: stubGate(gateResponse(0.05)).client,
    });
    keyless.runtime.__advisorTest!.benchmarkStoreOptions = storeOptions;
    const keylessText = await runAdvisor({
      runtime: keyless.runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Evidence check",
      config: baseConfig({
        typesafe: { enabled: false, settings: null, keyPresent: false },
        typesafeSettings: null,
      }),
    });
    expect(keylessText).toContain("advisor answer");

    const disabled = runtimeWith({
      gateClient: stubGate(gateResponse(0.05)).client,
    });
    disabled.runtime.__advisorTest!.benchmarkStoreOptions = storeOptions;
    const disabledText = await runAdvisor({
      runtime: disabled.runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Evidence check",
      config: baseConfig({
        typesafeSource: { disabled: true },
        typesafe: { enabled: false, settings: null, keyPresent: true },
        typesafeSettings: null,
      }),
    });
    expect(disabledText).toContain("advisor answer");

    setSessionModel("ses_fixture", {
      providerID: "anthropic",
      id: "claude-opus-5-5",
    });
    const self = runtimeWith({
      gateClient: stubGate(gateResponse(0.9)).client,
    });
    self.runtime.__advisorTest!.benchmarkStoreOptions = storeOptions;
    const selfText = await runAdvisor({
      runtime: self.runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Evidence check",
      config: baseConfig(),
    });
    expect(selfText).toContain("already the advisor model");
    expect(metricRecords().every((row) => row.benchmarks === undefined)).toBe(
      true,
    );
  });

  test("observes a refresh on the next invocation", async () => {
    const first = writeBenchmarkFiles({
      requesterCoding: 60,
      advisorCoding: 80,
    });
    const seams = benchmarkSeams(first);
    const { client, calls } = stubGate(gateResponse(0.05));
    const { runtime } = runtimeWith({ gateClient: client });
    runtime.__advisorTest!.benchmarkStoreOptions = seams.storeOptions;
    const config = baseConfig({ benchmarks: seams.config });

    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "First",
      config,
    });
    const second = writeBenchmarkFiles({
      requesterCoding: 60,
      advisorCoding: 100,
    });
    await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "general",
      question: "Second",
      config,
    });

    expect(calls).toHaveLength(2);
    const before = calls[0]?.state as Record<string, any>;
    const after = calls[1]?.state as Record<string, any>;
    expect(before.benchmarks.content_hash).toBe(first.contentHash);
    expect(before.benchmarks.comparisons[0].advisor_minus_requester).toBe(20);
    expect(after.benchmarks.content_hash).toBe(second.contentHash);
    expect(after.benchmarks.comparisons[0].advisor_minus_requester).toBe(40);
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  test("falls back to ordinary behavior on combined failures", async () => {
    const written = writeBenchmarkFiles({
      requesterCoding: 60,
      advisorCoding: 80,
    });
    writeFileSync(written.snapshotPath, "broken{{{");
    const seams = benchmarkSeams(written);
    const calls: SystemOneCall[] = [];
    const client: GateClient = {
      async systemOne(call) {
        calls.push(call);
        return { kind: "timeout", type: "timeout" };
      },
    };
    const { runtime, generated } = runtimeWith({ gateClient: client });
    runtime.__advisorTest!.benchmarkStoreOptions = seams.storeOptions;

    const text = await runAdvisor({
      runtime,
      sessionId: "ses_fixture",
      mode: "review",
      trigger: "pre_complete",
      question: "Evidence check",
      config: baseConfig({ benchmarks: seams.config }),
    });

    expect(text).toContain("advisor answer");
    expect(generated).toHaveLength(1);
    const row = metricRecords()[0]!;
    expect(row.gate.status).toBe("fallback");
    expect(row.benchmarks).toMatchObject({ source: "unavailable" });
  });

  test("records benchmark evidence on errors", async () => {
    const written = writeBenchmarkFiles({
      requesterCoding: 60,
      advisorCoding: 80,
    });
    const seams = benchmarkSeams(written);
    const { client } = stubGate(gateResponse(0.9));
    const { runtime } = runtimeWith({
      gateClient: client,
      generate: async () => {
        throw new Error("boom");
      },
    });
    runtime.__advisorTest!.benchmarkStoreOptions = seams.storeOptions;

    await expect(
      runAdvisor({
        runtime,
        sessionId: "ses_fixture",
        mode: "general",
        question: "Evidence check",
        config: baseConfig({ benchmarks: seams.config }),
      }),
    ).rejects.toThrow("advisor failed");

    const row = metricRecords()[0]!;
    expect(row.outcome).toBe("error");
    expect(row.benchmarks).toMatchObject({
      source: "user",
      finalEffort: "xhigh",
      finalMatch: "matched",
    });
  });
});
