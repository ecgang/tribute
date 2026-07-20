"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BACKENDS,
  BACKEND_META,
  type AttributeResponse,
  type AttributionReport,
  type BackendId,
  type Citation,
  type SettlementRecord,
  type SourceAttribution,
} from "@/lib/schema";
import { SAMPLE_TRACES } from "@/lib/sampleTraces";
import { shouldFetch, shouldCommit } from "@/lib/loadGuard";
import { verifyChainBrowser } from "@/lib/verifyBrowser";
import type { BackendEval, EvalResult } from "@/lib/eval";

type Mode = "canned" | "live";

const fmtUSD = (n: number) =>
  n === 0 ? "$0.00" : `$${n.toFixed(n < 0.01 ? 6 : 4)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [traceId, setTraceId] = useState<string>("clean-attribution");
  const [backend, setBackend] = useState<BackendId>("retrieval");
  const [mode, setMode] = useState<Mode>("canned");
  const [openQuery, setOpenQuery] = useState<string>("");
  // Bumped on every open-prompt submit so an identical query re-triggers load() (React ignores a
  // same-value setState), giving a real retry after a degraded/failed response.
  const [runToken, setRunToken] = useState(0);
  const [data, setData] = useState<
    AttributeResponse & { notice?: string; error?: string; retrievedCount?: number }
  >();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [evalResult, setEvalResult] = useState<EvalResult>();
  // Tracks the last grounded % we displayed, so a backend switch can render the
  // change as a delta ("▼ 46 pts vs naive") instead of a silent number swap.
  const prevGroundedRef = useRef<{ v: number; backend: BackendId } | null>(null);
  const [delta, setDelta] = useState<{ pts: number; vs: BackendId } | null>(null);
  // The fetch key the UI currently wants. Recorded before load()'s dedupe return, so a settled
  // response commits ONLY if it still matches the latest intent — this is the A→B→A guard
  // (returning to A restores A as desired, so a late B response is dropped, not shown under A).
  const desiredKeyRef = useRef<string>("");
  // Fetch-dedupe keys. On an open prompt the four backends all come back in one response, so
  // switching backend is a client-side view change — the loaded key stops it re-firing the (paid)
  // live ablation. Crucially the key locks only on SUCCESS (see load()), so a failed/degraded
  // request stays retryable for the same prompt. Scenarios refetch per backend (server computes one).
  const loadedKeyRef = useRef<string | null>(null);
  const inFlightKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/eval")
      .then((r) => r.json())
      .then(setEvalResult)
      .catch(() => {});
  }, []);

  const scenario = useMemo(() => SAMPLE_TRACES.find((t) => t.id === traceId)!, [traceId]);

  const isOpen = openQuery.trim().length > 0;

  // On an open prompt every backend is scored over the same answer, so the displayed report follows
  // the toggle client-side; scenarios (and any legacy payload) fall back to the single `report`.
  const activeReport =
    (isOpen && data?.reports?.[backend] ? data.reports[backend] : data?.report) ?? undefined;

  // Settlement, audit and RSL are always assembled from the causal PRIMARY report, so their labels
  // and the exported audit record must follow that report's backend — not the display toggle (which
  // only switches the comparison view on open prompts). Else a causal ledger would read "citation".
  const settlementBackend = data?.report?.backend ?? backend;

  // Open-prompt submit: lead with the honest causal view, and force a fresh attempt even for an
  // identical query (clear the lock + bump runToken so load() re-runs despite the same string).
  const submitOpen = useCallback((q: string) => {
    loadedKeyRef.current = null;
    setBackend("causal");
    setOpenQuery(q);
    setRunToken((t) => t + 1);
  }, []);

  const load = useCallback(async () => {
    // Open prompt returns all backends in one payload → backend is NOT part of its fetch key,
    // so toggling backends re-renders from `data.reports` without another server round-trip.
    const fetchKey = isOpen ? `open:${openQuery}` : `sc:${traceId}:${backend}:${mode}`;
    // Record the latest intent BEFORE the dedupe return — even a deduped return-to-A must restore
    // A as the desired key so A's in-flight response (not a stale B) is the one that commits.
    desiredKeyRef.current = fetchKey;
    if (!shouldFetch(fetchKey, { loadedKey: loadedKeyRef.current, inFlight: inFlightKeysRef.current })) {
      return;
    }
    inFlightKeysRef.current.add(fetchKey);
    setLoading(true);
    setError(undefined);
    try {
      // Open prompt forces live (retrieve → generate → attribute); scenarios honor the mode toggle.
      const body = isOpen
        ? { query: openQuery, backend: "causal", mode: "live" }
        : { traceId, backend, mode };
      const res = await fetch("/api/attribute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as typeof data;
      if (!shouldCommit(fetchKey, desiredKeyRef.current)) return; // a newer selection superseded this
      setData(next);
      // Lock the key ONLY on a real, usable response — a degraded 200 (error payload such as
      // live_disabled) leaves it unlocked so the same prompt can be retried. (delta is recomputed
      // reactively below, so it also fires on client-side open-prompt backend switches.)
      if (!next?.error) loadedKeyRef.current = fetchKey;
    } catch (e) {
      if (shouldCommit(fetchKey, desiredKeyRef.current)) setError(String(e));
    } finally {
      inFlightKeysRef.current.delete(fetchKey); // clear only THIS request's ownership
      if (shouldCommit(fetchKey, desiredKeyRef.current)) setLoading(false);
    }
    // runToken is a dep so a re-submit of the same open prompt re-runs this even when the query
    // string is unchanged (the submit handler clears loadedKeyRef so the guard permits it).
  }, [traceId, backend, mode, openQuery, isOpen, runToken]);

  useEffect(() => {
    // Imperative data fetch (POST /api/attribute) re-run when the scenario,
    // backend, or mode changes. Effects are the correct mechanism for this;
    // there is no render-time or external-store equivalent for a network call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Grounding delta ("▲/▼ N pts vs X"): recompute whenever the DISPLAYED report changes — driven by
  // `data`/`backend`, so it also fires on open-prompt backend toggles (which switch client-side with
  // no refetch and therefore never re-enter load()). Guard on the report actually matching the
  // selected backend so a scenario's in-flight window doesn't compute a delta off the stale report.
  useEffect(() => {
    if (!activeReport || activeReport.backend !== backend) return;
    const grounded = Math.max(0, 1 - activeReport.unattributed);
    const prev = prevGroundedRef.current;
    setDelta(
      prev && prev.backend !== backend
        ? { pts: Math.round((grounded - prev.v) * 100), vs: prev.backend }
        : null,
    );
    prevGroundedRef.current = { v: grounded, backend };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, backend]);

  return (
    <main className="mx-auto max-w-7xl px-5 py-6">
      <Header mode={mode} setMode={setMode} />

      {evalResult && <EvalStrip evalResult={evalResult} />}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        {/* LEFT: scenario + the RAG answer */}
        <section className="flex flex-col gap-5">
          <ScenarioPicker
            traceId={traceId}
            isOpen={isOpen}
            onPickScenario={(id) => {
              setOpenQuery("");
              setTraceId(id);
            }}
            onSubmitOpen={submitOpen}
            loading={loading}
          />
          <AnswerPanel
            query={isOpen ? openQuery : scenario.query}
            answer={data?.trace?.answer ?? (isOpen ? "" : scenario.answer)}
            teaching={
              isOpen
                ? data?.retrievedCount
                  ? `Live: retrieved ${data.retrievedCount} real sources, generated the answer, then measured each source's causal contribution by leave-one-out.`
                  : "Live open prompt — retrieving sources, generating, and measuring contribution…"
                : scenario.teaching
            }
            mode={isOpen ? "live" : mode}
            model={data?.report?.mode === "live" ? "live" : "pre-computed"}
          />
        </section>

        {/* RIGHT: the meter */}
        <section className="flex flex-col gap-5">
          <BackendToggle backend={backend} setBackend={setBackend} loading={loading} />
          {error && (
            <div className="panel p-4 text-sm" style={{ color: "var(--danger)" }}>
              {error}
            </div>
          )}
          {data?.notice && (
            <div
              className="panel p-3 text-xs"
              style={{ color: "var(--warn)", borderColor: "var(--warn)" }}
            >
              {data.notice}
            </div>
          )}
          {data?.report && activeReport && (
            <>
              <GroundingBadge
                backend={backend}
                unattributed={activeReport.unattributed}
                delta={delta}
                onSeeCausal={backend !== "causal" ? () => setBackend("causal") : undefined}
              />
              {data.reports && (
                <DivergencePanel
                  reports={data.reports}
                  citations={data.citations}
                  retrievedCount={data.retrievedCount}
                />
              )}
              <AttributionPanel
                backend={backend}
                sources={activeReport.sources}
                unattributed={activeReport.unattributed}
              />
              <AuditPanel
                records={data.settlement}
                entries={data.audit}
                backend={settlementBackend}
                total={data.total}
              />
              <Act2Section>
                <RslPanel data={data} />
                <Ledger data={data} backend={settlementBackend} />
              </Act2Section>
            </>
          )}
        </section>
      </div>

      {data?.report && <RslLeverage data={data} backend={settlementBackend} />}
      {evalResult && <EvalPanel evalResult={evalResult} backend={backend} />}
      <Footer />
    </main>
  );
}

/* ----------------------------------------------------------------------------- */

function GroundingBadge({
  backend,
  unattributed,
  delta,
  onSeeCausal,
}: {
  backend: BackendId;
  unattributed: number;
  delta: { pts: number; vs: BackendId } | null;
  onSeeCausal?: () => void;
}) {
  const grounded = Math.max(0, 1 - unattributed);
  const state = grounded >= 0.7 ? "ok" : grounded <= 0.4 ? "bad" : "mid";
  const color = state === "ok" ? "var(--money)" : state === "bad" ? "var(--danger)" : "var(--warn)";
  const headline =
    state === "ok"
      ? "✓ GROUNDED"
      : state === "bad"
        ? "⚠️ NOT GROUNDED"
        : "◑ PARTIALLY GROUNDED";
  const sub =
    state === "bad"
      ? "answered largely from the model's own memory — not the sources"
      : "of the answer is causally traced to retrieved sources";
  const causal = backend === "causal";
  return (
    // Hero tier — the one number the whole page is built to reveal. Top border
    // tracks grounding state so the reveal reads in color, not just digits.
    <div className="panel-hero p-5" style={{ borderTopColor: color }}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="mono text-[11px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          {causal ? "Causal (leave-one-out) says" : "Naive (retrieval-rank) says"}
        </span>
        {delta && (
          <span
            className="animate-delta mono text-[11px] font-semibold"
            style={{ color: delta.pts < 0 ? "var(--danger)" : "var(--money)" }}
          >
            {delta.pts < 0 ? "▼" : "▲"} {Math.abs(delta.pts)} pts vs {BACKEND_META[delta.vs].short}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-3">
        <span className="mono text-3xl font-bold leading-none" style={{ color }}>
          {pct(grounded)}
        </span>
        <div className="flex flex-col">
          <span className="text-base font-semibold uppercase tracking-wide" style={{ color }}>
            {headline}
          </span>
          <span className="text-[12px]" style={{ color: "var(--muted)" }}>{sub}</span>
        </div>
      </div>
      <p className="mt-3 text-[11px]" style={{ color: "var(--muted)" }}>
        {causal
          ? "Measured causally (leave-one-out): the share of the answer that actually changes when sources are removed. This is the audit-grade grounding signal."
          : "Naive backends assume everything retrieved was used — that claim hasn't been verified against the answer yet."}
      </p>
      {onSeeCausal && (
        <button
          onClick={onSeeCausal}
          className="seg mt-3 rounded-md px-3 py-1.5 text-xs font-semibold"
          style={{ background: "var(--money)", color: "#06281d" }}
        >
          See Causal → watch this number change
        </button>
      )}
    </div>
  );
}

function TwoBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <span className="mono w-12 shrink-0 text-[10px]" style={{ color: "var(--muted)" }}>
        {label}
      </span>
      <div className="bar-track h-2 flex-1">
        <div className="animate-bar h-full" style={{ width: `${Math.round(value * 100)}%`, background: color }} />
      </div>
      <span className="mono w-9 shrink-0 text-right text-[11px] font-semibold" style={{ color }}>
        {pct(value)}
      </span>
    </div>
  );
}

/**
 * The "citation ≠ causation" receipt (live open-prompt only): for the SAME generated answer,
 * each source's own citation share beside its measured causal contribution. Divergent sources get
 * tagged — a cited source that drove nothing ("decorative citation") and an uncited source that
 * actually drove the answer ("uncredited driver"). Deliberately about the ARTIFACT, not a person.
 */
function DivergencePanel({
  reports,
  citations,
  retrievedCount,
}: {
  reports: Partial<Record<BackendId, AttributionReport>>;
  citations?: Citation[];
  retrievedCount?: number;
}) {
  const citation = reports.citation;
  const causal = reports.causal;
  if (!citation || !causal) return null;

  const citById = new Map(citation.sources.map((s) => [s.sourceId, s.attributionScore]));
  const citedIds = new Set((citations ?? []).map((c) => c.sourceId));

  const rows = causal.sources.map((s) => {
    const citScore = citById.get(s.sourceId) ?? 0;
    const cauScore = s.attributionScore;
    const cited = citedIds.has(s.sourceId) || citScore > 0;
    // Thresholds: <5% causal ≈ "did nothing"; ≥15% causal ≈ a material driver. Deliberately
    // asymmetric so only clear-cut divergences get tagged — borderline cases stay untagged.
    let tag: { label: string; color: string } | null = null;
    if (cited && cauScore < 0.05) tag = { label: "decorative citation", color: "var(--danger)" };
    else if (!cited && cauScore >= 0.15) tag = { label: "uncredited driver", color: "var(--money)" };
    return { s, citScore, cauScore, cited, tag };
  });
  rows.sort((a, b) => Math.abs(b.cauScore - b.citScore) - Math.abs(a.cauScore - a.citScore));
  const anyDivergence = rows.some((r) => r.tag);

  return (
    <div className="panel p-4" style={{ borderColor: "var(--money)" }}>
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          Citation vs causal · what the answer credited vs what drove it
        </div>
        <span className="mono text-[10px]" style={{ color: "var(--money)" }}>the receipt</span>
      </div>
      <p className="mb-3 text-[12px]" style={{ color: anyDivergence ? "var(--text)" : "var(--muted)" }}>
        {anyDivergence
          ? "The answer's own citations and its measured causal drivers disagree — see the tags."
          : "On this question the citations and the causal drivers broadly agree."}
      </p>
      <div className="flex flex-col gap-3">
        {rows.map(({ s, citScore, cauScore, cited, tag }) => (
          <div key={s.sourceId}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium">
                {cited ? "" : "— "}
                {s.title}
              </span>
              {tag && (
                <span
                  className="mono shrink-0 rounded px-1.5 py-0.5 text-[9px]"
                  style={{ background: "var(--panel-2)", color: tag.color }}
                >
                  {tag.label}
                </span>
              )}
            </div>
            <TwoBar label="cited" value={citScore} color="var(--accent)" />
            <TwoBar label="causal" value={cauScore} color="var(--money)" />
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px]" style={{ color: "var(--muted)" }}>
        Within this disclosed set of {retrievedCount ?? causal.sources.length} retrieved sources, for a
        single generation (temperature 0): <span className="mono">cited</span> = the answer&apos;s own
        inline-citation share; <span className="mono">causal</span> = share of answer-claims lost when
        that source is removed. Directional, not reproducible run-to-run; not proof of human origin.
      </p>
    </div>
  );
}

function Act2Section({ children }: { children: React.ReactNode }) {
  // Deliberately demoted: collapsed by default so it can't steal focus from the
  // grounding reveal. The teaser stays visible; the detail is one click away.
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="mb-2 flex w-full items-center gap-3 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          Act 2 · when payment rails arrive
        </span>
        <span className="h-px flex-1" style={{ background: "var(--border)" }} />
        <span className="mono text-[10px]" style={{ color: "var(--muted)" }}>{open ? "hide ▾" : "show ▸"}</span>
      </button>
      <p className="mb-3 text-[12px]" style={{ color: "var(--muted)" }}>
        The same causal record that proves grounding today becomes the meter that <em>settles</em>{" "}
        per-inference payments when RSL&apos;s rail matures. Same engine, expansion market.
      </p>
      {open && (
        <div className="flex flex-col gap-5" style={{ opacity: 0.85 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function Header({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <span
            className="grid h-7 w-7 place-items-center rounded-md text-sm font-bold"
            style={{ background: "var(--money)", color: "#06281d" }}
          >
            ₸
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Tribute</h1>
          <span className="mono text-[11px] rounded px-1.5 py-0.5" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
            AI answer provenance
          </span>
        </div>
        <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--muted)" }}>
          Prove which sources your AI actually <em>used</em> to answer — causally, not just retrieved,
          and tamper-evident. <span style={{ color: "var(--text)" }}>The provenance layer for enterprise AI.</span>
        </p>
      </div>
      <div className="flex items-center gap-1 rounded-lg p-1" style={{ background: "var(--panel-2)" }}>
        {(["canned", "live"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className="seg rounded-md px-3 py-1.5 text-xs font-medium"
            style={
              mode === m
                ? { background: "var(--accent)", color: "#04142e" }
                : { color: "var(--muted)" }
            }
          >
            {m === "canned" ? "Pre-computed" : "Live (Claude)"}
          </button>
        ))}
      </div>
    </header>
  );
}

function ScenarioPicker({
  traceId,
  isOpen,
  onPickScenario,
  onSubmitOpen,
  loading,
}: {
  traceId: string;
  isOpen: boolean;
  onPickScenario: (id: string) => void;
  onSubmitOpen: (q: string) => void;
  loading: boolean;
}) {
  const [input, setInput] = useState("");
  const submit = () => {
    if (input.trim().length >= 3) onSubmitOpen(input.trim());
  };
  return (
    <div className="panel p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        Scenario
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {SAMPLE_TRACES.map((t) => {
          const active = !isOpen && traceId === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onPickScenario(t.id)}
              className="seg rounded-lg border p-3 text-left text-sm"
              style={{
                borderColor: active ? "var(--accent)" : "var(--border)",
                background: active ? "var(--panel-2)" : "transparent",
              }}
            >
              <div className="font-medium">{t.title}</div>
            </button>
          );
        })}
      </div>

      {/* Open prompt — type any question, run the live meter on real retrieved sources */}
      <div
        className="mt-3 rounded-lg border p-3"
        style={{ borderColor: isOpen ? "var(--money)" : "var(--border)" }}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            ✨ Your own prompt {isOpen && <span style={{ color: "var(--money)" }}>· live</span>}
          </span>
          <span className="mono text-[10px]" style={{ color: "var(--muted)" }}>
            retrieves real sources · causal
          </span>
        </div>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Ask anything — e.g. What caused the 2008 financial crisis?"
            className="mono flex-1 rounded-md border px-3 py-2 text-[13px] outline-none"
            style={{ borderColor: "var(--border)", background: "var(--panel-2)", color: "var(--text)" }}
          />
          <button
            onClick={submit}
            disabled={loading || input.trim().length < 3}
            className="seg rounded-md px-4 py-2 text-xs font-semibold disabled:opacity-50"
            style={{ background: "var(--money)", color: "#06281d" }}
          >
            {loading && isOpen ? "Running…" : "Run"}
          </button>
        </div>
        <p className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
          Runs the full meter on a live question: search → generate → measure causal contribution →
          RSL discovery on the real source URLs. Needs search + model keys.
        </p>
      </div>
    </div>
  );
}

function AnswerPanel({
  query,
  answer,
  teaching,
  mode,
  model,
}: {
  query: string;
  answer: string;
  teaching?: string;
  mode: Mode;
  model: string;
}) {
  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          RAG answer
        </div>
        <span className="mono text-[10px] rounded px-1.5 py-0.5" style={{ background: "var(--panel-2)", color: mode === "live" ? "var(--money)" : "var(--muted)" }}>
          {model}
        </span>
      </div>
      <div className="text-sm" style={{ color: "var(--muted)" }}>Query</div>
      <div className="mb-3 font-medium">{query}</div>
      <div className="text-sm" style={{ color: "var(--muted)" }}>Answer</div>
      <p className="mt-1 text-[15px] leading-relaxed">{answer}</p>
      {teaching && (
        <div
          className="mt-4 rounded-lg border-l-2 p-3 text-[13px]"
          style={{ borderColor: "var(--accent)", background: "var(--panel-2)", color: "var(--muted)" }}
        >
          {teaching}
        </div>
      )}
    </div>
  );
}

function BackendToggle({
  backend,
  setBackend,
  loading,
}: {
  backend: BackendId;
  setBackend: (b: BackendId) => void;
  loading: boolean;
}) {
  const meta = BACKEND_META[backend];
  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          Attribution backend {loading && <span className="ml-2 animate-pulse" style={{ color: "var(--accent)" }}>computing…</span>}
        </div>
        <span className="mono text-[10px]" style={{ color: meta.kind === "active" ? "var(--money)" : "var(--muted)" }}>
          {meta.kind === "active" ? "causal · re-generates" : "passive · observes"}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1 rounded-lg p-1" style={{ background: "var(--panel-2)" }}>
        {BACKENDS.map((b) => {
          const active = backend === b;
          const causal = b === "causal";
          return (
            <button
              key={b}
              onClick={() => setBackend(b)}
              className="seg rounded-md px-2 py-2 text-xs font-medium"
              style={
                active
                  ? { background: causal ? "var(--money)" : "var(--accent)", color: causal ? "#06281d" : "#04142e" }
                  : { color: "var(--muted)" }
              }
            >
              {BACKEND_META[b].short}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[13px]" style={{ color: "var(--muted)" }}>
        {meta.blurb}
      </p>
    </div>
  );
}

function AttributionPanel({
  backend,
  sources,
  unattributed,
}: {
  backend: BackendId;
  sources: SourceAttribution[];
  unattributed: number;
}) {
  const causal = backend === "causal";
  const barColor = causal ? "var(--money)" : "var(--accent)";
  const max = Math.max(0.0001, ...sources.map((s) => s.attributionScore));
  return (
    <div className="panel p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        Attribution score · per source
      </div>
      <div className="flex flex-col gap-3">
        {sources.map((s) => (
          <div key={s.sourceId}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium">{s.title}</span>
              <span className="mono text-sm font-semibold" style={{ color: barColor }}>
                {pct(s.attributionScore)}
              </span>
            </div>
            <div className="bar-track h-2.5">
              <div
                className="animate-bar h-full"
                style={{ width: `${(s.attributionScore / max) * 100}%`, background: barColor }}
              />
            </div>
            <div className="mt-1.5 grid grid-cols-4 gap-2">
              {(["relevance", "authority", "uniqueness", "usage"] as const).map((k) => (
                <SubScore key={k} label={k} value={s.subScores[k]} />
              ))}
            </div>
          </div>
        ))}
        {/* Unattributed / parametric */}
        <div className="mt-1 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-sm" style={{ color: "var(--warn)" }}>
              Model parametric / unattributed
            </span>
            <span className="mono text-sm font-semibold" style={{ color: "var(--warn)" }}>
              {pct(unattributed)}
            </span>
          </div>
          <div className="bar-track h-2.5">
            <div className="h-full" style={{ width: `${unattributed * 100}%`, background: "var(--warn)" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SubScore({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[10px]" style={{ color: "var(--muted)" }}>
        <span className="capitalize">{label.slice(0, 4)}</span>
        <span className="mono">{value.toFixed(2)}</span>
      </div>
      <div className="bar-track h-1">
        <div className="h-full" style={{ width: `${value * 100}%`, background: "var(--muted)" }} />
      </div>
    </div>
  );
}

const VIA_BADGE: Record<string, { label: string; color: string }> = {
  live: { label: "live · real", color: "var(--money)" },
  cc: { label: "CC / public domain", color: "var(--accent)" },
  illustrative: { label: "illustrative", color: "var(--warn)" },
  none: { label: "—", color: "var(--muted)" },
};

function RslPanel({ data }: { data: AttributeResponse }) {
  return (
    <div className="panel-compact p-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        RSL license terms · discovered per source
      </div>
      <p className="mb-3 text-[11px]" style={{ color: "var(--muted)" }}>
        Live discovery follows <span className="mono">robots.txt → License: → rsl.xml</span>.
        Only Stack Overflow &amp; the RSL Collective ship real RSL today — publisher rates are
        <span style={{ color: "var(--warn)" }}> illustrative</span>, anchored to reported deal economics.
      </p>
      <div className="flex flex-col gap-2">
        {data.rsl.map((r) => {
          const badge = VIA_BADGE[r.via] ?? VIA_BADGE.none;
          return (
            <div key={r.sourceUrl} className="flex items-center justify-between gap-3 text-sm">
              <span className="mono truncate text-[12px]" title={r.provenance}>{r.domain}</span>
              <div className="flex items-center gap-2">
                {r.found ? (
                  <>
                    <span
                      className="mono rounded px-1.5 py-0.5 text-[10px]"
                      style={{ background: "var(--panel-2)", color: r.paymentType === "use" ? "var(--money)" : "var(--muted)" }}
                    >
                      payment=&quot;{r.paymentType}&quot;
                    </span>
                    <span className="mono text-[12px]" style={{ color: "var(--muted)" }}>
                      {r.baseRate ? `${fmtUSD(r.baseRate)}/use` : r.via === "live" && r.paymentType === "use" ? "rate @ server" : "no fee"}
                    </span>
                  </>
                ) : (
                  <span className="text-[12px]" style={{ color: "var(--muted)" }}>no RSL terms</span>
                )}
                <span
                  className="mono rounded px-1.5 py-0.5 text-[9px]"
                  style={{ background: "var(--panel-2)", color: badge.color }}
                  title={r.provenance}
                >
                  {badge.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Ledger({ data, backend }: { data: AttributeResponse; backend: BackendId }) {
  return (
    <div className="panel-compact p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          Settlement ledger · RSL-shaped records
        </div>
        <span className="mono text-[10px]" style={{ color: "var(--muted)" }}>
          base × score × usage
        </span>
      </div>
      {data.settlement.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>No billable sources for this response.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px]" style={{ color: "var(--muted)" }}>
              <th className="pb-2 font-medium">source</th>
              <th className="pb-2 text-right font-medium">base</th>
              <th className="pb-2 text-right font-medium">score</th>
              <th className="pb-2 text-right font-medium">usage</th>
              <th className="pb-2 text-right font-medium">amount</th>
            </tr>
          </thead>
          <tbody className="mono text-[12px]">
            {data.settlement.map((r: SettlementRecord) => (
              <tr key={r.sourceId} className="border-t" style={{ borderColor: "var(--border)" }}>
                <td className="py-1.5 pr-2 truncate" style={{ maxWidth: 160 }}>{r.sourceId.split("-").slice(0, 2).join("-")}</td>
                <td className="py-1.5 text-right" style={{ color: "var(--muted)" }}>{fmtUSD(r.baseRate)}</td>
                <td className="py-1.5 text-right">{r.attributionScore.toFixed(3)}</td>
                <td className="py-1.5 text-right" style={{ color: "var(--muted)" }}>{r.usage.toFixed(2)}</td>
                <td className="py-1.5 text-right font-semibold" style={{ color: r.amount > 0 ? "var(--money)" : "var(--muted)" }}>
                  {fmtUSD(r.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2" style={{ borderColor: "var(--border)" }}>
              <td className="pt-2 text-[11px]" colSpan={4} style={{ color: "var(--muted)" }}>
                total settlement · backend={backend}
              </td>
              <td className="pt-2 text-right text-base font-bold" style={{ color: "var(--money)" }}>
                {fmtUSD(data.total.amount)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

function AuditPanel({
  records,
  entries,
  backend,
  total,
}: {
  records: SettlementRecord[];
  entries: AttributeResponse["audit"];
  backend: BackendId;
  total: AttributeResponse["total"];
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const [tampered, setTampered] = useState(false);
  // A trust feature, not the reveal — collapsed by default so a technical
  // evaluator opens it deliberately rather than it competing above the fold.
  const [open, setOpen] = useState(false);

  const replay = useCallback(async () => {
    const recs = tampered
      ? records.map((r, i) => (i === 0 ? { ...r, amount: r.amount + 0.01 } : r))
      : records;
    const ok = await verifyChainBrowser(recs, entries);
    setState(ok ? "ok" : "fail");
  }, [records, entries, tampered]);

  // Reset the verification result when the records or the tamper toggle change.
  // Done during render (React's "adjust state on a prop change" pattern) rather
  // than in an effect, so it doesn't trigger an extra render pass.
  const verifyKey = `${entries.length}:${entries[0]?.chainHash ?? ""}:${tampered}`;
  const [seenVerifyKey, setSeenVerifyKey] = useState(verifyKey);
  if (verifyKey !== seenVerifyKey) {
    setSeenVerifyKey(verifyKey);
    setState("idle");
  }

  return (
    <div className="panel p-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          Audit trail · hash-chained <span style={{ color: "var(--money)" }}>· the independence moat</span>
        </div>
        <span className="mono text-[10px]" style={{ color: "var(--muted)" }}>
          {open ? "hide ▾" : `${entries.length} records · verify ▸`}
        </span>
      </button>
      {open && (
      <>
      <div className="mb-3 mt-3 flex items-center justify-end gap-2">
        <label className="flex items-center gap-1 text-[11px]" style={{ color: "var(--muted)" }}>
          <input type="checkbox" checked={tampered} onChange={(e) => setTampered(e.target.checked)} />
          simulate tamper
        </label>
        <button
          onClick={replay}
          className="seg rounded-md px-3 py-1 text-xs font-medium"
          style={{ background: "var(--panel-2)", color: "var(--text)" }}
        >
          Replay &amp; verify
        </button>
        <button
          onClick={() =>
            downloadJson(`tribute-audit-${backend}.json`, {
              kind: "tribute.audit-record",
              version: 1,
              exportedAt: new Date().toISOString(),
              backend,
              settlement: records,
              audit: entries,
              total,
            })
          }
          className="seg rounded-md px-3 py-1 text-xs font-medium"
          style={{ background: "var(--panel-2)", color: "var(--text)" }}
        >
          Download audit record (JSON)
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {entries.length === 0 && (
          <p className="text-sm" style={{ color: "var(--muted)" }}>No records to chain.</p>
        )}
        {entries.map((e) => (
          <div key={e.index} className="mono flex items-center gap-2 text-[11px]">
            <span style={{ color: "var(--muted)" }}>#{e.index}</span>
            <span className="truncate" style={{ color: "var(--accent)" }}>{e.chainHash.slice(0, 24)}…</span>
            <span className="ml-auto truncate" style={{ color: "var(--muted)" }}>{e.summary}</span>
          </div>
        ))}
      </div>
      {state !== "idle" && (
        <div
          className="mt-3 rounded-md px-3 py-2 text-sm font-medium"
          style={
            state === "ok"
              ? { background: "rgba(52,211,153,0.12)", color: "var(--money)" }
              : { background: "rgba(248,113,113,0.12)", color: "var(--danger)" }
          }
        >
          {state === "ok"
            ? "✓ Chain verified — ledger is intact and replayable."
            : "✗ Verification FAILED — a record was altered after settlement."}
        </div>
      )}
      </>
      )}
    </div>
  );
}

const METHOD_LABEL: Record<BackendId, string> = {
  retrieval: "retrieval-rank",
  citation: "citation-grounded",
  semantic: "semantic-overlap",
  causal: "causal-loo",
};

function RslLeverage({ data, backend }: { data: AttributeResponse; backend: BackendId }) {
  // Pick a billable source to make the standard→record mapping concrete.
  const term =
    data.rsl.find((r) => r.paymentType === "use") ?? data.rsl.find((r) => r.found);
  const record = term
    ? data.settlement.find((s) => s.sourceUrl === term.sourceUrl)
    : undefined;
  if (!term) return null;

  // The authentic, real payment-bearing RSL — the RSL Collective's own live royalty.xml.
  const xml = `<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/" server="api.rslcollective.org">
    <license>
      <permits type="usage">ai-all</permits>
      <payment type="use">
        <standard>rslcollective.org/license</standard>
      </payment>
    </license>
    <!-- per-source attribution: UNDEFINED in RSL 1.0 -->
  </content>
</rsl>`;

  const recordObj = record
    ? {
        source_id: record.sourceId,
        license_ref: record.rslLicenseRef,
        attribution_score: record.attributionScore,
        usage: record.usage,
        amount: record.amount,
        method: METHOD_LABEL[backend],
        response_hash: record.responseHash,
      }
    : null;

  return (
    <div className="panel mt-5 p-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        Act 2 · Standing on the standard — the settlement expansion (RSL)
      </div>
      <p className="mb-3 max-w-3xl text-[13px]" style={{ color: "var(--muted)" }}>
        The next data squeeze moves from <span style={{ color: "var(--text)" }}>access</span> (crawl
        licensing, x402) to <span style={{ color: "var(--text)" }}>attribution</span> — who gets paid
        depends on measured contribution. RSL is the rail 1,500+ publishers endorsed (deployment is
        just beginning — today only Stack Overflow &amp; the RSL Collective ship real terms); it
        declared the payment and left the measurement blank. Tribute emits the record that fills it.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium" style={{ color: "var(--muted)" }}>
            <span>What RSL declares (the rail)</span>
            <span className="mono text-[9px]" style={{ color: "var(--money)" }}>real · rslcollective.org/royalty.xml</span>
          </div>
          <pre
            className="mono overflow-x-auto rounded-lg p-3 text-[11px] leading-relaxed"
            style={{ background: "var(--panel-2)", color: "var(--text)" }}
          >
{xml}
          </pre>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium">
            <span style={{ color: "var(--money)" }}>What Tribute emits (the hole it leaves)</span>
            <span className="mono text-[9px]" style={{ color: "var(--money)" }}>● re-emits on every meter change</span>
          </div>
          <pre
            key={`${recordObj?.response_hash ?? "none"}:${backend}`}
            className="animate-emit mono overflow-x-auto rounded-lg p-3 text-[11px] leading-relaxed"
            style={{ background: "var(--panel-2)", color: "var(--money)", borderLeft: "2px solid var(--money)" }}
          >
{recordObj ? JSON.stringify(recordObj, null, 2) : "// this source carries no per-use fee\n// (CC / public-domain → attribution only)"}
          </pre>
        </div>
      </div>
      <p className="mt-3 text-[11px]" style={{ color: "var(--muted)" }}>
        {term.via === "live"
          ? "Source terms fetched live and real. "
          : term.via === "illustrative"
            ? "Amount uses an illustrative rate (RSL not yet deployed for this source) anchored to reported deal economics; the real rate resolves at the publisher's license server. "
            : ""}
        The attribution score is the part RSL leaves undefined — that is what Tribute measures.
      </p>
    </div>
  );
}

function evalBy(r: EvalResult, id: BackendId): BackendEval {
  return r.backends.find((b) => b.backend === id)!;
}

function EvalStrip({ evalResult }: { evalResult: EvalResult }) {
  const causal = evalBy(evalResult, "causal");
  const retrieval = evalBy(evalResult, "retrieval");
  return (
    <div
      className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border px-4 py-3"
      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
    >
      <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        Independent meter accuracy
      </div>
      <div className="text-[15px]">
        <span className="font-semibold" style={{ color: "var(--money)" }}>
          Causal rejects {pct(causal.rejection)}
        </span>{" "}
        <span style={{ color: "var(--muted)" }}>of provably-unused sources —</span>{" "}
        <span className="font-semibold" style={{ color: "var(--danger)" }}>
          naive retrieval only {pct(retrieval.rejection)}
        </span>
        .
      </div>
      <div className="mono ml-auto text-[11px]" style={{ color: "var(--muted)" }}>
        measured on {evalResult.unusedSampleCount} labeled distractor/parametric sources · not circular
      </div>
    </div>
  );
}

function EvalPanel({ evalResult, backend }: { evalResult: EvalResult; backend: BackendId }) {
  const W = 560;
  const H = 300;
  const mL = 56;
  const mB = 44;
  const mT = 22;
  const mR = 96;
  const maxCost = Math.max(2, ...evalResult.backends.map((b) => b.cost));
  const yMin = 0.5;
  const x = (cost: number) => mL + (cost / maxCost) * (W - mL - mR);
  const y = (rej: number) => mT + (1 - (rej - yMin) / (1 - yMin)) * (H - mT - mB);
  const pts = [...evalResult.backends].sort((a, b) => a.cost - b.cost);
  const color = (id: BackendId) => (id === "causal" ? "var(--money)" : "var(--accent)");
  const active = evalBy(evalResult, backend);

  return (
    <div className="panel mt-5 p-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        Cost / fidelity — accuracy vs generations
      </div>
      <p className="mb-2 text-[13px]" style={{ color: "var(--muted)" }}>
        Dial accuracy per budget. The cheap backends are calibrated against{" "}
        <span style={{ color: "var(--money)" }}>measured causal contribution</span> — an independent
        yardstick, not the backends&apos; own similarity assumption.
      </p>
      <p className="mb-2 text-[13px]" style={{ color: "var(--muted)" }}>
        <strong style={{ color: "var(--text)" }}>Calibration</strong> = rank agreement (Spearman)
        between each cheap backend and the measured causal backend — an independent yardstick,
        synthetic ground truth, not third-party validated.
      </p>
      {/* Live: reads off the backend you're currently metering with. */}
      <p key={backend} className="animate-delta mb-3 text-[13px]">
        <span style={{ color: "var(--muted)" }}>Now metering with </span>
        <span className="font-semibold" style={{ color: color(backend) }}>{BACKEND_META[backend].short}</span>
        <span style={{ color: "var(--muted)" }}> — rejects </span>
        <span className="mono font-semibold" style={{ color: color(backend) }}>{pct(active.rejection)}</span>
        <span style={{ color: "var(--muted)" }}> of provably-unused sources at </span>
        <span className="mono font-semibold" style={{ color: "var(--text)" }}>{active.cost}</span>
        <span style={{ color: "var(--muted)" }}> gen/response.</span>
      </p>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1.5fr_minmax(0,1fr)] md:items-center">
        {/* curve */}
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[560px] overflow-visible">
          {/* axes */}
          <line x1={mL} y1={mT} x2={mL} y2={H - mB} stroke="var(--border)" />
          <line x1={mL} y1={H - mB} x2={W - mR} y2={H - mB} stroke="var(--border)" />
          {[0.5, 0.75, 1.0].map((g) => (
            <g key={g}>
              <text x={mL - 8} y={y(g) + 4} textAnchor="end" fontSize="12" fill="var(--muted)">
                {Math.round(g * 100)}
              </text>
              <line x1={mL} y1={y(g)} x2={W - mR} y2={y(g)} stroke="var(--border)" strokeDasharray="2 3" opacity={0.4} />
            </g>
          ))}
          <text x={(mL + W - mR) / 2} y={H - 8} textAnchor="middle" fontSize="12" fill="var(--muted)">
            generations / response →
          </text>
          {/* connecting line */}
          <polyline
            points={pts.map((b) => `${x(b.cost)},${y(b.rejection)}`).join(" ")}
            fill="none"
            stroke="var(--border)"
            strokeWidth={2}
          />
          {/* points — the backend you're metering with lights up, the rest recede */}
          {pts.map((b) => {
            const on = b.backend === backend;
            return (
              <g key={b.backend} opacity={on ? 1 : 0.45}>
                {on && (
                  <circle
                    cx={x(b.cost)}
                    cy={y(b.rejection)}
                    r={13}
                    fill="none"
                    stroke={color(b.backend)}
                    strokeWidth={2}
                    opacity={0.5}
                  />
                )}
                <circle
                  className="eval-dot"
                  cx={x(b.cost)}
                  cy={y(b.rejection)}
                  r={on ? 8.5 : 6}
                  fill={color(b.backend)}
                />
                <text
                  x={x(b.cost) + 10}
                  y={y(b.rejection) + 4}
                  fontSize="13"
                  fontWeight={on ? 700 : 400}
                  fill="var(--text)"
                  className="mono"
                >
                  {BACKEND_META[b.backend].short} {pct(b.rejection)}
                </text>
              </g>
            );
          })}
        </svg>
        {/* table */}
        <table className="w-full self-center text-sm">
          <thead>
            <tr className="text-left text-[11px]" style={{ color: "var(--muted)" }}>
              <th className="pb-1 font-medium">backend</th>
              <th className="pb-1 text-right font-medium">rejection</th>
              <th className="pb-1 text-right font-medium">false-attr</th>
              <th className="pb-1 text-right font-medium">calibration</th>
              <th className="pb-1 text-right font-medium">cost</th>
            </tr>
          </thead>
          <tbody className="mono text-[12px]">
            {evalResult.backends.map((b) => {
              const on = b.backend === backend;
              return (
                <tr
                  key={b.backend}
                  className="eval-row border-t"
                  style={{
                    borderColor: "var(--border)",
                    background: on ? "var(--panel-2)" : "transparent",
                    boxShadow: on ? `inset 2px 0 0 ${color(b.backend)}` : undefined,
                  }}
                >
                  <td className="py-1 pl-2" style={{ color: color(b.backend) }}>
                    {BACKEND_META[b.backend].short}
                    {on && <span className="ml-1" style={{ color: "var(--muted)" }}>◀ now</span>}
                  </td>
                  <td className="py-1 text-right font-semibold">{pct(b.rejection)}</td>
                  <td className="py-1 text-right" style={{ color: "var(--muted)" }}>{pct(b.falseAttribution)}</td>
                  <td className="py-1 text-right" style={{ color: on ? color(b.backend) : "var(--muted)" }}>
                    {b.calibrationVsCausal.toFixed(2)}
                  </td>
                  <td className="py-1 text-right" style={{ color: "var(--muted)" }}>{b.cost} gen</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-8 border-t pt-4 text-[12px]" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
      Records target a local RSL-shaped ledger. The live RSL Collective reporting API does not yet
      define a per-source attribution payload — the measurement gap Tribute is early to. Demo only;
      attribution is directional, not court-grade.
    </footer>
  );
}
