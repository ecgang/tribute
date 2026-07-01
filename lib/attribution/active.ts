/**
 * Stage 3 — active backend (causal leave-one-out) via a real model.
 *
 * Unlike the passive backends, this one RE-GENERATES the answer with each source
 * removed and measures the delta. That requires a re-invocation capability, so it
 * lives behind a different contract from the passive backends. Determinism lever is
 * temperature = 0 (the Anthropic API does not expose a seed); we note this honestly —
 * settlement numbers from live mode are directional, not bit-reproducible.
 */
import type { RetrievedCandidate } from "../schema";
import { cosine } from "../text";
import type { WeightMap } from "./passive";

export const LIVE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

export class LiveUnavailableError extends Error {}

/**
 * The injectable model-callable: query + candidate sources in, generated answer text out.
 * Provider-agnostic on purpose — this is the seam a BYO-model deployment injects a customer's
 * model into, and the seam a future surrogate backend E (k masked `gen` calls + a linear fit
 * over the results) would consume as just another caller. The concrete Anthropic-backed
 * implementation lives in `./anthropicGenerate`; `active.ts` never constructs a client.
 */
export type GenerateFn = (query: string, candidates: RetrievedCandidate[]) => Promise<string>;

export type LiveCausalResult = {
  answer: string;
  weights: WeightMap;
  model: string;
};

/** Split an answer into atomic claims (sentence-level). */
export function splitClaims(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

/**
 * Claim-level causal delta: the FRACTION OF CLAIMS that disappear when a source is removed.
 * A claim "survives" if a close lexical match still exists in the ablated answer. This
 * measures CONTENT change, not phrasing drift — so it doesn't inflate when the model merely
 * rewords. Lexical (not an LLM judge) on purpose: judging an LLM with an LLM would
 * re-introduce the circularity the eval harness exists to avoid.
 */
export function claimLevelDelta(baseline: string, ablated: string, threshold = 0.5): number {
  const claims = splitClaims(baseline);
  if (claims.length === 0) return 0;
  if (!ablated.trim()) return 1;
  const ablatedClaims = splitClaims(ablated);
  if (ablatedClaims.length === 0) return 1;
  const lost = claims.filter(
    (cl) => Math.max(0, ...ablatedClaims.map((a) => cosine(cl, a))) < threshold,
  ).length;
  return Math.max(0, Math.min(1, lost / claims.length));
}

/**
 * Generate a baseline answer, then for each candidate re-generate with it removed and
 * measure the CLAIM-LEVEL delta as that source's causal contribution. `gen` is injected —
 * this function never constructs a model client itself, which is what makes it unit-testable
 * with a mock `GenerateFn` (see tests/liveCausal.test.ts).
 */
export async function liveCausal(
  query: string,
  candidates: RetrievedCandidate[],
  gen: GenerateFn,
): Promise<LiveCausalResult> {
  const baseline = await gen(query, candidates);

  const deltas = await Promise.all(
    candidates.map(async (c) => {
      const without = candidates.filter((x) => x.sourceId !== c.sourceId);
      const ablated = without.length ? await gen(query, without) : "";
      const delta = claimLevelDelta(baseline, ablated);
      return { sourceId: c.sourceId, delta };
    }),
  );

  const weights: WeightMap = {};
  for (const d of deltas) weights[d.sourceId] = d.delta;
  return { answer: baseline, weights, model: LIVE_MODEL };
}

/** For non-causal live runs we still regenerate the answer so the trace is "live". */
export async function liveAnswer(
  query: string,
  candidates: RetrievedCandidate[],
  gen: GenerateFn,
): Promise<string> {
  return gen(query, candidates);
}
