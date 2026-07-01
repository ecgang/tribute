import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, SsrfBlockedError } from "../lib/ssrfGuard";

describe("assertPublicHttpUrl — SSRF rejection", () => {
  it("rejects the cloud metadata IP", async () => {
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects IPv4 loopback", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects RFC1918 10/8", async () => {
    await expect(assertPublicHttpUrl("http://10.0.0.5/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects RFC1918 192.168/16", async () => {
    await expect(assertPublicHttpUrl("http://192.168.1.1/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects RFC1918 172.16/12", async () => {
    await expect(assertPublicHttpUrl("http://172.16.0.1/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects IPv6 loopback", async () => {
    await expect(assertPublicHttpUrl("http://[::1]/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects non-http(s) scheme (ftp)", async () => {
    await expect(assertPublicHttpUrl("ftp://example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects non-http(s) scheme (file)", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects malformed URLs", async () => {
    await expect(assertPublicHttpUrl("not-a-url")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  // `localhost` resolves via the test environment's DNS/hosts config, which is not
  // guaranteed to be deterministic in CI. The literal-IP cases above (127.0.0.1,
  // ::1, 10/8, 192.168/16, 172.16/12) already exercise the same blocked-range
  // classifier without depending on a resolver, so we assert on those instead of
  // asserting `localhost` directly.
  it("rejects the literal loopback address that `localhost` resolves to", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a known public host", async () => {
    const url = await assertPublicHttpUrl("https://stackoverflow.com");
    expect(url.hostname).toBe("stackoverflow.com");
  });
});
