import { describe, expect, it } from "vitest";
import { shapleyCausal, shapleyGenerationCount } from "../lib/attribution/shapley";
import { liveCausal, type GenerateFn } from "../lib/attribution/active";
import type { RetrievedCandidate } from "../lib/schema";

function cand(id: string): RetrievedCandidate {
  return {
    sourceId: id,
    sourceUrl: `https://example.com/${id}`,
    title: id,
    chunkText: id,
    retrievalScore: 1,
    rank: 1,
    authorityPrior: 1,
  };
}

/**
 * Build a mock GenerateFn from a map sourceId → the fact(s) that source contributes. The generated
 * "answer" for a subset is the union of its sources' facts, one sentence each. Each fact renders as
 * its token repeated (and nothing else), so distinct facts are lexically near-ORTHOGONAL — the
 * claim-survival matcher (`cosine ≥ 0.5` in claimLevelDelta) then treats each fact as its own claim,
 * making v(S) = |facts(S)| / |facts(N)| exactly. That determinism is what lets us hand-check the
 * Shapley axioms. (An earlier version used shared filler words like "the established fact is that
 * X holds true"; the near-identical sentences fooled the cosine matcher — a mock bug, not a code
 * bug — so filler is deliberately omitted here.)
 */
function factGen(factsOf: Record<string, string[]>, parametricFacts: string[] = []): GenerateFn {
  return async (_q, cands) => {
    const facts = new Set(parametricFacts);
    for (const c of cands) for (const f of factsOf[c.sourceId] ?? []) facts.add(f);
    // One sentence per fact: the fact token repeated → distinct facts share no vocabulary.
    return [...facts].map((f) => `${f} ${f} ${f} ${f} ${f}.`).join(" ");
  };
}

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe("shapleyCausal — axioms", () => {
  it("additive independent sources: φ equals the leave-one-out deltas (no regression on the easy case)", async () => {
    const cands = [cand("a"), cand("b")];
    const gen = factGen({ a: ["alpha"], b: ["beta"] });
    const shap = await shapleyCausal("q", cands, gen);
    const loo = await liveCausal("q", cands, gen);
    // Two independent facts, each 1/2 of the answer → φ = 0.5 each, matching LOO.
    expect(shap.weights["a"]).toBeCloseTo(0.5, 5);
    expect(shap.weights["b"]).toBeCloseTo(0.5, 5);
    expect(shap.weights["a"]).toBeCloseTo(loo.weights["a"], 5);
    expect(shap.weights["b"]).toBeCloseTo(loo.weights["b"], 5);
  });

  it("REDUNDANT duplicate sources each score > 0 (the fix) where leave-one-out gives 0", async () => {
    const cands = [cand("a"), cand("b")];
    const gen = factGen({ a: ["shared"], b: ["shared"] }); // identical single fact
    const shap = await shapleyCausal("q", cands, gen);
    const loo = await liveCausal("q", cands, gen);
    // LOO: removing either leaves the fact (still in the other) → both 0.
    expect(loo.weights["a"]).toBeCloseTo(0, 5);
    expect(loo.weights["b"]).toBeCloseTo(0, 5);
    // Shapley: the two split the fact's value → each 0.5, both clearly > 0.
    expect(shap.weights["a"]).toBeCloseTo(0.5, 5);
    expect(shap.weights["b"]).toBeCloseTo(0.5, 5);
    expect(shap.weights["a"]).toBeGreaterThan(0.05);
    expect(shap.weights["b"]).toBeGreaterThan(0.05);
  });

  it("dummy source (contributes nothing) gets φ = 0", async () => {
    const cands = [cand("a"), cand("dud")];
    const gen = factGen({ a: ["alpha"], dud: [] });
    const shap = await shapleyCausal("q", cands, gen);
    expect(shap.weights["a"]).toBeCloseTo(1, 5);
    expect(shap.weights["dud"]).toBeCloseTo(0, 5);
  });

  it("symmetry: interchangeable sources get equal credit", async () => {
    const cands = [cand("a"), cand("b"), cand("c")];
    const gen = factGen({ a: ["topic"], b: ["topic"], c: ["topic"] }); // three-way redundancy
    const shap = await shapleyCausal("q", cands, gen);
    expect(shap.weights["a"]).toBeCloseTo(1 / 3, 5);
    expect(shap.weights["b"]).toBeCloseTo(1 / 3, 5);
    expect(shap.weights["c"]).toBeCloseTo(1 / 3, 5);
  });

  it("efficiency: Σφ = v(N) − v(∅) = 1 − parametric", async () => {
    const cands = [cand("a"), cand("b")];
    // 'beta' is parametric (survives with zero sources); 'alpha' only from source a.
    const gen = factGen({ a: ["alpha"], b: [] }, ["beta"]);
    const shap = await shapleyCausal("q", cands, gen);
    expect(sum(shap.weights)).toBeCloseTo(1 - shap.parametric, 5);
  });

  it("fully parametric answer → parametric ≈ 1 and Σφ ≈ 0", async () => {
    const cands = [cand("a"), cand("b")];
    const gen = factGen({ a: [], b: [] }, ["common", "knowledge"]); // sources add nothing
    const shap = await shapleyCausal("q", cands, gen);
    expect(shap.parametric).toBeCloseTo(1, 5);
    expect(sum(shap.weights)).toBeCloseTo(0, 5);
  });
});

describe("shapleyCausal — cost + caching", () => {
  it("generates each distinct subset at most once (no wasted quota)", async () => {
    const cands = [cand("a"), cand("b"), cand("c")];
    let calls = 0;
    const base = factGen({ a: ["apple"], b: ["berry"], c: ["cherry"] });
    const gen: GenerateFn = async (q, c) => {
      calls += 1;
      return base(q, c);
    };
    await shapleyCausal("q", cands, gen);
    // 2^3 = 8 subsets, but the full set reuses the baseline → 8 distinct generations total
    // (baseline + 7 proper subsets incl. ∅). Never more.
    expect(calls).toBe(8);
  });

  it("shapleyGenerationCount matches exact vs sampled thresholds", () => {
    expect(shapleyGenerationCount(3)).toEqual({ exact: true, generations: 8 });
    expect(shapleyGenerationCount(6)).toEqual({ exact: true, generations: 64 });
    expect(shapleyGenerationCount(8, { samples: 32 }).exact).toBe(false);
  });

  it("sampled cost estimate excludes the shared empty set + free full prefix (reviewer fix)", () => {
    // k=8, samples=2: distinct proper subsets ≤ 1 (∅, shared) + 2·(8−1) = 15, +1 baseline = 16.
    // The old `samples·k+1` = 17 overcounted.
    expect(shapleyGenerationCount(8, { samples: 2 })).toEqual({ exact: false, generations: 16 });
  });
});

describe("shapleyCausal — input validation (reviewer findings)", () => {
  const cands = [cand("a"), cand("b")];
  const gen = factGen({ a: ["alpha"], b: ["beta"] });

  it("rejects k above the supported maximum instead of silently corrupting masks", async () => {
    const many = Array.from({ length: 31 }, (_, i) => cand(`s${i}`));
    await expect(shapleyCausal("q", many, factGen({}), { exactMaxK: 0, samples: 4 })).rejects.toThrow(
      /exceeds the supported maximum/,
    );
  });

  it("rejects zero samples instead of dividing by zero → NaN weights", async () => {
    await expect(shapleyCausal("q", cands, gen, { exactMaxK: 0, samples: 0 })).rejects.toThrow(
      /positive integer/,
    );
  });

  it("rejects an empty permutation set", async () => {
    await expect(
      shapleyCausal("q", cands, gen, { exactMaxK: 0, permutations: () => [] }),
    ).rejects.toThrow(/no permutations/);
  });

  it("rejects a malformed permutation (duplicate index)", async () => {
    await expect(
      shapleyCausal("q", cands, gen, { exactMaxK: 0, permutations: () => [[0, 0]] }),
    ).rejects.toThrow(/invalid permutation/);
  });
});

describe("shapleyCausal — Monte-Carlo path approximates exact", () => {
  it("sampled φ is close to exact for a small game with a fixed permutation set", async () => {
    const cands = [cand("a"), cand("b"), cand("c")];
    const gen = factGen({ a: ["apple", "berry"], b: ["berry"], c: ["cherry"] }); // partial overlap
    const exact = await shapleyCausal("q", cands, gen, { exactMaxK: 3 });
    // Force the sampled path with an exhaustive, deterministic permutation set (all 6 orderings of
    // 3 elements) → Monte-Carlo average equals the exact Shapley value.
    const allPerms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const sampled = await shapleyCausal("q", cands, gen, {
      exactMaxK: 0,
      permutations: () => allPerms,
    });
    for (const id of ["a", "b", "c"]) {
      expect(sampled.weights[id]).toBeCloseTo(exact.weights[id], 5);
    }
  });
});
