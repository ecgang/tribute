/**
 * Tribute — core contracts.
 *
 * The RAG trace is the central, pipeline-agnostic input. Everything downstream
 * (attribution backends, scoring, settlement, audit) reads this shape.
 *
 * Note the trace FORWARD-DECLARES the fields the *active* (re-generating) backends
 * need — `generation` (model/seed/temperature/promptAssemblyRef) — so adding causal
 * attribution later never forces a breaking schema change. (Per the architecture review.)
 */
import { z } from "zod";

export const BACKENDS = ["retrieval", "citation", "semantic", "causal"] as const;
export type BackendId = (typeof BACKENDS)[number];

export const BACKEND_META: Record<
  BackendId,
  { label: string; short: string; kind: "passive" | "active"; blurb: string }
> = {
  retrieval: {
    label: "Retrieval-weighted",
    short: "Retrieval",
    kind: "passive",
    blurb:
      "Weights by retrieval score / rank. Measures availability, not use — this is what most apps self-report.",
  },
  citation: {
    label: "Citation-grounded",
    short: "Citation",
    kind: "passive",
    blurb:
      "Aggregates the model's own inline citations. Better than retrieval, but only as honest as the model's citing.",
  },
  semantic: {
    label: "Semantic-overlap",
    short: "Semantic",
    kind: "passive",
    blurb:
      "Lexical/semantic similarity between answer spans and source spans. A cross-check; also drives uniqueness.",
  },
  causal: {
    label: "Causal (leave-one-out)",
    short: "Causal",
    kind: "active",
    blurb:
      "Re-generates the answer with each source removed and measures the delta. Closest to measured causal contribution — the independent, audit-resistant signal.",
  },
};

/** One retrieved candidate placed in the model's context. */
export const RetrievedCandidateSchema = z.object({
  sourceId: z.string(),
  sourceUrl: z.string(),
  title: z.string(),
  chunkText: z.string(),
  retrievalScore: z.number().min(0).max(1),
  rank: z.number().int().min(1),
  /** Domain authority prior (default 1.0). Pluggable. */
  authorityPrior: z.number().min(0).max(1).default(1),
  /**
   * Independent ground-truth label for the eval harness: this source provably did NOT
   * causally contribute (a distractor that was retrieved-but-unused, or a source the model
   * already knew). Used to compute a backend's false-attribution rate — a falsifiable
   * accuracy number that does NOT depend on the backends' own similarity assumptions.
   */
  groundTruthUnused: z.boolean().optional(),
  /**
   * Pre-baked demo signals so canned mode produces all four backends offline.
   * In live mode these are computed (citations from the model, ablationDelta from
   * real leave-one-out re-generation).
   */
  canned: z
    .object({
      /** Share of cited claims attributed to this source (backend B). 0..1 */
      citationShare: z.number().min(0).max(1).optional(),
      /** Normalized semantic change in the answer when this source is removed (backend D). 0..1 */
      ablationDelta: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type RetrievedCandidate = z.infer<typeof RetrievedCandidateSchema>;

/** Optional per-claim citation linking an answer span to a candidate. */
export const CitationSchema = z.object({
  claim: z.string(),
  sourceId: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const RagTraceSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** A short narrator note for the demo describing what this scenario shows. */
  teaching: z.string().optional(),
  query: z.string(),
  candidates: z.array(RetrievedCandidateSchema),
  answer: z.string(),
  citations: z.array(CitationSchema).optional(),
  /** Forward-declared active-backend contract (used by live causal re-generation). */
  generation: z
    .object({
      model: z.string(),
      seed: z.number().int().optional(),
      temperature: z.number().min(0).max(1),
      promptAssemblyRef: z.string(),
    })
    .optional(),
});
export type RagTrace = z.infer<typeof RagTraceSchema>;

/** The four sub-scores from the deck: Relevance, Authority, Uniqueness, Usage. */
export type SubScores = {
  relevance: number;
  authority: number;
  uniqueness: number;
  usage: number;
};

export type SourceAttribution = {
  sourceId: string;
  sourceUrl: string;
  title: string;
  rank: number;
  subScores: SubScores;
  /** Composite Attribution Score in [0,1], normalized so the set sums to ≤ 1. */
  attributionScore: number;
};

export type AttributionReport = {
  traceId: string;
  backend: BackendId;
  mode: "canned" | "live";
  sources: SourceAttribution[];
  /** 1 − Σ attributionScore. The share credited to the model's parametric knowledge / unattributed. */
  unattributed: number;
};

/** RSL license terms discovered for a source. */
export type RslTerms = {
  sourceUrl: string;
  domain: string;
  found: boolean;
  /**
   * Provenance of the terms — drives honest labeling:
   *  "live"        = real RSL XML actually fetched + parsed now (or a verified-real file).
   *  "illustrative"= no RSL deployed; showing a rate-card anchored to real deal economics.
   *  "cc"          = genuinely CC / public-domain (real license; no per-use fee, attribution).
   *  "none"        = no RSL terms and not illustrating.
   */
  via: "live" | "illustrative" | "cc" | "none";
  /** True only when the terms reflect a real, verifiable source (live fetch or CC/PD). */
  real?: boolean;
  paymentType?: "use" | "inference" | "crawl" | "purchase" | "attribution";
  /** Per-use rate. Undefined when the rate lives at the license server (the common real case). */
  baseRate?: number;
  currency?: string;
  licenseRef?: string;
  /** CC/terms URL when the license is an open/terms license rather than a payment one. */
  terms?: string;
  server?: string;
  /** One-line citation/explanation of where the number comes from. */
  provenance?: string;
  raw?: string;
};

export type SettlementRecord = {
  sourceId: string;
  sourceUrl: string;
  rslLicenseRef: string;
  baseRate: number;
  currency: string;
  attributionScore: number;
  usage: number;
  /** Payment = baseRate × attributionScore × usage. */
  amount: number;
  responseHash: string;
  timestamp: string;
  backend: BackendId;
};

export type AuditEntry = {
  index: number;
  /** Hash of this record's canonical payload. */
  recordHash: string;
  /** Chain hash of the previous entry (or genesis). */
  prevHash: string;
  /** chainHash = H(prevHash + recordHash). */
  chainHash: string;
  summary: string;
};

export type AttributeResponse = {
  trace: { id: string; title: string; query: string; answer: string };
  report: AttributionReport;
  rsl: RslTerms[];
  settlement: SettlementRecord[];
  audit: AuditEntry[];
  total: { amount: number; currency: string };
};
