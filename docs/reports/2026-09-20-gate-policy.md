# Advisor gate policy evaluation — 2026-09-20

Tracking: [PR #10](https://github.com/pfoundation/ocAdvisorTool/pull/10),
following the benchmark work in [issue #8](https://github.com/pfoundation/ocAdvisorTool/issues/8).

## Decision

Adopt the explicit material-value question and true/false criteria below,
retaining `skipBelow: 0.20`, model/benchmark evidence, and the independent effort
question. The comparison experiment preceded implementation; its selected prompt
is now used by `src/typesafeGate.ts`.

Threshold-only changes are a viable alternative on the evaluated cases. The
selected question clarifies the boundary between useful independent reasoning
and work already resolved by a direct action, while preserving the existing
conservative threshold.

## Exact selected question

The TypeSafe Noul `instructions` is an object with `question` and `judge` fields.

**question:**

> Would this specific advisor consultation add material value beyond the requesting agent's next direct action with the evidence and tools already available?

**judge** (ordered array):

1. Assess the actual unresolved question, not just whether it is phrased as a request for an opinion.
2. Material value includes resolving substantive uncertainty, comparing meaningful approaches, finding a plausible correctness issue, or independent review of consequential work. Being stuck is not required.
3. A useful action that is already determined by direct reading, a deterministic tool, or an explicit mechanical instruction usually needs no consultation.
4. Explicit user requests for the advisor should proceed. Missing or truncated task context is uncertainty, not proof that consultation is unnecessary.
5. Prior consultations are not a quota. Revisit changed evidence or concerns; an identical settled question without new evidence adds little.
6. Model identities alone do not establish value. Relevant comparable benchmarks may inform substantive cases; an advisor advantage cannot turn a direct lookup into a substantive case. A strong requester still benefits from independent review. Missing, stale, or incomparable benchmarks neither prove nor disprove value.

**criteria.true:**

> A substantive unresolved decision, diagnosis, or correctness concern could benefit from independent reasoning; or the user explicitly requests the advisor. Uncertain task evidence does not justify suppressing consultation.

**criteria.false:**

> Visible evidence establishes that a direct lookup, deterministic operation, mechanical edit, or unchanged previously answered question resolves this request without meaningful independent reasoning.

These are model instructions, not deterministic bypass rules. The code skips
only when the returned need probability is **strictly below 0.20**. Gate failures
continue to fall back to the ordinary advisor behavior.

## Method and provenance

- Gate model pinned to `jev-1.13.0`, SDK `@typesafe-ai/sdk` 0.6.0.
- Baseline code: [`374bdf1f20b01434cd6a912c92f65356c7170e4c`](https://github.com/pfoundation/ocAdvisorTool/tree/374bdf1f20b01434cd6a912c92f65356c7170e4c).
  Its original need prompt says a concrete question awaiting an independent
  opinion "usually qualifies."
- Genuine bundled Artificial Analysis snapshot, fetched
  `2026-09-20T00:11:18.433Z`, content hash
  `53419a14dba4c94d617b7b99f3984ca38f5f6aaface948a0d3c7bea85c092b10`.
- Requesters: `opencode/deepseek-v4.1-flash#max`,
  `meta/muse-spark-1.3#xhigh`, and `openai/gpt-6-astra#xhigh`.
  Advisor: `anthropic/claude-fable-5-1`, with high/xhigh/max candidates and
  xhigh fallback. Cross-provider benchmark matching was enabled.
- 24 pre-labeled synthetic scenarios: 10 routine/skip and 14 useful/proceed.
  There were 16 discovery scenarios and 8 reserved holdout scenarios.
- Each full-evidence scenario: three requester profiles × two repetitions.
  Each task-only control: two repetitions, with models, benchmarks, and the
  caller's model identity removed. No redundant repetition per removed model.
- 192 live comparison requests: 144 full-evidence and 48 task-only. Candidate
  questions were batched independently per the TypeSafe contract; thresholds
  were swept offline over the same returned probabilities.
- The production wire projection, SDK adapter, deadline, baseline decision
  function, and effort question were used. Expected labels were not sent.
- The selected policy was recorded before querying the holdout. Neither the
  prompts nor selection changed in response to holdout results.
- A further 72 calls confirmed the selected prompt with only the normal need
  and effort questions. No advisor generation was invoked.
- Frozen local experiment specification SHA-256:
  `ac4d22be3777a8119ae409676ff95b985596b25edc6261cd4d117135c7b8ab11`.

## Comparison results

Higher routine avoidance is better. False skips count useful consultations that
would be suppressed. These are repeated call counts, not independent production
tasks or measurements of actual advisor outcome improvements.

| Policy | Routine calls avoided | Useful calls wrongly skipped | Repeat decision flips |
| --- | ---: | ---: | ---: |
| Original wording, threshold 0.20 | 12/60 (20%) | 0/84 | 0 |
| Original wording, threshold 0.30 | 38/60 (63%) | 0/84 | 0 |
| Original wording, threshold 0.40 | 56/60 (93%) | 0/84 | 0 |
| Original wording, threshold 0.50 | 60/60 (100%) | 0/84 | 0 |
| Identity-neutralizing clarification, 0.20 | 51/60 (85%) | 0/84 | 1 |
| Identity-neutralizing clarification, 0.30 | 57/60 (95%) | 0/84 | 1 |
| **Material-value criteria, 0.20** | **60/60 (100%)** | **0/84** | **0** |
| Material-value criteria, 0.40 | 60/60 (100%) | 6/84 | 0 |
| Task-only original wording, 0.20 | 4/20 (20%) | 0/28 | 0 |
| Task-only material-value criteria, 0.20 | 20/20 (100%) | 0/28 | 0 |
| Original gate OR routine probability ≥0.90 | 12/60 (20%) | 0/84 | 0 |
| Trigger-specific thresholds: 0.20 for stuck/pre_complete/followup, otherwise 0.40 | 44/60 (73%) | 0/84 | 0 |

On the holdout alone, the selected policy skipped **24/24 routine calls** and
preserved **24/24 useful calls**. There were no transport/validation fallbacks
in the 192 comparison requests. Input/output tokens: 472,888/20,237;
latency p50/p95: 257/341 ms. These timings measure the multi-question experiment,
not the final two-question production policy.

### Scenario-level need probabilities

Means over three requester profiles × two repetitions, with full evidence.
The case names describe the synthetic evidence, not broad rules for all such tasks.

| Scenario | Expected | Original question | Selected question |
| --- | --- | ---: | ---: |
| Package version lookup | skip | 0.235 | 0.063 |
| Byte-budget correctness review | proceed | 0.683 | 0.337 |
| Consequential design choice | proceed | 0.733 | 0.738 |
| Difficult package-resolution debugging | proceed | 0.792 | 0.715 |
| Ambiguous rollout sequencing | proceed | 0.735 | 0.728 |
| Repeat review with new evidence | proceed | 0.767 | 0.575 |
| Typecheck script lookup | skip | 0.358 | 0.140 |
| Test-filename reference lookup | skip | 0.405 | 0.127 |
| Mechanical local rename | skip | 0.255 | 0.118 |
| Spelling correction framed as review | skip | 0.235 | 0.090 |
| Duplicate settled question, no change | skip | 0.342 | 0.120 |
| One-line tenant authorization change | proceed | 0.832 | 0.758 |
| Explicit user request for advisor | proceed | 0.720 | 0.800 |
| Missing migration context | proceed | 0.875 | 0.862 |
| Candidate fix with unresolved cancellation races | proceed | 0.817 | 0.752 |
| Single flag with durability consequences | proceed | 0.838 | 0.798 |
| **Holdout:** read a configured port | skip | 0.295 | 0.098 |
| **Holdout:** straightforward arithmetic | skip | 0.115 | 0.035 |
| **Holdout:** run the configured formatter | skip | 0.247 | 0.118 |
| **Holdout:** extract an explicit log code | skip | 0.173 | 0.058 |
| **Holdout:** duplicate-payment retry risk | proceed | 0.857 | 0.752 |
| **Holdout:** risky deletion-query cleanup | proceed | 0.777 | 0.682 |
| **Holdout:** conflicting cache-invalidation traces | proceed | 0.802 | 0.758 |
| **Holdout:** reconsider after a newly observed outage | proceed | 0.822 | 0.755 |

### Production-shaped confirmation

Another 72 live calls used only the selected need question and the unchanged
effort question through `runTypeSafeGate`, at threshold 0.20. All 24 scenarios
were exercised once per requester:

| Requester | Routine calls skipped | Useful calls preserved | Routine need range | Useful need range |
| --- | ---: | ---: | --- | --- |
| DeepSeek V4.1 Flash max | 10/10 | 14/14 | 0.03–0.13 | 0.34–0.85 |
| Muse Spark 1.3 xhigh | 10/10 | 14/14 | 0.04–0.15 | 0.35–0.87 |
| GPT-6 Astra xhigh | 10/10 | 14/14 | 0.04–0.14 | 0.34–0.86 |

Total: **30/30 routine skips, 42/42 useful proceeds, zero fallbacks**.
Latency p50/p95: 265/355 ms; input/output tokens: 147,039/4,061.
The experiment comprised 264 requests in all, before implementation verification.

## Tradeoffs and interpretation

1. **Threshold-only:** simplest configuration-only improvement. Threshold 0.40
   captured 93% of routine calls; 0.50 captured all. Both preserved all useful
   calls here, but leave the broad judgment definition intact. This sample does
   not establish a production-calibrated threshold of 0.50.
2. **Small identity clarification:** substantially improves the original prompt,
   but misses some routine cases and retains a repeat decision flip.
3. **Material-value criteria:** selected because it defines both sides of the
   decision explicitly, works at the existing conservative threshold, and
   retains capability evidence.
4. **Task-only screening:** removing identities and scores alone did not improve
   avoidance at 0.20. With material-value criteria it matched full-evidence
   decisions, but did not demonstrate an accuracy advantage. Model-aware effort
   selection would need its own evidence path in such an architecture.
5. **Separate routine classifier:** at 0.90 and 0.95 it added no skips; its routine
   probabilities did not reach those cutoffs. Lower cutoffs would be another
   calibration decision. The result does not prove this architecture cannot
   work, but provides no benefit for its additional question and decision logic.
6. **Trigger-specific thresholds:** coarse proxies for value. A review can be a
   spelling correction, while a one-line change can affect authorization.

**Prompt and threshold must be evaluated together.** At threshold 0.40, the
selected question wrongly skipped all six calls for the focused byte-budget
correctness review; at 0.20 it preserved them. The same numeric cutoff does not
have interchangeable behavior across differently worded questions.

## Limits and corrections to the exploratory discussion

- The dataset contains 24 author-labeled scenarios, only 14 of them useful.
  Repeats and model variants test stability, not production error rates. The
  holdout was reserved within the same authored dataset, not supplied externally.
- The earlier five-case A/B did not establish that benchmarks doubled
  unnecessary consultations. This larger study also does not isolate the causal
  contribution of model identities on its own.
- Scores may inform consultation usefulness, not just trust in the eventual
  advisor answer. They should not alone determine the outcome.
- The local log's 28 proceed records were separate from direct
  `runTypeSafeGate` experiments: that function does not append advisor metrics.
  The earlier claim that those records included every experiment was incorrect.
- DeepSeek's default comparison has an effort mismatch and no published coding
  score. Raw scores remain labeled with non-comparability reasons; the experiment
  did not manufacture comparable deltas.

## Ongoing verification

From the repository root, with `TYPESAFE_API_KEY` in the environment:

```sh
bun src/typesafeGate.eval.ts --model jev-1.13.0
```

The committed 16-case evaluation includes the original benchmark scenarios and
six additions covering routine script lookups, mechanical renames, spelling
reviews, unchanged repeat questions, explicit advisor requests, and consequential
one-line authorization changes. It calls TypeSafe only. It is a regression set,
not a byte-for-byte replay of the historical 264-request experiment above.

### Implementation verification

The same 16 cases were run immediately before and after installing the selected
question, using `jev-1.13.0`, the production gate, and threshold 0.20:

| Measure | Before | After |
| --- | ---: | ---: |
| Routine consultations skipped | 0/6 | 6/6 |
| Useful consultations preserved | 10/10 | 10/10 |
| Fallbacks | 0 | 0 |
| Input tokens | 16,398 | 18,222 |
| Latency p50/p95 | 277/605 ms | 238/583 ms |

The focused correctness review proceeded at need 0.33 after the change; the
explicit user request proceeded at 0.77. The before/after runs are additional to
the 264-call exploration. Prompt serialization was also checked against the
frozen selected experiment question for exact equality. All 338 automated tests,
typecheck, and build passed; the SDK boundary test verifies both true/false
criteria reach the wire alongside the structured instructions.

Historical wire logs and the comparison harness were retained locally under
`/tmp/opencode/ocadvisor-gate-options-20260920/`; this report preserves the
decision, exact selected prompt, provenance, aggregate and case-level results,
and limitations independently of those temporary files.

## Models used

Models: openai/gpt-6-astra:xhigh

Gate inference: `jev-1.13.0` via TypeSafe. Requester/advisor profiles in the
experiment are input evidence; those models were not invoked for the synthetic
consultations.
