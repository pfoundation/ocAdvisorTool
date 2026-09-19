// Gate evidence assembly: resolves both participants against one
// benchmark view and selects the shared comparison set. Comparisons always
// reflect the advisor's default effort (pinned, fallback, or fixed); every
// relevant candidate effort additionally reports its own match coverage so
// effort selection can weigh it. Scores stay attached to their evaluated
// effort and comparability reason — the gate judges, never recomputes.
import {
  compareBenchmarks,
  selectGateMetrics,
  type BenchmarkMatch,
  type MatchSource,
  type MatchStatus,
  type MetricComparison,
} from "./benchmarkMatch.js";
import type { BenchmarkView } from "./benchmarkStore.js";
import type { AdvisorProfile, RequesterProfile } from "./modelProfiles.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CompactMatch {
  status: MatchStatus;
  source: MatchSource | null;
  aaModelID: string | null;
  evaluatedEffort: string | null;
}

export interface EvidenceModels {
  requester: RequesterProfile;
  advisor: AdvisorProfile;
}

export interface EvidenceBenchmarks {
  source: "user" | "seed" | "unavailable";
  fetchedAt: string | null;
  ageDays: number | null;
  contentHash: string | null;
  hashVerified: boolean;
  requesterMatch: CompactMatch;
  advisorDefaultMatch: CompactMatch;
  advisorCandidates: Array<{ effort: string | null } & CompactMatch>;
  comparisons: MetricComparison[];
  // Set when byte-budget trimming drops score detail; identities stay.
  omitted: boolean;
}

function compact(match: BenchmarkMatch): CompactMatch {
  return {
    status: match.status,
    source: match.source,
    aaModelID: match.aaModelID,
    evaluatedEffort: match.evaluatedEffort,
  };
}

function relevantEfforts(advisor: AdvisorProfile): Array<string | null> {
  switch (advisor.policy.kind) {
    case "pinned":
      return [advisor.policy.effort];
    case "candidates":
      return [...advisor.policy.candidates];
    case "fixed":
      return [advisor.policy.effort];
  }
}

function defaultEffort(advisor: AdvisorProfile): string | null {
  switch (advisor.policy.kind) {
    case "pinned":
      return advisor.policy.effort;
    case "candidates":
      return advisor.policy.fallback;
    case "fixed":
      return advisor.policy.effort;
  }
}

export function buildBenchmarkEvidence(input: {
  requester: RequesterProfile;
  advisor: AdvisorProfile;
  view: BenchmarkView;
  nowMs?: number;
}): { models: EvidenceModels; benchmarks: EvidenceBenchmarks } {
  const { requester, advisor, view } = input;
  const requesterMatch = view.matcher.match({
    providerID: requester.providerID ?? "",
    modelID: requester.modelID ?? "",
    variant: requester.variant,
  });
  const efforts = relevantEfforts(advisor);
  const candidates = efforts.map((effort) => ({
    effort,
    ...compact(
      view.matcher.match({
        providerID: advisor.providerID,
        modelID: advisor.modelID,
        variant: effort,
      }),
    ),
  }));
  const fallback = defaultEffort(advisor);
  const defaultMatch = view.matcher.match({
    providerID: advisor.providerID,
    modelID: advisor.modelID,
    variant: fallback,
  });
  const snapshot = view.snapshot;
  const fetchedAt = snapshot?.fetchedAt ?? null;
  const nowMs = input.nowMs ?? Date.now();
  const ageDays =
    fetchedAt === null || !Number.isFinite(Date.parse(fetchedAt))
      ? null
      : Math.max(0, Math.floor((nowMs - Date.parse(fetchedAt)) / DAY_MS));
  return {
    models: { requester, advisor },
    benchmarks: {
      source: view.snapshotSource,
      fetchedAt,
      ageDays,
      contentHash: snapshot?.contentHash ?? null,
      hashVerified: snapshot ? view.snapshotHashVerified : false,
      requesterMatch: compact(requesterMatch),
      advisorDefaultMatch: compact(defaultMatch),
      advisorCandidates: candidates,
      comparisons: selectGateMetrics(
        compareBenchmarks(requesterMatch, defaultMatch),
      ),
      omitted: false,
    },
  };
}
