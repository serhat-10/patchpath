import type { Cache } from "../cache.js";
import { cvss3Score, severityFromScore } from "../cvss.js";
import { compareVersions, crossesBreaking, isPrerelease, isValidVersion } from "../semver.js";
import type { Severity, Vulnerability } from "../types.js";
import { fetchJson, mapLimit, sanitize, type NetContext } from "../util.js";

const API = "https://api.osv.dev/v1";
const BATCH_SIZE = 1000;
const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "v1:osv:vuln:";

interface OsvQuery {
  package: { name: string; ecosystem: "npm" };
  version: string;
  page_token?: string;
}

interface OsvResult {
  vulns?: { id: string }[];
  next_page_token?: string;
}

interface OsvBatchResponse {
  results: OsvResult[];
}

interface RangeEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

export interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  withdrawn?: string;
  severity?: { type?: string; score?: string }[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { type?: string; events?: RangeEvent[] }[];
    versions?: string[];
  }[];
}

export interface PackageRef {
  name: string;
  version: string;
}

export interface VulnerabilityResult {
  vulnerabilities: Vulnerability[];
  /** Smallest newer version outside every affected range, when it can be determined. */
  fixVersion?: string;
}

export interface VulnerabilityLookup {
  /** Keyed by `name@version`; packages without vulnerabilities are absent. */
  results: Map<string, VulnerabilityResult>;
  /** Full advisory records by id (with affected ranges), for those whose details could be fetched. */
  records: Map<string, OsvVuln>;
  warnings: string[];
}

const keyOf = (ref: PackageRef) => `${ref.name}@${ref.version}`;

function severityOf(vuln: OsvVuln): Severity {
  // Records for malicious packages carry no severity, but are always critical.
  if (vuln.id.startsWith("MAL-")) return "critical";
  switch (vuln.database_specific?.severity?.toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MODERATE":
    case "MEDIUM":
      return "moderate";
    case "LOW":
      return "low";
  }
  for (const entry of vuln.severity ?? []) {
    const score = entry.score ? cvss3Score(entry.score) : null;
    if (score !== null) return severityFromScore(score);
  }
  return "unknown";
}

function affectedEntries(vuln: OsvVuln, name: string) {
  return (vuln.affected ?? []).filter((a) => a.package?.ecosystem === "npm" && a.package.name === name);
}

/** Evaluates OSV range events (introduced / fixed / last_affected) for one version. */
function inRange(events: RangeEvent[], version: string): boolean {
  const pointOf = (e: RangeEvent) => (e.introduced === "0" ? "0.0.0" : (e.introduced ?? e.fixed ?? e.last_affected ?? "0.0.0"));
  let affected = false;
  for (const e of [...events].sort((a, b) => compareVersions(pointOf(a), pointOf(b)))) {
    if (e.introduced !== undefined) {
      if (e.introduced === "0" || compareVersions(version, e.introduced) >= 0) affected = true;
    } else if (e.fixed !== undefined) {
      if (compareVersions(version, e.fixed) >= 0) affected = false;
    } else if (e.last_affected !== undefined) {
      if (compareVersions(version, e.last_affected) > 0) affected = false;
    }
  }
  return affected;
}

/** True when the advisory's affected versions or ranges for `name` include `version`. */
export function isAffected(vuln: OsvVuln, name: string, version: string): boolean {
  return affectedEntries(vuln, name).some(
    (a) =>
      a.versions?.includes(version) ||
      (a.ranges ?? []).some((r) => (!r.type || r.type === "SEMVER" || r.type === "ECOSYSTEM") && inRange(r.events ?? [], version)),
  );
}

/**
 * The smallest newer version that none of the vulnerabilities affect. Non-breaking
 * candidates are tried first, so a major upgrade is only suggested when nothing else clears them.
 */
function findFixVersion(ref: PackageRef, vulns: OsvVuln[]): string | undefined {
  const candidates = new Set<string>();
  for (const vuln of vulns) {
    for (const entry of affectedEntries(vuln, ref.name)) {
      for (const range of entry.ranges ?? []) {
        for (const event of range.events ?? []) if (event.fixed) candidates.add(event.fixed);
      }
    }
  }
  return [...candidates]
    .filter(
      (v) =>
        isValidVersion(v) &&
        compareVersions(v, ref.version) > 0 &&
        (!isPrerelease(v) || isPrerelease(ref.version)),
    )
    .sort(
      (a, b) =>
        Number(crossesBreaking(ref.version, a)) - Number(crossesBreaking(ref.version, b)) ||
        compareVersions(a, b),
    )
    .find((candidate) => vulns.every((vuln) => !isAffected(vuln, ref.name, candidate)));
}

function toVulnerability(vuln: OsvVuln, packageName: string): Vulnerability {
  const fixedIn = new Set<string>();
  for (const entry of affectedEntries(vuln, packageName)) {
    for (const range of entry.ranges ?? []) {
      for (const event of range.events ?? []) if (event.fixed) fixedIn.add(sanitize(event.fixed, 50));
    }
  }
  return {
    id: sanitize(vuln.id, 100),
    aliases: (vuln.aliases ?? []).map((a) => sanitize(a, 100)),
    summary: sanitize(vuln.summary ?? vuln.details?.split("\n")[0] ?? "", 200),
    severity: severityOf(vuln),
    fixedIn: [...fixedIn],
    url: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`,
  };
}

/** Placeholder for an advisory whose details could not be fetched: never drop a known vulnerability. */
const unavailable = (id: string): Vulnerability => ({
  id: sanitize(id, 100),
  aliases: [],
  summary: "details unavailable",
  severity: "unknown",
  fixedIn: [],
  url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
});

async function queryBatch(queries: OsvQuery[], net: NetContext): Promise<OsvResult[]> {
  const response = await fetchJson<OsvBatchResponse>(`${API}/querybatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries }),
  }, net);
  if (!response || !Array.isArray(response.results) || response.results.length !== queries.length) {
    throw new Error("api.osv.dev returned an unexpected response.");
  }
  return response.results;
}

async function fetchDetails(id: string, cache: Cache, net: NetContext): Promise<OsvVuln | null> {
  const key = `${CACHE_PREFIX}${id}`;
  const cached = await cache.get<OsvVuln>(key, DETAILS_TTL_MS);
  if (cached && typeof cached === "object" && cached.id === id) return cached;
  const vuln = await fetchJson<OsvVuln>(`${API}/vulns/${encodeURIComponent(id)}`, {}, net);
  if (vuln) await cache.set(key, vuln);
  return vuln;
}

/** Looks up known vulnerabilities for each package version. */
export async function queryVulnerabilities(
  refs: PackageRef[],
  cache: Cache,
  net: NetContext = {},
  /** Advisory records already fetched in this scan; they are not fetched again. */
  seed?: Map<string, OsvVuln>,
): Promise<VulnerabilityLookup> {
  const warnings: string[] = [];
  const idsByRef = new Map<string, Set<string>>();

  for (let start = 0; start < refs.length; start += BATCH_SIZE) {
    const chunk = refs.slice(start, start + BATCH_SIZE);
    const queries: OsvQuery[] = chunk.map((r) => ({
      package: { name: r.name, ecosystem: "npm" },
      version: r.version,
    }));
    const results = await queryBatch(queries, net);

    for (const [i, result] of results.entries()) {
      const ref = chunk[i] as PackageRef;
      const ids = new Set((result.vulns ?? []).map((v) => v.id));
      // Large result sets are paginated: re-send this one query with the token.
      for (let token = result.next_page_token; token; ) {
        const [page] = await queryBatch([{ ...(queries[i] as OsvQuery), page_token: token }], net);
        for (const v of page?.vulns ?? []) ids.add(v.id);
        token = page?.next_page_token;
      }
      if (ids.size) idsByRef.set(keyOf(ref), ids);
    }
  }

  const uniqueIds = [...new Set([...idsByRef.values()].flatMap((s) => [...s]))];
  const details = new Map<string, OsvVuln>();
  const unreachable: string[] = [];
  await mapLimit(uniqueIds, 8, async (id) => {
    const seen = seed?.get(id);
    if (seen) {
      details.set(id, seen);
      return;
    }
    try {
      const vuln = await fetchDetails(id, cache, net);
      if (vuln) details.set(id, vuln);
      else unreachable.push(id);
    } catch (error) {
      // A cancelled scan must stop, not carry on with placeholders.
      if (net.signal?.aborted) throw error;
      unreachable.push(id);
    }
  });
  if (unreachable.length) {
    warnings.push(
      `Could not fetch details for ${unreachable.length} advisor${unreachable.length === 1 ? "y" : "ies"} ` +
        `(${unreachable.sort().slice(0, 3).map((id) => sanitize(id, 60)).join(", ")}${unreachable.length > 3 ? ", ..." : ""}). ` +
        `They are listed with unknown severity.`,
    );
  }

  const results = new Map<string, VulnerabilityResult>();
  for (const ref of refs) {
    const ids = idsByRef.get(keyOf(ref));
    if (!ids) continue;
    const known = [...ids]
      .sort()
      .map((id) => ({ id, osv: details.get(id) }))
      .filter((v) => !v.osv?.withdrawn);
    if (!known.length) continue;
    const complete = known.every((v) => v.osv);
    results.set(keyOf(ref), {
      vulnerabilities: known.map((v) => (v.osv ? toVulnerability(v.osv, ref.name) : unavailable(v.id))),
      // Without every advisory's affected ranges a fix cannot be verified.
      fixVersion: complete ? findFixVersion(ref, known.map((v) => v.osv as OsvVuln)) : undefined,
    });
  }
  return { results, records: details, warnings };
}
