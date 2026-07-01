import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RagTraceSchema } from "../lib/schema";

describe("examples/sample-trace.json — the BYO-trace fixture", () => {
  it("validates against RagTraceSchema", () => {
    const body = JSON.parse(
      readFileSync(join(__dirname, "..", "examples", "sample-trace.json"), "utf8"),
    ) as { trace: unknown };
    expect(() => RagTraceSchema.parse(body.trace)).not.toThrow();
  });
});
