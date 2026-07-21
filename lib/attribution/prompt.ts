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

/** Render the retrieved candidates as the `[Source n]` context block the prompt refers to. */
export function buildContext(candidates: RetrievedCandidate[]): string {
  return candidates
    .map((c, i) => `[Source ${i + 1}] ${c.title}\n${c.chunkText}`)
    .join("\n\n");
}
