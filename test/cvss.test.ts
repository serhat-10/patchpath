import { describe, expect, it } from "vitest";
import { cvss3Score, severityFromScore } from "../src/core/cvss.js";

describe("cvss3Score", () => {
  it("matches published CVSS 3.1 base scores", () => {
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H")).toBe(10);
    expect(cvss3Score("CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N")).toBe(5.5);
  });

  it("scores no impact as zero", () => {
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
  });

  it("rejects vectors it cannot score", () => {
    expect(cvss3Score("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toBeNull();
    expect(cvss3Score("garbage")).toBeNull();
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L")).toBeNull();
  });
});

describe("severityFromScore", () => {
  it("uses the CVSS rating bands", () => {
    expect(severityFromScore(9.8)).toBe("critical");
    expect(severityFromScore(7)).toBe("high");
    expect(severityFromScore(4)).toBe("moderate");
    expect(severityFromScore(3.9)).toBe("low");
    expect(severityFromScore(0)).toBe("unknown");
  });
});
