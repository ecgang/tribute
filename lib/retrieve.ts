/**
 * Open-prompt retrieval layer.
 *
 * For an arbitrary user query we must assemble a real candidate source set before the
 * attribution pipeline can run. This is the ONLY new component needed for open prompts —
 * everything downstream (generation, all backends, RSL discovery, scoring, settlement,
 * audit) is already source-agnostic.
 *
 * Uses Tavily (returns title+url+content snippets ready to use as candidates). Pluggable;
 * swap the provider without touching the rest of the pipeline.
 */
import type { RetrievedCandidate } from "./schema";
import { sourceIdFor } from "./sourceResolver";

export class SearchUnavailableError extends Error {}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export async function retrieveCandidates(query: string, k = 4): Promise<RetrievedCandidate[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new SearchUnavailableError(
      "TAVILY_API_KEY not set — open-prompt retrieval unavailable.",
    );
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let results: TavilyResult[];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: k,
        search_depth: "basic",
      }),
    });
    if (!res.ok) throw new SearchUnavailableError(`Tavily HTTP ${res.status}`);
    const json = (await res.json()) as { results?: TavilyResult[] };
    results = json.results ?? [];
  } finally {
    clearTimeout(t);
  }

  if (results.length === 0) {
    throw new SearchUnavailableError("No sources retrieved for that query.");
  }

  return results.slice(0, k).map((r, i) => ({
    sourceId: sourceIdFor(r.url),
    sourceUrl: r.url,
    title: r.title || new URL(r.url).hostname,
    chunkText: (r.content || "").slice(0, 1200),
    // Tavily relevance score when present, else a gentle rank-based decay.
    retrievalScore: r.score != null ? clamp01(r.score) : clamp01(1 - i * 0.15),
    rank: i + 1,
    authorityPrior: 1,
  }));
}
