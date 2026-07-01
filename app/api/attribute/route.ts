import { NextResponse } from "next/server";
import { z } from "zod";
import { BACKENDS, RagTraceSchema, type AttributeResponse, type RagTrace } from "@/lib/schema";
import { SAMPLE_TRACE_BY_ID } from "@/lib/sampleTraces";
import { discoverAll } from "@/lib/rslDiscovery";
import { assembleResponse } from "@/lib/pipeline";
import { liveCausal, liveAnswer, LiveUnavailableError, LIVE_MODEL } from "@/lib/attribution/active";
import { retrieveCandidates, SearchUnavailableError } from "@/lib/retrieve";

export const runtime = "nodejs";
// Open-prompt = search + 1 baseline + N ablation model calls; give it room past the default limit.
export const maxDuration = 60;

const BodySchema = z.object({
  traceId: z.string().optional(),
  trace: RagTraceSchema.optional(),
  /** Free-text open prompt — triggers live retrieval + generation + attribution. */
  query: z.string().min(3).optional(),
  backend: z.enum(BACKENDS),
  mode: z.enum(["canned", "live"]).default("canned"),
});

/** Run live generation + the selected backend over a trace whose answer is not yet generated. */
async function attributeLive(
  trace: RagTrace,
  backend: (typeof BACKENDS)[number],
  rsl: Awaited<ReturnType<typeof discoverAll>>,
  timestamp: string,
): Promise<AttributeResponse> {
  if (backend === "causal") {
    const { answer, weights, model } = await liveCausal(trace.query, trace.candidates);
    const liveTrace = { ...trace, answer, generation: { model, temperature: 0, promptAssemblyRef: "rag-v1" } };
    return assembleResponse(liveTrace, "causal", "live", rsl, timestamp, { causal: weights });
  }
  const answer = await liveAnswer(trace.query, trace.candidates);
  const liveTrace = { ...trace, answer, generation: { model: LIVE_MODEL, temperature: 0, promptAssemblyRef: "rag-v1" } };
  return assembleResponse(liveTrace, backend, "live", rsl, timestamp);
}

export async function POST(req: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    console.error("attribute route error", e);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const timestamp = new Date().toISOString();

  // ---- Open-prompt path: retrieve real sources, generate, attribute. Always live. ----
  if (body.query && !body.traceId && !body.trace) {
    let candidates;
    try {
      candidates = await retrieveCandidates(body.query);
    } catch (e) {
      if (e instanceof SearchUnavailableError) {
        return NextResponse.json(
          { error: "search_unavailable", notice: `Open prompt needs a search key. ${e.message}` },
          { status: 200 },
        );
      }
      console.error("attribute route error", e);
      return NextResponse.json({ error: "retrieve_failed" }, { status: 502 });
    }

    const openTrace: RagTrace = {
      id: "open",
      title: "Open prompt",
      query: body.query,
      candidates,
      answer: "",
    };
    const rsl = await discoverAll(candidates.map((c) => c.sourceUrl), { tryLive: true });

    try {
      const result = await attributeLive(openTrace, body.backend, rsl, timestamp);
      return NextResponse.json({
        ...result,
        retrievedCount: candidates.length,
        notice: undefined,
      });
    } catch (e) {
      if (e instanceof LiveUnavailableError) {
        return NextResponse.json(
          { error: "live_unavailable", notice: `Open prompt needs generation. ${e.message}` },
          { status: 200 },
        );
      }
      console.error("attribute route error", e);
      return NextResponse.json({ error: "live_failed" }, { status: 502 });
    }
  }

  // ---- Canned / scenario path ----
  const trace = body.trace ?? (body.traceId ? SAMPLE_TRACE_BY_ID[body.traceId] : undefined);
  if (!trace) {
    return NextResponse.json({ error: "unknown_trace" }, { status: 404 });
  }

  const urls = trace.candidates.map((c) => c.sourceUrl);
  const rsl = await discoverAll(urls, { tryLive: body.mode === "live" });

  let notice: string | undefined;
  let result: AttributeResponse;

  if (body.mode === "live") {
    try {
      result = await attributeLive(trace, body.backend, rsl, timestamp);
    } catch (e) {
      if (e instanceof LiveUnavailableError) {
        notice = "Live mode unavailable (no ANTHROPIC_API_KEY) — showing pre-computed results.";
        result = assembleResponse(trace, body.backend, "canned", rsl, timestamp);
      } else {
        console.error("attribute route error", e);
        return NextResponse.json({ error: "live_failed" }, { status: 502 });
      }
    }
  } else {
    result = assembleResponse(trace, body.backend, "canned", rsl, timestamp);
  }

  return NextResponse.json({ ...result, notice });
}
