/**
 * Stage 3 — Attribution backends (passive: read the trace, never re-generate).
 *
 *   A Retrieval-weighted  — weight ∝ retrieval score. Measures availability, not use.
 *   B Citation-grounded   — weight ∝ the model's own citation share.
 *   C Semantic-overlap    — weight ∝ lexical similarity(answer, source). Also → uniqueness.
 *
 * Each returns a map sourceId → relevance weight in [0,1] (NOT forced to sum to 1;
 * the combiner handles normalization). Uniqueness and usage are cross-source features
 * computed here and consumed by the scoring stage.
 */
import type { RagTrace } from "../schema";
import { cosine } from "../text";

export type WeightMap = Record<string, number>;

export function retrievalWeights(trace: RagTrace): WeightMap {
  const out: WeightMap = {};
  for (const c of trace.candidates) out[c.sourceId] = c.retrievalScore;
  return out;
}

export function citationWeights(trace: RagTrace): WeightMap {
  const out: WeightMap = {};
  // Prefer pre-baked citation share; otherwise derive from the citations[] array.
  const haveCanned = trace.candidates.some((c) => c.canned?.citationShare != null);
  if (haveCanned) {
    for (const c of trace.candidates) out[c.sourceId] = c.canned?.citationShare ?? 0;
    return out;
  }
  const counts: Record<string, number> = {};
  let total = 0;
  for (const cit of trace.citations ?? []) {
    counts[cit.sourceId] = (counts[cit.sourceId] ?? 0) + 1;
    total += 1;
  }
  for (const c of trace.candidates) out[c.sourceId] = total ? (counts[c.sourceId] ?? 0) / total : 0;
  return out;
}

export function semanticWeights(trace: RagTrace): WeightMap {
  const out: WeightMap = {};
  for (const c of trace.candidates) out[c.sourceId] = cosine(trace.answer, c.chunkText);
  return out;
}

/** Canned causal weights read pre-baked leave-one-out deltas (live mode overrides this). */
export function cannedCausalWeights(trace: RagTrace): WeightMap {
  const out: WeightMap = {};
  for (const c of trace.candidates) out[c.sourceId] = c.canned?.ablationDelta ?? 0;
  return out;
}

/** Uniqueness: 1 − max lexical similarity to any OTHER source's chunk. High = non-redundant. */
export function uniquenessMap(trace: RagTrace): WeightMap {
  const out: WeightMap = {};
  for (const c of trace.candidates) {
    let maxSim = 0;
    for (const other of trace.candidates) {
      if (other.sourceId === c.sourceId) continue;
      maxSim = Math.max(maxSim, cosine(c.chunkText, other.chunkText));
    }
    out[c.sourceId] = 1 - maxSim;
  }
  return out;
}
