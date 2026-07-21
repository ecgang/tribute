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
 * A→B→A ownership + loading-sync: models the loader's ref algorithm EXACTLY — desiredKey set before
 * the dedupe return, commit gated on shouldCommit, and `loading` derived from whether the desired
 * key is in flight at every transition (including the dedupe return and the settle path). Regression
 * guard for (a) a late B response committing under A, and (b) a cached return-to-A stranding the
 * spinner. Both fail on the earlier reqId / shouldCommit-gated-finally logic.
 */
function makeLoader() {
  let loadedKey: string | null = null;
  const inFlight = new Set<string>();
  let desiredKey = "";
  let loading = false;
  const committed: string[] = [];

  const start = (key: string): boolean => {
    desiredKey = key; // recorded BEFORE the dedupe return
    if (!shouldFetch(key, { loadedKey, inFlight })) {
      loading = inFlight.has(key); // deduped: pending dup → true, cached → false
      return false;
    }
    inFlight.add(key);
    loading = true;
    return true;
  };
  const settle = (key: string, ok = true) => {
    if (shouldCommit(key, desiredKey)) {
      committed.push(key);
      if (ok) loadedKey = key;
    }
    inFlight.delete(key);
    loading = inFlight.has(desiredKey); // spinner tracks the CURRENTLY-desired request
  };
  return {
    start,
    settle,
    committed,
    get loading() {
      return loading;
    },
  };
}

describe("A→B→A ownership + loading sync", () => {
  it("in-flight A→B→A (B settles first): only A commits, loading ends false", () => {
    const L = makeLoader();
    expect([L.start("A"), L.start("B"), L.start("A")]).toEqual([true, true, false]);
    L.settle("B"); // desired is A → B dropped; A still pending
    expect(L.loading).toBe(true);
    L.settle("A");
    expect(L.committed).toEqual(["A"]);
    expect(L.loading).toBe(false);
  });

  it("cached A→B→A: A loaded, B starts, return to A, B settles → loading false, B dropped", () => {
    const L = makeLoader();
    L.start("A");
    L.settle("A"); // A cached
    expect(L.loading).toBe(false);
    L.start("B"); // B in flight
    expect(L.loading).toBe(true);
    L.start("A"); // return to cached A → deduped; desired A is not pending
    expect(L.loading).toBe(false);
    L.settle("B"); // late B → dropped, spinner stays cleared
    expect(L.committed).toEqual(["A"]);
    expect(L.loading).toBe(false);
  });
});
