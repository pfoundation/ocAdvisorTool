import { describe, expect, test } from "bun:test";
import {
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

  test("classifies invalid effort requests", () => {
    expect(
      classifyAdvisorError('Effort "low" is not allowed (allowed: high, max).'),
    ).toBe("invalid_effort");
    expect(
      classifyAdvisorError(
        'Effort "xhigh" is not a variant of anthropic/claude-fable-5-1 (available: high, max).',
      ),
    ).toBe("invalid_effort");
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

  test("resolveAdvisorVariant prefers xhigh when listed", () => {
    expect(resolveAdvisorVariant(null)).toBe("xhigh");
    expect(resolveAdvisorVariant({})).toBe("xhigh");
    expect(resolveAdvisorVariant({ variants: [{ id: "xhigh" }] })).toBe(
      "xhigh",
    );
    expect(
      resolveAdvisorVariant({ variants: [{ id: "high" }] }),
    ).toBeUndefined();
  });

  test("resolveAdvisorVariant honors a requested effort", () => {
    const model = { variants: [{ id: "high" }, { id: "max" }] };
    expect(resolveAdvisorVariant(model, DEFAULT_ADVISOR_CONFIG, "high")).toBe(
      "high",
    );
    // Without catalog data the request cannot be validated, so it passes
    // through to switchModel.
    expect(resolveAdvisorVariant(null, DEFAULT_ADVISOR_CONFIG, "xhigh")).toBe(
      "xhigh",
    );
    expect(resolveAdvisorVariant({}, DEFAULT_ADVISOR_CONFIG, "xhigh")).toBe(
      "xhigh",
    );
  });

  test("resolveAdvisorVariant rejects a requested effort the model lacks", () => {
    expect(() =>
      resolveAdvisorVariant(
        { variants: [{ id: "max" }] },
        DEFAULT_ADVISOR_CONFIG,
        "xhigh",
      ),
    ).toThrow(
      'Effort "xhigh" is not a variant of anthropic/claude-fable-5-1 (available: max).',
    );
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
    variants: [{ id: "xhigh" }],
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
      variant: "xhigh",
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
      variant: "xhigh",
    });
  });

  test("honors a requested effort listed by the catalog", async () => {
    const runtime: V2PluginContext = {
      catalog: {
        provider: { get: async () => ({ data: { activation: "enabled" } }) },
        model: {
          list: async () => ({
            data: [
              { ...fableModel, variants: [{ id: "high" }, { id: "max" }] },
            ],
          }),
        },
      },
      integration: {
        connection: { active: async () => ({ type: "credential", id: "c1" }) },
      },
    };
    await expect(
      checkAdvisorSupport(runtime, DEFAULT_ADVISOR_CONFIG, "high"),
    ).resolves.toEqual({ supported: true, variant: "high" });
  });

  test("rejects a requested effort the catalog lacks", async () => {
    const result = await checkAdvisorSupport(healthy(), undefined, "max");
    expect(result).toEqual({
      supported: false,
      reason:
        'Effort "max" is not a variant of anthropic/claude-fable-5-1 (available: xhigh).',
    });
  });
});

describe("ensureAdvisorSession", () => {
  const fableSession = {
    id: "ses_advisor1",
    title: "advisor",
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
    expect(calls).toContain('create:{"title":"advisor"}');
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

  test("reuses a legacy-titled session from before the rename", async () => {
    resetAdvisorSessionCache();
    const calls: string[] = [];
    const runtime: V2PluginContext = {
      session: {
        get: async () => {
          throw new Error("not found");
        },
        list: async () => ({
          data: [{ ...fableSession, title: "ocAdvisor" }],
        }),
        create: async () => {
          calls.push("create");
          return { data: { id: "ses_other" } };
        },
        switchModel: async () => {
          calls.push("switch");
        },
      },
      storage: { get: async () => null, set: async () => {} },
    };
    await expect(ensureAdvisorSession(runtime, "max")).resolves.toBe(
      "ses_advisor1",
    );
    expect(calls).toEqual([]);
    resetAdvisorSessionCache();
  });

  test("repins a reused session when the requested effort changes", async () => {
    resetAdvisorSessionCache();
    const calls: string[] = [];
    const runtime: V2PluginContext = {
      session: {
        get: async () => ({
          data: {
            ...fableSession,
            id: "ses_effort1",
            model: {
              providerID: "anthropic",
              id: "claude-fable-5-1",
              variant: "max",
            },
          },
        }),
        switchModel: async (input: unknown) => {
          calls.push(`switch:${JSON.stringify(input)}`);
        },
      },
      storage: { get: async () => "ses_effort1", set: async () => {} },
    };
    await expect(ensureAdvisorSession(runtime, "max")).resolves.toBe(
      "ses_effort1",
    );
    expect(calls).toEqual([]);
    await expect(ensureAdvisorSession(runtime, "high")).resolves.toBe(
      "ses_effort1",
    );
    expect(calls).toEqual([
      'switch:{"sessionID":"ses_effort1","model":{"providerID":"anthropic","id":"claude-fable-5-1","variant":"high"}}',
    ]);
    resetAdvisorSessionCache();
  });

  test("falls back to the last pinned variant when the payload omits it", async () => {
    resetAdvisorSessionCache();
    const calls: string[] = [];
    let reported: Record<string, string> = {
      providerID: "anthropic",
      id: "claude-fable-5-1",
      variant: "max",
    };
    const runtime: V2PluginContext = {
      session: {
        get: async () => ({
          data: { ...fableSession, id: "ses_effort2", model: reported },
        }),
        switchModel: async (input: unknown) => {
          calls.push(`switch:${JSON.stringify(input)}`);
        },
      },
      storage: { get: async () => "ses_effort2", set: async () => {} },
    };
    // The reported variant seeds the cache without a switch.
    await expect(ensureAdvisorSession(runtime, "max")).resolves.toBe(
      "ses_effort2",
    );
    expect(calls).toEqual([]);
    // Payloads that omit the variant compare against the cached pin.
    reported = { providerID: "anthropic", id: "claude-fable-5-1" };
    await expect(ensureAdvisorSession(runtime, "max")).resolves.toBe(
      "ses_effort2",
    );
    expect(calls).toEqual([]);
    await expect(ensureAdvisorSession(runtime, "high")).resolves.toBe(
      "ses_effort2",
    );
    expect(calls).toEqual([
      'switch:{"sessionID":"ses_effort2","model":{"providerID":"anthropic","id":"claude-fable-5-1","variant":"high"}}',
    ]);
    resetAdvisorSessionCache();
  });
});

describe("checkpoint guidance", () => {
  test("tool description names the modes and the one-call policy", () => {
    expect(TOOL_DESCRIPTION).toContain('"plan"');
    expect(TOOL_DESCRIPTION).toContain('"debug"');
    expect(TOOL_DESCRIPTION).toContain('"review"');
    expect(TOOL_DESCRIPTION).toContain("AT MOST ONE");
    expect(TOOL_DESCRIPTION).toContain("followup");
    expect(TOOL_DESCRIPTION).not.toContain("ocAdvisor");
  });

  test("injected instruction stays short", () => {
    expect(CHECKPOINT_INSTRUCTION.length).toBeLessThan(600);
    expect(CHECKPOINT_INSTRUCTION).toContain("advisor");
    expect(CHECKPOINT_INSTRUCTION).toContain("review");
    expect(CHECKPOINT_INSTRUCTION).not.toContain("ocAdvisor");
  });
});

describe("isAdvisorToolName", () => {
  test("matches the current and legacy tool names", () => {
    expect(isAdvisorToolName("advisor")).toBe(true);
    expect(isAdvisorToolName("ocAdvisor")).toBe(true);
    expect(isAdvisorToolName("ocadvisor")).toBe(true);
    expect(isAdvisorToolName("read")).toBe(false);
    expect(isAdvisorToolName("execute")).toBe(false);
    expect(isAdvisorToolName(null)).toBe(false);
    expect(isAdvisorToolName(undefined)).toBe(false);
  });
});

describe("tool registration", () => {
  test("registers advisor as a direct tool outside Code Mode", async () => {
    const added: Array<Record<string, unknown>> = [];
    const ctx: V2PluginContext = {
      tool: {
        transform: async (
          fn: (draft: { add: (tool: unknown) => void }) => void,
        ) => {
          fn({ add: (tool) => added.push(tool as Record<string, unknown>) });
          return { dispose: () => {} };
        },
      },
    };
    await setupOcAdvisorV2(ctx);
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe("advisor");
    // OpenCode 2 exposes a tool to the model directly only with
    // `codemode: false`; otherwise it is reachable only via `execute`,
    // whose tool log shows the call's input but never the answer.
    expect(added[0].options).toEqual({ codemode: false });
    expect(typeof added[0].execute).toBe("function");
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

  test("keeps the tool and injects a typed text system part for non-Fable models", async () => {
    const handler = await captureHook();
    const tool = { description: "x", input: {} };
    const event = {
      model: { providerID: "xai", id: "grok-4.6" },
      tools: { advisor: tool } as Record<string, unknown>,
      system: [{ type: "text", text: "base prompt" }],
    };
    handler(event);
    // The registered definition must survive untouched: OpenCode maps hook
    // entries back to registered tools and drops ones it cannot match.
    expect(event.tools.advisor).toBe(tool);
    expect(event.system).toHaveLength(2);
    // The 2.0 server validates system parts as { type: "text", text };
    // a part without `type` fails the request schema and kills the session.
    expect(event.system[1]).toEqual({
      type: "text",
      text: CHECKPOINT_INSTRUCTION,
    });
  });

  test("injects nothing when the tool is not available to the request", async () => {
    const handler = await captureHook();
    const event = {
      model: { providerID: "xai", id: "grok-4.6" },
      tools: {} as Record<string, unknown>,
      system: [{ type: "text", text: "base prompt" }],
    };
    handler(event);
    // A hook cannot add a direct tool; OpenCode drops unregistered entries.
    expect(event.tools).toEqual({});
    expect(event.system).toHaveLength(1);
  });

  test("hides the tool and injects nothing for Fable models", async () => {
    const handler = await captureHook();
    const event = {
      model: { providerID: "anthropic", id: "claude-fable-5-1" },
      tools: {
        advisor: { description: "x", input: {} },
        ocAdvisor: { description: "legacy", input: {} },
      } as Record<string, unknown>,
      system: [{ type: "text", text: "base prompt" }],
    };
    handler(event);
    expect(event.tools.advisor).toBeUndefined();
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

  test("defaults to anthropic/claude-fable-5-1#xhigh", () => {
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
    expect(
      resolveAdvisorConfig({ variant: null }, noEnv).variant,
    ).toBeUndefined();
    expect(
      resolveAdvisorConfig({ variant: "none" }, noEnv).variant,
    ).toBeUndefined();
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

    const overridden = resolveAdvisorConfig(
      { model: "openai/gpt-6-astra" },
      env,
    );
    expect(overridden.provider).toBe("openai");
    expect(overridden.model).toBe("gpt-6-astra");
    // timeout still comes from env since options did not set it
    expect(overridden.timeoutMs).toBe(90000);
  });

  test("agentEffort defaults to disabled", () => {
    expect(resolveAdvisorConfig(undefined, noEnv).agentEffort).toBeNull();
  });

  test("agentEffort true enables the default levels", () => {
    expect(
      resolveAdvisorConfig({ agentEffort: true }, noEnv).agentEffort,
    ).toEqual(["high", "xhigh", "max"]);
  });

  test("agentEffort false, null, or none disables the feature", () => {
    expect(
      resolveAdvisorConfig({ agentEffort: false }, noEnv).agentEffort,
    ).toBeNull();
    expect(
      resolveAdvisorConfig({ agentEffort: null }, noEnv).agentEffort,
    ).toBeNull();
    expect(
      resolveAdvisorConfig({ agentEffort: "none" }, noEnv).agentEffort,
    ).toBeNull();
  });

  test("agentEffort accepts an explicit list or comma string", () => {
    expect(
      resolveAdvisorConfig({ agentEffort: ["high", "max"] }, noEnv).agentEffort,
    ).toEqual(["high", "max"]);
    expect(
      resolveAdvisorConfig({ agentEffort: "high, xhigh" }, noEnv).agentEffort,
    ).toEqual(["high", "xhigh"]);
    expect(
      resolveAdvisorConfig({ agent_effort: "high" }, noEnv).agentEffort,
    ).toEqual(["high"]);
  });

  test("agentEffort trims, dedupes, and drops empties", () => {
    expect(
      resolveAdvisorConfig(
        { agentEffort: [" high ", "", "high", "max"] },
        noEnv,
      ).agentEffort,
    ).toEqual(["high", "max"]);
  });

  test("agentEffort reads from the environment with options winning", () => {
    expect(
      resolveAdvisorConfig(undefined, { OCADVISOR_AGENT_EFFORT: "true" })
        .agentEffort,
    ).toEqual(["high", "xhigh", "max"]);
    expect(
      resolveAdvisorConfig(
        { agentEffort: false },
        { OCADVISOR_AGENT_EFFORT: "true" },
      ).agentEffort,
    ).toBeNull();
  });
});

describe("resolveRequestedEffort", () => {
  const effortConfig: AdvisorConfig = {
    ...DEFAULT_ADVISOR_CONFIG,
    agentEffort: ["high", "xhigh", "max"],
  };

  test("passes allowed efforts through", () => {
    expect(resolveRequestedEffort(effortConfig, "high")).toBe("high");
    expect(resolveRequestedEffort(effortConfig, " xhigh ")).toBe("xhigh");
  });

  test("treats missing or blank effort as omitted", () => {
    expect(resolveRequestedEffort(effortConfig, undefined)).toBeUndefined();
    expect(resolveRequestedEffort(effortConfig, null)).toBeUndefined();
    expect(resolveRequestedEffort(effortConfig, "  ")).toBeUndefined();
  });

  test("rejects efforts outside the allow-list", () => {
    expect(() => resolveRequestedEffort(effortConfig, "low")).toThrow(
      'Effort "low" is not allowed (allowed: high, xhigh, max).',
    );
  });

  test("ignores effort when the feature is disabled", () => {
    expect(
      resolveRequestedEffort(DEFAULT_ADVISOR_CONFIG, "high"),
    ).toBeUndefined();
  });
});

describe("agent effort tool surface", () => {
  test("hides effort when disabled", () => {
    const schema = buildAdvisorInputSchema(DEFAULT_ADVISOR_CONFIG) as {
      properties: Record<string, unknown>;
    };
    expect("effort" in schema.properties).toBe(false);
    expect(buildToolDescription(DEFAULT_ADVISOR_CONFIG)).toBe(TOOL_DESCRIPTION);
  });

  test("advertises the allowed efforts when enabled", () => {
    const config: AdvisorConfig = {
      ...DEFAULT_ADVISOR_CONFIG,
      agentEffort: ["high", "max"],
    };
    const schema = buildAdvisorInputSchema(config) as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.properties.effort.enum).toEqual(["high", "max"]);
    const description = buildToolDescription(config);
    expect(description).toContain('"effort"');
    expect(description).toContain("high, max");
  });

  test("registration uses the configured tool surface", async () => {
    const added: Array<Record<string, unknown>> = [];
    const ctx = {
      options: { agentEffort: true },
      tool: {
        transform: async (
          fn: (draft: { add: (tool: unknown) => void }) => void,
        ) => {
          fn({ add: (tool) => added.push(tool as Record<string, unknown>) });
          return { dispose: () => {} };
        },
      },
    } as unknown as V2PluginContext;
    await setupOcAdvisorV2(ctx);
    expect(added).toHaveLength(1);
    const input = added[0].input as {
      properties: Record<string, unknown>;
    };
    expect("effort" in input.properties).toBe(true);
    expect(String(added[0].description)).toContain('"effort"');
  });
});

describe("model helpers honor a custom config", () => {
  const opusConfig: AdvisorConfig = {
    provider: "anthropic",
    model: "claude-opus-5",
    variant: "high",
    timeoutMs: 300000,
    maxTranscriptChars: 0,
    agentEffort: null,
    typesafeSource: { disabled: false, overrides: {} },
    typesafe: { enabled: false, settings: null, keyPresent: false },
    typesafeSettings: null,
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
