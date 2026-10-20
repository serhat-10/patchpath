import { describe, expect, it } from "vitest";
import { sanitize, truncate } from "../src/core/util.js";

describe("sanitize", () => {
  it("removes terminal escape sequences", () => {
    const title = sanitize("harmless \x1b]0;PWNED\x07 text");
    expect(title).not.toMatch(/[\x00-\x1f\x7f]/);
    const link = sanitize("click \x1b]8;;http://evil\x1b\\here\x1b]8;;\x1b\\");
    expect(link).not.toContain("\x1b");
    expect(sanitize("\x1b[31mred\x1b[0m")).not.toContain("\x1b");
  });

  it("removes bidi overrides and zero-width characters", () => {
    expect(sanitize("a‮b​c⁦d")).toBe("a b c d");
  });

  it("removes invisible characters that can smuggle or disguise text", () => {
    // Unicode tag characters spell hidden ASCII ("A", "B") that some models read
    expect(sanitize("ok\u{E0041}\u{E0042}\u{E007F}")).toBe("ok");
    expect(sanitize("a⁠b⁡c⁤d")).toBe("a b c d");
    expect(sanitize("de­precated")).toBe("de precated");
    expect(sanitize("x؜y᠎z")).toBe("x y z");
    expect(sanitize("zero‍width​join﻿")).toBe("zero width join");
  });

  it("never leaves a lone surrogate when truncating", () => {
    const emoji = "\u{1F600}";
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (let max = 2; max <= 12; max++) {
      const out = sanitize(`a${emoji.repeat(10)}`, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).not.toMatch(loneSurrogate);
      expect(out.endsWith("…")).toBe(true);
    }
    expect(truncate(`ab${emoji}`, 4)).toBe(`ab${emoji}`);
    expect(truncate(`ab${emoji}cd`, 4)).toBe("ab…");
  });

  it("collapses whitespace and bounds the length", () => {
    expect(sanitize("a\n\n  b\tc")).toBe("a b c");
    expect(sanitize("x".repeat(50), 10)).toHaveLength(10);
  });

  it("tolerates non-string input", () => {
    expect(sanitize(undefined)).toBe("");
    expect(sanitize(42)).toBe("42");
  });
});
