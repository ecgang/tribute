/**
 * The canonical RAG generation prompt — single source of truth.
 *
 * Extracted so EVERY entrant (the live Anthropic route + each cross-model benchmark provider)
 * sends byte-identical instructions. If the system prompt or context format varied per provider,
 * the cross-model faithfulness benchmark would be measuring prompt differences, not model behavior.
 */
import type { RetrievedCandidate } from "../schema";

export const RAG_SYSTEM =
  "You are a retrieval-augmented answer engine. Answer the user's question concisely using ONLY the provided sources. " +
  "Cite the sources you actually use with inline bracketed markers matching their number — e.g. [1], [2] — " +
  "placing each marker immediately after the sentence or clause it supports. Only cite a source when it genuinely " +
  "supports that claim; never cite a source you did not use. If the sources do not contain the answer, say so in " +
  "one sentence and answer from general knowledge without any citation markers.";

/**
 * The closed-book prompt for the ZERO-source pass — i.e. v(∅), the parametric share.
 *
 * v(∅) must measure what the model actually KNOWS on its own. Reusing RAG_SYSTEM with an empty
 * source block does the opposite: it primes retrieval framing, so the model hedges ("the sources
 * do not contain this…") instead of committing, which deflates and adds noise to the parametric
 * share (and thus to grounding = 1 − parametric). This neutral prompt elicits a committed
 * closed-book answer — no retrieval framing, no note about absent sources, no citation markers.
 */
export const CLOSED_BOOK_SYSTEM =
  "Answer the user's question concisely from your own knowledge. Commit to your best direct answer. " +
  "Do not mention sources, retrieval, or that any sources are missing, and do not add citation markers. " +
  "If you genuinely do not know, say so in one sentence.";

/**
 * System prompt for a source subset: retrieval instructions when sources are present, a committed
 * closed-book prompt when the subset is empty (the v(∅) / parametric pass). Every entrant routes
 * through this so the zero-source instruction is byte-identical across the API and CLI paths.
 */
export function systemFor(candidates: RetrievedCandidate[]): string {
  return candidates.length === 0 ? CLOSED_BOOK_SYSTEM : RAG_SYSTEM;
}

/**
 * The shared user-message body. With sources: a `Sources:` block + the question. Empty subset:
 * just the question — no empty `Sources:` block, which would re-prime the retrieval framing the
 * closed-book system prompt is deliberately dropping.
 */
export function userBody(query: string, candidates: RetrievedCandidate[]): string {
  return candidates.length === 0
    ? `Question: ${query}`
    : `Sources:\n${buildContext(candidates)}\n\nQuestion: ${query}`;
}

/** Render the retrieved candidates as the `[Source n]` context block the prompt refers to. */
export function buildContext(candidates: RetrievedCandidate[]): string {
  return candidates
    .map((c, i) => `[Source ${i + 1}] ${c.title}\n${c.chunkText}`)
    .join("\n\n");
}
