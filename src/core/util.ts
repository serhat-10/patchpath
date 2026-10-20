import { homedir } from "node:os";
import nodePath from "node:path";
import pkg from "../../package.json";

/**
 * The path to show in a report, so pasting the report does not leak the local user name:
 * relative to `cwd` when inside it (`.` for the cwd itself), else `~`-prefixed when under the home
 * directory, else unchanged (absolute). The last case can still hold a user name if the project
 * lives in another user's folder; there is nothing safe to cut there. Display only: reading files
 * keeps using the real absolute path.
 */
export function displayPath(
  path: string,
  opts: { cwd?: string; home?: string; pathModule?: Pick<typeof nodePath, "relative" | "isAbsolute" | "sep"> } = {},
): string {
  const pm = opts.pathModule ?? nodePath;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const inside = (base: string): string | undefined => {
    if (!base) return undefined;
    const rel = pm.relative(base, path);
    if (rel === "") return "";
    if (rel === ".." || rel.startsWith(".." + pm.sep) || pm.isAbsolute(rel)) return undefined;
    return rel;
  };
  const fromCwd = inside(cwd);
  if (fromCwd !== undefined) return fromCwd === "" ? "." : fromCwd;
  const fromHome = inside(home);
  if (fromHome !== undefined) return fromHome === "" ? "~" : "~" + pm.sep + fromHome;
  return path;
}

export const USER_AGENT = `patchpath/${pkg.version} (+dependency health scanner)`;

/** Error caused by user input or environment; the CLI prints it without a stack trace. */
export class UserError extends Error {}

/** A host could not be reached (DNS, connection refused, timeout), even after retries. */
export class NetworkError extends UserError {
  constructor(
    message: string,
    readonly host: string,
  ) {
    super(message);
  }
}

class RetryableHttpError extends Error {
  constructor(
    message: string,
    readonly delayMs?: number,
  ) {
    super(message);
  }
}

/**
 * Characters that can hide, reorder or smuggle text, or drive a terminal:
 * C0/C1 controls (including ESC), soft hyphen, Arabic letter mark, Mongolian vowel separator,
 * zero-width characters (including the zero-width joiner, so emoji ZWJ sequences fall apart into
 * their parts: a cosmetic cost accepted to keep invisible text out), bidi marks, overrides and
 * isolates, invisible operators (U+2060-2064), the byte-order mark and Unicode tag characters.
 */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿\u{e0000}-\u{e007f}]/gu;

/** Shortens text to at most `max` UTF-16 units (ellipsis included) without splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = Math.max(0, max - 1);
  const last = text.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}

/**
 * Makes text from an untrusted source (registry, advisory database, lockfile) safe to print
 * or hand to another program: no terminal escape sequences, one line, bounded length.
 */
export function sanitize(text: unknown, max = 300): string {
  const clean = String(text ?? "")
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(clean, max);
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Stops hammering a host that is down. After `threshold` consecutive calls to a host have failed
 * at the network level (each after its own retries), every further call to that host fails at once
 * with the same error, and calls still retrying give up at their next attempt.
 * One breaker is meant to live for one scan.
 */
export class CircuitBreaker {
  private readonly failures = new Map<string, number>();
  private readonly open = new Map<string, NetworkError>();

  constructor(readonly threshold = 3) {}

  /** The error to fail with when the host's circuit is open. */
  check(host: string): NetworkError | undefined {
    return this.open.get(host);
  }

  success(host: string): void {
    this.failures.set(host, 0);
  }

  failure(host: string, error: NetworkError): void {
    const count = (this.failures.get(host) ?? 0) + 1;
    this.failures.set(host, count);
    if (count >= this.threshold && !this.open.has(host)) this.open.set(host, error);
  }
}

export interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
  /** Aborts the request and any pending retry. */
  signal?: AbortSignal;
  breaker?: CircuitBreaker;
}

/** What scan() hands to the data sources: a shared cancel signal and circuit breaker. */
export interface NetContext {
  signal?: AbortSignal;
  breaker?: CircuitBreaker;
}

const isNetworkFailure = (error: unknown) => error instanceof TypeError && error.message === "fetch failed";
const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";

/**
 * Fetches JSON with a timeout and retries on network errors, 429 and 5xx. Returns null on 404.
 * Persistent network failures surface as a NetworkError (a UserError) so the CLI can explain them.
 */
export async function fetchJson<T>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  { retries = 3, timeoutMs = 30_000, signal, breaker }: FetchOptions = {},
): Promise<T | null> {
  const host = new URL(url).host;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    const open = breaker?.check(host);
    if (open) throw open;
    let delay = 500 * 2 ** attempt;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, {
        ...init,
        headers: { "user-agent": USER_AGENT, accept: "application/json", ...init.headers },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.status === 404) {
        breaker?.success(host);
        return null;
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        throw new RetryableHttpError(
          `HTTP ${res.status} from ${host}`,
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : undefined,
        );
      }
      breaker?.success(host);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
      return (await res.json()) as T;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      lastError = error;
      if (!(error instanceof RetryableHttpError) && !isNetworkFailure(error) && !isTimeout(error)) break;
      if (error instanceof RetryableHttpError && error.delayMs) delay = error.delayMs;
      if (attempt === retries) break;
      await sleep(delay, signal);
    }
  }
  let failure: NetworkError | undefined;
  if (isNetworkFailure(lastError)) {
    const cause = ((lastError as TypeError).cause as { code?: string } | undefined)?.code;
    failure = new NetworkError(`Could not reach ${host}${cause ? ` (${cause})` : ""}. Are you offline?`, host);
  } else if (isTimeout(lastError)) {
    failure = new NetworkError(`Timed out waiting for ${host}.`, host);
  }
  if (failure) {
    breaker?.failure(host, failure);
    throw failure;
  }
  throw lastError;
}

const NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/**
 * A package name npm accepts, restricted to characters that are inert in bash, zsh, PowerShell and
 * cmd: an optional `@scope/`, then letters (upper case only exists in legacy names), digits and
 * `.` `_` `~` `-`, never first, at most 214 characters. Names come from lockfiles and end up in
 * printed `npm install` lines and registry URLs, so anything else (`#`, `$(...)`, spaces, a leading
 * `-` that npm would read as an option, the legacy `!'()*`) is refused.
 */
export function isValidNpmName(name: unknown): name is string {
  if (typeof name !== "string" || !name.length || name.length > 214) return false;
  if (name === "node_modules" || name === "favicon.ico") return false;
  if (!name.startsWith("@")) return NAME_PART.test(name);
  const slash = name.indexOf("/");
  return slash > 1 && NAME_PART.test(name.slice(1, slash)) && NAME_PART.test(name.slice(slash + 1));
}

/**
 * An advisory about malicious code in the package itself: an OSV `MAL-` id, or a record that has
 * one as an alias. The summary is not used: ordinary advisories often say "malicious input".
 */
export const isMalicious = (v: { id: string; aliases?: string[] }): boolean =>
  v.id.startsWith("MAL-") || (v.aliases ?? []).some((a) => a.startsWith("MAL-"));
