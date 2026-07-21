/**
 * Cross-model attribution benchmark — "do models cite what they actually use?" (`npm run benchmark-models`)
 *
 * Given the SAME retrieved sources, drive each model (Claude API / GPT via Codex CLI / Gemini via
 * agy) through the real pipeline and measure citation FAITHFULNESS: of what each model cited, how
 * much actually did causal work (precision), and of what did work, how much it credited (recall).
 * Produces a ranked leaderboard — the citeable, event-driven demonstration that replaces the
 * (killed) daily newsletter. See plans/wild-questing-eclipse.md.
 *
 *   npm run benchmark-models -- --dry                 # cost estimate, no spend
 *   npm run benchmark-models -- --smoke               # 1 question × all models (validation gate)
 *   LIVE_ENABLED=1 ANTHROPIC_API_KEY=… TAVILY_API_KEY=… npm run benchmark-models
 *   npm run benchmark-models -- --questions ./qs.txt --k 4
 *
 * Fairness: one retrieval per question, shared across all models (cached so a resumed run reuses
 * the identical source set). Honest caveats are printed on every result — see the footer.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retrieveCandidates } from "../lib/retrieve";
import { parseCitations } from "../lib/attribution/passive";
import { RAG_SYSTEM } from "../lib/attribution/prompt";
import { shapleyCausal, shapleyGenerationCount } from "../lib/attribution/shapley";
import type { RetrievedCandidate } from "../lib/schema";
import { citationFaithfulness, isAbstention } from "./faithfulness";
import { defaultEntrants, type Entrant } from "./providers";

/** A source counts as causal if its Shapley credit exceeds this share of the answer. */
const CAUSAL_EPS = 0.05;
const K = Number(process.env.BENCH_K ?? argFlag("--k") ?? 3);
const CACHE_DIR = join("scripts", ".bench-cache");
/** Bump when the prompt, metric, or scoring logic changes — folded into the cache key so a config
 *  change can't silently reuse stale cached answers under a fresh run timestamp (reviewer finding).
 *  v3 = Shapley-value causal attribution (replaced strict leave-one-out). */
const BENCH_VERSION = "3";
const PROMPT_HASH = createHash("sha1").update(RAG_SYSTEM).digest("hex").slice(0, 8);

const DEFAULT_QUESTIONS = [
  "What are the key provisions of the EU AI Act that took effect this year?",
  "How does mRNA vaccine technology work?",
  "What caused the 2008 financial crisis?",
  "What is the latest news on Nvidia GPU export restrictions to China?",
  "How does the electoral college work in US presidential elections?",
];

export interface ModelResult {
  entrantId: string;
  label: string;
  ok: boolean;
  error?: string;
  answer?: string;
  /** False when faithfulness isn't measurable — either no source was individually causal (redundant
   *  sources) OR the model honestly abstained. Excluded from F1 rather than scored a misleading 0. */
  applicable: boolean;
  /** The model explicitly declined to cite because the sources didn't cover the question. */
  abstained: boolean;
  citationCount: number;
  grounding: number;
  decorative: number;
  uncredited: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface QuestionRecord {
  question: string;
  sources: number;
  results: ModelResult[];
}

function argFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function cacheKey(question: string): string {
  return createHash("sha1")
    .update(`${BENCH_VERSION}::${PROMPT_HASH}::${K}::${question}`)
    .digest("hex")
    .slice(0, 16);
}

function readCache<T>(name: string): T | undefined {
  const p = join(CACHE_DIR, name);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeCache(name: string, data: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, name), JSON.stringify(data));
}

/** Retrieve once per question, cached — so every model (and every resumed run) sees identical sources. */
async function sourcesFor(question: string): Promise<RetrievedCandidate[]> {
  const name = `${cacheKey(question)}-sources.json`;
  const cached = readCache<RetrievedCandidate[]>(name);
  if (cached) return cached;
  const cands = await retrieveCandidates(question, K);
  writeCache(name, cands);
  return cands;
}

async function runModel(
  entrant: Entrant,
  question: string,
  candidates: RetrievedCandidate[],
): Promise<ModelResult> {
  const name = `${cacheKey(question)}-${entrant.id}.json`;
  const cached = readCache<ModelResult>(name);
  if (cached) return cached;

  const base: ModelResult = {
    entrantId: entrant.id,
    label: entrant.label,
    ok: false,
    applicable: false,
    abstained: false,
    citationCount: 0,
    grounding: 0,
    decorative: 0,
    uncredited: 0,
    precision: 0,
    recall: 0,
    f1: 0,
  };
  try {
    const { answer, weights, parametric } = await shapleyCausal(
      question,
      candidates,
      entrant.makeGen(),
    );
    if (!answer.trim()) throw new Error("empty answer");
    const citations = parseCitations(answer, candidates);
    // The faithfulness sets are built from the RAW signals — the model's own citations and the
    // Shapley causal weights — NOT the composite attributionScore (reviewer finding: the composite
    // blends relevance/authority/uniqueness and would confound the metric).
    // `cited`  = exactly the sources the model cited (from its own inline [n] markers).
    // `causalSet` = sources whose Shapley credit cleared CAUSAL_EPS (redundancy-robust).
    const cited = new Set(citations.map((cit) => cit.sourceId));
    const causalSet = new Set(
      candidates.filter((c) => (weights[c.sourceId] ?? 0) > CAUSAL_EPS).map((c) => c.sourceId),
    );
    let decorative = 0;
    let uncredited = 0;
    for (const c of candidates) {
      const isCited = cited.has(c.sourceId);
      const drove = causalSet.has(c.sourceId);
      if (isCited && !drove) decorative += 1;
      if (!isCited && drove) uncredited += 1;
    }
    const { precision, recall, f1 } = citationFaithfulness(cited, causalSet);
    const citationCount = citations.length;
    // Abstention only EXCUSES a question when there is no causal signal at all. If ablation proved a
    // source drove the answer, a "from general knowledge" disclaimer must NOT hide that uncredited
    // driver — it stays scored (reviewer finding). So abstained ⇒ causalSet is empty.
    const abstained = causalSet.size === 0 && isAbstention(answer, citationCount);
    const result: ModelResult = {
      ...base,
      ok: true,
      applicable: causalSet.size > 0,
      abstained,
      answer,
      citationCount,
      // Grounding = 1 − parametric, straight from Shapley's efficiency identity (Σφ = v(N) − v(∅)),
      // cleaner and consistent with the causal weights than the composite report's `unattributed`.
      grounding: Math.max(0, Math.min(1, 1 - parametric)),
      decorative,
      uncredited,
      precision,
      recall,
      f1,
    };
    writeCache(name, result);
    return result;
  } catch (e) {
    return { ...base, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function aggregate(records: QuestionRecord[], entrants: Entrant[]) {
  return entrants
    .map((e) => {
      // Track WHICH questions (by index) this model was scored on, not just how many — so the
      // leaderboard can compare models over the exact same questions (reviewer finding).
      const perQ = records.map((r, qi) => ({ qi, res: r.results.find((x) => x.entrantId === e.id) }));
      const ok = perQ.filter((x) => x.res?.ok);
      const scored = ok.filter((x) => x.res?.applicable);
      const abstained = ok.filter((x) => x.res?.abstained).length;
      return {
        id: e.id,
        label: e.label,
        n: ok.length,
        nScored: scored.length,
        scoredQ: scored.map((x) => x.qi),
        abstained,
        redundant: ok.length - scored.length - abstained,
        f1: mean(scored.map((x) => x.res!.f1)),
        precision: mean(scored.map((x) => x.res!.precision)),
        recall: mean(scored.map((x) => x.res!.recall)),
        grounding: mean(ok.map((x) => x.res!.grounding)),
        decorative: ok.reduce((a, x) => a + (x.res?.decorative ?? 0), 0),
        uncredited: ok.reduce((a, x) => a + (x.res?.uncredited ?? 0), 0),
      };
    })
    .sort((a, b) => b.f1 - a.f1);
}

export function renderMarkdown(
  rows: ReturnType<typeof aggregate>,
  records: QuestionRecord[],
  questions: string[],
  ranAt: string,
): string {
  // Only models with a real faithfulness signal count toward the spread — a model that errored or
  // abstained/redundant on everything (nScored===0) is "no data", NOT an F1 of 0.00.
  const scoredRows = rows.filter((r) => r.nScored > 0);
  // The spread MUST be computed over the questions ALL scored models share (their intersection) —
  // comparing F1 across disjoint question sets is apples-to-oranges even if the counts match
  // (reviewer finding). The per-model F1 in the table is each model's own scorable set; the verdict's
  // spread is over the common intersection only.
  const intersection =
    scoredRows.length > 0
      ? scoredRows
          .map((r) => new Set(r.scoredQ))
          .reduce((a, b) => new Set([...a].filter((qi) => b.has(qi))))
      : new Set<number>();
  const f1OnIntersection = (id: string): number =>
    mean(
      [...intersection]
        .map((qi) => records[qi].results.find((x) => x.entrantId === id && x.applicable)?.f1)
        .filter((v): v is number => v != null),
    );
  const interF1 = scoredRows.map((r) => f1OnIntersection(r.id));
  const spread = interF1.length ? Math.max(...interF1) - Math.min(...interF1) : 0;
  // Flag when models were scored on non-identical question sets (some scored questions lie outside
  // the shared intersection) — the spread then rests only on the common ones.
  const setsDiffer = scoredRows.some((r) => r.nScored !== intersection.size);
  const setsWarn = setsDiffer
    ? ` ⚠ UNEQUAL SAMPLES — models were scored on different question sets (${scoredRows.map((r) => `${r.label.split(" ")[0]} ${r.nScored}q`).join(", ")}); spread is over the ${intersection.size} question(s) they share, not all questions.`
    : "";
  const verdict =
    scoredRows.length < 2
      ? `INSUFFICIENT DATA — fewer than 2 models produced a measurable faithfulness signal (${scoredRows.length}/${rows.length}). Fix the failing transports or use questions with less-redundant sources, then re-run.`
      : intersection.size === 0
        ? `NO COMMON QUESTIONS — the scored models share no question where all had a measurable signal, so they can't be compared. Re-run so they overlap.${setsWarn}`
        : spread > 0.1
          ? `REAL SPREAD (F1 range ${spread.toFixed(2)} over ${intersection.size} shared question(s)) — the models measurably differ.${setsWarn}`
          : `NARROW SPREAD (F1 range ${spread.toFixed(2)} over ${intersection.size} shared question(s)) — models behave similarly; widen the question bank before publishing.${setsWarn}`;
  const lines = [
    `# Tribute Attribution Benchmark`,
    ``,
    `_Given identical retrieved sources, do these models cite what they causally used?_`,
    ``,
    `Ran ${ranAt} · ${questions.length} questions · k=${K} sources each`,
    ``,
    `| Rank | Model | Faithfulness F1 | Precision | Recall | Grounding | Decorative cites | Uncredited drivers | Abstained | Scored / n |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
    ...rows.map((r, i) => {
      const f1 = r.nScored > 0 ? `**${r.f1.toFixed(2)}**` : "— (no data)";
      const p = r.nScored > 0 ? r.precision.toFixed(2) : "—";
      const rec = r.nScored > 0 ? r.recall.toFixed(2) : "—";
      const g = r.n > 0 ? `${(r.grounding * 100).toFixed(0)}%` : "—";
      return `| ${i + 1} | ${r.label} | ${f1} | ${p} | ${rec} | ${g} | ${r.decorative} | ${r.uncredited} | ${r.abstained} | ${r.nScored}/${r.n} |`;
    }),
    ``,
    `**Verdict:** ${verdict}`,
    ``,
    `## How to read it`,
    `- **Precision** = of the sources a model cited, the fraction that carried real Shapley causal credit. Low precision = decorative citations.`,
    `- **Recall** = of the sources that carried causal credit, the fraction the model actually cited. Low recall = uncredited drivers.`,
    `- **F1** = the balance of the two. Higher = the model's citations more faithfully track what drove its answer.`,
    ``,
    `## Methodology & honest caveats`,
    `- **Causal credit = Shapley values** over source subsets: each source is credited by its average marginal contribution to the answer's claims. Unlike strict leave-one-out, redundant sources SHARE credit (a fact in 3 sources → each ~1/3) instead of all scoring 0, so faithfulness reflects the model, not source redundancy.`,
    `- **Same sources for every model** (one retrieval per question, shared) — this measures citation behavior, not retrieval quality.`,
    `- **We can only audit models we drive over our source set** — this is NOT an audit of ChatGPT.com / Perplexity's live black box (we don't control their retrieval).`,
    `- **Transport (asymmetric):** Claude runs via the Anthropic API (temp 0, raw); Gemini via the agy CLI; GPT via the Codex CLI. Three transports — Claude is a raw API while Gemini/GPT are agent-wrapped, so some cross-model difference may reflect the wrapper, not the model. Directional, not bit-reproducible.`,
    `- **Abstained** = the model explicitly declined to cite because the sources didn't cover the question (an HONEST response our prompt allows). These are excluded from F1 rather than scored 0 — otherwise honesty would look like unfaithfulness. A high abstention count is itself a signal (that model refuses to cite ill-fitting sources).`,
    `- **Grounding = 1 − parametric**, where parametric = the share of the answer's claims that survive with ZERO sources (Shapley v(∅)). It's the model's own-knowledge share, measured, not the composite report.`,
    `- **Scored / n**: questions where the answer was fully parametric (no source carried causal credit) have no faithfulness signal and are excluded from F1 (counted in n, not in Scored).`,
    `- **Faithfulness ≠ truth.** A parametric answer isn't necessarily false; a grounded one isn't necessarily true.`,
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const smoke = process.argv.includes("--smoke");
  const qFile = argFlag("--questions");
  let questions = qFile
    ? readFileSync(qFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : DEFAULT_QUESTIONS;
  if (smoke) questions = questions.slice(0, 1);

  const entrants = defaultEntrants();
  const { exact, generations: genPerQ } = shapleyGenerationCount(K); // Shapley: 2^k, not k+1
  const estGen = questions.length * entrants.length * genPerQ;

  console.log(`\nTribute cross-model attribution benchmark`);
  console.log(`Models: ${entrants.map((e) => e.label).join(", ")}`);
  console.log(
    `Questions: ${questions.length} | k: ${K} | Shapley ${exact ? "exact" : "sampled"} | est. generations: ~${estGen} (${genPerQ}/model/question)`,
  );
  console.log(`(Claude via Anthropic API; Gemini via agy; GPT via Codex — one Tavily search per question)`);
  if (K >= 5) console.log(`⚠ k=${K}: Shapley is 2^k=${2 ** K} generations/model/question — this is a large, slow, quota-heavy run.`);
  console.log("");

  if (dry) {
    console.log("--dry: no spend. Questions:");
    questions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
    console.log(`\nRe-run without --dry (LIVE_ENABLED=1 + keys, codex/agy signed in) to execute.\n`);
    return;
  }

  if (process.env.LIVE_ENABLED !== "1") {
    console.error("Refusing to spend: set LIVE_ENABLED=1 (+ TAVILY_API_KEY, and agy signed in). Use --dry to estimate.");
    process.exitCode = 1;
    return;
  }

  const ranAt = new Date().toISOString();
  const records: QuestionRecord[] = [];
  for (const [qi, question] of questions.entries()) {
    console.log(`\n[Q${qi + 1}/${questions.length}] ${question}`);
    // Wrap the WHOLE per-question body: a single retrieval flake (Tavily rate-limit/timeout) must
    // NOT throw out of the loop and abort an unattended paid run before any output is written
    // (reviewer blocker). On failure we record an empty result set for the question and continue,
    // so every question that DID succeed still lands in the final leaderboard.
    try {
      const candidates = await sourcesFor(question);
      const results: ModelResult[] = [];
      for (const entrant of entrants) {
        const r = await runModel(entrant, question, candidates); // sequential: CLIs dislike parallel sessions
        results.push(r);
        console.log(
          r.ok
            ? `    ${entrant.label.padEnd(26)} F1 ${r.f1.toFixed(2)} | P ${r.precision.toFixed(2)} R ${r.recall.toFixed(2)} | cites ${r.citationCount} decorative ${r.decorative} uncredited ${r.uncredited}${r.ok && !r.applicable ? " (not scored)" : ""}`
            : `    ${entrant.label.padEnd(26)} ERROR ${r.error}`,
        );
      }
      records.push({ question, sources: candidates.length, results });
    } catch (e) {
      console.error(`    retrieval failed — skipping question: ${e instanceof Error ? e.message : String(e)}`);
      records.push({ question, sources: 0, results: [] });
    }
  }

  const rows = aggregate(records, entrants);
  const md = renderMarkdown(rows, records, questions, ranAt);
  const stamp = ranAt.replace(/[:.]/g, "-");
  writeFileSync(`scripts/benchmark-result-${stamp}.md`, md);
  writeFileSync(`scripts/benchmark-result-${stamp}.json`, JSON.stringify({ ranAt, k: K, rows, records }, null, 2));

  console.log(`\n${"=".repeat(72)}`);
  console.log(md);
  console.log(`\nLeaderboard → scripts/benchmark-result-${stamp}.md  (raw rows in the .json)\n`);
}

void main();
