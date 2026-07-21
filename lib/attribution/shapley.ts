/**
 * Shapley-value causal attribution — the redundancy-robust replacement for strict leave-one-out.
 *
 * Strict LOO (`liveCausal`) under-credits redundant sources: a fact carried by 3 sources survives
 * the removal of any one, so each scores ~0. Shapley credits each source by its AVERAGE MARGINAL
 * contribution across all source subsets, so those 3 sources split the fact's value (each ~1/3)
 * instead of zeroing out — the measure the cross-model benchmark needs to be defensible.
 *
 * Value function reuses the existing claim tooling (no new judge):
 *   v(S) = fraction of the BASELINE answer's claims reproducible from source-subset S
 *        = 1 − claimLevelDelta(baseline, gen(S)).
 *   v(N) = 1 (baseline vs itself). v(∅) = claims surviving with ZERO sources = the PARAMETRIC share.
 * By the Shapley efficiency axiom, Σ φᵢ = v(N) − v(∅) = 1 − parametric, so grounded-vs-parametric
 * falls out for free.
 *
 * This is benchmark-scoped: `liveCausal` stays the app's live-path measure (unchanged).
 */
import type { RetrievedCandidate } from "../schema";
import { claimLevelDelta, LIVE_MODEL, type GenerateFn } from "./active";
import type { WeightMap } from "./passive";

export interface ShapleyResult {
  answer: string;
  /** sourceId → Shapley credit φᵢ, clamped ≥ 0. */
  weights: WeightMap;
  model: string;
  /** v(∅): share of the answer's claims that survive with no sources (model's parametric knowledge). */
  parametric: number;
  /** How many model generations were spent (baseline + distinct evaluated subsets) — for cost reporting. */
  generations: number;
  /** True if computed by exact enumeration; false if Monte-Carlo sampled. */
  exact: boolean;
}

export interface ShapleyOpts {
  /** Exact enumeration only when 2^k ≤ 2^exactMaxK; above this, Monte-Carlo. Default 6 (≤64 subsets). */
  exactMaxK?: number;
  /** Monte-Carlo permutation samples used above the exact cap. Default 64. */
  samples?: number;
  /** Injectable permutation source for deterministic tests: returns `m` orderings of [0..k). */
  permutations?: (k: number, m: number) => number[][];
}

/** Subset membership uses 32-bit int masks, and 19! already exceeds Number.MAX_SAFE_INTEGER, so
 *  reject any k where either the masks or the factorial weights would silently corrupt. In practice
 *  k = retrieved sources per question (≈3–8), so this cap is a foot-gun guard, never a real limit. */
const MAX_K = 30;
/** Exact enumeration only when factorials stay exact (18! < MAX_SAFE_INTEGER < 19!). Above this we
 *  fall back to Monte-Carlo even if the caller set a larger exactMaxK. */
const SAFE_EXACT_K = 18;

function isExact(k: number, exactMaxK: number): boolean {
  return k <= Math.min(exactMaxK, SAFE_EXACT_K);
}

/** How many model generations an exact/sampled run will cost for k sources (baseline + subsets,
 *  excluding the full set which reuses the baseline). Used by the benchmark's --dry estimate. */
export function shapleyGenerationCount(k: number, opts: ShapleyOpts = {}): { exact: boolean; generations: number } {
  const exactMaxK = opts.exactMaxK ?? 6;
  if (isExact(k, exactMaxK)) {
    // all 2^k subsets except the full set (reuses baseline) + the baseline itself
    return { exact: true, generations: 2 ** k - 1 + 1 };
  }
  // Distinct proper subsets generated ≤ v(∅) (shared once) + samples·(k−1) non-empty non-full
  // prefixes, capped at every non-full subset (2^k−1); plus the baseline. (The full prefix per
  // permutation reuses the baseline for free — reviewer finding: `samples·k` overcounted.)
  const samples = opts.samples ?? 64;
  return { exact: false, generations: Math.min(2 ** k - 1, 1 + samples * (k - 1)) + 1 };
}

function defaultPermutations(k: number, m: number): number[][] {
  const perms: number[][] = [];
  for (let s = 0; s < m; s += 1) {
    const p = Array.from({ length: k }, (_, i) => i);
    for (let i = k - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    perms.push(p);
  }
  return perms;
}

/**
 * Compute Shapley causal weights. `gen` is injected (unit-testable with a mock that returns canned
 * answers per subset). Exact for small k, Monte-Carlo above `exactMaxK`.
 */
export async function shapleyCausal(
  query: string,
  candidates: RetrievedCandidate[],
  gen: GenerateFn,
  opts: ShapleyOpts = {},
): Promise<ShapleyResult> {
  const k = candidates.length;
  if (k > MAX_K) {
    // 32-bit subset masks + factorial precision both break past this; k is realistically ≤ ~8.
    throw new Error(`shapleyCausal: k=${k} exceeds the supported maximum of ${MAX_K} sources.`);
  }
  const baseline = await gen(query, candidates);
  const counter = { n: 1 }; // baseline counts as one generation

  // v(S) cache keyed by the sorted sourceIds of S (order-independent). The full set reuses the
  // baseline (v(N)=1 by construction); every other distinct subset is generated at most once.
  const cache = new Map<string, number>();
  const keyOf = (mask: number): string => {
    const ids: string[] = [];
    for (let i = 0; i < k; i += 1) if (mask & (1 << i)) ids.push(candidates[i].sourceId);
    return ids.sort().join("|");
  };
  const fullMask = (1 << k) - 1;

  const value = async (mask: number): Promise<number> => {
    if (mask === fullMask) return 1; // v(N): baseline vs itself, no generation
    const key = keyOf(mask);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const subset = candidates.filter((_, i) => mask & (1 << i));
    const ablated = await gen(query, subset); // subset may be empty → parametric answer
    counter.n += 1;
    const v = 1 - claimLevelDelta(baseline, ablated);
    cache.set(key, v);
    return v;
  };

  const exactMaxK = opts.exactMaxK ?? 6;
  const useExact = isExact(k, exactMaxK);
  const phi = new Array<number>(k).fill(0);

  if (useExact) {
    // Precompute factorials for the weight |S|!(k-|S|-1)!/k!
    const fact: number[] = [1];
    for (let i = 1; i <= k; i += 1) fact[i] = fact[i - 1] * i;
    for (let i = 0; i < k; i += 1) {
      for (let mask = 0; mask <= fullMask; mask += 1) {
        if (mask & (1 << i)) continue; // S must not contain i
        const s = popcount(mask);
        const weight = (fact[s] * fact[k - s - 1]) / fact[k];
        const withI = await value(mask | (1 << i));
        const withoutI = await value(mask);
        phi[i] += weight * (withI - withoutI);
      }
    }
  } else {
    const m = opts.samples ?? 64;
    if (!Number.isInteger(m) || m < 1) {
      throw new Error(`shapleyCausal: samples must be a positive integer, got ${m}.`);
    }
    const perms = (opts.permutations ?? defaultPermutations)(k, m);
    if (perms.length === 0) {
      throw new Error("shapleyCausal: permutation source returned no permutations.");
    }
    // A malformed permutation (missing/duplicate/out-of-range index) would silently skip or
    // double-count sources and corrupt the averaged φ — validate each is a true ordering of [0,k).
    for (const perm of perms) {
      const seen = new Set(perm);
      if (perm.length !== k || seen.size !== k || [...seen].some((i) => i < 0 || i >= k)) {
        throw new Error(`shapleyCausal: invalid permutation ${JSON.stringify(perm)} for k=${k}.`);
      }
    }
    for (const perm of perms) {
      let prefix = 0;
      let prevV = await value(0); // v(∅)
      for (const idx of perm) {
        const nextMask = prefix | (1 << idx);
        const nextV = await value(nextMask);
        phi[idx] += nextV - prevV;
        prefix = nextMask;
        prevV = nextV;
      }
    }
    for (let i = 0; i < k; i += 1) phi[i] /= perms.length;
  }

  const parametric = Math.max(0, Math.min(1, await value(0)));
  const weights: WeightMap = {};
  for (let i = 0; i < k; i += 1) weights[candidates[i].sourceId] = Math.max(0, phi[i]);
  return { answer: baseline, weights, model: LIVE_MODEL, parametric, generations: counter.n, exact: useExact };
}

function popcount(n: number): number {
  let c = 0;
  while (n) {
    n &= n - 1;
    c += 1;
  }
  return c;
}
