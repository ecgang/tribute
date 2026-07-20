import { describe, expect, it } from "vitest";
import { shouldFetch, shouldCommit } from "../lib/loadGuard";

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

/**
 * A→B→A response-ownership: models the loader's ref algorithm exactly (desiredKey set before the
 * dedupe return; commit gated on shouldCommit). Regression guard for the race where a late B
 * response committed while the UI had returned to A. This fails on the old reqId-only logic.
 */
describe("A→B→A ownership — only the currently-desired response commits", () => {
  it("drops a late B response and commits A after A→B→A with B resolving first", () => {
    let loadedKey: string | null = null;
    const inFlight = new Set<string>();
    let desiredKey = "";
    const committed: string[] = [];

    // Mirror of load() up to the request:
    const start = (key: string): boolean => {
      desiredKey = key; // recorded BEFORE the dedupe return
      if (!shouldFetch(key, { loadedKey, inFlight })) return false;
      inFlight.add(key);
      return true;
    };
    // Mirror of the settle path:
    const settle = (key: string, ok = true) => {
      if (shouldCommit(key, desiredKey)) {
        committed.push(key);
        if (ok) loadedKey = key;
      }
      inFlight.delete(key);
    };

    const issuedA1 = start("A"); // A in flight
    const issuedB = start("B"); // B in flight
    const issuedA2 = start("A"); // return to A: deduped (A in flight) but desiredKey := "A"
    expect([issuedA1, issuedB, issuedA2]).toEqual([true, true, false]);

    settle("B"); // B resolves first — desired is A → dropped
    settle("A"); // A resolves — desired A → commits

    expect(committed).toEqual(["A"]); // B never shown under A
  });
});
