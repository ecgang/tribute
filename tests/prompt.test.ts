import { describe, expect, it } from "vitest";
import { RAG_SYSTEM, buildContext } from "../lib/attribution/prompt";
import type { RetrievedCandidate } from "../lib/schema";

/**
 * The shared prompt is the single source of truth every entrant (API + benchmark CLIs) uses.
 * If it drifts, the cross-model benchmark stops measuring models and starts measuring prompts.
 */
describe("RAG_SYSTEM contract", () => {
  it("requires on-source answering with inline [n] citations", () => {
    expect(RAG_SYSTEM).toMatch(/ONLY the provided sources/);
    expect(RAG_SYSTEM).toMatch(/\[1\], \[2\]/);
    expect(RAG_SYSTEM).toMatch(/never cite a source you did not use/);
  });
});

describe("buildContext", () => {
  it("renders 1-indexed [Source n] blocks matching the citation markers", () => {
    const cands = [
      { title: "Alpha", chunkText: "alpha body" },
      { title: "Beta", chunkText: "beta body" },
    ] as RetrievedCandidate[];
    expect(buildContext(cands)).toBe("[Source 1] Alpha\nalpha body\n\n[Source 2] Beta\nbeta body");
  });
});
