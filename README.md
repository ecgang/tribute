# Tribute — Inference Attribution Meter (investor demo)

**Independent, per-source attribution metering for AI answers.** Tribute observes a RAG
trace (query → retrieved sources → answer) and measures *how much each source actually
contributed* to the generated answer, then emits RSL-shaped settlement records and a
tamper-evident audit trail.

> **The pitch:** DoubleVerify for the answer economy. The moment AI pays publishers
> per inference, a self-reported attribution number is worth zero — both sides need an
> *independent* meter. Tribute is that meter.

This repo is a **demo** for that thesis. The one beat to show: switch the attribution
**backend** from *Retrieval* (what apps self-report) to *Causal / leave-one-out* (what
actually happened) and watch the per-source payouts — and the dollars — move.

---

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # engine unit tests (the credibility layer)
npm run typecheck   # types only, no build
npm run build      # production build / typecheck
```

The demo runs fully **offline in "Pre-computed" mode** — no API key, no network. Every
scenario, score, ledger, and audit chain works with the network off.

### Live mode (optional)
Toggle **Live (Claude)** to generate the answer with a real model and run *real*
leave-one-out ablation (re-generating with each source removed, measuring the delta).

```bash
cp .env.example .env.local   # then add your key
# ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=claude-sonnet-4-6   (optional override)
```

Without a key, Live mode degrades gracefully to pre-computed results with a notice.

### Open-prompt mode (optional)
The **"✨ Your own prompt"** box lets anyone type an arbitrary question and run the *full*
meter on it live: **search → fetch real sources → generate → measure causal contribution →
RSL discovery on the real source URLs**. No other product offers open-prompt per-source
*scored* contribution. Needs `ANTHROPIC_API_KEY` + a (free) `TAVILY_API_KEY`:

```bash
# in .env.local or Vercel env
TAVILY_API_KEY=tvly-...   # free key at https://tavily.com
```

Without the search key, the box shows a graceful "needs a search key" notice; the canned
scenarios are unaffected. Retrieval is one pluggable layer (`lib/retrieve.ts`) — everything
downstream (backends, scoring, settlement, audit) is already source-agnostic.

---

## What it shows (the four scenarios)

| Scenario | The point |
|---|---|
| **Clean attribution** | Baseline — one source dominates, all backends agree. |
| **Distractor source** | A source retrieved at rank #1 but never used. *Retrieval* pays it the most; *Causal* pays it ~$0. The gap a self-reporting app would exploit. |
| **Parametric knowledge** | Common-knowledge query — removing every source doesn't change the answer, so *Causal* credits ~0 to sources and ~100% to "model parametric." Naive meters over-pay here. |
| **Redundant vs unique** | Two sources state the same fact, one is unique. *Causal* discounts the redundant pair and elevates the unique source — the **Uniqueness** dimension doing real work. |

## Architecture

```
RAG trace → Source Resolver → RSL Discovery → Attribution Engine → Scoring → Settlement → Audit
            canonical IDs      robots.txt RSL   A/B/C/D backends    composite   RSL-shaped    hash-chain
```

- **Backends** (`lib/attribution/`): A retrieval-weighted, B citation-grounded,
  C semantic-overlap (passive); D leave-one-out (active — re-generates).
- **Scoring** (`lib/scoring.ts`): `AttributionScore = f(Relevance, Authority, Uniqueness, Usage)`,
  normalized so the set sums to ≤ 1; the remainder is reported as parametric/unattributed.
- **Settlement** (`lib/settlement.ts`): `amount = baseRate × attributionScore × usage`.
- **Audit** (`lib/audit.ts`): hash-chained records; "Replay & verify" re-derives the chain
  in-browser and detects tampering.

## RSL data: what's real vs illustrative (read before demoing)

Discovery is real — it follows `robots.txt → License: → rsl.xml` and parses the RSL XML.
But as of 2026-06-30, **the only two real, fetchable RSL files on the open web are**:
- **stackoverflow.com** — `robots.txt` `License:` → `license.xml` (real RSL, CC-BY-SA, no fee).
- **rslcollective.org/royalty.xml** — real RSL with `<payment type="use">` + license server.

Even named adopters (AP, The Verge, Reddit) ship **no** machine-readable RSL yet — "1,500+
publishers" is endorsement, not deployment. So publisher rates in the demo are labeled
**illustrative**, anchored to reported deal economics (~$0.001/use; Reddit–Google ≈ $60M/yr).
CC/public-domain sources show their real licenses (no fee). Terms are tagged `live · real`,
`illustrative`, `CC`, or `none` so nothing is misrepresented. (Note: `payment type="inference"`
appears on rslstandard.org's guide page, but the *deployed* files use `type="use"` — we use `use`.)

## Honest scope (state this to investors — it's on-thesis)

- **The settlement rail does not exist yet.** RSL 1.0 declares `payment type="use"` but
  defines **no** per-source attribution payload, and the RSL Collective reporting API is
  gated beta. Records here target a **local RSL-shaped ledger** — that's not a fallback,
  it's currently the only honest output. *Being early to that gap is the bet.*
- Attribution is **directional and auditable**, not court-grade. Live causal numbers use
  `temperature=0` for stability (the API exposes no seed), so they are reproducible-ish,
  not bit-identical.
- **Out of scope:** live RSL Collective submission, ContextCite surrogate backend (E),
  real retrieval/RAG integration, auth, persistent DB.

Built as a working demonstration of independent inference attribution. Pre-computed mode is
fully self-contained; live + open-prompt modes need the keys noted above.
