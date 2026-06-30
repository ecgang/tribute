/**
 * The Tribute pipeline: trace → attribution → scoring → settlement → audit.
 * Pure and synchronous given resolved RSL terms, so it's identical in canned and live
 * mode (live mode only differs in how the causal weights + answer were produced).
 */
import { relevanceWeights } from "./attribution";
import type { WeightMap } from "./attribution/passive";
import { buildAuditChain } from "./audit";
import { buildReport } from "./scoring";
import type { AttributeResponse, BackendId, RagTrace, RslTerms } from "./schema";
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
