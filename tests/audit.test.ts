import { describe, expect, it } from "vitest";
import { buildAuditChain, nodeHasher, verifyChain, type Hasher } from "../lib/audit";
import type { SettlementRecord } from "../lib/schema";

const records: SettlementRecord[] = [
  {
    sourceId: "src-a",
    sourceUrl: "https://example.com/a",
    rslLicenseRef: "ref-a",
    baseRate: 0.02,
    currency: "USD",
    attributionScore: 0.5,
    usage: 1,
    amount: 0.01,
    responseHash: "hash-a",
    timestamp: "2026-06-30T00:00:00.000Z",
    backend: "causal",
  },
  {
    sourceId: "src-b",
    sourceUrl: "https://example.com/b",
    rslLicenseRef: "ref-b",
    baseRate: 0.03,
    currency: "USD",
    attributionScore: 0.25,
    usage: 1,
    amount: 0.0075,
    responseHash: "hash-b",
    timestamp: "2026-06-30T00:00:00.000Z",
    backend: "causal",
  },
];

const fakeHasher: Hasher = { sha256: (s) => `h(${s.length})` };

describe("audit hasher seam", () => {
  it("builds and verifies a chain with the default nodeHasher", () => {
    const entries = buildAuditChain(records);
    expect(verifyChain(records, entries)).toBe(true);
    expect(verifyChain(records, entries, nodeHasher)).toBe(true);
  });

  it("builds and verifies a chain with an injected fake hasher", () => {
    const entries = buildAuditChain(records, fakeHasher);
    expect(verifyChain(records, entries, fakeHasher)).toBe(true);
  });

  it("cross-checking a fake-hashed chain against nodeHasher fails", () => {
    const entries = buildAuditChain(records, fakeHasher);
    expect(verifyChain(records, entries, nodeHasher)).toBe(false);
  });
});
