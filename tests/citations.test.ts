import { describe, expect, it, vi } from "vitest";
import {
  citationWeights,
  parseCitations,
  stripCitationMarkers,
} from "../lib/attribution/passive";
import { claimLevelDelta, liveCausal, type GenerateFn } from "../lib/attribution/active";
import { assembleLiveWithReports } from "../lib/pipeline";
import type { RagTrace, RetrievedCandidate } from "../lib/schema";

function candidate(sourceId: string): RetrievedCandidate {
  return {
    sourceId,
    sourceUrl: `https://example.com/${sourceId}`,
    title: `Title ${sourceId}`,
    chunkText: `Chunk text for ${sourceId}`,
    retrievalScore: 0.9,
    rank: 1,
    authorityPrior: 1,
  };
}

describe("stripCitationMarkers", () => {
  it("removes single, grouped, and spaced markers and tidies whitespace", () => {
    expect(stripCitationMarkers("Paris is the capital [1].")).toBe("Paris is the capital.");
    expect(stripCitationMarkers("A fact [1, 2] and another [3].")).toBe("A fact and another.");
    expect(stripCitationMarkers("No markers here.")).toBe("No markers here.");
  });
});

describe("parseCitations", () => {
  const cands = [candidate("a"), candidate("b")];

  it("maps 1-indexed markers to the matching candidate sourceId", () => {
    const cites = parseCitations("Paris is the capital [1]. Berlin is in Germany [2].", cands);
    expect(cites.map((c) => c.sourceId)).toEqual(["a", "b"]);
  });

  it("expands grouped markers to one citation each", () => {
    const cites = parseCitations("Both agree on this [1, 2].", cands);
    expect(cites.map((c) => c.sourceId).sort()).toEqual(["a", "b"]);
  });

  it("dedupes a repeated marker within one group ([1, 1] counts once)", () => {
    const cites = parseCitations("Strongly supported [1, 1].", cands);
    expect(cites.map((c) => c.sourceId)).toEqual(["a"]);
  });

  it("ignores out-of-range / malformed markers instead of crediting a phantom source", () => {
    const cites = parseCitations("A hallucinated cite [9] and a real one [1].", cands);
    expect(cites.map((c) => c.sourceId)).toEqual(["a"]);
  });

  it("records the (marker-stripped) sentence as the claim", () => {
    const cites = parseCitations("Water boils at 100C [1].", cands);
    expect(cites[0]?.claim).toBe("Water boils at 100C.");
  });

  it("feeds citationWeights into a real per-source share", () => {
    const trace = {
      candidates: cands,
      citations: parseCitations("X is true [1]. Y is also true [1]. Z holds [2].", cands),
    } as unknown as RagTrace;
    const w = citationWeights(trace);
    expect(w["a"]).toBeCloseTo(2 / 3, 5);
    expect(w["b"]).toBeCloseTo(1 / 3, 5);
  });
});

describe("claimLevelDelta is invariant to inline [n] markers", () => {
  it("scores identical content as 0 whether or not markers are present", () => {
    const withMarkers = "Foo happens here [1]. Bar occurs there [2].";
    const without = "Foo happens here. Bar occurs there.";
    expect(claimLevelDelta(withMarkers, without)).toBe(0);
    expect(claimLevelDelta(withMarkers, withMarkers)).toBe(0);
  });
});

/**
 * The demonstration itself, as a regression test: a source the answer CITES contributes ~0
 * causally, while an UNCITED source actually drives the answer. Baseline cites [1] (s1) but the
 * load-bearing "Beta" claim only survives when s2 is present.
 */
describe("citation ≠ causation — the live receipt", () => {
  const CANDIDATES = [candidate("s1"), candidate("s2")];

  const makeGen = (): GenerateFn =>
    vi.fn(async (_q: string, cands: RetrievedCandidate[]) => {
      const hasS1 = cands.some((c) => c.sourceId === "s1");
      const hasS2 = cands.some((c) => c.sourceId === "s2");
      if (hasS1 && hasS2)
        return "Alpha fact holds according to records [1]. Beta fact also clearly holds true.";
      if (hasS1) return "Alpha fact holds according to records [1]."; // s2 removed → Beta lost
      if (hasS2) return "Alpha fact holds according to records. Beta fact also clearly holds true."; // s1 removed → both survive
      return "";
    });

  it("credits the cited source on citation but the uncited source on causal", async () => {
    const query = "alpha and beta facts";
    const { answer, weights } = await liveCausal(query, CANDIDATES, makeGen());

    // Causal: removing s1 changes nothing (0); removing s2 drops the Beta claim (>0).
    expect(weights["s1"]).toBe(0);
    expect(weights["s2"]).toBeGreaterThan(0);

    const liveTrace: RagTrace = {
      id: "open",
      title: "Open prompt",
      query,
      candidates: CANDIDATES,
      answer,
      citations: parseCitations(answer, CANDIDATES),
    };
    const res = assembleLiveWithReports(liveTrace, [], "2026-07-20T00:00:00.000Z", weights);

    const score = (backend: "citation" | "causal", id: string) =>
      res.reports?.[backend]?.sources.find((s) => s.sourceId === id)?.attributionScore ?? 0;

    // Citation credits the cited source (s1); causal credits the real driver (s2).
    expect(score("citation", "s1")).toBeGreaterThan(score("citation", "s2"));
    expect(score("causal", "s2")).toBeGreaterThan(score("causal", "s1"));
    // The headline divergence: s1 is cited-but-inert, s2 is uncredited-but-load-bearing.
    expect(score("citation", "s1")).toBeGreaterThan(0);
    expect(score("causal", "s1")).toBe(0);
    expect(score("causal", "s2")).toBeGreaterThan(0);

    // Primary report stays causal (drives settlement + audit).
    expect(res.report.backend).toBe("causal");
  });
});
