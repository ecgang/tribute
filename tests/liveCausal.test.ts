import { describe, expect, it, vi } from "vitest";
import { liveCausal, type GenerateFn } from "../lib/attribution/active";
import type { RetrievedCandidate } from "../lib/schema";

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

const BASELINE =
  "Water boils at 100 degrees Celsius. The Great Wall is in China. Mount Everest is the tallest mountain.";
const WITHOUT_LOAD_BEARING = "The Great Wall is in China. Mount Everest is the tallest mountain.";

const CANDIDATES = [candidate("load-bearing"), candidate("inert-1"), candidate("inert-2")];

/** Deterministic mock: drops the "water boils" claim iff "load-bearing" is absent from candidates. No network. */
function makeMockGen(): GenerateFn {
  return vi.fn(async (_query: string, cands: RetrievedCandidate[]) => {
    const hasLoadBearing = cands.some((c) => c.sourceId === "load-bearing");
    return hasLoadBearing ? BASELINE : WITHOUT_LOAD_BEARING;
  });
}

describe("liveCausal — injected GenerateFn orchestration (mock, no network)", () => {
  it("calls gen exactly N+1 times (1 baseline + N leave-one-out ablations)", async () => {
    const gen = makeMockGen();
    await liveCausal("what boils and where are things", CANDIDATES, gen);
    expect(gen).toHaveBeenCalledTimes(CANDIDATES.length + 1);
  });

  it("returns weights keyed by every candidate sourceId", async () => {
    const gen = makeMockGen();
    const { weights } = await liveCausal("what boils and where are things", CANDIDATES, gen);
    expect(Object.keys(weights).sort()).toEqual(CANDIDATES.map((c) => c.sourceId).sort());
  });

  it("scores the source whose removal drops a claim higher than inert sources", async () => {
    const gen = makeMockGen();
    const { weights } = await liveCausal("what boils and where are things", CANDIDATES, gen);
    expect(weights["inert-1"]).toBe(0);
    expect(weights["inert-2"]).toBe(0);
    expect(weights["load-bearing"]).toBeGreaterThan(weights["inert-1"]);
    expect(weights["load-bearing"]).toBeGreaterThan(weights["inert-2"]);
  });

  it("returns the baseline answer text and the configured model id", async () => {
    const gen = makeMockGen();
    const { answer, model } = await liveCausal("what boils and where are things", CANDIDATES, gen);
    expect(answer).toBe(BASELINE);
    expect(typeof model).toBe("string");
    expect(model.length).toBeGreaterThan(0);
  });

  it("empty-context ablation (last remaining source removed) yields \"\" not a gen call artifact", async () => {
    const single = [candidate("only-one")];
    const gen: GenerateFn = vi.fn(async (_q, cands) => (cands.length ? BASELINE : "should-not-happen"));
    const { weights } = await liveCausal("solo query", single, gen);
    // gen is called once for baseline, then the ablation has 0 candidates so liveCausal
    // short-circuits to "" without invoking gen a second time (see active.ts: without.length ? gen(...) : "").
    expect(gen).toHaveBeenCalledTimes(1);
    expect(weights["only-one"]).toBe(1);
  });
});
