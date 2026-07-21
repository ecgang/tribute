import { describe, expect, it } from "vitest";
import {
  aggregate,
  renderMarkdown,
  type ModelResult,
  type QuestionRecord,
} from "../scripts/benchmark-models";
import type { Entrant, ProviderId } from "../scripts/providers";

/**
 * Coverage for the two intellectual-honesty invariants that live in aggregate()/renderMarkdown()
 * (reviewer note: previously only the pure metric was tested). A regression here silently corrupts
 * the published leaderboard, so these guard: (V2) a no-data model is never shown/compared as F1 0,
 * and (V4) models scored on different question sets are flagged and compared only on their overlap.
 */
const entrant = (id: ProviderId, label: string): Entrant => ({
  id,
  label,
  makeGen: () => async () => "",
});

function result(entrantId: ProviderId, label: string, o: Partial<ModelResult>): ModelResult {
  return {
    entrantId,
    label,
    ok: true,
    applicable: true,
    abstained: false,
    citationCount: 1,
    grounding: 1,
    decorative: 0,
    uncredited: 0,
    precision: 1,
    recall: 1,
    f1: 1,
    ...o,
  };
}

const ENTRANTS = [entrant("claude", "Claude 1"), entrant("gemini", "Gemini 2")];

describe("aggregate", () => {
  it("counts only applicable results toward nScored and tracks which questions", () => {
    const records: QuestionRecord[] = [
      {
        question: "q0",
        sources: 3,
        results: [result("claude", "Claude 1", { f1: 1 }), result("gemini", "Gemini 2", { f1: 0.5 })],
      },
      // q1: Claude abstained (not applicable), Gemini scored
      {
        question: "q1",
        sources: 3,
        results: [
          result("claude", "Claude 1", { applicable: false, abstained: true }),
          result("gemini", "Gemini 2", { f1: 0.5 }),
        ],
      },
    ];
    const rows = aggregate(records, ENTRANTS);
    const a = rows.find((r) => r.id === "claude")!;
    const b = rows.find((r) => r.id === "gemini")!;
    expect(a.nScored).toBe(1);
    expect(a.scoredQ).toEqual([0]); // only q0 is applicable for Claude
    expect(a.abstained).toBe(1);
    expect(b.nScored).toBe(2);
    expect(b.scoredQ).toEqual([0, 1]);
  });
});

describe("renderMarkdown honesty invariants", () => {
  const q = ["q0", "q1"];

  it("shows a no-data (all-errored) model as '— (no data)' and excludes it from the verdict", () => {
    const records: QuestionRecord[] = [
      {
        question: "q0",
        sources: 3,
        results: [
          result("claude", "Claude 1", { f1: 1 }),
          result("gemini", "Gemini 2", { ok: false, applicable: false, error: "boom" }),
        ],
      },
    ];
    const md = renderMarkdown(aggregate(records, ENTRANTS), records, q, "2026-01-01T00:00:00.000Z");
    expect(md).toContain("— (no data)");
    // Only 1 model has a signal → insufficient data, NOT a fake spread against Gemini's "0".
    expect(md).toContain("INSUFFICIENT DATA");
  });

  it("compares only the shared question intersection and flags unequal sets", () => {
    const records: QuestionRecord[] = [
      {
        question: "q0",
        sources: 3,
        results: [result("claude", "Claude 1", { f1: 1 }), result("gemini", "Gemini 2", { f1: 0.6 })],
      },
      // q1: only Gemini is applicable (Claude abstained) → scored sets differ
      {
        question: "q1",
        sources: 3,
        results: [result("claude", "Claude 1", { applicable: false }), result("gemini", "Gemini 2", { f1: 0.9 })],
      },
    ];
    const md = renderMarkdown(aggregate(records, ENTRANTS), records, q, "2026-01-01T00:00:00.000Z");
    expect(md).toContain("UNEQUAL SAMPLES");
    // Spread must be over the 1 shared question (q0): |1.0 − 0.6| = 0.40, NOT dragged by q1.
    expect(md).toContain("over 1 shared question");
    expect(md).toContain("0.40");
  });

  it("computes a clean spread with no warning when both models cover the same questions", () => {
    const records: QuestionRecord[] = [
      {
        question: "q0",
        sources: 3,
        results: [result("claude", "Claude 1", { f1: 1 }), result("gemini", "Gemini 2", { f1: 0.8 })],
      },
      {
        question: "q1",
        sources: 3,
        results: [result("claude", "Claude 1", { f1: 1 }), result("gemini", "Gemini 2", { f1: 0.8 })],
      },
    ];
    const md = renderMarkdown(aggregate(records, ENTRANTS), records, q, "2026-01-01T00:00:00.000Z");
    expect(md).not.toContain("UNEQUAL SAMPLES");
    expect(md).toContain("over 2 shared question");
  });
});
