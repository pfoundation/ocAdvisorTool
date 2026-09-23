import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  countCallers,
  countGenerations,
  isAdvisorToolName,
  isDisabledNotice,
  isFailureFooter,
  isSelfConsultNotice,
  isSkipNotice,
  queryAdvisorHistory,
  sessionsWithAdvice,
} from "./advisorHistory";

function openFixtureDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)",
  );
  return db;
}

function addAssistant(
  db: InstanceType<typeof Database>,
  id: string,
  sessionId: string,
  timeCreated: number,
  content: unknown[],
): void {
  db.query(
    "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?,?,?,?,?)",
  ).run(id, sessionId, "assistant", timeCreated, JSON.stringify({ content }));
}

const START = 1_780_000_000_000;
const END = START + 86_400_000;

function toolBlock(
  id: string,
  state: Record<string, unknown>,
): Record<string, unknown> {
  return { type: "tool", id, name: "advisor", state };
}

describe("classification helpers", () => {
  test("recognizes advisor tool names and history markers", () => {
    expect(isAdvisorToolName("advisor")).toBe(true);
    expect(isAdvisorToolName("ocAdvisor")).toBe(true);
    expect(isAdvisorToolName("advisor_extra")).toBe(false);
    expect(
      isDisabledNotice("advisor is disabled for anthropic/claude-fable"),
    ).toBe(true);
    expect(
      isSelfConsultNotice(
        "advisor is disabled: the current model is already the advisor model (anthropic/claude-opus-5-5).",
      ),
    ).toBe(true);
    expect(
      isSelfConsultNotice("advisor is disabled for anthropic/claude-fable"),
    ).toBe(false);
    expect(isSkipNotice("advisor consultation skipped (typesafe): ...")).toBe(
      true,
    );
    expect(isSkipNotice("ocAdvisor consultation skipped")).toBe(false);
    expect(isFailureFooter("advisor failed (timeout): ...")).toBe(true);
    expect(isFailureFooter("## Advisor response")).toBe(false);
  });
});

describe("queryAdvisorHistory", () => {
  test("reads direct calls with generated advice", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_1", {
        status: "completed",
        input: { mode: "plan", question: "Should we gate?" },
        content: [{ type: "text", text: "## Advisor response\nadvice" }],
        time: { ran: START + 2000 },
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls.length).toBe(1);
    expect(history.calls[0].generation).toBe("advisor_response");
    expect(history.calls[0].caller).toBe("completed");
    expect(history.calls[0].mode).toBe("plan");
    expect(history.calls[0].questionChars).toBe(15);
    expect(countGenerations(history.calls)).toEqual({ advisor_response: 1 });
    expect(sessionsWithAdvice(history.calls).has("ses_a")).toBe(true);
  });

  test("keeps generated advice distinct from an interrupted caller", () => {
    const db = openFixtureDb();
    // The plugin finished generating, but the calling tool was interrupted.
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_1", {
        status: "error",
        input: { mode: "review" },
        content: [{ type: "text", text: "## Advisor response\nlate advice" }],
        time: { ran: START + 1000 },
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls[0].generation).toBe("advisor_response");
    expect(history.calls[0].caller).toBe("error");
    expect(countCallers(history.calls)).toEqual({ error: 1 });
  });

  test("classifies Fable and TypeSafe skips without counting them as advice", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_1", {
        status: "completed",
        input: { mode: "general" },
        content: [
          {
            type: "text",
            text: "advisor is disabled for anthropic/claude-fable-* sessions — the current model is already Fable.",
          },
        ],
        time: { ran: START + 1000 },
      }),
    ]);
    addAssistant(db, "msg_2", "ses_b", START + 2000, [
      toolBlock("call_2", {
        status: "completed",
        input: { mode: "plan" },
        content: [
          {
            type: "text",
            text: "advisor consultation skipped (typesafe): the request did not need an advisor at this point (need probability 0.05).",
          },
        ],
        time: { ran: START + 2000 },
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(countGenerations(history.calls)).toEqual({
      skipped_fable: 1,
      skipped_typesafe: 1,
    });
    expect(sessionsWithAdvice(history.calls).size).toBe(0);
  });

  test("classifies self-consultation notices apart from legacy Fable skips", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_1", {
        status: "completed",
        input: { mode: "general" },
        content: [
          {
            type: "text",
            text: "advisor is disabled: the current model is already the advisor model (anthropic/claude-opus-5-5).",
          },
        ],
        time: { ran: START + 1000 },
      }),
    ]);
    addAssistant(db, "msg_2", "ses_b", START + 2000, [
      toolBlock("call_2", {
        status: "completed",
        input: { mode: "general" },
        content: [
          {
            type: "text",
            text: "advisor is disabled for anthropic/claude-fable-* sessions — the current model is already Fable.",
          },
        ],
        time: { ran: START + 2000 },
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(countGenerations(history.calls)).toEqual({
      skipped_self: 1,
      skipped_fable: 1,
    });
    expect(sessionsWithAdvice(history.calls).size).toBe(0);
  });

  test("classifies model opt-out notices separately from Fable skips", () => {
    const notice =
      "advisor is disabled (model opt-out): openai/gpt-6-astra is listed in disabledForModels.";
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_1", {
        status: "completed",
        input: { mode: "general" },
        content: [{ type: "text", text: notice }],
        time: { ran: START + 1000 },
      }),
    ]);
    addAssistant(db, "msg_2", "ses_b", START + 2000, [
      {
        type: "tool",
        id: "call_nested",
        name: "execute",
        state: {
          status: "completed",
          metadata: {
            toolCalls: [
              {
                tool: "ocAdvisor",
                input: { mode: "plan", question: "Should we?" },
                output: notice,
              },
            ],
          },
        },
      },
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls).toHaveLength(2);
    expect(history.calls[0].generation).toBe("skipped_model");
    expect(history.calls[0].caller).toBe("completed");
    expect(history.calls[1].generation).toBe("skipped_model");
    expect(history.calls[1].callId).toBe("call_nested");
    expect(countGenerations(history.calls)).toEqual({ skipped_model: 2 });
    expect(sessionsWithAdvice(history.calls).size).toBe(0);
  });

  test("prefers a model opt-out notice over an empty duplicate representation", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_same", {
        status: "completed",
        input: { mode: "plan" },
        content: [],
      }),
      toolBlock("call_same", {
        status: "completed",
        input: { mode: "plan" },
        content: [
          {
            type: "text",
            text: "advisor is disabled (model opt-out): openai/gpt-6-astra is listed in disabledForModels.",
          },
        ],
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls).toHaveLength(1);
    expect(history.calls[0].generation).toBe("skipped_model");
  });

  test("treats completed-without-output as unknown, never success", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_1", {
        status: "completed",
        input: { mode: "plan" },
        content: [],
        time: { ran: START + 1000 },
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls[0].generation).toBe("unknown");
    expect(history.calls[0].caller).toBe("completed");
    expect(sessionsWithAdvice(history.calls).size).toBe(0);
  });

  test("reads legacy failure text as an error", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_1", {
        status: "completed",
        input: { mode: "debug" },
        content: [
          {
            type: "text",
            text: "advisor failed (timeout): Advisor generation timed out after 300000 ms",
          },
        ],
        time: { ran: START + 1000 },
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls[0].generation).toBe("error");
  });

  test("reads nested Code Mode calls", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      {
        type: "tool",
        id: "call_nested",
        name: "execute",
        state: {
          status: "completed",
          metadata: {
            toolCalls: [
              {
                tool: "ocAdvisor",
                input: { mode: "general", question: "Ping" },
                output: "pong",
              },
            ],
          },
        },
      },
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls.length).toBe(1);
    expect(history.calls[0].callId).toBe("call_nested");
    expect(history.calls[0].generation).toBe("advisor_response");
    expect(history.calls[0].mode).toBe("general");
  });

  test("reports running calls as running instead of advice", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_1", {
        status: "running",
        input: { mode: "plan" },
        content: [],
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls[0].generation).toBe("running");
    expect(history.calls[0].caller).toBe("running");
    expect(sessionsWithAdvice(history.calls).size).toBe(0);
  });

  test("deduplicates overlapping representations by call id", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_1", "ses_a", START + 1000, [
      toolBlock("call_same", {
        status: "completed",
        input: { mode: "plan" },
        content: [],
      }),
      toolBlock("call_same", {
        status: "completed",
        input: { mode: "plan" },
        content: [{ type: "text", text: "## Advisor response\nadvice" }],
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls.length).toBe(1);
    expect(history.calls[0].generation).toBe("advisor_response");
  });

  test("bounds the window on both endpoints", () => {
    const db = openFixtureDb();
    addAssistant(db, "msg_before", "ses_a", START - 1, [
      toolBlock("call_before", {
        status: "completed",
        input: { mode: "plan" },
        content: [{ type: "text", text: "advice" }],
        time: { ran: START - 1 },
      }),
    ]);
    addAssistant(db, "msg_after", "ses_b", END + 1, [
      toolBlock("call_after", {
        status: "completed",
        input: { mode: "plan" },
        content: [{ type: "text", text: "advice" }],
        time: { ran: END + 1 },
      }),
    ]);
    const history = queryAdvisorHistory(db, START, END);
    expect(history.calls.length).toBe(0);
  });
});
