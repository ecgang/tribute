import { describe, expect, it } from "vitest";
import { canonicalizeUrl, domainOf, sourceIdFor } from "../lib/sourceResolver";

describe("domainOf", () => {
  it("strips www and lowercases the hostname", () => {
    expect(domainOf("https://www.example.com/x")).toBe("example.com");
  });

  it("does not throw on a garbage string and returns something stable", () => {
    expect(() => domainOf("not a url")).not.toThrow();
    expect(domainOf("not a url")).toBe(domainOf("not a url"));
  });
});

describe("canonicalizeUrl", () => {
  it("strips www and forces https", () => {
    expect(canonicalizeUrl("http://www.example.com/a")).toBe("https://example.com/a");
  });

  it("removes tracking params like utm_source", () => {
    expect(canonicalizeUrl("https://example.com/a?utm_source=x&foo=bar")).toBe(
      "https://example.com/a?foo=bar",
    );
  });

  it("treats a trailing slash and no trailing slash as equal", () => {
    expect(canonicalizeUrl("https://example.com/page/")).toBe(
      canonicalizeUrl("https://example.com/page"),
    );
  });
});

describe("sourceIdFor", () => {
  it("produces the same id for two URLs that canonicalize identically", () => {
    const a = sourceIdFor("http://www.example.com/a/?utm_source=x");
    const b = sourceIdFor("https://example.com/a");
    expect(a).toBe(b);
  });

  it("does not throw on a malformed URL (regression)", () => {
    expect(() => sourceIdFor("::::")).not.toThrow();
  });

  it("returns the same id as before for a valid URL", () => {
    expect(sourceIdFor("https://www.example.com/foo/bar/")).toBe("example-com-foo-bar");
  });
});
