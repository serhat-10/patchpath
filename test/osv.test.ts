import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../src/core/cache.js";
import { queryVulnerabilities } from "../src/core/sources/osv.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (url: string, body?: { queries: { package: { name: string }; version: string; page_token?: string }[] }) => Response;

function stubOsv(handler: Handler) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      return handler(url, init?.body ? JSON.parse(String(init.body)) : undefined);
    }),
  );
  return calls;
}

const npm = (name: string, ranges: unknown[]) => ({ package: { ecosystem: "npm", name }, ranges });
const semver = (...events: Record<string, string>[]) => ({ type: "SEMVER", events });

const cache = new Cache(null);

afterEach(() => vi.unstubAllGlobals());

describe("queryVulnerabilities", () => {
  it("picks a fix that is outside every affected range, not just the largest per-advisory fix", async () => {
    // A is fixed in 1.0.5 and again in 2.1.3 (it also affects 2.0.0 - 2.1.2).
    // B is only fixed in 2.0.1. Taking the max of each advisory's own fix would give 2.0.1,
    // which A still affects.
    const A = {
      id: "A",
      database_specific: { severity: "HIGH" },
      affected: [npm("p", [semver({ introduced: "0" }, { fixed: "1.0.5" }, { introduced: "2.0.0" }, { fixed: "2.1.3" })])],
    };
    const B = { id: "B", database_specific: { severity: "LOW" }, affected: [npm("p", [semver({ introduced: "0" }, { fixed: "2.0.1" })])] };
    stubOsv((url, body) => {
      if (url.endsWith("/querybatch")) return json({ results: body!.queries.map(() => ({ vulns: [{ id: "A" }, { id: "B" }] })) });
      return json(url.endsWith("/A") ? A : B);
    });

    const { results } = await queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache);
    expect(results.get("p@1.0.0")?.fixVersion).toBe("2.1.3");
  });

  it("prefers a non-breaking fix when one clears everything", async () => {
    const A = { id: "A", affected: [npm("p", [semver({ introduced: "0" }, { fixed: "1.2.5" }, { introduced: "2.0.0" }, { fixed: "2.0.3" })])] };
    stubOsv((url, body) =>
      url.endsWith("/querybatch") ? json({ results: body!.queries.map(() => ({ vulns: [{ id: "A" }] })) }) : json(A),
    );
    const { results } = await queryVulnerabilities([{ name: "p", version: "1.2.0" }], cache);
    expect(results.get("p@1.2.0")?.fixVersion).toBe("1.2.5");
  });

  it("reports no fix when none is published", async () => {
    const A = { id: "A", affected: [npm("p", [semver({ introduced: "0" })])] };
    stubOsv((url, body) =>
      url.endsWith("/querybatch") ? json({ results: body!.queries.map(() => ({ vulns: [{ id: "A" }] })) }) : json(A),
    );
    const { results } = await queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache);
    expect(results.get("p@1.0.0")?.fixVersion).toBeUndefined();
    expect(results.get("p@1.0.0")?.vulnerabilities).toHaveLength(1);
  });

  it("respects last_affected", async () => {
    const A = { id: "A", affected: [npm("p", [semver({ introduced: "0" }, { last_affected: "1.4.0" })])] };
    stubOsv((url, body) =>
      url.endsWith("/querybatch") ? json({ results: body!.queries.map(() => ({ vulns: [{ id: "A" }] })) }) : json(A),
    );
    // no `fixed` event exists, so there is no candidate to suggest
    const { results } = await queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache);
    expect(results.get("p@1.0.0")?.fixVersion).toBeUndefined();
  });

  it("derives severity from a CVSS vector when the advisory has no label", async () => {
    const A = {
      id: "CVE-1",
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
      affected: [npm("p", [semver({ introduced: "0" }, { fixed: "1.0.1" })])],
    };
    stubOsv((url, body) =>
      url.endsWith("/querybatch") ? json({ results: body!.queries.map(() => ({ vulns: [{ id: "CVE-1" }] })) }) : json(A),
    );
    const { results } = await queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache);
    expect(results.get("p@1.0.0")?.vulnerabilities[0]?.severity).toBe("critical");
  });

  it("treats malicious-package records as critical", async () => {
    const A = { id: "MAL-2024-1", summary: "malware", affected: [npm("p", [semver({ introduced: "0" })])] };
    stubOsv((url, body) =>
      url.endsWith("/querybatch") ? json({ results: body!.queries.map(() => ({ vulns: [{ id: "MAL-2024-1" }] })) }) : json(A),
    );
    const { results } = await queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache);
    expect(results.get("p@1.0.0")?.vulnerabilities[0]?.severity).toBe("critical");
  });

  it("keeps a vulnerability whose details cannot be fetched and warns", async () => {
    stubOsv((url, body) => {
      if (url.endsWith("/querybatch")) return json({ results: body!.queries.map(() => ({ vulns: [{ id: "GHSA-bad" }] })) });
      return json({ error: "bad request" }, 400);
    });
    const { results, warnings } = await queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache);
    expect(results.get("p@1.0.0")?.vulnerabilities).toMatchObject([{ id: "GHSA-bad", severity: "unknown" }]);
    expect(results.get("p@1.0.0")?.fixVersion).toBeUndefined();
    expect(warnings.join(" ")).toContain("GHSA-bad");
  });

  it("skips withdrawn advisories", async () => {
    stubOsv((url, body) =>
      url.endsWith("/querybatch")
        ? json({ results: body!.queries.map(() => ({ vulns: [{ id: "W" }] })) })
        : json({ id: "W", withdrawn: "2024-01-01T00:00:00Z", affected: [] }),
    );
    const { results } = await queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache);
    expect(results.size).toBe(0);
  });

  it("follows pagination tokens", async () => {
    const detail = (id: string) => ({ id, affected: [npm("p", [semver({ introduced: "0" }, { fixed: "1.0.1" })])] });
    stubOsv((url, body) => {
      if (url.endsWith("/querybatch")) {
        const q = body!.queries[0]!;
        return json({
          results: [q.page_token ? { vulns: [{ id: "PAGE2" }] } : { vulns: [{ id: "PAGE1" }], next_page_token: "tok" }],
        });
      }
      return json(detail(url.split("/").pop()!));
    });
    const { results } = await queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache);
    expect(results.get("p@1.0.0")?.vulnerabilities.map((v) => v.id)).toEqual(["PAGE1", "PAGE2"]);
  });

  it("splits large inputs into batches of at most 1000", async () => {
    const calls = stubOsv((url, body) => json({ results: body!.queries.map(() => ({})) }));
    const refs = Array.from({ length: 2500 }, (_, i) => ({ name: `pkg-${i}`, version: "1.0.0" }));
    await queryVulnerabilities(refs, cache);
    expect(calls.filter((u) => u.endsWith("/querybatch"))).toHaveLength(3);
  });

  it("rejects a malformed batch response instead of mis-attributing results", async () => {
    stubOsv(() => json({ results: [] }));
    await expect(queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache)).rejects.toThrow(/unexpected response/);
  });

  it("strips control characters from advisory text", async () => {
    const A = {
      id: "A",
      summary: "evil \x1b]0;PWNED\x07 summary",
      affected: [npm("p", [semver({ introduced: "0" }, { fixed: "1.0.1" })])],
    };
    stubOsv((url, body) =>
      url.endsWith("/querybatch") ? json({ results: body!.queries.map(() => ({ vulns: [{ id: "A" }] })) }) : json(A),
    );
    const { results } = await queryVulnerabilities([{ name: "p", version: "1.0.0" }], cache);
    expect(results.get("p@1.0.0")?.vulnerabilities[0]?.summary).not.toMatch(/[\x00-\x1f]/);
  });
});
