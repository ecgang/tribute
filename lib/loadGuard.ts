/**
 * Fetch-dedupe guard for the open-prompt / scenario loader.
 *
 * The open-prompt path returns all backends in one (paid) response, so switching backend must NOT
 * re-fire the request — but a FAILED or degraded request must stay retryable for the same prompt.
 * The invariant that makes both true: a key is "locked" (skip re-fetch) only once it has SUCCEEDED
 * or is currently IN FLIGHT. A failure locks nothing, so the identical prompt can be retried.
 */
export interface LoadGuardState {
  /** Key of the last request that returned a usable response. Locked → skip. */
  loadedKey: string | null;
  /** Keys currently awaiting a response. Membership → skip (in-flight dedupe). A Set (not a
   *  scalar) so interleaved requests for different keys each track + clear their own ownership. */
  inFlight: ReadonlySet<string>;
}

/** True when a request for `key` should actually be issued (not already loaded, not in flight). */
export function shouldFetch(key: string, state: LoadGuardState): boolean {
  return key !== state.loadedKey && !state.inFlight.has(key);
}
