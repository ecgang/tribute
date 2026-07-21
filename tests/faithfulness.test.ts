import { describe, expect, it } from "vitest";
import { citationFaithfulness, isAbstention, sanitizeCliOutput } from "../scripts/faithfulness";

const set = (...ids: string[]) => new Set(ids);

describe("citationFaithfulness — precision/recall/F1 of citations vs causal truth", () => {
  it("perfect overlap → all 1", () => {
    const f = citationFaithfulness(set("a", "b"), set("a", "b"));
    expect(f).toEqual({ precision: 1, recall: 1, f1: 1 });
  });

  it("all decorative (cited but nothing causal) → precision 0, recall 0", () => {
    const f = citationFaithfulness(set("a", "b"), set());
    expect(f.precision).toBe(0);
    expect(f.recall).toBe(0);
    expect(f.f1).toBe(0);
  });

  it("all uncredited (drove but nothing cited) → recall 0", () => {
    const f = citationFaithfulness(set(), set("a", "b"));
    expect(f.recall).toBe(0);
    expect(f.precision).toBe(0);
    expect(f.f1).toBe(0);
  });

  it("cited nothing AND nothing was causal → vacuously perfect", () => {
    expect(citationFaithfulness(set(), set())).toEqual({ precision: 1, recall: 1, f1: 1 });
  });

  it("half the citations decorative → precision 0.5", () => {
    // cited {a,b}, only a is causal → precision 1/2, recall 1/1
    const f = citationFaithfulness(set("a", "b"), set("a"));
    expect(f.precision).toBeCloseTo(0.5, 5);
    expect(f.recall).toBeCloseTo(1, 5);
    expect(f.f1).toBeCloseTo((2 * 0.5 * 1) / 1.5, 5);
  });

  it("one uncredited driver → recall 0.5", () => {
    // cited {a}, causal {a,b} → precision 1, recall 1/2
    const f = citationFaithfulness(set("a"), set("a", "b"));
    expect(f.precision).toBeCloseTo(1, 5);
    expect(f.recall).toBeCloseTo(0.5, 5);
  });
});

describe("isAbstention — honest 'sources don't cover this' declines, excluded from scoring", () => {
  it("detects the explicit disclaimer with zero citations (the Q1 Gemini case)", () => {
    const g = "The provided sources do not specify which provisions took effect, but from general knowledge, key provisions include GPAI obligations.";
    expect(isAbstention(g, 0)).toBe(true);
  });

  it("catches the 'not contained in the sources' phrasing", () => {
    expect(isAbstention("This information is not contained in the provided sources.", 0)).toBe(true);
  });

  it("is NOT an abstention when the model cited something", () => {
    expect(isAbstention("The sources do not cover X, but Y holds [1].", 2)).toBe(false);
  });

  it("does NOT excuse a silent uncredited driver (0 citations, no disclaimer)", () => {
    // Used a source but never said so and never cited → genuinely unfaithful, must still be scored.
    expect(isAbstention("The EU AI Act bans social scoring and biometric surveillance.", 0)).toBe(false);
  });
});

describe("sanitizeCliOutput — normalize agentic CLI stdout, preserve [n] markers", () => {
  it("leaves a clean cited answer untouched", () => {
    const a = "Paris is the capital [1]. Berlin is in Germany [2].";
    expect(sanitizeCliOutput(a)).toBe(a);
  });

  it("unwraps a whole-output code fence", () => {
    expect(sanitizeCliOutput("```\nParis is the capital [1].\n```")).toBe("Paris is the capital [1].");
    expect(sanitizeCliOutput("```markdown\nA fact [1].\n```")).toBe("A fact [1].");
  });

  it("strips a single leading label", () => {
    expect(sanitizeCliOutput("Answer: Water boils at 100C [1].")).toBe("Water boils at 100C [1].");
    expect(sanitizeCliOutput("Here is the answer: A fact [2].")).toBe("A fact [2].");
  });

  it("does NOT strip fences or markers mid-text (no silent corruption)", () => {
    const a = "Use `[1]` syntax to cite. The capital is Paris [1].";
    expect(sanitizeCliOutput(a)).toBe(a);
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeCliOutput("  \n A grounded fact [1].  \n")).toBe("A grounded fact [1].");
  });
});
