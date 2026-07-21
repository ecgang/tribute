/**
 * Cross-model benchmark providers — each a `GenerateFn` so the existing pipeline
 * (`liveCausal` → `parseCitations` → `assembleLiveWithReports`) drives every model unchanged.
 *
 * BENCHMARK-ONLY. This module shells out to LOCAL CLIs (codex, agy) and MUST NEVER be imported
 * by the Next.js route — shelling to local binaries from a web request is unsafe and won't run on
 * Vercel. It lives under scripts/ for exactly that reason.
 *
 * Providers:
 *   claude → Anthropic API (temp 0, raw completion).
 *   gpt    → Codex CLI  (`codex exec -o <file>` captures only the final assistant message).
 *   gemini → agy CLI    (`agy --print --mode plan` prints the response to stdout).
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateFn } from "../lib/attribution/active";
import type { RetrievedCandidate } from "../lib/schema";
import { systemFor, userBody } from "../lib/attribution/prompt";
import { anthropicGenerate } from "../lib/attribution/anthropicGenerate";
import { sanitizeCliOutput } from "./faithfulness";

// Mechanical server-boundary guard: this module shells out to local CLIs, so it must NEVER run
// inside a Next.js server/edge bundle — an HTTP-controlled prompt reaching codex/agy would be RCE.
// Next sets NEXT_RUNTIME in its server bundles; throw at import time if we're ever loaded there.
// (A comment alone isn't enforcement — reviewer finding.) Threat model note: executable resolution
// still trusts the developer's PATH minus node_modules/.bin; acceptable for a LOCAL dev-only tool
// that this guard keeps off any server, not a hardened multi-tenant surface.
if (process.env.NEXT_RUNTIME) {
  throw new Error("scripts/providers.ts is benchmark-only and must not be imported into a Next.js runtime.");
}

export type ProviderId = "claude" | "gemini" | "gemini-flash" | "gpt";

/** The single-prompt form of the instruction — CLIs have no separate system slot, so the system
 *  prompt is folded in, byte-identical to what the API path sends via `systemFor`. Empty subset
 *  (v(∅)) → closed-book system prompt, no `Sources:` block, and no citation output instruction. */
export function buildRagPrompt(query: string, candidates: RetrievedCandidate[]): string {
  const outputTail =
    candidates.length === 0
      ? `Output ONLY the answer text. No preamble, no explanation of your process, no code fences.`
      : `Output ONLY the answer text with inline [n] citations. No preamble, no explanation of your process, no code fences.`;
  return `${systemFor(candidates)}\n\n${userBody(query, candidates)}\n\n${outputTail}`;
}

interface CliResult {
  stdout: string;
  stderr: string;
}

interface RunOpts {
  timeoutMs: number;
  /** Working directory — codex must run OUTSIDE the repo or it explores it and hangs. */
  cwd?: string;
  /** Written to the child's stdin then closed — used to pass large prompts safely. */
  input?: string;
}

/** Spawn a CLI with an argv array (NO shell — avoids injection from prompt content), capture
 *  stdout, enforce a hard timeout, reject on nonzero exit. */
function runCli(cmd: string, args: string[], opts: RunOpts): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    // Sanitize PATH: `npx` (the benchmark runs under `npx tsx`) prepends `node_modules/.bin` to
    // PATH. codex is a Node CLI whose `#!/usr/bin/env node` shebang then resolves to a wrapped/wrong
    // node from that dir, which crashes on a circular dependency and emits EMPTY stdout. Stripping
    // the `node_modules/.bin` segments makes codex's shebang find the real node. Harmless for agy
    // (a Go binary). Verified: with the strip codex returns a clean answer; without it, empty.
    const env = { ...process.env };
    if (env.PATH) {
      env.PATH = env.PATH.split(":")
        .filter((p) => !p.includes("node_modules/.bin"))
        .join(":");
    }
    // detached:true makes the child a process-GROUP leader, so on timeout we can kill the whole
    // group — agent CLIs (codex/agy) spawn descendants that a bare child.kill() would orphan,
    // leaving them burning subscription quota. We also wait for the real 'close' before settling.
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: [opts.input != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL"); // negative pid → whole process group
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer); // settle only after the process has actually terminated
      if (timedOut) reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`));
    });
    if (opts.input != null) {
      child.stdin?.end(opts.input);
    }
  });
}

const CLI_TIMEOUT_MS = Number(process.env.BENCH_CLI_TIMEOUT_MS ?? 240_000);

/**
 * Global CLI serialization. `liveCausal` fires its ablation generations via `Promise.all`
 * (great for the API), but concurrent `codex`/`agy` sessions collide (shared session state,
 * reconnection storms → codex exits 0 without writing its -o file). Serializing every CLI call
 * through one chain fixes that without touching the shared engine. Slower, but correct.
 */
let cliChain: Promise<unknown> = Promise.resolve();
function serializeCli<T>(fn: () => Promise<T>): Promise<T> {
  const run = cliChain.then(fn, fn);
  cliChain = run.catch(() => undefined);
  return run;
}

/** Retry a transient CLI failure once (the agent CLIs hit intermittent "Reconnecting" errors). */
async function withRetry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * GPT via Codex CLI. `codex exec` is a coding agent that, run INSIDE a repo, explores it and hangs
 * on Q&A prompts. Fix (verified): run from an EMPTY non-repo dir with `--skip-git-repo-check` so
 * there's nothing to explore, pass the prompt on stdin (`-`), `-s read-only` to sandbox tool use.
 * The final answer comes back on STDOUT (event chrome goes to stderr); we capture stdout directly
 * rather than the `-o` file, which proved flaky under repeated in-run invocation.
 */
const CODEX_SANDBOX = join(tmpdir(), "tribute-codex-sandbox");

export function codexGenerate(model?: string): GenerateFn {
  return (query, candidates) =>
    serializeCli(() =>
      withRetry(async () => {
        mkdirSync(CODEX_SANDBOX, { recursive: true });
        const args = ["exec", "-s", "read-only", "--skip-git-repo-check"];
        if (model) args.push("-m", model);
        args.push("-"); // read the prompt from stdin
        const { stdout, stderr } = await runCli("codex", args, {
          timeoutMs: CLI_TIMEOUT_MS,
          cwd: CODEX_SANDBOX,
          input: buildRagPrompt(query, candidates),
        });
        const answer = sanitizeCliOutput(stdout);
        if (!answer.trim()) {
          throw new Error(`codex returned empty stdout. stderr tail: ${stderr.slice(-400)}`);
        }
        return answer;
      }),
    );
}

/**
 * Gemini via agy CLI. Verified invocation: `--model=<name>` (equals, FIRST) then `-p <prompt>`
 * — the positional-after-flags form silently drops the model and ignores the prompt. Default mode
 * in `-p` (non-interactive) can't get edit confirmations, so it stays effectively read-only.
 */
export function agyGenerate(model: string): GenerateFn {
  return (query, candidates) =>
    serializeCli(() =>
      withRetry(async () => {
        const { stdout } = await runCli(
          "agy",
          [`--model=${model}`, "-p", buildRagPrompt(query, candidates)],
          { timeoutMs: CLI_TIMEOUT_MS },
        );
        return sanitizeCliOutput(stdout);
      }),
    );
}

export interface Entrant {
  id: ProviderId;
  /** Display label for the leaderboard. */
  label: string;
  /** Lazy: constructing a gen may build an API client that throws without a key, so `--dry`
   *  (which only needs labels) never triggers it. The runner calls this once before use. */
  makeGen: () => GenerateFn;
}

/**
 * Default entrants — a 3-family benchmark, each on its OWN transport (also maximizes independence):
 * Claude via the Anthropic API, Gemini via agy, GPT via Codex. Claude is deliberately NOT on agy:
 * running two models through agy doubles its shared subscription quota and exhausts it mid-run
 * (observed — Claude died at Q3). The API path is robust and needs ANTHROPIC_API_KEY. Transport
 * asymmetry (API vs agent CLIs) is flagged in the leaderboard caveats. Codex uses its configured
 * default model unless BENCH_CODEX_MODEL is set; Gemini slug from `agy models`.
 */
export function defaultEntrants(): Entrant[] {
  return [
    { id: "claude", label: "Claude Sonnet 4.6", makeGen: () => anthropicGenerate() },
    { id: "gemini", label: "Gemini 3.1 Pro", makeGen: () => agyGenerate("gemini-3.1-pro-high") },
    { id: "gpt", label: "GPT (Codex)", makeGen: () => codexGenerate(process.env.BENCH_CODEX_MODEL) },
  ];
}
