import { describe, expect, it } from "vitest";
import { evaluate } from "../lib/eval";
import { claimLevelDelta, splitClaims } from "../lib/attribution/active";

describe("eval harness — independent accuracy", () => {
  const r = evaluate();
  const by = (id: string) => r.backends.find((b) => b.backend === id)!;

  it("causal rejects unused sources better than naive retrieval", () => {
    expect(by("causal").rejection).toBeGreaterThan(by("retrieval").rejection);
    expect(by("causal").falseAttribution).toBeLessThan(by("retrieval").falseAttribution);
  });

  it("accuracy increases with cost (retrieval < citation < causal)", () => {
    expect(by("citation").rejection).toBeGreaterThan(by("retrieval").rejection);
    expect(by("causal").rejection).toBeGreaterThan(by("citation").rejection);
    expect(by("causal").cost).toBeGreaterThan(by("citation").cost);
  });

  it("labels at least 3 independent ground-truth-unused sources", () => {
    expect(r.unusedSampleCount).toBeGreaterThanOrEqual(3);
  });
});

describe("claim-level causal delta — content, not phrasing", () => {
  it("identical content → ~0 delta even when reworded", () => {
    const a = "Water boils at 100 degrees Celsius. The sky is blue.";
    const b = "The sky is blue. Water boils at one hundred degrees Celsius.";
    expect(claimLevelDelta(a, b)).toBeLessThan(0.5);
  });

  it("a dropped claim registers as lost", () => {
    const a = "Webb launched in December 2021. Its mirror is 6.5 meters wide.";
    const ablated = "Webb launched in December 2021.";
    expect(claimLevelDelta(a, ablated)).toBeGreaterThan(0.3);
  });

  it("empty ablated answer → full delta", () => {
    expect(claimLevelDelta("Some factual claim about a topic here.", "")).toBe(1);
  });

  it("splitClaims drops trivially short fragments", () => {
    expect(splitClaims("Hi. This is a real sentence with content.")).toHaveLength(1);
  });
});
