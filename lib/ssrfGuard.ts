/**
 * SSRF guard for outbound, user-influenced fetches (RSL discovery).
 *
 * Every outbound fetch to an attacker-influenced URL MUST go through
 * `fetchTextGuarded` (or call `assertPublicHttpUrl` first). This rejects
 * non-http(s) schemes and any hostname that resolves to a private, loopback,
 * link-local, or cloud-metadata address.
 *
 * Residual risk (deferred, see plans/001-ssrf-hardening.md "Maintenance
 * notes"): DNS rebinding (TOCTOU) — the check resolves DNS, then `fetch`
 * re-resolves independently. Full protection needs an IP-pinned dispatcher;
 * out of scope for this pass.
 */
import { lookup } from "dns/promises";

const USER_AGENT = "TributeMeter/0.2 (+https://tribute-wine.vercel.app)";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** True if a dotted-quad IPv4 string falls in a private/loopback/link-local range. */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 0) return true; // "this network"
  return false;
}

/** True if an IPv6 string is loopback, unique-local, link-local, or an IPv4-mapped blocked address. */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower === "::") return true; // unspecified
  // Unique-local fc00::/7 → first hex group starts with 'fc' or 'fd'.
  const firstGroup = lower.split(":")[0];
  if (/^f[cd][0-9a-f]{0,2}$/.test(firstGroup)) return true;
  // Link-local fe80::/10.
  if (/^fe[89ab][0-9a-f]$/.test(firstGroup)) return true;
  // IPv4-mapped: ::ffff:a.b.c.d
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

/** Classify an already-resolved IP address string as blocked (private/loopback/link-local) or not. */
function isBlockedIp(address: string): boolean {
  return address.includes(":") ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

/**
 * Parse `raw`, enforce http(s)-only, and ensure the hostname resolves ONLY to
 * public IP addresses. Throws `SsrfBlockedError` on any violation.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError(`invalid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`blocked scheme: ${url.protocol}`);
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new SsrfBlockedError("empty hostname");
  }

  // Literal-IP hostnames: classify directly, no DNS needed.
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isBlockedIp(bareHost)) {
    throw new SsrfBlockedError(`blocked literal IP host: ${hostname}`);
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new SsrfBlockedError(`DNS resolution failed for: ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(`no addresses resolved for: ${hostname}`);
  }

  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new SsrfBlockedError(`blocked resolved address ${address} for host ${hostname}`);
    }
  }

  return url;
}

/**
 * SSRF-safe replacement for a raw `fetch(url).text()` call. Validates the URL
 * (scheme + resolved-IP checks) before connecting, applies the existing
 * AbortController timeout pattern, and caps the response body size.
 * Returns `null` on any error (blocked URL, network failure, timeout, or
 * non-OK response) — matching the previous `fetchText` contract.
 */
export async function fetchTextGuarded(
  rawUrl: string,
  timeoutMs: number,
  maxBytes = 512_000,
): Promise<string | null> {
  try {
    await assertPublicHttpUrl(rawUrl);
  } catch {
    return null;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(rawUrl, {
      signal: ctrl.signal,
      headers: { "user-agent": USER_AGENT },
    });
    if (!res.ok) return null;

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) return null;

    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            return null;
          }
          chunks.push(value);
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return buf.toString("utf-8");
    }

    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
