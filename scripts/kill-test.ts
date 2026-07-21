/**
 * Kill-test harness — "is there a chart here?" (`npm run kill-test`)
 *
 * The newsletter panel (Liotta/Codex/Linus/Gemini) converged on ONE cheap, decisive
 * pre-build experiment: run a batch of trending topics through the REAL engine and measure
 * whether the grounding / citation-dependence signal actually VARIES across topics — or
 * collapses into a flat, predictable band. Liotta's framing: *"a flat line is not a chart."*
 * If every topic lands in the same bucket ("mostly parametric"), the curiosity gap closes by
 * issue #5 and the daily receipt won't retain — kill it before building a pipeline.
 *
 * This script runs the SAME code path as the live open-prompt route
 * (retrieveCandidates → liveCausal → parseCitations → assembleLiveWithReports), so its
 * numbers are the product's real numbers, not a re-implementation.
 *
 * COST: each topic = 1 baseline + k ablation model calls (k≈4) + 1 search call.
 * ~15 topics ≈ 75 Anthropic calls + 15 Tavily calls. Gated behind LIVE_ENABLED=1 + keys,
 * exactly like the paid route. Use `--dry` to list topics + cost estimate without spending.
 *
 *   LIVE_ENABLED=1 ANTHROPIC_API_KEY=… TAVILY_API_KEY=… npm run kill-test
 *   npm run kill-test -- --dry                       # estimate only, no spend
 *   npm run kill-test -- --topics ./today-trends.txt # one topic per line (the day's X trends)
 */
import { readFileSync } from "node:fs";
import { retrieveCandidates } from "../lib/retrieve";
import { liveCausal } from "../lib/attribution/active";
import { anthropicGenerate } from "../lib/attribution/anthropicGenerate";
import { parseCitations } from "../lib/attribution/passive";
import { assembleLiveWithReports } from "../lib/pipeline";
import type { AttributionReport, RagTrace } from "../lib/schema";

/**
 * Default topic set: a deliberate MIX of post-cutoff/recent events (should force grounding)
 * and evergreen/common-knowledge questions (should be mostly parametric). If the signal can't
 * separate even THESE, it certainly won't separate a day's worth of same-flavor trends. Swap in
 * the day's real X trends with `--topics ./file.txt` (one question per line).
 */
const DEFAULT_TOPICS: string[] = [
  // recent / post-cutoff — expected higher grounding
  "What are the terms of the most recent US federal interest rate decision?",
  "What happened in the latest SpaceX Starship test flight?",
  "What are the key provisions of the EU AI Act that took effect this year?",
  "Who won the most recent Formula 1 grand prix and what were the standings?",
  "What is the latest news on the Nvidia GPU export restrictions to China?",
  "What were the results of the most recent major tech company earnings call?",
  "What is the current status of the latest US government shutdown negotiations?",
  "What are the details of the newest flagship smartphone released this month?",
  // evergreen / common-knowledge — expected mostly parametric
  "How does mRNA vaccine technology work?",
  "What caused the 2008 financial crisis?",
  "How does photosynthesis convert sunlight into energy?",
  "What are the main causes of inflation?",
  "How does the electoral college work in US presidential elections?",
  "What is the difference between TCP and UDP?",
  "Why is the sky blue?",
];

interface TopicResult {
  topic: string;
  ok: boolean;
  error?: string;
  retrieved: number;
  /** Share of the answer credited to sources under CAUSAL ablation (1 − parametric). */
  grounding: number;
  parametric: number;
  citationCount: number;
  /** Cited by the model but ~0 causal contribution ("decorative citation"). */
  decorative: number;
  /** Not cited by the model but real causal contribution ("uncredited driver"). */
  uncreditedDrivers: number;
  /** Bucket for the modal-verdict check. */
  bucket: "mostly-parametric" | "mixed" | "well-grounded";
}

const NEAR_ZERO = 0.05; // treat attributionScore below this as "no real contribution"
const CANDIDATES_PER_TOPIC = Number(process.env.KILL_TEST_K ?? 4);

function scoreOf(report: AttributionReport | undefined, sourceId: string): number {
  return report?.sources.find((s) => s.sourceId === sourceId)?.attributionScore ?? 0;
}

function bucketFor(grounding: number): TopicResult["bucket"] {
  if (grounding < 0.33) return "mostly-parametric";
  if (grounding < 0.66) return "mixed";
  return "well-grounded";
}

async function runTopic(topic: string): Promise<TopicResult> {
  const base: TopicResult = {
    topic,
    ok: false,
    retrieved: 0,
    grounding: 0,
    parametric: 1,
    citationCount: 0,
    decorative: 0,
    uncreditedDrivers: 0,
    bucket: "mostly-parametric",
  };
  try {
    const candidates = await retrieveCandidates(topic, CANDIDATES_PER_TOPIC);
    const gen = anthropicGenerate();
    const { answer, weights, model } = await liveCausal(topic, candidates, gen);
    const trace: RagTrace = {
      id: "kill-test",
      title: topic,
      query: topic,
      candidates,
      answer,
      citations: parseCitations(answer, candidates),
      generation: { model, temperature: 0, promptAssemblyRef: "rag-v1" },
    };
    // rsl = [] : we only care about grounding/citation/causal here, not settlement — skip RSL fetches.
    const res = assembleLiveWithReports(trace, [], new Date().toISOString(), weights);
    const causal = res.reports?.causal;
    const citation = res.reports?.citation;

    let decorative = 0;
    let uncreditedDrivers = 0;
    for (const c of candidates) {
      const cited = scoreOf(citation, c.sourceId) > NEAR_ZERO;
      const drove = scoreOf(causal, c.sourceId) > NEAR_ZERO;
      if (cited && !drove) decorative += 1;
      if (!cited && drove) uncreditedDrivers += 1;
    }
    const parametric = causal?.unattributed ?? 1;
    const grounding = Math.max(0, Math.min(1, 1 - parametric));
    return {
      ...base,
      ok: true,
      retrieved: candidates.length,
      grounding,
      parametric,
      citationCount: trace.citations?.length ?? 0,
      decorative,
      uncreditedDrivers,
      bucket: bucketFor(grounding),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/** Bounded-concurrency map so we don't hammer the API rate limits. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function loadTopics(): string[] {
  const flag = process.argv.indexOf("--topics");
  if (flag !== -1 && process.argv[flag + 1]) {
    return readFileSync(process.argv[flag + 1], "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  }
  return DEFAULT_TOPICS;
}

async function main(): Promise<void> {
  const topics = loadTopics();
  const dry = process.argv.includes("--dry");
  const estCalls = topics.length * (1 + CANDIDATES_PER_TOPIC);

  console.log(`\nTribute kill-test — grounding-variance experiment`);
  console.log(`Topics: ${topics.length} | candidates/topic (k): ${CANDIDATES_PER_TOPIC}`);
  console.log(`Estimated spend: ~${estCalls} Anthropic calls + ${topics.length} Tavily searches\n`);

  if (dry) {
    console.log("--dry: listing topics only, no spend.\n");
    topics.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t}`));
    console.log("\nRe-run without --dry (and with LIVE_ENABLED=1 + keys) to execute.\n");
    return;
  }

  if (process.env.LIVE_ENABLED !== "1") {
    console.error(
      "Refusing to spend: set LIVE_ENABLED=1 (plus ANTHROPIC_API_KEY + TAVILY_API_KEY) to run the paid harness.\n" +
        "Or use `npm run kill-test -- --dry` for a no-cost estimate.",
    );
    process.exitCode = 1;
    return;
  }

  const t0 = Date.now();
  const results = await pool(topics, 3, async (topic, i) => {
    const r = await runTopic(topic);
    const tag = r.ok
      ? `grounding ${(r.grounding * 100).toFixed(0)}% | cites ${r.citationCount} | decorative ${r.decorative} | drivers ${r.uncreditedDrivers}`
      : `ERROR ${r.error}`;
    console.log(`  [${String(i + 1).padStart(2)}/${topics.length}] ${tag}  — ${topic.slice(0, 60)}`);
    return r;
  });

  const ok = results.filter((r) => r.ok);
  const grounds = ok.map((r) => r.grounding);
  const sd = stdev(grounds);
  const buckets = {
    "mostly-parametric": ok.filter((r) => r.bucket === "mostly-parametric").length,
    mixed: ok.filter((r) => r.bucket === "mixed").length,
    "well-grounded": ok.filter((r) => r.bucket === "well-grounded").length,
  };
  const modalShare = ok.length ? Math.max(...Object.values(buckets)) / ok.length : 1;

  // Heuristic verdict — the whole point of the test.
  const flat = sd < 0.08 || modalShare > 0.7;
  const strong = sd > 0.15 && modalShare < 0.6;
  const verdict = flat
    ? "FLAT LINE → likely KILL. The signal doesn't separate topics; a daily receipt would be predictable by issue #5."
    : strong
      ? "REAL SPREAD → worth proceeding to the predict-then-reveal human test."
      : "MODEST SPREAD → borderline; look at the per-topic table before deciding.";

  console.log(`\n${"=".repeat(72)}`);
  console.log(`RESULT — ${ok.length}/${results.length} topics succeeded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`Grounding %: mean ${(mean(grounds) * 100).toFixed(0)}  min ${(Math.min(...grounds) * 100).toFixed(0)}  max ${(Math.max(...grounds) * 100).toFixed(0)}  stdev ${(sd * 100).toFixed(1)}pp`);
  console.log(`Buckets: mostly-parametric ${buckets["mostly-parametric"]} | mixed ${buckets.mixed} | well-grounded ${buckets["well-grounded"]}  (modal share ${(modalShare * 100).toFixed(0)}%)`);
  console.log(`Decorative citations seen: ${ok.reduce((a, r) => a + r.decorative, 0)} | uncredited drivers: ${ok.reduce((a, r) => a + r.uncreditedDrivers, 0)}`);
  console.log(`\nVERDICT: ${verdict}`);
  console.log(
    `\nCaveats: leave-one-out UNDER-credits redundant sources (a fact in 3 sources scores ~0 each),\n` +
      `so low grounding = "no single source was necessary", not "unused". This measures citation-\n` +
      `DEPENDENCE, not truth — parametric ≠ false. The human predict-then-reveal test is still required.\n`,
  );

  // Persist the raw rows so the panel's "is there a chart" question can be eyeballed / charted later.
  const out = { ranAt: new Date().toISOString(), k: CANDIDATES_PER_TOPIC, stdev: sd, modalShare, buckets, results };
  const path = `scripts/kill-test-result-${Date.now()}.json`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`Raw rows → ${path}\n`);
}

void main();
