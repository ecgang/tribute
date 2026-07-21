/**
 * Baked RAG traces for canned (offline, demo-safe) mode.
 *
 * Each scenario is engineered so the naive backends (retrieval/citation) and the
 * causal backend (leave-one-out) *disagree* in an instructive, honest way — that
 * divergence is the pitch ("self-reported attribution is worth zero").
 *
 * `canned` signals (citationShare, ablationDelta) stand in for what live
 * mode computes from a real model. They are hand-set to reflect realistic behavior.
 */
import type { RagTrace } from "./schema";

export const SAMPLE_TRACES: RagTrace[] = [
  {
    id: "clean-attribution",
    title: "Clean attribution (baseline)",
    teaching:
      "A well-behaved query: one source clearly dominates and all four backends roughly agree. The sanity baseline before the interesting cases.",
    query:
      "What real-time operating system approach did the Apollo Guidance Computer use?",
    answer:
      "The Apollo Guidance Computer ran a priority-driven, preemptive executive that scheduled jobs by priority and could shed low-priority work under overload, the behavior that let it survive the 1201/1202 alarms during Apollo 11's descent. A restart-protection scheme let interrupted jobs resume cleanly.",
    candidates: [
      {
        sourceId: "agc-1",
        sourceUrl: "https://en.wikipedia.org/wiki/Apollo_Guidance_Computer",
        title: "Apollo Guidance Computer: Executive & priority scheduling",
        chunkText:
          "The AGC's Executive used a priority-driven, preemptive scheduler. Under overload it shed low-priority jobs, producing the 1201/1202 alarms while continuing critical guidance tasks.",
        retrievalScore: 0.92,
        rank: 1,
        authorityPrior: 1.0,
        canned: { citationShare: 0.7, ablationDelta: 0.66 },
      },
      {
        sourceId: "agc-2",
        sourceUrl: "https://history.nasa.gov/computers/Ch2-5.html",
        title: "NASA: Computers in Spaceflight, restart protection",
        chunkText:
          "A restart-protection mechanism checkpointed jobs so that after a software restart, interrupted tasks resumed without loss of guidance state.",
        retrievalScore: 0.6,
        rank: 2,
        authorityPrior: 0.95,
        canned: { citationShare: 0.25, ablationDelta: 0.24 },
      },
      {
        sourceId: "agc-3",
        sourceUrl: "https://www.britannica.com/technology/Apollo-Guidance-Computer",
        title: "Britannica: Apollo Guidance Computer (overview)",
        chunkText:
          "The AGC was a milestone in integrated-circuit computing, with about 2,000 words of erasable memory and 36,000 words of fixed memory.",
        retrievalScore: 0.34,
        rank: 3,
        authorityPrior: 0.85,
        canned: { citationShare: 0.05, ablationDelta: 0.06 },
      },
    ],
    citations: [
      { claim: "priority-driven, preemptive executive", sourceId: "agc-1" },
      { claim: "shed low-priority work under overload", sourceId: "agc-1" },
      { claim: "restart-protection scheme", sourceId: "agc-2" },
    ],
  },

  {
    id: "distractor",
    title: "Distractor source (self-report overpays)",
    teaching:
      "A topically-similar source is retrieved at rank #1 but the answer never actually used it. Retrieval-weighted attribution pays it the MOST; causal attribution pays it ~nothing. This is the gap an AI app would exploit to under- or mis-report.",
    query:
      "When was the James Webb Space Telescope launched, and how wide is its primary mirror?",
    answer:
      "The James Webb Space Telescope launched on 25 December 2021 aboard an Ariane 5. Its segmented primary mirror is 6.5 meters in diameter, made of 18 gold-coated beryllium hexagons.",
    candidates: [
      {
        sourceId: "jwst-distractor",
        sourceUrl: "https://www.theverge.com/2021/12/24/jwst-hubble-comparison",
        title: "The Verge: How Webb compares to Hubble (feature)",
        chunkText:
          "Webb is often compared to Hubble, but it observes primarily in the infrared and orbits the Sun at the L2 point rather than orbiting Earth.",
        retrievalScore: 0.95,
        rank: 1,
        authorityPrior: 0.95,
        groundTruthUnused: true,
        // Model plausibly-but-wrongly cites this topically-similar source: citation backend
        // is fooled (0.20), only causal catches that it was unused (0.03). On-thesis.
        canned: { citationShare: 0.2, ablationDelta: 0.03 },
      },
      {
        sourceId: "jwst-launch",
        sourceUrl: "https://www.nasa.gov/mission_pages/webb/launch/index.html",
        title: "NASA: Webb launch facts",
        chunkText:
          "The James Webb Space Telescope launched 25 December 2021 on an Ariane 5 rocket from Kourou, French Guiana.",
        retrievalScore: 0.82,
        rank: 2,
        authorityPrior: 1.0,
        canned: { citationShare: 0.55, ablationDelta: 0.56 },
      },
      {
        sourceId: "jwst-mirror",
        sourceUrl: "https://en.wikipedia.org/wiki/James_Webb_Space_Telescope",
        title: "Wikipedia: JWST primary mirror",
        chunkText:
          "Webb's primary mirror is 6.5 m across, composed of 18 hexagonal gold-coated beryllium segments.",
        retrievalScore: 0.5,
        rank: 3,
        authorityPrior: 0.9,
        canned: { citationShare: 0.43, ablationDelta: 0.41 },
      },
    ],
    citations: [
      { claim: "launched on 25 December 2021 aboard an Ariane 5", sourceId: "jwst-launch" },
      { claim: "6.5 meters in diameter", sourceId: "jwst-mirror" },
      { claim: "18 gold-coated beryllium hexagons", sourceId: "jwst-mirror" },
    ],
  },

  {
    id: "parametric-knowledge",
    title: "Parametric knowledge (don't pay for what the model already knew)",
    teaching:
      "Common-knowledge query. The sources were retrieved and overlap the answer textually, so retrieval and semantic backends over-attribute; but removing every source doesn't change the answer, so causal attribution is ~0 and the credit flows to 'model parametric / unattributed.' The honest case naive meters get wrong.",
    query: "What is the boiling point of water at sea level?",
    answer:
      "At standard atmospheric pressure (sea level), water boils at 100 °C (212 °F).",
    candidates: [
      {
        sourceId: "boil-1",
        sourceUrl: "https://www.britannica.com/science/boiling-point",
        title: "Britannica: Boiling point",
        chunkText:
          "At one atmosphere of pressure, water boils at 100 degrees Celsius (212 degrees Fahrenheit).",
        retrievalScore: 0.88,
        rank: 1,
        authorityPrior: 1.0,
        groundTruthUnused: true,
        canned: { citationShare: 0.1, ablationDelta: 0.04 },
      },
      {
        sourceId: "boil-2",
        sourceUrl: "https://en.wikipedia.org/wiki/Boiling_point",
        title: "Wikipedia: Boiling point",
        chunkText:
          "The boiling point of water at sea-level atmospheric pressure is 100 °C.",
        retrievalScore: 0.8,
        rank: 2,
        authorityPrior: 0.9,
        groundTruthUnused: true,
        canned: { citationShare: 0.08, ablationDelta: 0.03 },
      },
      {
        sourceId: "boil-3",
        sourceUrl: "https://www.usgs.gov/faqs/water-boiling-temperature",
        title: "USGS: Water FAQ",
        chunkText:
          "Pure water boils at 100 °C (212 °F) at standard sea-level pressure.",
        retrievalScore: 0.7,
        rank: 3,
        authorityPrior: 0.95,
        groundTruthUnused: true,
        canned: { citationShare: 0.05, ablationDelta: 0.02 },
      },
    ],
  },

  {
    id: "redundant-sources",
    title: "Redundant vs unique (uniqueness matters)",
    teaching:
      "Two sources state the same fact (redundant); a third is the only source for its claim. Retrieval and citation split credit evenly across the redundant pair, but causal attribution discounts the redundant sources (removing one leaves the other) and elevates the unique source. This is the 'uniqueness' dimension doing real work.",
    query: "How strong was the 2011 Tōhoku earthquake, and what did it trigger?",
    answer:
      "The 2011 Tōhoku earthquake had a magnitude of 9.0–9.1 Mw, making it the most powerful quake recorded in Japan. It triggered a massive tsunami that caused the Fukushima Daiichi nuclear disaster.",
    candidates: [
      {
        sourceId: "tohoku-mag-a",
        sourceUrl: "https://www.usgs.gov/earthquakes/2011-tohoku",
        title: "USGS: 2011 Tōhoku magnitude",
        chunkText:
          "The 11 March 2011 Tōhoku earthquake registered a moment magnitude of 9.0–9.1, the largest ever recorded in Japan.",
        retrievalScore: 0.82,
        rank: 1,
        authorityPrior: 0.95,
        canned: { citationShare: 0.35, ablationDelta: 0.16 },
      },
      {
        sourceId: "tohoku-mag-b",
        sourceUrl: "https://en.wikipedia.org/wiki/2011_Tohoku_earthquake",
        title: "Wikipedia: 2011 Tōhoku earthquake (magnitude)",
        chunkText:
          "The earthquake had a magnitude of 9.0–9.1 Mw, the most powerful ever recorded in Japan.",
        retrievalScore: 0.79,
        rank: 2,
        authorityPrior: 0.95,
        canned: { citationShare: 0.33, ablationDelta: 0.15 },
      },
      {
        sourceId: "tohoku-tsunami",
        sourceUrl: "https://www.nature.com/articles/fukushima-tsunami-2011",
        title: "Nature: Tsunami and the Fukushima Daiichi disaster",
        chunkText:
          "The ensuing tsunami inundated the Fukushima Daiichi plant, causing loss of cooling and the subsequent nuclear disaster.",
        retrievalScore: 0.55,
        rank: 3,
        authorityPrior: 0.95,
        canned: { citationShare: 0.32, ablationDelta: 0.55 },
      },
    ],
    citations: [
      { claim: "magnitude of 9.0–9.1 Mw", sourceId: "tohoku-mag-a" },
      { claim: "most powerful quake recorded in Japan", sourceId: "tohoku-mag-b" },
      { claim: "tsunami that caused the Fukushima Daiichi nuclear disaster", sourceId: "tohoku-tsunami" },
    ],
  },
];

export const SAMPLE_TRACE_BY_ID = Object.fromEntries(
  SAMPLE_TRACES.map((t) => [t.id, t]),
) as Record<string, RagTrace>;
