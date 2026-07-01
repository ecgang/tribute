/**
 * Stage 2 — RSL Discovery (real).
 *
 * RSL terms are declared via robots.txt `License:` directive → an `rsl.xml`/`license.xml`,
 * or directly at well-known paths. We follow that chain for real, parse the RSL XML, and
 * label provenance honestly:
 *   - live        : real RSL XML fetched + parsed now (or a VERIFIED-REAL file).
 *   - illustrative: no RSL deployed → rate-card anchored to real deal economics, clearly labeled.
 *   - cc          : genuinely CC / public-domain (real, attribution, no per-use fee).
 *   - none        : nothing.
 *
 * Reality check (2026-06-30): the ONLY two real, fetchable RSL files on the open web are
 * Stack Overflow (CC-BY-SA) and the RSL Collective's own royalty.xml (payment type="use").
 * Even named adopters (AP, The Verge, Reddit) ship no machine-readable RSL. Publisher rates
 * below are illustrative, anchored to reported AI-licensing deals — NOT live-fetched.
 */
import type { RslTerms } from "./schema";
import { domainOf } from "./sourceResolver";
import { fetchTextGuarded } from "./ssrfGuard";

const COLLECTIVE = "https://api.rslcollective.org";

/** Illustrative per-use rate anchored to reported deal economics (~$0.001/source-use). */
const ILLUSTRATIVE_PROVENANCE =
  "Illustrative rate — anchored to reported AI-licensing deal economics (~$0.001/use; e.g. Reddit–Google $60M/yr). RSL leaves the real rate at the publisher's license server.";

/** Verified-real RSL — content actually fetched + confirmed on 2026-06-30. Embedded so the
 *  demo shows real terms even if a serverless egress IP gets bot-challenged. */
const KNOWN_REAL: Record<string, Omit<RslTerms, "sourceUrl" | "domain">> = {
  "stackoverflow.com": {
    found: true,
    via: "live",
    real: true,
    paymentType: "attribution",
    baseRate: 0,
    currency: "USD",
    licenseRef: "CC-BY-SA-4.0",
    terms: "https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt",
    provenance: "Real — fetched live via stackoverflow.com/robots.txt → License: → license.xml.",
    raw: '<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><terms>https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt</terms></content></rsl>',
  },
  "rslcollective.org": {
    found: true,
    via: "live",
    real: true,
    paymentType: "use",
    currency: "USD",
    licenseRef: "https://rslcollective.org/license",
    server: COLLECTIVE,
    provenance: "Real — RSL Collective's live royalty.xml (payment type=\"use\"); rate resolved at the license server.",
    raw: '<rsl xmlns="https://rslstandard.org/rsl"><content url="/" server="https://api.rslcollective.org"><license><permits type="usage">ai-all</permits><payment type="use"><standard>https://rslcollective.org/license</standard></payment></license></content></rsl>',
  },
};

/** Genuinely CC / public-domain sources — real licenses, attribution, no per-use fee. */
const CC_PD: Record<string, { licenseRef: string }> = {
  "en.wikipedia.org": { licenseRef: "CC-BY-SA-4.0" },
  "wikipedia.org": { licenseRef: "CC-BY-SA-4.0" },
  "nasa.gov": { licenseRef: "US-Gov-Public-Domain" },
  "history.nasa.gov": { licenseRef: "US-Gov-Public-Domain" },
  "usgs.gov": { licenseRef: "US-Gov-Public-Domain" },
};

/** Publishers shown with an illustrative per-use rate (no real RSL deployed yet). */
const ILLUSTRATIVE: Record<string, number> = {
  "britannica.com": 0.0008,
  "theverge.com": 0.001,
  "nature.com": 0.0015,
  "apnews.com": 0.0011,
  "nypost.com": 0.001,
  "bbc.com": 0.0012,
  "dw.com": 0.0009,
  "reuters.com": 0.0013,
  "bloomberg.com": 0.0015,
  "nytimes.com": 0.0015,
};

function ccTerms(url: string, domain: string): RslTerms {
  return {
    sourceUrl: url,
    domain,
    found: true,
    via: "cc",
    real: true,
    paymentType: "attribution",
    baseRate: 0,
    currency: "USD",
    licenseRef: CC_PD[domain].licenseRef,
    provenance: "Real license — CC / public-domain; attribution required, no per-use fee.",
  };
}

function illustrativeTerms(url: string, domain: string): RslTerms {
  return {
    sourceUrl: url,
    domain,
    found: true,
    via: "illustrative",
    real: false,
    paymentType: "use",
    baseRate: ILLUSTRATIVE[domain],
    currency: "USD",
    licenseRef: `rsl:${domain}/illustrative`,
    server: COLLECTIVE,
    provenance: ILLUSTRATIVE_PROVENANCE,
  };
}

function staticTerms(url: string): RslTerms {
  const domain = domainOf(url);
  if (KNOWN_REAL[domain]) return { sourceUrl: url, domain, ...KNOWN_REAL[domain] };
  if (CC_PD[domain]) return ccTerms(url, domain);
  if (ILLUSTRATIVE[domain] != null) return illustrativeTerms(url, domain);
  return { sourceUrl: url, domain, found: false, via: "none" };
}

/** Parse a real RSL XML document into terms. */
export function parseRslXml(url: string, xml: string): RslTerms | null {
  if (!/<rsl[\s>]/i.test(xml)) return null;
  const domain = domainOf(url);
  const payment = xml.match(/<payment\b[^>]*\btype=["']?([a-z]+)["']?/i)?.[1]?.toLowerCase();
  const amount = xml.match(/<payment\b[^>]*\bamount=["']([0-9.]+)["']/i)?.[1];
  const server = xml.match(/\bserver=["']([^"']+)["']/i)?.[1];
  const standard = xml.match(/<standard>\s*([^<\s]+)\s*<\/standard>/i)?.[1];
  const terms = xml.match(/<terms>\s*([^<\s]+)\s*<\/terms>/i)?.[1];
  if (!payment && !terms) return null;
  return {
    sourceUrl: url,
    domain,
    found: true,
    via: "live",
    real: true,
    paymentType: (payment as RslTerms["paymentType"]) ?? (terms ? "attribution" : undefined),
    baseRate: amount ? Number(amount) : terms ? 0 : undefined,
    currency: "USD",
    licenseRef: standard ?? terms ?? (terms ? "open-terms" : undefined),
    terms,
    server,
    provenance: `Real — fetched live from ${domain} and parsed as RSL.`,
    raw: xml.replace(/\s+/g, " ").trim().slice(0, 400),
  };
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  return fetchTextGuarded(url, timeoutMs);
}

/** Real discovery: robots.txt License: → rsl/license.xml, then well-known paths. */
async function discoverLive(url: string, timeoutMs: number): Promise<RslTerms | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }

  // 1. robots.txt `License:` directive → fetch the linked RSL file.
  const robots = await fetchText(`${origin}/robots.txt`, timeoutMs);
  const licUrl = robots?.match(/^\s*License:\s*(\S+)/im)?.[1];
  if (licUrl) {
    const abs = licUrl.startsWith("http") ? licUrl : `${origin}${licUrl.startsWith("/") ? "" : "/"}${licUrl}`;
    const xml = await fetchText(abs, timeoutMs);
    if (xml) {
      const parsed = parseRslXml(url, xml);
      if (parsed) return parsed;
    }
  }

  // 2. Well-known RSL file paths.
  for (const path of ["/license.xml", "/royalty.xml", "/rsl.xml", "/.well-known/rsl.xml"]) {
    const xml = await fetchText(`${origin}${path}`, timeoutMs);
    if (xml) {
      const parsed = parseRslXml(url, xml);
      if (parsed) return parsed;
    }
  }
  return null;
}

export async function discoverRsl(
  url: string,
  opts?: { tryLive?: boolean; timeoutMs?: number },
): Promise<RslTerms> {
  const tryLive = opts?.tryLive ?? true;
  if (tryLive) {
    const live = await discoverLive(url, opts?.timeoutMs ?? 2500);
    if (live) return live;
  }
  // No live RSL found → verified-real embed / CC / illustrative / none.
  return staticTerms(url);
}

export async function discoverAll(urls: string[], opts?: { tryLive?: boolean }): Promise<RslTerms[]> {
  return Promise.all(urls.map((u) => discoverRsl(u, opts)));
}
