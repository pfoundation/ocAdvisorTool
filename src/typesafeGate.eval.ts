/**
 * Opt-in gate evaluation over labeled cases.
 *
 * Run: bun src/typesafeGate.eval.ts [--model jev-1.13.0]
 *
 * Calls TypeSafe only (never the expensive advisor) and prints per-case
 * decisions plus aggregate false-skip, unnecessary-proceed, fallback, latency,
 * usage, and cost figures. Without TYPESAFE_API_KEY it reports the missing
 * prerequisite and sends no request.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { runTypeSafeGate } from "./typesafeGate.js";
import {
  TYPESAFE_DEFAULTS,
  makeDecisionState,
  type DecisionState,
} from "./typesafeState.js";

interface EvalCase {
  id: string;
  expectation: "skip" | "proceed";
  why: string;
  input: {
    mode: string;
    trigger: string;
    question: string;
  };
  state: {
    user: { latestRequest: string };
    context: { messages: string[] };
    history: { priorConsultations: number; priorModes: string[] };
  };
}

interface EvalFile {
  model?: string;
  cases: EvalCase[];
}

const PER_MTOK = 0.042;

function parseModelArg(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) return args[i + 1];
  }
  return null;
}

function fixtureState(testCase: EvalCase): DecisionState {
  const base = makeDecisionState({
    question: testCase.input.question,
    mode: testCase.input.mode,
    trigger: testCase.input.trigger,
    explicitEffort: null,
    caller: "evaluation",
    directory: null,
    priorConsultations: testCase.state.history.priorConsultations,
    priorModes: testCase.state.history.priorModes,
    priorQuestions: [],
    supportedEfforts: ["high", "xhigh", "max"],
    defaultEffort: "xhigh",
    maxStateBytes: TYPESAFE_DEFAULTS.maxStateBytes,
  });
  base.user.latestRequest = testCase.state.user.latestRequest;
  base.context.messages = testCase.state.context.messages;
  base.context.latestUserIncluded = true;
  base.coverage.includedMessages = base.context.messages.length;
  base.coverage.totalMessages = base.context.messages.length;
  return base;
}

const key = process.env.TYPESAFE_API_KEY;
if (!key || !key.trim()) {
  console.log(
    "TYPESAFE_API_KEY is not set for this process; live evaluation is pending. No request sent.",
  );
  process.exit(0);
}

const file = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures/typesafeGate.cases.json"),
    "utf8",
  ),
) as EvalFile;
const model = parseModelArg() ?? file.model ?? TYPESAFE_DEFAULTS.model;

const rows: Array<{
  id: string;
  expected: string;
  actual: string;
  needed: number | null;
  effort: string | null;
  confidence: number | null;
  status: string;
  reason: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}> = [];

for (const testCase of file.cases) {
  const decision = await runTypeSafeGate({
    state: fixtureState(testCase),
    input: {
      mode: testCase.input.mode,
      trigger: testCase.input.trigger,
      question: testCase.input.question,
      explicitEffort: null,
      supportedEfforts: ["high", "xhigh", "max"],
      defaultEffort: "xhigh",
    },
    settings: { ...TYPESAFE_DEFAULTS, model: model ?? undefined },
    keyPresent: true,
    env: process.env,
  });
  const actual =
    decision.status === "skip"
      ? "skip"
      : decision.status === "proceed"
        ? "proceed"
        : "fallback";
  const gated = decision.status === "disabled" ? null : decision;
  rows.push({
    id: testCase.id,
    expected: testCase.expectation,
    actual,
    needed:
      gated && (gated.status === "skip" || gated.status === "proceed")
        ? gated.metrics.neededProbability
        : null,
    effort: gated?.status === "proceed" ? gated.effectiveEffort : null,
    confidence: gated?.status === "proceed" ? gated.effortConfidence : null,
    status: decision.status,
    reason: gated?.reason ?? "disabled",
    latencyMs: gated ? gated.metrics.latencyMs : 0,
    inputTokens: gated ? gated.metrics.inputTokens : null,
    outputTokens: gated ? gated.metrics.outputTokens : null,
  });
}

const latencies = rows
  .map((row) => row.latencyMs)
  .filter((value) => value > 0)
  .sort((a, b) => a - b);
const p50 = latencies.length
  ? latencies[Math.floor(latencies.length / 2)]
  : null;
const p95 = latencies.length
  ? latencies[
      Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))
    ]
  : null;
const inputTokens = rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
const falseSkips = rows.filter(
  (row) => row.expected === "proceed" && row.actual === "skip",
).length;
const unnecessaryProceeds = rows.filter(
  (row) => row.expected === "skip" && row.actual === "proceed",
).length;
const fallbacks = rows.filter((row) => row.actual === "fallback").length;

console.log(`# TypeSafe gate evaluation (model: ${model ?? "sdk default"})`);
console.log(`Cases: ${rows.length}\n`);
for (const row of rows) {
  console.log(
    `- ${row.id}: expected ${row.expected}, got ${row.actual}` +
      ` (need=${row.needed ?? "n/a"}, effort=${row.effort ?? "-"}, conf=${row.confidence ?? "-"}, status=${row.status}, reason=${row.reason}, ${row.latencyMs}ms)`,
  );
}
console.log("\n## Aggregate");
console.log(`- False skips on must-consult cases: ${falseSkips}`);
console.log(`- Unnecessary proceeds on routine cases: ${unnecessaryProceeds}`);
console.log(`- Fallbacks: ${fallbacks}`);
console.log(`- Latency p50/p95: ${p50 ?? "n/a"}/${p95 ?? "n/a"} ms`);
console.log(`- Input tokens: ${inputTokens.toLocaleString()}`);
console.log(
  `- Estimated input cost: $${((inputTokens / 1_000_000) * PER_MTOK).toFixed(6)}`,
);
console.log(
  "\nThresholds are policy starting points; adjust from observed cases and record changes.",
);
