import { describe, expect, it } from "vitest";
import { SAMPLE_TRACE_BY_ID } from "../lib/sampleTraces";
import { discoverAll } from "../lib/rslDiscovery";
import { assembleResponse } from "../lib/pipeline";
import { verifyChain } from "../lib/audit";
import type { BackendId, RagTrace } from "../lib/schema";

const TS = "2026-06-30T00:00:00.000Z";

async function run(trace: RagTrace, backend: BackendId) {
  const rsl = await discoverAll(trace.candidates.map((c) => c.sourceUrl), { tryLive: false });
  return assembleResponse(trace, backend, "canned", rsl, TS);
}

const top = (r: Awaited<ReturnType<typeof run>>) => r.report.sources[0];
const score = (r: Awaited<ReturnType<typeof run>>, id: string) =>
  r.report.sources.find((s) => s.sourceId === id)!.attributionScore;

describe("distractor scenario — self-report overpays the unused source", () => {
  const trace = SAMPLE_TRACE_BY_ID["distractor"];
  it("retrieval ranks the distractor #1", async () => {
    const r = await run(trace, "retrieval");
    expect(top(r).sourceId).toBe("jwst-distractor");
  });
  it("causal pays the distractor far less than retrieval does", async () => {
    const ret = await run(trace, "retrieval");
    const cau = await run(trace, "causal");
    expect(score(cau, "jwst-distractor")).toBeLessThan(0.1);
    expect(score(ret, "jwst-distractor")).toBeGreaterThan(score(cau, "jwst-distractor") * 3);
  });
});

describe("parametric-knowledge scenario — don't pay for what the model knew", () => {
  const trace = SAMPLE_TRACE_BY_ID["parametric-knowledge"];
  it("causal attributes most credit to parametric/unattributed", async () => {
    const r = await run(trace, "causal");
    expect(r.report.unattributed).toBeGreaterThan(0.6);
  });
  it("retrieval over-attributes (low unattributed)", async () => {
    const r = await run(trace, "retrieval");
    expect(r.report.unattributed).toBeLessThan(0.2);
  });
});

describe("redundant-vs-unique scenario — uniqueness does real work", () => {
  const trace = SAMPLE_TRACE_BY_ID["redundant-sources"];
  it("causal elevates the unique source above the redundant pair", async () => {
    const r = await run(trace, "causal");
    expect(score(r, "tohoku-tsunami")).toBeGreaterThan(score(r, "tohoku-mag-a"));
    expect(score(r, "tohoku-tsunami")).toBeGreaterThan(score(r, "tohoku-mag-b"));
  });
  it("retrieval splits the redundant pair roughly evenly", async () => {
    const r = await run(trace, "retrieval");
    const a = score(r, "tohoku-mag-a");
    const b = score(r, "tohoku-mag-b");
    expect(Math.abs(a - b)).toBeLessThan(0.06);
  });
});

describe("attribution scores are bounded and sum to ≤ 1", () => {
  it("holds across every scenario and backend", async () => {
    for (const trace of Object.values(SAMPLE_TRACE_BY_ID)) {
      for (const backend of ["retrieval", "citation", "semantic", "causal"] as BackendId[]) {
        const r = await run(trace, backend);
        const sum = r.report.sources.reduce((a, s) => a + s.attributionScore, 0);
        expect(sum).toBeLessThanOrEqual(1.0001);
        for (const s of r.report.sources) {
          expect(s.attributionScore).toBeGreaterThanOrEqual(0);
          expect(s.attributionScore).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("settlement math + RSL term variety", () => {
  it("amount = baseRate × attributionScore × usage", async () => {
    const r = await run(SAMPLE_TRACE_BY_ID["distractor"], "causal");
    for (const rec of r.settlement) {
      expect(rec.amount).toBeCloseTo(rec.baseRate * rec.attributionScore * rec.usage, 8);
    }
  });
  it("CC / public-domain sources settle at zero fee", async () => {
    const r = await run(SAMPLE_TRACE_BY_ID["distractor"], "causal");
    const wiki = r.settlement.find((x) => x.sourceUrl.includes("wikipedia.org"));
    expect(wiki?.amount).toBe(0); // CC-BY-SA → attribution only, no fee
  });
});

describe("audit chain", () => {
  it("verifies for an untampered ledger", async () => {
    const r = await run(SAMPLE_TRACE_BY_ID["clean-attribution"], "causal");
    expect(verifyChain(r.settlement, r.audit)).toBe(true);
  });
  it("fails when a settlement amount is tampered", async () => {
    const r = await run(SAMPLE_TRACE_BY_ID["clean-attribution"], "causal");
    const tampered = r.settlement.map((rec, i) =>
      i === 0 ? { ...rec, amount: rec.amount + 0.01 } : rec,
    );
    expect(verifyChain(tampered, r.audit)).toBe(false);
  });
});
