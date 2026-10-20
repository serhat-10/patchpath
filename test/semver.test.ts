import { describe, expect, it } from "vitest";
import { compareVersions, crossesBreaking, updateGap } from "../src/core/semver.js";

describe("updateGap", () => {
  it("reports the largest component that is behind", () => {
    expect(updateGap("1.2.3", "2.0.0")).toBe("major");
    expect(updateGap("1.2.3", "1.3.0")).toBe("minor");
    expect(updateGap("1.2.3", "1.2.4")).toBe("patch");
  });

  it("returns null when current or ahead", () => {
    expect(updateGap("1.2.3", "1.2.3")).toBeNull();
    expect(updateGap("2.0.0", "1.9.9")).toBeNull();
  });

  it("treats a prerelease as behind its own release", () => {
    expect(updateGap("1.0.0-beta.1", "1.0.0")).toBe("patch");
  });

  it("ignores versions it cannot parse", () => {
    expect(updateGap("latest", "1.0.0")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("10.0.0", "9.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("follows semver prerelease precedence", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i - 1] as string, ordered[i] as string), `${ordered[i - 1]} < ${ordered[i]}`).toBeLessThan(0);
    }
  });

  it("ignores build metadata", () => {
    expect(compareVersions("1.0.0+build.1", "1.0.0")).toBe(0);
  });
});

describe("crossesBreaking", () => {
  it("flags a new major", () => {
    expect(crossesBreaking("1.9.0", "2.0.0")).toBe(true);
    expect(crossesBreaking("1.2.0", "1.9.0")).toBe(false);
  });

  it("treats a new minor on 0.x as breaking", () => {
    expect(crossesBreaking("0.1.7", "0.2.0")).toBe(true);
    expect(crossesBreaking("0.1.7", "0.1.13")).toBe(false);
  });

  it("treats a new patch on 0.0.x as breaking", () => {
    expect(crossesBreaking("0.0.1", "0.0.2")).toBe(true);
    expect(crossesBreaking("0.0.1", "0.1.0")).toBe(true);
    expect(crossesBreaking("0.0.3", "0.0.3")).toBe(false);
  });
});
