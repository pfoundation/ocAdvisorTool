// Integration coverage for the TypeSafe gate inside runAdvisor. These tests
// drive the real code path with a fixture session database, a fixture metrics
// file, and a stub gate client, so no network or production state is touched.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
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
    "CREATE TABLE session_message (session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
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
}): { runtime: V2PluginContext; generated: Array<Record<string, unknown>> } {
  const generated: Array<Record<string, unknown>> = [];
  const runtime = {
    __advisorTest: {
      gateClient: options.gateClient,
      gateEnv: options.gateEnv ?? {},
      dbPath,
      metricsPath,
    },
    catalog: {
      provider: {
        get: async () => ({ activation: "enabled" }),
      },
      model: {
        list: async () => [
          {
            providerID: "anthropic",
            id: "claude-fable-5-1",
            enabled: true,
            variants: [{ id: "high" }, { id: "xhigh" }, { id: "max" }],
          },
        ],
      },
    },
    integration: {
      connection: { active: async () => ({ status: "connected" }) },
    },
    session: {
      create: async () => ({ id: "ses_advisor_fixture" }),
      get: async () => ({
        id: "ses_advisor_fixture",
        model: {
          providerID: "anthropic",
          id: "claude-fable-5-1",
          variant: "xhigh",
        },
      }),
      switchModel: async () => {},
      generate: async (request: Record<string, unknown>) => {
        generated.push(request);
        return options.generate
          ? await options.generate(request)
          : { text: "advisor answer" };
      },
    },
  } as unknown as V2PluginContext;
  return { runtime, generated };
}

function baseConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    provider: "anthropic",
    model: "claude-fable-5-1",
    variant: "xhigh",
    timeoutMs: 5000,
    maxTranscriptChars: 0,
    agentEffort: ["high", "xhigh", "max"],
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

  test("keeps the Fable guard ahead of the gate", async () => {
    const { client, calls } = stubGate(gateResponse(0.9));
    const { runtime, generated } = runtimeWith({ gateClient: client });
    // Point the fixture session at a Fable caller model.
    const db = new Database(dbPath);
    db.query("UPDATE session_v2 SET model = ? WHERE id = ?").run(
      JSON.stringify({ providerID: "anthropic", id: "claude-fable-5-1" }),
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
    expect(text).toContain("advisor is disabled");
    expect(calls.length).toBe(0);
    expect(generated.length).toBe(0);
    const records = metricRecords();
    expect(records[0].outcome).toBe("skipped_fable");
  });
});
