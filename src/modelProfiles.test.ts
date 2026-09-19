import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  resolveAdvisorProfile,
  resolveRequesterProfile,
} from "./modelProfiles";

function openFixtureDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
  );
  return db;
}

function addMessage(
  db: InstanceType<typeof Database>,
  row: {
    id?: string | null;
    sessionId: string;
    type: string;
    seq: number;
    data: Record<string, unknown>;
  },
): void {
  db.query(
    "INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?,?,?,?,?)",
  ).run(
    row.id ?? null,
    row.sessionId,
    row.type,
    row.seq,
    JSON.stringify(row.data),
  );
}

function assistantData(
  model: Record<string, unknown>,
  toolBlocks: Array<{ id: string; name: string }> = [],
): Record<string, unknown> {
  return {
    agent: "build",
    model,
    content: toolBlocks.map((block) => ({
      type: "tool",
      id: block.id,
      name: block.name,
      state: { status: "running", input: {} },
    })),
  };
}

describe("resolveRequesterProfile", () => {
  test("resolves the originating message by its identifier", () => {
    const db = openFixtureDb();
    addMessage(db, {
      id: "msg_origin",
      sessionId: "ses_child",
      type: "assistant",
      seq: 10,
      data: assistantData(
        { providerID: "openai", id: "gpt-6-astra", variant: "xhigh" },
        [{ id: "call_1", name: "advisor" }],
      ),
    });

    const profile = resolveRequesterProfile(db, {
      sessionId: "ses_child",
      messageID: "msg_origin",
      callID: "call_1",
      sessionModel: {
        providerID: "meta",
        id: "muse-spark-1.3",
        variant: "max",
      },
    });
    expect(profile).toEqual({
      providerID: "openai",
      modelID: "gpt-6-astra",
      variant: "xhigh",
      provenance: "invocation_message",
    });
  });

  test("ignores a stale session row when the message identifies the turn", () => {
    const db = openFixtureDb();
    addMessage(db, {
      id: "msg_origin",
      sessionId: "ses_main",
      type: "assistant",
      seq: 10,
      data: assistantData({ providerID: "xai", id: "grok-4.6" }),
    });

    // The session row already points at a newer model after a switch.
    const profile = resolveRequesterProfile(db, {
      sessionId: "ses_main",
      messageID: "msg_origin",
      sessionModel: {
        providerID: "openai",
        id: "gpt-6-astra",
        variant: "xhigh",
      },
    });
    expect(profile.providerID).toBe("xai");
    expect(profile.modelID).toBe("grok-4.6");
    expect(profile.variant).toBeNull();
    expect(profile.provenance).toBe("invocation_message");
  });

  test("falls through when the call identifier does not match", () => {
    const db = openFixtureDb();
    addMessage(db, {
      id: "msg_origin",
      sessionId: "ses_main",
      type: "assistant",
      seq: 10,
      data: assistantData({ providerID: "xai", id: "grok-4.6" }, [
        { id: "call_1", name: "advisor" },
      ]),
    });
    addMessage(db, {
      id: "msg_latest",
      sessionId: "ses_main",
      type: "assistant",
      seq: 11,
      data: assistantData({ providerID: "openai", id: "gpt-6-astra" }),
    });

    const profile = resolveRequesterProfile(db, {
      sessionId: "ses_main",
      messageID: "msg_origin",
      callID: "call_zzz",
      sessionModel: null,
    });
    expect(profile.providerID).toBe("openai");
    expect(profile.provenance).toBe("latest_message");
  });

  test("falls back to the latest assistant message without identifiers", () => {
    const db = openFixtureDb();
    addMessage(db, {
      id: "msg_old",
      sessionId: "ses_main",
      type: "assistant",
      seq: 10,
      data: assistantData({ providerID: "xai", id: "grok-4.6" }),
    });
    addMessage(db, {
      id: "msg_new",
      sessionId: "ses_main",
      type: "assistant",
      seq: 11,
      data: assistantData({
        providerID: "openai",
        id: "gpt-6-astra",
        variant: "max",
      }),
    });

    const profile = resolveRequesterProfile(db, {
      sessionId: "ses_main",
      sessionModel: null,
    });
    expect(profile).toEqual({
      providerID: "openai",
      modelID: "gpt-6-astra",
      variant: "max",
      provenance: "latest_message",
    });
  });

  test("skips assistant messages without a usable model", () => {
    const db = openFixtureDb();
    addMessage(db, {
      id: "msg_old",
      sessionId: "ses_main",
      type: "assistant",
      seq: 10,
      data: assistantData({ providerID: "openai", id: "gpt-6-astra" }),
    });
    addMessage(db, {
      id: "msg_new",
      sessionId: "ses_main",
      type: "assistant",
      seq: 11,
      data: { agent: "build", model: {}, content: [] },
    });

    const profile = resolveRequesterProfile(db, { sessionId: "ses_main" });
    expect(profile.modelID).toBe("gpt-6-astra");
    expect(profile.provenance).toBe("latest_message");
  });

  test("never reads the parent chain for a subagent call", () => {
    const db = openFixtureDb();
    addMessage(db, {
      id: "msg_parent",
      sessionId: "ses_parent",
      type: "assistant",
      seq: 50,
      data: assistantData({ providerID: "openai", id: "gpt-6-astra" }),
    });
    addMessage(db, {
      id: "msg_child",
      sessionId: "ses_child",
      type: "assistant",
      seq: 3,
      data: assistantData({ providerID: "meta", id: "muse-spark-1.3" }),
    });

    const profile = resolveRequesterProfile(db, { sessionId: "ses_child" });
    expect(profile.providerID).toBe("meta");
    expect(profile.provenance).toBe("latest_message");
  });

  test("scopes message identifiers to the calling session", () => {
    const db = openFixtureDb();
    addMessage(db, {
      id: "msg_shared",
      sessionId: "ses_other",
      type: "assistant",
      seq: 1,
      data: assistantData({ providerID: "openai", id: "gpt-6-astra" }),
    });
    addMessage(db, {
      id: "msg_mine",
      sessionId: "ses_main",
      type: "assistant",
      seq: 1,
      data: assistantData({ providerID: "meta", id: "muse-spark-1.3" }),
    });

    const profile = resolveRequesterProfile(db, {
      sessionId: "ses_main",
      messageID: "msg_shared",
    });
    expect(profile.providerID).toBe("meta");
    expect(profile.provenance).toBe("latest_message");
  });

  test("preserves complete gateway model IDs", () => {
    const db = openFixtureDb();
    addMessage(db, {
      id: "msg_origin",
      sessionId: "ses_main",
      type: "assistant",
      seq: 10,
      data: assistantData({
        providerID: "openrouter",
        id: "openai/gpt-6-astra",
        variant: "high",
      }),
    });

    const profile = resolveRequesterProfile(db, {
      sessionId: "ses_main",
      messageID: "msg_origin",
    });
    expect(profile.providerID).toBe("openrouter");
    expect(profile.modelID).toBe("openai/gpt-6-astra");
  });

  test("reads alternate provider and model field names", () => {
    const db = openFixtureDb();
    addMessage(db, {
      id: "msg_origin",
      sessionId: "ses_main",
      type: "assistant",
      seq: 10,
      data: assistantData({ provider: "acme", modelID: "reasoner-1" }),
    });

    const profile = resolveRequesterProfile(db, {
      sessionId: "ses_main",
      messageID: "msg_origin",
    });
    expect(profile.providerID).toBe("acme");
    expect(profile.modelID).toBe("reasoner-1");
  });

  test("falls back to the labeled session model", () => {
    const db = openFixtureDb();
    const profile = resolveRequesterProfile(db, {
      sessionId: "ses_main",
      sessionModel: {
        providerID: "meta",
        id: "muse-spark-1.3",
        variant: "max",
      },
    });
    expect(profile).toEqual({
      providerID: "meta",
      modelID: "muse-spark-1.3",
      variant: "max",
      provenance: "session_fallback",
    });
  });

  test("reports unknown when nothing identifies the requester", () => {
    const db = openFixtureDb();
    addMessage(db, {
      sessionId: "ses_main",
      type: "user",
      seq: 1,
      data: { text: "hello" },
    });
    expect(
      resolveRequesterProfile(db, {
        sessionId: "ses_main",
        sessionModel: null,
      }),
    ).toEqual({
      providerID: null,
      modelID: null,
      variant: null,
      provenance: "unknown",
    });
    expect(
      resolveRequesterProfile(db, {
        sessionId: "ses_missing",
        sessionModel: { providerID: "", id: "" },
      }).provenance,
    ).toBe("unknown");
  });

  test("survives malformed message rows without throwing", () => {
    const db = openFixtureDb();
    db.query(
      "INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?,?,?,?,?)",
    ).run("msg_bad", "ses_main", "assistant", 10, "not-json{{{");
    const profile = resolveRequesterProfile(db, {
      sessionId: "ses_main",
      messageID: "msg_bad",
      sessionModel: { providerID: "meta", id: "muse-spark-1.3" },
    });
    expect(profile.provenance).toBe("session_fallback");
    expect(profile.modelID).toBe("muse-spark-1.3");
  });
});

describe("resolveAdvisorProfile", () => {
  test("pins an explicit caller effort over candidates", () => {
    expect(
      resolveAdvisorProfile({
        providerID: "anthropic",
        modelID: "claude-fable-5-1",
        requestedEffort: "max",
        supportedEfforts: ["high", "xhigh"],
        defaultEffort: "xhigh",
      }),
    ).toEqual({
      providerID: "anthropic",
      modelID: "claude-fable-5-1",
      policy: { kind: "pinned", effort: "max" },
    });
  });

  test("exposes gate-selectable candidates with their fallback", () => {
    const candidates = ["high", "xhigh", "max"];
    const profile = resolveAdvisorProfile({
      providerID: "anthropic",
      modelID: "claude-fable-5-1",
      supportedEfforts: candidates,
      defaultEffort: "xhigh",
    });
    expect(profile.policy).toEqual({
      kind: "candidates",
      candidates: ["high", "xhigh", "max"],
      fallback: "xhigh",
    });
    expect(profile.policy.kind).toBe("candidates");
    if (profile.policy.kind === "candidates") {
      expect(profile.policy.candidates).not.toBe(candidates);
    }
  });

  test("fixes the effort when selection is unavailable", () => {
    expect(
      resolveAdvisorProfile({
        providerID: "anthropic",
        modelID: "claude-fable-5-1",
        supportedEfforts: [],
        defaultEffort: "xhigh",
      }).policy,
    ).toEqual({ kind: "fixed", effort: "xhigh" });
    expect(
      resolveAdvisorProfile({
        providerID: "anthropic",
        modelID: "claude-fable-5-1",
        supportedEfforts: [],
        defaultEffort: null,
      }).policy,
    ).toEqual({ kind: "fixed", effort: null });
  });
});
