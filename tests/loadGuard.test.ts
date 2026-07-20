import { describe, expect, it } from "vitest";
import { shouldFetch } from "../lib/loadGuard";

const KEY = "open:what caused the 2008 financial crisis";

const NONE: ReadonlySet<string> = new Set();

describe("shouldFetch — open-prompt fetch dedupe / retry lifecycle", () => {
  it("fetches when nothing is loaded or in flight", () => {
    expect(shouldFetch(KEY, { loadedKey: null, inFlight: NONE })).toBe(true);
  });

  it("skips while the same key is in flight (in-flight dedupe)", () => {
    expect(shouldFetch(KEY, { loadedKey: null, inFlight: new Set([KEY]) })).toBe(false);
  });

  it("skips after the same key has loaded — backend toggle causes no paid refetch", () => {
    expect(shouldFetch(KEY, { loadedKey: KEY, inFlight: NONE })).toBe(false);
  });

  it("RETRIES the same prompt after a failure: a failed request locks nothing", () => {
    // load() deletes its key from inFlight in `finally` and only sets loadedKey on success, so a
    // transient failure leaves state {loadedKey:null, inFlight:∅} — the identical prompt is
    // retryable (regression guard for the sticky-failure bug where the key was committed early).
    expect(shouldFetch(KEY, { loadedKey: null, inFlight: NONE })).toBe(true);
  });

  it("fetches a different key even while another key is in flight (interleaving)", () => {
    expect(shouldFetch("sc:clean-attribution:causal:canned", { loadedKey: null, inFlight: new Set([KEY]) })).toBe(
      true,
    );
  });

  it("fetches a different key even when another has loaded", () => {
    expect(shouldFetch("sc:clean-attribution:causal:canned", { loadedKey: KEY, inFlight: NONE })).toBe(
      true,
    );
  });
});
