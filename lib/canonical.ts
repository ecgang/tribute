/**
 * Pure (no node:crypto) canonical serialization of a settlement record, shared by the
 * server audit chain and the in-browser "replay & verify" check so both hash identically.
 */
import type { SettlementRecord } from "./schema";

export function canonicalRecord(r: SettlementRecord): string {
  return JSON.stringify([
    r.sourceId,
    r.rslLicenseRef,
    r.baseRate,
    r.attributionScore,
    r.usage,
    r.amount,
    r.responseHash,
    r.backend,
  ]);
}

export const GENESIS = "GENESIS";
