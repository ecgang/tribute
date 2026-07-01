/**
 * Concrete Anthropic-backed `GenerateFn` factory (server-only).
 *
 * This is the only place in the causal path that constructs an Anthropic client. Determinism
 * lever is temperature = 0 (the Anthropic API does not expose a seed); settlement numbers from
 * live mode are directional, not bit-reproducible.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { RetrievedCandidate } from "../schema";
import { LIVE_MODEL, LiveUnavailableError, type GenerateFn } from "./active";

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new LiveUnavailableError("ANTHROPIC_API_KEY not set — live mode unavailable.");
  return new Anthropic({ apiKey });
}

function buildContext(candidates: RetrievedCandidate[]): string {
  return candidates
    .map((c, i) => `[Source ${i + 1}] ${c.title}\n${c.chunkText}`)
    .join("\n\n");
}

const SYSTEM =
  "You are a retrieval-augmented answer engine. Answer the user's question concisely using ONLY the provided sources. If the sources do not contain the answer, answer from general knowledge in one sentence. Do not mention the sources or that you were given context.";

/**
 * Build a `GenerateFn` backed by a real Anthropic client. Constructs (and validates) the
 * client eagerly, so `LiveUnavailableError` surfaces at call-site construction — matching the
 * prior behavior where `client()` was invoked before any generation happened.
 */
export function anthropicGenerate(): GenerateFn {
  const anthropic = client();
  return async (query: string, candidates: RetrievedCandidate[]): Promise<string> => {
    const msg = await anthropic.messages.create({
      model: LIVE_MODEL,
      max_tokens: 400,
      temperature: 0,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Sources:\n${buildContext(candidates)}\n\nQuestion: ${query}`,
        },
      ],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  };
}
