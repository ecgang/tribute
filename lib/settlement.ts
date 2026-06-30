/**
 * Stage 5 — Settlement Emitter.
 * Emits an RSL-shaped settlement record per billable source:
 *   amount = baseRate × attributionScore × usage
 *
 * Records target a LOCAL ledger in an RSL-compatible shape. (The live RSL Collective
 * reporting API does not yet define a per-source attribution payload — see README —
 * so the local ledger is currently the only honest output, not a fallback.)
 */
import { createHash } from "crypto";
import type {
  AttributionReport,
  RslTerms,
  SettlementRecord,
} from "./schema";
import { round } from "./text";

export function responseHash(answer: string, backend: string): string {
  return createHash("sha256").update(`${backend}\n${answer}`).digest("hex").slice(0, 16);
}

export function buildSettlement(
  report: AttributionReport,
  answer: string,
  rsl: RslTerms[],
  timestamp: string,
): SettlementRecord[] {
  const rslByUrl = new Map(rsl.map((r) => [r.sourceUrl, r]));
  const rHash = responseHash(answer, report.backend);
  const records: SettlementRecord[] = [];

  for (const s of report.sources) {
    const terms = rslByUrl.get(s.sourceUrl);
    if (!terms || !terms.found) continue; // no RSL terms → nothing to settle
    const baseRate = terms.baseRate ?? 0;
    const usage = s.subScores.usage;
    const amount = round(baseRate * s.attributionScore * usage, 8);
    records.push({
      sourceId: s.sourceId,
      sourceUrl: s.sourceUrl,
      rslLicenseRef: terms.licenseRef ?? `rsl:${terms.domain}`,
      baseRate,
      currency: terms.currency ?? "USD",
      attributionScore: s.attributionScore,
      usage,
      amount,
      responseHash: rHash,
      timestamp,
      backend: report.backend,
    });
  }
  return records;
}

export function settlementTotal(records: SettlementRecord[]): { amount: number; currency: string } {
  const amount = round(
    records.reduce((sum, r) => sum + r.amount, 0),
    8,
  );
  return { amount, currency: records[0]?.currency ?? "USD" };
}
