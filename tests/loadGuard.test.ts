import { describe, expect, it } from "vitest";
import { shouldFetch } from "../lib/loadGuard";

const KEY = "open:what caused the 2008 financial crisis";

describe("shouldFetch — open-prompt fetch dedupe / retry lifecycle", () => {
  it("fetches when nothing is loaded or in flight", () => {
    expect(shouldFetch(KEY, { loadedKey: null, inFlightKey: null })).toBe(true);
  });

  it("skips while the same key is in flight (in-flight dedupe)", () => {
    expect(shouldFetch(KEY, { loadedKey: null, inFlightKey: KEY })).toBe(false);
  });

  it("skips after the same key has loaded — backend toggle causes no paid refetch", () => {
    expect(shouldFetch(KEY, { loadedKey: KEY, inFlightKey: null })).toBe(false);
  });

  it("RETRIES the same prompt after a failure: a failed request locks nothing", () => {
    // load() clears inFlight in `finally` and only sets loadedKey on success, so a transient
    // failure leaves state {null,null} — the identical prompt is retryable (regression guard for
    // the sticky-failure bug where the key was committed before the request).
    expect(shouldFetch(KEY, { loadedKey: null, inFlightKey: null })).toBe(true);
  });

  it("fetches a different key even when another has loaded", () => {
    expect(shouldFetch("sc:clean-attribution:causal:canned", { loadedKey: KEY, inFlightKey: null })).toBe(
      true,
    );
  });
});
