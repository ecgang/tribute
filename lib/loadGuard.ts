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

/**
 * True when a settled response for `responseKey` should be committed — i.e. it still matches the
 * latest desired key (the UI's current intent). This is what makes A→B→A safe: after A→B→A the
 * desired key is A again, so a late B response is dropped and only A's response wins, even though
 * the returning A request was deduped as already-in-flight.
 */
export function shouldCommit(responseKey: string, desiredKey: string): boolean {
  return responseKey === desiredKey;
}
