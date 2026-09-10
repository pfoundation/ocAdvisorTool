import { describe, expect, test } from "bun:test";
import {
  ADVISOR_TRIGGERS,
  CHECKPOINT_INSTRUCTION,
  DEFAULT_ADVISOR_CONFIG,
  TOOL_DESCRIPTION,
  buildAdvisorPrompt,
  checkAdvisorSupport,
  classifyAdvisorError,
  ensureAdvisorSession,
  extractGeneratedText,
  findAdvisorModel,
  hasAdvisorConnection,
  inferTrigger,
  isFableModel,
  isProviderUsable,
  parseModelRef,
  resolveAdvisorConfig,
  resolveAdvisorVariant,
  setupOcAdvisorV2,
  resetAdvisorSessionCache,
  unwrapData,
  withTimeout,
} from "./ocAdvisor";
import type { AdvisorConfig, V2PluginContext } from "./ocAdvisor";

describe("isFableModel", () => {
  test("detects anthropic fable models", () => {
    expect(
      isFableModel({ providerID: "anthropic", id: "claude-fable-5-1" }),
    ).toBe(true);
    expect(
      isFableModel({ provider: "anthropic", modelID: "claude-fable-5" }),
    ).toBe(true);
  });

  test("rejects non-fable models", () => {
    expect(isFableModel({ providerID: "anthropic", id: "claude-opus-5" })).toBe(
      false,
    );
    expect(isFableModel({ providerID: "xai", id: "grok-4.6" })).toBe(false);
    expect(isFableModel({ providerID: "meta", id: "muse-spark-1.3" })).toBe(
      false,
    );
  });

  test("handles missing input", () => {
    expect(isFableModel(null)).toBe(false);
    expect(isFableModel(undefined)).toBe(false);
    expect(isFableModel({})).toBe(false);
  });
});

describe("inferTrigger", () => {
  test("passes explicit triggers through", () => {
    for (const trigger of ADVISOR_TRIGGERS) {
      expect(inferTrigger("general", trigger)).toBe(trigger);
    }
  });

  test("infers trigger from mode", () => {
    expect(inferTrigger("plan", undefined)).toBe("before_approach");
    expect(inferTrigger("debug", undefined)).toBe("stuck");
    expect(inferTrigger("review", undefined)).toBe("pre_complete");
    expect(inferTrigger("general", undefined)).toBe("other");
    expect(inferTrigger(undefined, undefined)).toBe("other");
  });

  test("falls back to mode inference for unknown triggers", () => {
    expect(inferTrigger("plan", "bogus")).toBe("before_approach");
    expect(inferTrigger("debug", "")).toBe("stuck");
  });
});

describe("classifyAdvisorError", () => {
  test("classifies known failure modes", () => {
    expect(
      classifyAdvisorError(
        "Anthropic API error 400: Your credit balance is too low",
      ),
    ).toBe("insufficient_credit");
    expect(
      classifyAdvisorError(
        'Anthropic API error 429: {"type":"rate_limit_error"}',
      ),
    ).toBe("rate_limit");
    expect(classifyAdvisorError("Failed to parse JSON")).toBe("json_parse");
    expect(classifyAdvisorError("The operation was aborted.")).toBe("aborted");
    expect(classifyAdvisorError("TimeoutError: The operation timed out")).toBe(
      "timeout",
    );
    expect(classifyAdvisorError("Anthropic API error 401: unauthorized")).toBe(
      "auth",
    );
  });

  test("classifies OpenCode discovery failures", () => {
    expect(
      classifyAdvisorError("Model unavailable: anthropic/claude-fable-5-1"),
    ).toBe("model_unavailable");
    expect(
      classifyAdvisorError(
        "Anthropic provider is disabled or unavailable in OpenCode",
      ),
    ).toBe("provider_unavailable");
    expect(
      classifyAdvisorError("No Anthropic connection configured in OpenCode"),
    ).toBe("auth");
  });

  test("defaults to api_error", () => {
    expect(classifyAdvisorError("Anthropic API error 500: overloaded")).toBe(
      "api_error",
    );
    expect(classifyAdvisorError("fetch failed")).toBe("api_error");
  });
});

describe("buildAdvisorPrompt", () => {
  test("folds system instructions, transcript, and question into one prompt", () => {
    const prompt = buildAdvisorPrompt(
      "SYSTEM",
      "TRANSCRIPT",
      "Is this correct?",
      null,
    );
    expect(prompt).toContain("SYSTEM");
    expect(prompt).toContain("TRANSCRIPT");
    expect(prompt).toContain("Specific question: Is this correct?");
  });

  test("uses a default task and appends the prior-consultation note", () => {
    const prompt = buildAdvisorPrompt(
      "SYSTEM",
      "TRANSCRIPT",
      undefined,
      "PRIOR NOTE",
    );
    expect(prompt).toContain("provide your advisory guidance");
    expect(prompt).toContain("PRIOR NOTE");
  });
});

describe("support helpers", () => {
  test("isProviderUsable rejects disabled or missing providers", () => {
    expect(isProviderUsable({ activation: "enabled" })).toBe(true);
    expect(isProviderUsable({ activation: "auto" })).toBe(true);
    expect(isProviderUsable({ activation: "disabled" })).toBe(false);
    expect(isProviderUsable(null)).toBe(false);
    expect(isProviderUsable(undefined)).toBe(false);
  });

  test("findAdvisorModel matches the advisor model", () => {
    const fable = {
      providerID: "anthropic",
      id: "claude-fable-5-1",
      enabled: true,
    };
    expect(
      findAdvisorModel([{ providerID: "xai", id: "grok-4.6" }, fable]),
    ).toBe(fable);
    expect(
      findAdvisorModel([
        { providerID: "anthropic", modelID: "claude-fable-5-1" },
      ]),
    ).not.toBeNull();
    expect(findAdvisorModel([{ ...fable, enabled: false }])).toBeNull();
    expect(findAdvisorModel([])).toBeNull();
    expect(findAdvisorModel(null)).toBeNull();
  });

  test("resolveAdvisorVariant prefers max when listed", () => {
    expect(resolveAdvisorVariant(null)).toBe("max");
    expect(resolveAdvisorVariant({})).toBe("max");
    expect(resolveAdvisorVariant({ variants: [{ id: "max" }] })).toBe("max");
    expect(
      resolveAdvisorVariant({ variants: [{ id: "high" }] }),
    ).toBeUndefined();
  });

  test("hasAdvisorConnection requires a configured connection", () => {
    expect(hasAdvisorConnection({ type: "credential", id: "cred_1" })).toBe(
      true,
    );
    expect(hasAdvisorConnection(null)).toBe(false);
    expect(hasAdvisorConnection(undefined)).toBe(false);
    expect(hasAdvisorConnection({ active: false })).toBe(false);
  });

  test("unwrapData handles enveloped and bare payloads", () => {
    expect(unwrapData({ data: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapData([1, 2])).toEqual([1, 2]);
    expect(unwrapData(null)).toBeNull();
  });

  test("extractGeneratedText handles known shapes", () => {
    expect(extractGeneratedText("hi")).toBe("hi");
    expect(extractGeneratedText({ text: "hi" })).toBe("hi");
    expect(extractGeneratedText({ data: { text: "hi" } })).toBe("hi");
    expect(extractGeneratedText({})).toBeNull();
    expect(extractGeneratedText(null)).toBeNull();
  });

  test("withTimeout rejects slow work", async () => {
    await expect(withTimeout(Promise.resolve(1), 1000, "fast")).resolves.toBe(
      1,
    );
    await expect(
      withTimeout(new Promise(() => {}), 10, "slow"),
    ).rejects.toThrow("timed out");
  });
});

describe("checkAdvisorSupport", () => {
  const fableModel = {
    providerID: "anthropic",
    id: "claude-fable-5-1",
    enabled: true,
    variants: [{ id: "max" }],
  };
  const healthy = (): V2PluginContext => ({
    catalog: {
      provider: { get: async () => ({ data: { activation: "enabled" } }) },
      model: { list: async () => ({ data: [fableModel] }) },
    },
    integration: {
      connection: { active: async () => ({ type: "credential", id: "c1" }) },
    },
  });

  test("supports generation when provider, model, and connection exist", async () => {
    await expect(checkAdvisorSupport(healthy())).resolves.toEqual({
      supported: true,
      variant: "max",
    });
  });

  test("rejects a disabled provider", async () => {
    const runtime = healthy();
    runtime.catalog!.provider!.get = async () => ({
      data: { activation: "disabled" },
    });
    const result = await checkAdvisorSupport(runtime);
    expect(result.supported).toBe(false);
  });

  test("rejects a missing model", async () => {
    const runtime = healthy();
    runtime.catalog!.model!.list = async () => ({ data: [] });
    const result = await checkAdvisorSupport(runtime);
    expect(result).toEqual({
      supported: false,
      reason: "Model unavailable: anthropic/claude-fable-5-1",
    });
  });

  test("rejects a missing connection", async () => {
    const runtime = healthy();
    runtime.integration!.connection!.active = async () => null;
    const result = await checkAdvisorSupport(runtime);
    expect(result.supported).toBe(false);
  });

  test("skips checks the runtime does not offer", async () => {
    await expect(checkAdvisorSupport({})).resolves.toEqual({
      supported: true,
      variant: "max",
    });
  });
});

describe("ensureAdvisorSession", () => {
  const fableSession = {
    id: "ses_advisor1",
    title: "ocAdvisor",
    model: { providerID: "anthropic", id: "claude-fable-5-1" },
  };

  test("creates and pins the advisor session on first use", async () => {
    resetAdvisorSessionCache();
    const calls: string[] = [];
    const runtime: V2PluginContext = {
      session: {
        get: async () => {
          calls.push("get");
          throw new Error("not found");
        },
        list: async () => {
          calls.push("list");
          return { data: [] };
        },
        create: async (input: unknown) => {
          calls.push(`create:${JSON.stringify(input)}`);
          return { data: { id: "ses_created1" } };
        },
        switchModel: async (input: unknown) => {
          calls.push(`switch:${JSON.stringify(input)}`);
        },
      },
      storage: {
        get: async () => null,
        set: async () => {},
      },
    };
    await expect(ensureAdvisorSession(runtime, "max")).resolves.toBe(
      "ses_created1",
    );
    expect(calls).toContain('create:{"title":"ocAdvisor"}');
    expect(calls).toContain(
      'switch:{"sessionID":"ses_created1","model":{"providerID":"anthropic","id":"claude-fable-5-1","variant":"max"}}',
    );
  });

  test("reuses the cached session without recreating it", async () => {
    const calls: string[] = [];
    const runtime: V2PluginContext = {
      session: {
        get: async () => ({ data: { ...fableSession, id: "ses_created1" } }),
        create: async () => {
          calls.push("create");
          return { data: { id: "ses_other" } };
        },
        switchModel: async () => {
          calls.push("switch");
        },
      },
      storage: { get: async () => "ses_created1", set: async () => {} },
    };
    await expect(ensureAdvisorSession(runtime, "max")).resolves.toBe(
      "ses_created1",
    );
    expect(calls).toEqual([]);
  });

  test("repins a reused session that drifted off the advisor model", async () => {
    resetAdvisorSessionCache();
    const calls: string[] = [];
    const runtime: V2PluginContext = {
      session: {
        get: async () => ({
          data: {
            ...fableSession,
            model: { providerID: "xai", id: "grok-4.6" },
          },
        }),
        switchModel: async (input: unknown) => {
          calls.push(`switch:${JSON.stringify(input)}`);
        },
      },
      storage: { get: async () => "ses_advisor1", set: async () => {} },
    };
    await expect(ensureAdvisorSession(runtime, undefined)).resolves.toBe(
      "ses_advisor1",
    );
    expect(calls).toEqual([
      'switch:{"sessionID":"ses_advisor1","model":{"providerID":"anthropic","id":"claude-fable-5-1"}}',
    ]);
    resetAdvisorSessionCache();
  });
});

describe("checkpoint guidance", () => {
  test("tool description names the three checkpoints", () => {
    expect(TOOL_DESCRIPTION).toContain('"plan"');
    expect(TOOL_DESCRIPTION).toContain('"debug"');
    expect(TOOL_DESCRIPTION).toContain('"review"');
    expect(TOOL_DESCRIPTION).toContain("BEFORE committing");
    expect(TOOL_DESCRIPTION).toContain("WHEN STUCK");
    expect(TOOL_DESCRIPTION).toContain("BEFORE declaring");
    expect(TOOL_DESCRIPTION).toContain("followup");
  });

  test("injected instruction stays short", () => {
    expect(CHECKPOINT_INSTRUCTION.length).toBeLessThan(600);
    expect(CHECKPOINT_INSTRUCTION).toContain("ocAdvisor");
    expect(CHECKPOINT_INSTRUCTION).toContain("review");
  });
});

describe("context hook", () => {
  async function captureHook() {
    let handler: ((event: any) => void) | undefined;
    const ctx: V2PluginContext = {
      session: {
        hook: async (name: string, fn: (event: any) => void) => {
          if (name === "context") handler = fn;
          return { dispose: () => {} };
        },
      },
    };
    await setupOcAdvisorV2(ctx);
    if (!handler) throw new Error("context hook was not registered");
    return handler;
  }

  test("injects a typed text system part and the tool for non-Fable models", async () => {
    const handler = await captureHook();
    const event = {
      model: { providerID: "xai", id: "grok-4.6" },
      tools: {} as Record<string, unknown>,
      system: [{ type: "text", text: "base prompt" }],
    };
    handler(event);
    expect(Object.keys(event.tools)).toContain("ocAdvisor");
    expect(event.system).toHaveLength(2);
    // The 2.0 server validates system parts as { type: "text", text };
    // a part without `type` fails the request schema and kills the session.
    expect(event.system[1]).toEqual({
      type: "text",
      text: CHECKPOINT_INSTRUCTION,
    });
  });

  test("hides the tool and injects nothing for Fable models", async () => {
    const handler = await captureHook();
    const event = {
      model: { providerID: "anthropic", id: "claude-fable-5-1" },
      tools: { ocAdvisor: { description: "x", input: {} } } as Record<
        string,
        unknown
      >,
      system: [{ type: "text", text: "base prompt" }],
    };
    handler(event);
    expect(event.tools.ocAdvisor).toBeUndefined();
    expect(event.system).toHaveLength(1);
  });
});

describe("parseModelRef", () => {
  test("splits provider/model#variant", () => {
    expect(parseModelRef("anthropic/claude-fable-5-1#max")).toEqual({
      provider: "anthropic",
      model: "claude-fable-5-1",
      variant: "max",
    });
  });

  test("handles provider/model without a variant", () => {
    expect(parseModelRef("openai/gpt-6-astra")).toEqual({
      provider: "openai",
      model: "gpt-6-astra",
    });
  });

  test("treats a bare token as a model id", () => {
    expect(parseModelRef("claude-opus-5")).toEqual({ model: "claude-opus-5" });
  });

  test("ignores empty input", () => {
    expect(parseModelRef("   ")).toEqual({});
  });
});

describe("resolveAdvisorConfig", () => {
  const noEnv: Record<string, string | undefined> = {};

  test("defaults to anthropic/claude-fable-5-1#max", () => {
    expect(resolveAdvisorConfig(undefined, noEnv)).toEqual(
      DEFAULT_ADVISOR_CONFIG,
    );
    expect(resolveAdvisorConfig({}, noEnv)).toEqual(DEFAULT_ADVISOR_CONFIG);
  });

  test("options override provider, model, and variant", () => {
    const config = resolveAdvisorConfig(
      { provider: "openai", model: "gpt-6-astra", variant: "high" },
      noEnv,
    );
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-6-astra");
    expect(config.variant).toBe("high");
  });

  test("accepts a combined model reference string", () => {
    const config = resolveAdvisorConfig(
      { model: "anthropic/claude-opus-5#max" },
      noEnv,
    );
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-opus-5");
    expect(config.variant).toBe("max");
  });

  test("an explicit variant field wins over a combined ref", () => {
    const config = resolveAdvisorConfig(
      { model: "openai/gpt-6-astra#high", variant: "none" },
      noEnv,
    );
    expect(config.model).toBe("gpt-6-astra");
    expect(config.variant).toBeUndefined();
  });

  test("null or none variant disables the pin", () => {
    expect(resolveAdvisorConfig({ variant: null }, noEnv).variant).toBeUndefined();
    expect(resolveAdvisorConfig({ variant: "none" }, noEnv).variant).toBeUndefined();
  });

  test("clamps timeout and transcript overrides", () => {
    const config = resolveAdvisorConfig(
      { timeoutMs: 60000, maxTranscriptChars: 120000 },
      noEnv,
    );
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxTranscriptChars).toBe(120000);
  });

  test("rejects nonsensical numeric overrides", () => {
    const config = resolveAdvisorConfig(
      { timeoutMs: 0, maxTranscriptChars: -5 },
      noEnv,
    );
    expect(config.timeoutMs).toBe(DEFAULT_ADVISOR_CONFIG.timeoutMs);
    expect(config.maxTranscriptChars).toBe(
      DEFAULT_ADVISOR_CONFIG.maxTranscriptChars,
    );
  });

  test("options take precedence over environment variables", () => {
    const env = {
      OCADVISOR_MODEL: "xai/grok-4.6#xhigh",
      OCADVISOR_TIMEOUT_MS: "90000",
    };
    const fromEnv = resolveAdvisorConfig(undefined, env);
    expect(fromEnv.provider).toBe("xai");
    expect(fromEnv.model).toBe("grok-4.6");
    expect(fromEnv.variant).toBe("xhigh");
    expect(fromEnv.timeoutMs).toBe(90000);

    const overridden = resolveAdvisorConfig({ model: "openai/gpt-6-astra" }, env);
    expect(overridden.provider).toBe("openai");
    expect(overridden.model).toBe("gpt-6-astra");
    // timeout still comes from env since options did not set it
    expect(overridden.timeoutMs).toBe(90000);
  });
});

describe("model helpers honor a custom config", () => {
  const opusConfig: AdvisorConfig = {
    provider: "anthropic",
    model: "claude-opus-5",
    variant: "high",
    timeoutMs: 300000,
    maxTranscriptChars: 0,
  };

  test("findAdvisorModel matches the configured model", () => {
    const opus = { providerID: "anthropic", id: "claude-opus-5" };
    const fable = { providerID: "anthropic", id: "claude-fable-5-1" };
    expect(findAdvisorModel([fable, opus], opusConfig)).toBe(opus);
    expect(findAdvisorModel([fable], opusConfig)).toBeNull();
  });

  test("resolveAdvisorVariant uses the configured variant", () => {
    expect(
      resolveAdvisorVariant({ variants: [{ id: "high" }] }, opusConfig),
    ).toBe("high");
    expect(
      resolveAdvisorVariant({ variants: [{ id: "max" }] }, opusConfig),
    ).toBeUndefined();
    expect(resolveAdvisorVariant(null, opusConfig)).toBe("high");
  });

  test("checkAdvisorSupport reports the configured model when missing", async () => {
    const runtime: V2PluginContext = {
      catalog: {
        provider: { get: async () => ({ data: { activation: "enabled" } }) },
        model: {
          list: async () => ({
            data: [{ providerID: "anthropic", id: "claude-fable-5-1" }],
          }),
        },
      },
    };
    const result = await checkAdvisorSupport(runtime, opusConfig);
    expect(result).toEqual({
      supported: false,
      reason: "Model unavailable: anthropic/claude-opus-5",
    });
  });

  test("ensureAdvisorSession pins the configured model and variant", async () => {
    resetAdvisorSessionCache();
    const calls: string[] = [];
    const runtime: V2PluginContext = {
      session: {
        get: async () => {
          throw new Error("not found");
        },
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "ses_opus1" } }),
        switchModel: async (input: unknown) => {
          calls.push(JSON.stringify(input));
        },
      },
      storage: { get: async () => null, set: async () => {} },
    };
    await ensureAdvisorSession(runtime, "high", opusConfig);
    expect(calls).toContain(
      '{"sessionID":"ses_opus1","model":{"providerID":"anthropic","id":"claude-opus-5","variant":"high"}}',
    );
    resetAdvisorSessionCache();
  });
});
