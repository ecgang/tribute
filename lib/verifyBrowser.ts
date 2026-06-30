/** In-browser hash-chain verification (mirrors lib/audit.ts using SubtleCrypto). */
import { canonicalRecord, GENESIS } from "./canonical";
import type { AuditEntry, SettlementRecord } from "./schema";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyChainBrowser(
  records: SettlementRecord[],
  entries: AuditEntry[],
): Promise<boolean> {
  if (records.length !== entries.length) return false;
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const recordHash = await sha256Hex(canonicalRecord(records[i]));
    const chainHash = await sha256Hex(prev + recordHash);
    if (recordHash !== entries[i].recordHash || chainHash !== entries[i].chainHash) return false;
    prev = chainHash;
  }
  return true;
}
