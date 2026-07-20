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
import type { Citation, RagTrace, RetrievedCandidate } from "../schema";
import { cosine } from "../text";

export type WeightMap = Record<string, number>;

/** Strip inline citation markers like `[1]` or `[1, 3]` from answer text (and tidy spacing). */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Parse the model's inline `[n]` citation markers into per-claim Citations.
 * `[n]` is 1-indexed into the candidate set → `candidates[n-1]`; grouped markers like `[1, 3]`
 * expand to one Citation each. Out-of-range or malformed markers are ignored (never throw), so a
 * hallucinated `[9]` can't crash the pipeline or credit a non-existent source. `claim` is the
 * sentence the marker sits in, with markers stripped — `citationWeights` counts occurrences → share.
 */
export function parseCitations(answer: string, candidates: RetrievedCandidate[]): Citation[] {
  const citations: Citation[] = [];
  const sentences = answer.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const markerRe = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(sentence)) !== null) {
      const seen = new Set<number>(); // dedupe within one group: `[1, 1]` counts once
      for (const part of m[1].split(",")) {
        const n = parseInt(part.trim(), 10);
        if (seen.has(n)) continue;
        seen.add(n);
        const cand = candidates[n - 1];
        if (!cand) continue; // out of range / NaN → ignore
        citations.push({ claim: stripCitationMarkers(sentence), sourceId: cand.sourceId });
      }
    }
  }
  return citations;
}

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
