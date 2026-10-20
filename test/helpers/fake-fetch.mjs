// Preloaded with `node --import` by the CLI tests: replaces globalThis.fetch so the real CLI can
// run without a network.
//   PATCHPATH_FAKE_FETCH=offline   every call fails like a DNS failure
//   PATCHPATH_FAKE_FETCH=<json>    {"vulns": {"name@version": {"id", "severity", "fixed"}},
//                                  "registry": {"name": <abbreviated packument>}}  (registry is optional)
//   PATCHPATH_FAKE_LOG=<file>      one line per call: "<url> <body>"
import { appendFileSync } from "node:fs";

const mode = process.env.PATCHPATH_FAKE_FETCH ?? "offline";
const log = process.env.PATCHPATH_FAKE_LOG;
const config = mode === "offline" ? { vulns: {} } : JSON.parse(mode);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (log) appendFileSync(log, `${url} ${init.body ?? ""}\n`.replace(/\n(?!$)/g, " "));
  if (mode === "offline") {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ENOTFOUND" };
    throw error;
  }
  if (url.endsWith("/v1/querybatch")) {
    const { queries } = JSON.parse(String(init.body));
    return json({
      results: queries.map((q) => {
        const v = config.vulns[`${q.package.name}@${q.version}`];
        return v ? { vulns: [{ id: v.id }] } : {};
      }),
    });
  }
  const detail = /\/v1\/vulns\/(.+)$/.exec(url);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    const [key, v] = Object.entries(config.vulns).find(([, x]) => x.id === id) ?? [];
    if (!v) return json({}, 404);
    const name = key.slice(0, key.lastIndexOf("@"));
    return json({
      id,
      summary: `test advisory for ${name}`,
      database_specific: { severity: v.severity },
      affected: [{ package: { ecosystem: "npm", name }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: v.fixed }] }] }],
    });
  }
  if (url.startsWith("https://registry.npmjs.org/")) {
    const name = decodeURIComponent(url.slice("https://registry.npmjs.org/".length));
    return json(config.registry?.[name] ?? { "dist-tags": {}, versions: {} });
  }
  return json({ error: "unexpected request" }, 500);
};
