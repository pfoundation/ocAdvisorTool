// OpenCode 2.4 keeps assistant blocks in session_part and leaves
// session_message.data.content empty. Fixture rows mirror that layout as
// recorded by a live 2.4 server.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { queryAdvisorHistory } from "./advisorHistory";
import { resolveRequesterProfile } from "./modelProfiles";
import {
  formatV2Message,
  resetAdvisorSessionCache,
  resolveAdvisorConfig,
  runAdvisor,
  type V2PluginContext,
} from "./ocAdvisor";
import {
  loadMessageParts,
  loadSessionParts,
  loadToolNamesInWindow,
  loadToolPartsInWindow,
  withPartContent,
} from "./sessionParts";
import { TYPESAFE_DEFAULTS, buildDecisionState } from "./typesafeState";

let dir: string;
let dbPath: string;

const ASSISTANT = {
  agent: "build",
  model: { id: "claude-opus-5-5", providerID: "anthropic", variant: "xhigh" },
  content: [],
  finish: "tool-calls",
};

function createSchema(db: Database, withParts = true): void {
  db.run(
    "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT)",
  );
  db.run(
    "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)",
  );
  if (withParts) {
    db.run(
      "CREATE TABLE session_part (message_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, type TEXT NOT NULL, call_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (message_id, ordinal))",
    );
  }
}

function insertMessage(
  db: Database,
  row: {
    id: string;
    session: string;
    type: string;
    seq: number;
    data: unknown;
  },
): void {
  db.query(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?,?,?,?,?,?)",
  ).run(
    row.id,
    row.session,
    row.type,
    row.seq,
    1_000 + row.seq,
    JSON.stringify(row.data),
  );
}

function insertPart(
  db: Database,
  row: {
    message: string;
    session: string;
    ordinal: number;
    data: Record<string, unknown>;
  },
): void {
  db.query(
    "INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    row.message,
    row.session,
    row.ordinal,
    String(row.data.type),
    typeof row.data.id === "string" ? row.data.id : null,
    1_000,
    1_000,
    JSON.stringify(row.data),
  );
}

function writeFixture(options: { withParts?: boolean } = {}): void {
  const withParts = options.withParts ?? true;
  const db = new Database(dbPath);
  createSchema(db, withParts);
  db.query(
    "INSERT INTO session_v2 (id, parent_id, title, model, agent, directory) VALUES (?,?,?,?,?,?)",
  ).run(
    "ses_v24",
    null,
    "Fixture",
    JSON.stringify({ providerID: "anthropic", id: "claude-opus-5-5" }),
    "build",
    dir,
  );
  insertMessage(db, {
    id: "msg_user",
    session: "ses_v24",
    type: "user",
    seq: 1,
    data: { text: "Fix the advisor directory error" },
  });
  insertMessage(db, {
    id: "msg_a1",
    session: "ses_v24",
    type: "assistant",
    seq: 2,
    data: ASSISTANT,
  });
  insertMessage(db, {
    id: "msg_a2",
    session: "ses_v24",
    type: "assistant",
    seq: 3,
    data: ASSISTANT,
  });
  if (withParts) {
    // Inserted out of ordinal order: readers must sort.
    insertPart(db, {
      message: "msg_a1",
      session: "ses_v24",
      ordinal: 1,
      data: { type: "text", text: "Reproducing the failure first." },
    });
    insertPart(db, {
      message: "msg_a1",
      session: "ses_v24",
      ordinal: 0,
      data: {
        type: "reasoning",
        text: "private thinking",
        native: { signature: "x" },
      },
    });
    insertPart(db, {
      message: "msg_a1",
      session: "ses_v24",
      ordinal: 2,
      data: {
        type: "tool",
        id: "toolu_shell1",
        name: "shell",
        executed: false,
        state: {
          status: "completed",
          input: { command: "git status" },
          content: [
            { type: "text", text: "On branch master\nnothing to commit" },
          ],
        },
      },
    });
    insertPart(db, {
      message: "msg_a2",
      session: "ses_v24",
      ordinal: 0,
      data: {
        type: "tool",
        id: "toolu_adv1",
        name: "advisor",
        executed: false,
        state: {
          status: "error",
          input: { mode: "debug", question: "Why does it fail?" },
          error: {
            type: "unknown",
            message: "advisor failed (api_error): Directory not found: /gone",
          },
        },
      },
    });
  }
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocadvisor-parts-"));
  dbPath = join(dir, "opencode.db");
  resetAdvisorSessionCache();
});

afterEach(() => {
  resetAdvisorSessionCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("session part helpers", () => {
  test("groups a session's parts by message in ordinal order, without reasoning", () => {
    writeFixture();
    const db = new Database(dbPath, { readonly: true });
    try {
      const parts = loadSessionParts(db, "ses_v24");
      expect(parts.get("msg_a1")?.map((part) => part.type)).toEqual([
        "text",
        "tool",
      ]);
      expect(parts.get("msg_a2")).toHaveLength(1);
      const tools = loadSessionParts(db, "ses_v24", { toolsOnly: true });
      expect(tools.get("msg_a1")?.map((part) => part.id)).toEqual([
        "toolu_shell1",
      ]);
      expect(loadMessageParts(db, "msg_a1", { toolsOnly: true })).toHaveLength(
        1,
      );
    } finally {
      db.close();
    }
  });

  test("lists tool names in a window without loading tool output", () => {
    writeFixture();
    const db = new Database(dbPath, { readonly: true });
    try {
      const names = loadToolNamesInWindow(db, 0, 10_000);
      expect(names.get("msg_a1")).toEqual([{ type: "tool", name: "shell" }]);
      expect(names.get("msg_a2")).toEqual([{ type: "tool", name: "advisor" }]);
    } finally {
      db.close();
    }
  });

  test("returns nothing on databases without session_part", () => {
    writeFixture({ withParts: false });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(loadSessionParts(db, "ses_v24").size).toBe(0);
      expect(loadToolPartsInWindow(db, 0, 10_000).size).toBe(0);
    } finally {
      db.close();
    }
  });

  test("loads only tool parts of assistant messages inside the window", () => {
    writeFixture();
    const db = new Database(dbPath, { readonly: true });
    try {
      const all = loadToolPartsInWindow(db, 0, 10_000);
      expect([...all.keys()].sort()).toEqual(["msg_a1", "msg_a2"]);
      expect(all.get("msg_a1")?.map((part) => part.type)).toEqual(["tool"]);
      const advisorOnly = loadToolPartsInWindow(db, 0, 10_000, "advisor");
      expect([...advisorOnly.keys()]).toEqual(["msg_a2"]);
      // msg_a1 is created at 1002, msg_a2 at 1003.
      expect([...loadToolPartsInWindow(db, 1_003, 10_000).keys()]).toEqual([
        "msg_a2",
      ]);
    } finally {
      db.close();
    }
  });

  test("prefers inline content and fills only empty content", () => {
    const inline = { content: [{ type: "text", text: "inline" }] };
    const parts = [{ type: "text", text: "from parts" }];
    expect(withPartContent(inline, parts)).toBe(inline);
    expect(withPartContent({ content: [] }, parts).content).toEqual(parts);
    expect(withPartContent({}, parts).content).toEqual(parts);
    const empty = { content: [] };
    expect(withPartContent(empty, undefined)).toBe(empty);
  });
});

describe("advisor history on OpenCode 2.4 storage", () => {
  test("finds advisor calls stored as parts and classifies thrown failures", () => {
    writeFixture();
    const db = new Database(dbPath, { readonly: true });
    try {
      const history = queryAdvisorHistory(db, 0, 10_000);
      expect(history.calls).toEqual([
        {
          callId: "toolu_adv1",
          sessionId: "ses_v24",
          timeUtc: new Date(1_003).toISOString(),
          mode: "debug",
          questionChars: "Why does it fail?".length,
          generation: "error",
          caller: "error",
          hadOutput: false,
        },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("gate state and requester on OpenCode 2.4 storage", () => {
  test("the gate sees assistant content stored as parts", () => {
    writeFixture();
    const db = new Database(dbPath, { readonly: true });
    try {
      const state = buildDecisionState(db, "ses_v24", {
        question: "Review",
        mode: "review",
        trigger: "pre_complete",
        explicitEffort: null,
        caller: null,
        directory: dir,
        priorConsultations: 0,
        priorModes: [],
        supportedEfforts: ["high", "xhigh", "max"],
        defaultEffort: "xhigh",
        maxStateBytes: TYPESAFE_DEFAULTS.maxStateBytes,
        formatMessage: formatV2Message,
      } as Parameters<typeof buildDecisionState>[2]);
      const joined = state.context.messages.join("\n");
      expect(joined).toContain("Reproducing the failure first.");
      expect(joined).toContain("[Tool: shell] (completed)");
    } finally {
      db.close();
    }
  });

  test("matches the invoking call id against parts", () => {
    writeFixture();
    const db = new Database(dbPath, { readonly: true });
    try {
      const matched = resolveRequesterProfile(db, {
        sessionId: "ses_v24",
        messageID: "msg_a1",
        callID: "toolu_shell1",
      });
      expect(matched.provenance).toBe("invocation_message");
      // A call id that is not in the message's parts falls through to the
      // latest assistant message instead of trusting the wrong message.
      const mismatched = resolveRequesterProfile(db, {
        sessionId: "ses_v24",
        messageID: "msg_a1",
        callID: "toolu_elsewhere",
      });
      expect(mismatched.provenance).toBe("latest_message");
    } finally {
      db.close();
    }
  });
});

describe("advisor transcript on OpenCode 2.4 storage", () => {
  function captureRuntime(prompts: string[]): V2PluginContext {
    return {
      session: {
        get: async () => ({
          id: "ses_advisor",
          model: {
            providerID: "anthropic",
            id: "claude-fable-5-2",
            variant: "xhigh",
          },
        }),
        switchModel: async () => {},
        generate: async (request: { prompt: string }) => {
          prompts.push(request.prompt);
          return { text: "advice" };
        },
      },
      storage: { get: async () => "ses_advisor", set: async () => {} },
      __advisorTest: {
        dbPath,
        metricsPath: join(dir, "metrics.jsonl"),
        sessionDirectory: join(dir, "advisor-session"),
      },
    };
  }

  test("includes assistant text and tool calls stored as parts", async () => {
    writeFixture();
    const prompts: string[] = [];
    const text = await runAdvisor({
      runtime: captureRuntime(prompts),
      sessionId: "ses_v24",
      mode: "review",
      question: "Review the fix",
      config: resolveAdvisorConfig({ typesafe: false }),
    });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt).toContain("## Assistant (agent: build) [claude-opus-5-5]");
    expect(prompt).toContain("Reproducing the failure first.");
    expect(prompt).toContain("[Tool: shell] (completed)");
    expect(prompt).toContain("Output: On branch master\nnothing to commit");
    expect(prompt).toContain(
      "Error: advisor failed (api_error): Directory not found: /gone",
    );
    expect(prompt).not.toContain("private thinking");
    expect(prompt).not.toContain("[object Object]");
    expect(prompt).not.toContain("Transcript incomplete");
    // The failed advisor call is a prior consultation in this chain.
    expect(prompt).toContain("already has 1 recorded advisor consultation(s)");
    expect(text).toContain("advisor consultation #2");
  });

  test("flags a transcript whose assistant content cannot be read", async () => {
    writeFixture({ withParts: false });
    const prompts: string[] = [];
    await runAdvisor({
      runtime: captureRuntime(prompts),
      sessionId: "ses_v24",
      mode: "general",
      question: "Anything",
      config: resolveAdvisorConfig({ typesafe: false }),
    });
    expect(prompts[0]).toContain(
      "[Transcript incomplete: none of this session's 2 assistant messages could be read.",
    );
  });
});
