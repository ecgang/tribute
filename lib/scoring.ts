/**
 * Stage 4 — Scoring (operationalizes the deck's formula).
 *
 *   Attribution Score = f(Relevance, Authority, Uniqueness, Usage)
 *
 * - Relevance : the backend's contribution weight (load-bearing term).
 * - Authority : source-level prior (domain reputation / RSL tier). Default 1.0.
 * - Uniqueness: non-redundancy vs the rest of the set (from semantic backend).
 * - Usage     : share of the answer attributable to the source.
 *
 * Combiner weights live in config (not hardcoded into the formula). All sub-scores are
 * emitted so settlement is explainable. Scores are normalized so the set sums to ≤ 1;
 * the remainder is reported as `unattributed` (the model's parametric knowledge).
 */
import type {
  AttributionReport,
  BackendId,
  RagTrace,
  SourceAttribution,
} from "./schema";
import { round } from "./text";
import { uniquenessMap, type WeightMap } from "./attribution/passive";

export const SCORING_CONFIG = {
  /** Blend weights for relevance vs the uniqueness/usage modifiers (sum to 1). */
  wRelevance: 0.6,
  wUniqueness: 0.2,
  wUsage: 0.2,
} as const;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function buildReport(
  trace: RagTrace,
  backend: BackendId,
  relevance: WeightMap,
  mode: "canned" | "live",
): AttributionReport {
  const uniq = uniquenessMap(trace);
  const { wRelevance, wUniqueness, wUsage } = SCORING_CONFIG;

  // Usage = share of the answer attributable to a source THROUGH THE SELECTED LENS,
  // i.e. its relevance share for the active backend. This keeps Usage consistent with
  // the chosen backend rather than leaking a privileged ground-truth signal into the
  // naive backends (which would erase the naive-vs-causal contrast).
  const relSum =
    trace.candidates.reduce((a, c) => a + clamp01(relevance[c.sourceId] ?? 0), 0) || 1;

  const raw: { c: (typeof trace.candidates)[number]; composite: number; rel: number; auth: number; uq: number; us: number }[] =
    trace.candidates.map((c) => {
      const rel = clamp01(relevance[c.sourceId] ?? 0);
      const auth = clamp01(c.authorityPrior ?? 1);
      const uq = clamp01(uniq[c.sourceId] ?? 0);
      const us = rel / relSum;
      // blend ∈ [wRelevance, 1] — modifiers can only discount, never inflate past relevance.
      const blend = wRelevance + wUniqueness * uq + wUsage * us;
      const composite = rel * auth * blend;
      return { c, composite, rel, auth, uq, us };
    });

  const sum = raw.reduce((a, r) => a + r.composite, 0);
  // Normalize ONLY if the set over-attributes (sum > 1). Under-attribution is preserved
  // and surfaced as `unattributed` — this is what makes the parametric case honest.
  const scale = sum > 1 ? 1 / sum : 1;

  const sources: SourceAttribution[] = raw
    .map((r) => ({
      sourceId: r.c.sourceId,
      sourceUrl: r.c.sourceUrl,
      title: r.c.title,
      rank: r.c.rank,
      subScores: {
        relevance: round(r.rel),
        authority: round(r.auth),
        uniqueness: round(r.uq),
        usage: round(r.us),
      },
      attributionScore: round(r.composite * scale),
    }))
    .sort((a, b) => b.attributionScore - a.attributionScore);

  const attributed = sources.reduce((a, s) => a + s.attributionScore, 0);
  return {
    traceId: trace.id,
    backend,
    mode,
    sources,
    unattributed: round(Math.max(0, 1 - attributed)),
  };
}
