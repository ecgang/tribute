/**
 * Stage 1 — Source Resolver.
 * Canonicalizes a URL to a stable domain + source identity so the same source is
 * recognized across traces regardless of tracking params / trailing slashes.
 */

const TRACKING_PREFIXES = ["utm_", "ref", "fbclid", "gclid", "mc_"];

export function domainOf(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
  }
}

export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.protocol = "https:";
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PREFIXES.some((p) => key.toLowerCase().startsWith(p))) {
        u.searchParams.delete(key);
      }
    }
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

/** Deterministic stable id from the canonical URL (path-aware). */
export function sourceIdFor(url: string): string {
  const c = canonicalizeUrl(url);
  return `${domainOf(c)}${new URL(c).pathname}`.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/g, "");
}
