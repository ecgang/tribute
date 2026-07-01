import { describe, expect, it } from "vitest";
import { parseRslXml } from "../lib/rslDiscovery";

// Real fixtures, embedded verbatim from lib/rslDiscovery.ts KNOWN_REAL.
const SO_RAW =
  '<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><terms>https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt</terms></content></rsl>';
const COLLECTIVE_RAW =
  '<rsl xmlns="https://rslstandard.org/rsl"><content url="/" server="https://api.rslcollective.org"><license><permits type="usage">ai-all</permits><payment type="use"><standard>https://rslcollective.org/license</standard></payment></license></content></rsl>';

describe("parseRslXml", () => {
  it("parses the Stack Overflow fixture (terms, no payment)", () => {
    const result = parseRslXml("https://stackoverflow.com/", SO_RAW);
    expect(result).not.toBeNull();
    expect(result?.paymentType).toBe("attribution");
    expect(result?.baseRate).toBe(0);
  });

  it("parses the RSL Collective fixture (payment type=use)", () => {
    const result = parseRslXml("https://rslcollective.org/", COLLECTIVE_RAW);
    expect(result).not.toBeNull();
    expect(result?.paymentType).toBe("use");
    expect(result?.server).toBe("https://api.rslcollective.org");
  });

  it("returns null for a plain non-RSL string", () => {
    expect(parseRslXml("https://example.com/", "<html></html>")).toBeNull();
  });

  it("returns null for an <rsl> doc with neither <payment> nor <terms>", () => {
    const xml = '<rsl xmlns="https://rslstandard.org/rsl"><content url="/"></content></rsl>';
    expect(parseRslXml("https://example.com/", xml)).toBeNull();
  });
});
