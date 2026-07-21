/**
 * Pure metrics + CLI-output hygiene for the cross-model benchmark.
 * Kept dependency-free and side-effect-free so it unit-tests without any model calls.
 */

export interface Faithfulness {
  /** Of the sources the model CITED, the fraction that actually did causal work. */
  precision: number;
  /** Of the sources that actually did causal work, the fraction the model CITED. */
  recall: number;
  /** Harmonic mean of precision and recall — the leaderboard's headline number. */
  f1: number;
}

/**
 * Citation faithfulness = how well a model's citations match what actually drove its answer.
 * `cited` and `causal` are sets of sourceIds (cited by the model / causal under ablation).
 *
 * Empty-set conventions (a benchmark must score the degenerate cases, not divide by zero):
 * - cited=∅, causal=∅  → perfectly faithful (used nothing, credited nothing): p=r=f1=1.
 * - cited=∅, causal≠∅  → credited none of the real drivers: recall=0 (and precision=0).
 * - cited≠∅, causal=∅  → every citation was decorative: precision=0 (and recall=0).
 */
export function citationFaithfulness(cited: Set<string>, causal: Set<string>): Faithfulness {
  let inter = 0;
  for (const id of cited) if (causal.has(id)) inter += 1;

  const precision = cited.size > 0 ? inter / cited.size : causal.size === 0 ? 1 : 0;
  const recall = causal.size > 0 ? inter / causal.size : cited.size === 0 ? 1 : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/**
 * Detect an ABSTENTION: the model explicitly declined to cite because the sources didn't cover the
 * question (our prompt's escape hatch: "if the sources do not contain the answer, say so and answer
 * from general knowledge without citations"). This is HONEST behavior, so faithfulness must NOT be
 * measured on it — a model that abstains cites nothing, which would otherwise collapse P/R to 0 and
 * penalize the honest choice. The caller marks abstentions non-applicable (excluded from F1), the
 * same treatment as fully-redundant sources.
 *
 * Anchored on an explicit disclaimer, NOT on "cited nothing" alone — a model that silently uses a
 * source without citing it (a real uncredited driver) is unfaithful and must still be scored.
 */
const ABSTAIN_RE =
  /(?:sources?|provided (?:sources?|context|material|information))[^.?!]*\b(?:do(?:es)? not|don't|doesn't|did not|didn't|fail to|lack|contain no)\b[^.?!]*\b(?:contain|specify|include|cover|mention|address|provide|discuss|detail)\b|\bfrom (?:my )?general knowledge\b|\bnot (?:contained|found|present|available|mentioned|specified) in (?:the )?(?:provided )?sources?\b/i;

export function isAbstention(answer: string, citationCount: number): boolean {
  if (citationCount > 0) return false; // it cited → it did not abstain
  return ABSTAIN_RE.test(answer);
}

/**
 * Normalize a raw agentic-CLI stdout into just the answer text.
 *
 * Codex / agy are reasoning agents, not raw completion endpoints — they may wrap the answer in a
 * single fenced block or prefix a label like "Answer:". Keep this CONSERVATIVE: unwrap a whole-output
 * code fence and strip a single known leading label, but never touch inline `[n]` citation markers or
 * mid-text content (over-stripping would silently corrupt the very thing we measure).
 */
export function sanitizeCliOutput(raw: string): string {
  let text = raw.trim();

  // Unwrap a fenced block ONLY when the entire output is one fence (```lang\n…\n```).
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();

  // Strip a single leading label line the agents sometimes emit before the answer proper.
  text = text.replace(/^(?:answer|response|here(?:'s| is)[^\n:]*)\s*:\s*/i, "").trim();

  return text;
}
