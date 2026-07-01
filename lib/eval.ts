/**
 * Eval harness — the credibility layer.
 *
 * The hard objection to any attribution meter: "your synthetic ground truth uses the same
 * similarity assumption as your backends, so you've shown self-consistency, not accuracy."
 * We answer it two ways that do NOT depend on the backends' own logic:
 *
 *  1. FALSE-ATTRIBUTION RATE — over sources we INDEPENDENTLY labeled `groundTruthUnused`
 *     (distractors retrieved-but-unused; parametric-knowledge sources the model already
 *     knew), how much weight does each backend wrongly assign? Lower = better. This is a
 *     falsifiable number we control, not circular.
 *
 *  2. CALIBRATION vs CAUSAL — how well does each cheap/passive backend's ranking track the
 *     measured leave-one-out (causal) backend? Causal contribution is behavioral, not
 *     similarity-based, so it's an independent yardstick for the cheap backends.
 *
 * Plus the COST/FIDELITY curve: accuracy vs the number of model generations each backend
 * costs — the "dial accuracy per budget" economics.
 */
import { BACKENDS, type BackendId, type RagTrace } from "./schema";
import { SAMPLE_TRACES } from "./sampleTraces";
import { relevanceWeights } from "./attribution";
import { buildReport } from "./scoring";

/** Extra model generations each backend costs to attribute one response. */
export const BACKEND_COST: Record<BackendId, number> = {
  retrieval: 0, // pure retrieval metadata
  citation: 1, // needs the answer + its citations (one generation)
  semantic: 0, // embeddings only, no generation
  causal: 0, // set per-trace below: 1 baseline + N ablations
};

/**
 * Loader seam — the labeled dataset the benchmark runs over. Today this is the
 * hand-authored, independently-labeled SAMPLE_TRACES (canned mode). The metric
 * computation below (evaluate) only depends on this function's return shape, so a
 * larger/real corpus can be swapped in here without touching the math.
 *
 * // TODO: dataset adapters (RAGAS/ALCE/AIS corpora) — load real labeled traces from
 * those benchmarks instead of/alongside SAMPLE_TRACES. Out of scope for this change;
 * see plans/009-eval-benchmark-module.md.
 */
export function loadBenchmarkTraces(): RagTrace[] {
  return SAMPLE_TRACES;
}

function scoresFor(
  traces: RagTrace[],
  traceIndex: number,
  backend: BackendId,
): Record<string, number> {
  const trace = traces[traceIndex];
  const rel = relevanceWeights(trace, backend);
  const report = buildReport(trace, backend, rel, "canned");
  const out: Record<string, number> = {};
  for (const s of report.sources) out[s.sourceId] = s.attributionScore;
  return out;
}

/** Spearman rank correlation between two score vectors over the same keys. */
function spearman(a: Record<string, number>, b: Record<string, number>): number {
  const keys = Object.keys(a);
  if (keys.length < 2) return 1;
  const rank = (vals: Record<string, number>): Record<string, number> => {
    const sorted = [...keys].sort((x, y) => vals[y] - vals[x]);
    const r: Record<string, number> = {};
    sorted.forEach((k, i) => (r[k] = i));
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = keys.length;
  let d2 = 0;
  for (const k of keys) d2 += (ra[k] - rb[k]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export interface BackendEval {
  backend: BackendId;
  /** Mean attribution wrongly assigned to ground-truth-unused sources (lower better). */
  falseAttribution: number;
  /** 1 − falseAttribution. The headline "distractor rejection" accuracy. */
  rejection: number;
  /** Mean rank agreement with the causal backend (1.0 for causal itself). */
  calibrationVsCausal: number;
  /** Generations cost to attribute one response. */
  cost: number;
}

export interface EvalResult {
  backends: BackendEval[];
  unusedSampleCount: number;
  traceCount: number;
}

export function evaluate(): EvalResult {
  const traces = loadBenchmarkTraces();

  // Average causal cost across traces = 1 baseline + N ablations.
  const avgCausalCost = traces.reduce((a, t) => a + 1 + t.candidates.length, 0) / traces.length;

  // Collect causal scores per trace once (the calibration yardstick).
  const causalScores = traces.map((_, i) => scoresFor(traces, i, "causal"));

  let unusedSampleCount = 0;
  traces.forEach((t) =>
    t.candidates.forEach((c) => {
      if (c.groundTruthUnused) unusedSampleCount += 1;
    }),
  );

  const backends: BackendEval[] = BACKENDS.map((backend) => {
    let unusedWeightSum = 0;
    let unusedCount = 0;
    let calibSum = 0;

    traces.forEach((trace, i) => {
      const scores = scoresFor(traces, i, backend);
      trace.candidates.forEach((c) => {
        if (c.groundTruthUnused) {
          unusedWeightSum += scores[c.sourceId] ?? 0;
          unusedCount += 1;
        }
      });
      calibSum += spearman(scores, causalScores[i]);
    });

    const falseAttribution = unusedCount ? unusedWeightSum / unusedCount : 0;
    return {
      backend,
      falseAttribution: Number(falseAttribution.toFixed(4)),
      rejection: Number((1 - falseAttribution).toFixed(4)),
      calibrationVsCausal: Number((calibSum / traces.length).toFixed(3)),
      cost: backend === "causal" ? Number(avgCausalCost.toFixed(1)) : BACKEND_COST[backend],
    };
  });

  return { backends, unusedSampleCount, traceCount: traces.length };
}

/**
 * Formats an EvalResult into a plain-text, citable benchmark table: a one-line headline
 * (the pitch's measured claim) followed by a per-backend table. Pure formatting — no
 * metric computation happens here.
 */
export function formatReport(result: EvalResult): string {
  const causal = result.backends.find((b) => b.backend === "causal");
  const retrieval = result.backends.find((b) => b.backend === "retrieval");
  const headline =
    causal && retrieval
      ? `Causal rejects ${(causal.rejection * 100).toFixed(1)}% of provably-unused sources; ` +
        `naive retrieval only ${(retrieval.rejection * 100).toFixed(1)}% — measured on ` +
        `${result.unusedSampleCount} labeled sources across ${result.traceCount} traces.`
      : `Measured on ${result.unusedSampleCount} labeled sources across ${result.traceCount} traces.`;

  const header = ["backend", "rejection", "false-attr", "calibration", "cost"];
  const rows = result.backends.map((b) => [
    b.backend,
    b.rejection.toFixed(4),
    b.falseAttribution.toFixed(4),
    b.calibrationVsCausal.toFixed(3),
    String(b.cost),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const formatRow = (cols: string[]): string =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");

  const table = [
    formatRow(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(formatRow),
  ].join("\n");

  return `${headline}\n\n${table}`;
}
