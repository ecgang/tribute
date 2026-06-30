/** Small, dependency-free text utilities for the semantic-overlap backend. */

const STOP = new Set(
  "a an the of to in on at for and or but is are was were be been being it its this that these those with as by from into over under about which who whom whose what when where how than then so such can could will would may might do does did has have had not no nor".split(
    /\s+/,
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );
}

function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Cosine similarity of two texts over bag-of-words term frequencies. 0..1 */
export function cosine(a: string, b: string): number {
  const fa = termFreq(tokenize(a));
  const fb = termFreq(tokenize(b));
  if (fa.size === 0 || fb.size === 0) return 0;
  let dot = 0;
  for (const [t, va] of fa) {
    const vb = fb.get(t);
    if (vb) dot += va * vb;
  }
  let na = 0;
  for (const v of fa.values()) na += v * v;
  let nb = 0;
  for (const v of fb.values()) nb += v * v;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Approximate token count of an answer (for usage share). */
export function tokenCount(text: string): number {
  return tokenize(text).length;
}

export function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
