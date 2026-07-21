/**
 * The Tribute pipeline: trace → attribution → scoring → settlement → audit.
 * Pure and synchronous given resolved RSL terms, so it's identical in canned and live
 * mode (live mode only differs in how the causal weights + answer were produced).
 */
import { relevanceWeights } from "./attribution";
import type { WeightMap } from "./attribution/passive";
import { buildAuditChain } from "./audit";
import { buildReport } from "./scoring";
import {
  BACKENDS,
  type AttributeResponse,
  type AttributionReport,
  type BackendId,
  type RagTrace,
  type RslTerms,
} from "./schema";
import { buildSettlement, settlementTotal } from "./settlement";

export function assembleResponse(
  trace: RagTrace,
  backend: BackendId,
  mode: "canned" | "live",
  rsl: RslTerms[],
  timestamp: string,
  override?: { causal?: WeightMap },
): AttributeResponse {
  const rel = relevanceWeights(trace, backend, override);
  const report = buildReport(trace, backend, rel, mode);
  const settlement = buildSettlement(report, trace.answer, rsl, timestamp);
  const audit = buildAuditChain(settlement);
  const total = settlementTotal(settlement);
  return {
    trace: { id: trace.id, title: trace.title, query: trace.query, answer: trace.answer },
    report,
    rsl,
    settlement,
    audit,
    total,
  };
}

/**
 * Live open-prompt assembly: score ALL FOUR backends over the SAME generated answer + the SAME
 * measured causal weights, so the response can show citation-vs-causal divergence for one trace.
 * The primary `report` (and therefore settlement + audit) is the causal one — the audit-grade signal.
 */
export function assembleLiveWithReports(
  trace: RagTrace,
  rsl: RslTerms[],
  timestamp: string,
  causalWeights: WeightMap,
): AttributeResponse {
  const base = assembleResponse(trace, "causal", "live", rsl, timestamp, { causal: causalWeights });
  const reports: Partial<Record<BackendId, AttributionReport>> = {};
  for (const b of BACKENDS) {
    reports[b] = buildReport(trace, b, relevanceWeights(trace, b, { causal: causalWeights }), "live");
  }
  return { ...base, reports, citations: trace.citations };
}
