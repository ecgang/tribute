/**
 * Stage 6 — Audit Trail.
 * Hash-chains settlement records so a record can't be silently revised: each entry
 * commits to the previous chain hash. `verifyChain` replays and detects any tamper.
 *
 * (Honest scope note: hash-chaining proves the LEDGER wasn't altered after the fact.
 *  It does NOT prove the input trace was faithful — that's the independence/verify
 *  problem the product's positioning addresses, not something crypto alone solves.)
 */
import { createHash } from "crypto";
import type { AuditEntry, SettlementRecord } from "./schema";
import { canonicalRecord, GENESIS } from "./canonical";

export { canonicalRecord };

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function buildAuditChain(records: SettlementRecord[]): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prevHash = GENESIS;
  records.forEach((r, i) => {
    const recordHash = sha256(canonicalRecord(r));
    const chainHash = sha256(prevHash + recordHash);
    entries.push({
      index: i,
      recordHash,
      prevHash,
      chainHash,
      summary: `${r.sourceId} · ${r.amount.toFixed(6)} ${r.currency}`,
    });
    prevHash = chainHash;
  });
  return entries;
}

/** Recompute the chain from records and confirm it matches the stored entries. */
export function verifyChain(records: SettlementRecord[], entries: AuditEntry[]): boolean {
  const recomputed = buildAuditChain(records);
  if (recomputed.length !== entries.length) return false;
  return recomputed.every(
    (e, i) =>
      e.recordHash === entries[i].recordHash &&
      e.prevHash === entries[i].prevHash &&
      e.chainHash === entries[i].chainHash,
  );
}
