// Optional preload that records every outgoing request of a Node process (fetch and http/https.request) and refuses hosts that are not allowed.
// Used through run-patchpath.mjs / plan-eval.mjs / run-all.mjs --log-hosts <file>; they set NODE_OPTIONS=--import=<this file> and KIT_REQLOG=<file>.
// KIT_ALLOW (comma separated host names) replaces the default allow list api.osv.dev,registry.npmjs.org.
// A request to a host that is not allowed is logged with "ok": false and then fails with an error; nothing is sent.
import { appendFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";

const file = process.env.KIT_REQLOG;
const ALLOW = new Set((process.env.KIT_ALLOW || "api.osv.dev,registry.npmjs.org").split(",").map((s) => s.trim()).filter(Boolean));
const log = (via, host, extra) => { if (file) appendFileSync(file, JSON.stringify({ t: Date.now(), via, host, cwd: process.cwd(), ...extra }) + "\n"); };

const orig = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  const host = new URL(url).hostname;
  const ok = ALLOW.has(host);
  log("fetch", host, { ok, url: url.slice(0, 120) });
  if (!ok) throw new Error("hostlog: blocked host " + host);
  return orig(input, init);
};
for (const m of [https, http]) {
  const o = m.request;
  m.request = function (...a) {
    let h;
    try { const x = a[0]; h = typeof x === "string" ? new URL(x).hostname : x instanceof URL ? x.hostname : x.hostname || x.host; } catch { /* unknown host: treated as blocked below */ }
    log("http.request", h, { ok: ALLOW.has(h) });
    if (!ALLOW.has(h)) throw new Error("hostlog: blocked host " + h);
    return o.apply(this, a);
  };
}
