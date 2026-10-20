#!/usr/bin/env node
import { parseArgs } from "node:util";
import pkg from "../../package.json";
import { exceedsThreshold, formatText } from "../core/format.js";
import { scan, type ScanOptions } from "../core/scan.js";
import type { Severity } from "../core/types.js";
import { UserError, sanitize } from "../core/util.js";

const HELP = `patchpath ${pkg.version}
Dependency health report: known vulnerabilities, deprecations and outdated packages.

Usage: patchpath [path] [options]

  path                 project directory or lockfile: package-lock.json,
                       npm-shrinkwrap.json, yarn.lock (yarn v1) or
                       pnpm-lock.yaml (v9) (default: current directory).
                       yarn and pnpm lockfiles get no upgrade plan.

Options:
  --json               print the full report as JSON
  --no-dev             skip packages installed only for development
                       (what npm install --omit=dev leaves out)
  --no-cache           do not read or write the local cache
  --no-plan            skip the upgrade plan (which version of each direct
                       dependency clears the vulnerabilities below it)
  --fail-on <level>    exit with code 1 if a vulnerability is at or above
                       low | moderate | high | critical
                       (a vulnerability of unknown severity counts as moderate)
  --registry <url>     treat packages resolved from this URL prefix as public
                       registry packages (a mirror or proxy of registry.npmjs.org)
                       and check them; repeatable
  --include-pinned-lag also warn when a direct dependency pinned to an exact
                       version in package.json ("1.2.3", no ^ or ~) is a major
                       version behind (hidden by default: pins are usually
                       deliberate; vulnerabilities are always reported)
  --assume-public      treat lockfile entries without a "resolved" URL as public
                       registry packages (npm's omit-lockfile-registry-resolved;
                       pnpm entries with only an integrity)
  --allow-unchecked    with --fail-on, do not fail (exit 3) because some packages
                       could not be checked
  -v, --version        print version
  -h, --help           show this help

Exit codes:
  0  no vulnerability at or above --fail-on (or no --fail-on given)
  1  a vulnerability is at or above --fail-on
  2  error (bad option, unreadable lockfile, network failure)
  3  --fail-on given, threshold not reached, but some packages were not checked
     (other registry, git, file, or no "resolved" URL); see --registry,
     --assume-public, --allow-unchecked

Only names and versions of packages resolved from registry.npmjs.org (or a
--registry mirror, or with --assume-public) are sent to api.osv.dev and
registry.npmjs.org. Everything else is skipped and never sent.
`;

interface Outcome {
  code: number;
  stdout?: string;
  stderr?: string;
}

async function main(): Promise<Outcome> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        "no-dev": { type: "boolean" },
        "no-cache": { type: "boolean" },
        "no-plan": { type: "boolean" },
        "fail-on": { type: "string" },
        registry: { type: "string", multiple: true },
        "assume-public": { type: "boolean" },
        "include-pinned-lag": { type: "boolean" },
        "allow-unchecked": { type: "boolean" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UserError(`${(error as Error).message} Run patchpath --help for usage.`);
  }
  const { values, positionals } = parsed;

  if (values.help) return { code: 0, stdout: HELP };
  if (values.version) return { code: 0, stdout: `${pkg.version}\n` };

  const failOn = values["fail-on"];
  if (failOn !== undefined && !(["low", "moderate", "high", "critical"] as string[]).includes(failOn)) {
    throw new UserError(`--fail-on must be one of: low, moderate, high, critical (got "${failOn}").`);
  }

  const options: ScanOptions = {
    includeDev: !values["no-dev"],
    cache: !values["no-cache"],
    plan: !values["no-plan"],
    registries: values.registry,
    assumePublic: values["assume-public"],
    includePinnedLag: values["include-pinned-lag"],
  };
  const report = await scan(positionals[0] ?? ".", options);

  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const stdout = values.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatText(report, { color })}\n`;

  if (!failOn) return { code: 0, stdout };
  if (exceedsThreshold(report, failOn as Severity)) return { code: 1, stdout };
  const unchecked = report.summary.external;
  if (unchecked > 0 && !values["allow-unchecked"]) {
    return {
      code: 3,
      stdout,
      stderr:
        `patchpath: --fail-on ${failOn}: nothing at or above the threshold, but ${unchecked} ` +
        `package${unchecked === 1 ? " was" : "s were"} not checked (exit code 3). ` +
        `Use --registry <url> for a mirror of the public registry, --assume-public if your lockfile omits ` +
        `"resolved" URLs, or --allow-unchecked to accept the gap.\n`,
    };
  }
  return { code: 0, stdout };
}

/** Writes and waits until the stream has taken the data (pipes on Windows are asynchronous). */
const write = (stream: NodeJS.WriteStream, text: string | undefined) =>
  new Promise<void>((resolve) => {
    if (!text) return resolve();
    stream.write(text, () => resolve());
  });

/**
 * Lets Node exit on its own once the output is flushed. Nothing should still be running at this
 * point, but if a stray timer or socket does keep the event loop alive, the user must not wait for
 * it: a fallback timer (which itself does not keep the process alive) forces the exit.
 * Calling process.exit() right away is not safe: on Windows, Node 24 can abort with a libuv
 * assertion (exit code 127) when it exits while a reused keep-alive connection is open.
 */
async function finish({ code, stdout, stderr }: Outcome): Promise<void> {
  process.exitCode = code;
  await Promise.all([write(process.stdout, stdout), write(process.stderr, stderr)]);
  setTimeout(() => process.exit(code), 1000).unref();
}

main().then(finish, (error: unknown) => {
  const message = sanitize(error instanceof Error ? error.message : error, 500);
  const stack =
    process.env.PATCHPATH_DEBUG && error instanceof Error && error.stack ? `${error.stack}\n` : "";
  return finish({ code: 2, stderr: `patchpath: ${message}\n${stack}` });
});
