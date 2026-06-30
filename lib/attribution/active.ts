/**
 * Stage 3 — active backend (causal leave-one-out) via a real model.
 *
 * Unlike the passive backends, this one RE-GENERATES the answer with each source
 * removed and measures the delta. That requires a re-invocation capability, so it
 * lives behind a different contract from the passive backends. Determinism lever is
 * temperature = 0 (the Anthropic API does not expose a seed); we note this honestly —
 * settlement numbers from live mode are directional, not bit-reproducible.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { RetrievedCandidate } from "../schema";
import { cosine } from "../text";
import type { WeightMap } from "./passive";

export const LIVE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

export class LiveUnavailableError extends Error {}

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new LiveUnavailableError("ANTHROPIC_API_KEY not set — live mode unavailable.");
  return new Anthropic({ apiKey });
}

function buildContext(candidates: RetrievedCandidate[]): string {
  return candidates
    .map((c, i) => `[Source ${i + 1}] ${c.title}\n${c.chunkText}`)
    .join("\n\n");
}

const SYSTEM =
  "You are a retrieval-augmented answer engine. Answer the user's question concisely using ONLY the provided sources. If the sources do not contain the answer, answer from general knowledge in one sentence. Do not mention the sources or that you were given context.";

async function generate(
  anthropic: Anthropic,
  query: string,
  candidates: RetrievedCandidate[],
): Promise<string> {
  const msg = await anthropic.messages.create({
    model: LIVE_MODEL,
    max_tokens: 400,
    temperature: 0,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Sources:\n${buildContext(candidates)}\n\nQuestion: ${query}`,
      },
    ],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

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
 * measure the CLAIM-LEVEL delta as that source's causal contribution.
 */
export async function liveCausal(
  query: string,
  candidates: RetrievedCandidate[],
): Promise<LiveCausalResult> {
  const anthropic = client();
  const baseline = await generate(anthropic, query, candidates);

  const deltas = await Promise.all(
    candidates.map(async (c) => {
      const without = candidates.filter((x) => x.sourceId !== c.sourceId);
      const ablated = without.length ? await generate(anthropic, query, without) : "";
      const delta = claimLevelDelta(baseline, ablated);
      return { sourceId: c.sourceId, delta };
    }),
  );

  const weights: WeightMap = {};
  for (const d of deltas) weights[d.sourceId] = d.delta;
  return { answer: baseline, weights, model: LIVE_MODEL };
}

/** For non-causal live runs we still regenerate the answer so the trace is "live". */
export async function liveAnswer(query: string, candidates: RetrievedCandidate[]): Promise<string> {
  return generate(client(), query, candidates);
}
