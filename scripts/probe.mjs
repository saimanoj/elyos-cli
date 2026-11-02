// Throwaway API probe. Fires a battery of requests at each endpoint, logs one
// line per request, and dumps every raw response to probe-results.json so we
// can dig through undocumented behaviour afterwards.
//
//   node --env-file=.env scripts/probe.mjs                # full probe, waits out throttling
//   node --env-file=.env scripts/probe.mjs weather        # just one endpoint
//   node --env-file=.env scripts/probe.mjs --ratelimit    # map the rate limit (no backing off)
//
// To probe a different API, edit CONFIG. Nothing below it is Elyos-specific.

import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CONFIG = {
  baseUrl: process.env.ELYOS_API_URL ?? "https://elyos-interview-907656039105.europe-west2.run.app",
  auth: { header: "X-API-Key", env: "ELYOS_API_KEY" },
  timeoutMs: 30_000,
  // How the API says "slow down": seconds to wait, or null. Elyos sends 200 + {status:"throttled"}.
  throttledFor: (res, json) =>
    res.status === 429 || json?.status === "throttled"
      ? Number(json?.retry_after_seconds ?? res.headers.get("retry-after") ?? 10)
      : null,
  endpoints: [
    {
      name: "weather", path: "/weather", param: "location",
      samples: ["London", "Tokyo", "New York"],
      extras: ["London, UK", "Paris, TX", "Springfield", "51.5072,-0.1276", "São Paulo", "東京"],
      repeats: 6,
    },
    {
      name: "research", path: "/research", param: "topic",
      samples: ["solar energy", "quantum computing"],
      extras: ["a", "the complete history of everything"],
      repeats: 8,
    },
  ],
};

// Generic string-param edge cases. `undefined` omits the param, an array repeats it.
const edgeInputs = (sample) => [
  ["missing", undefined], ["empty", ""], ["whitespace", "   "],
  ["lowercase", sample.toLowerCase()], ["uppercase", sample.toUpperCase()], ["padded", `  ${sample}  `],
  ["nonsense", "xqzvbnmw"], ["numeric", "12345"], ["emoji", "🌞"], ["special", "a&b=c;d/e?f"],
  ["injection", "' OR 1=1 --"], ["long-2k", "a".repeat(2000)], ["repeated-param", [sample, "Paris"]],
];

const key = process.env[CONFIG.auth.env];
if (!key) throw new Error(`${CONFIG.auth.env} is not set`);
const authed = { [CONFIG.auth.header]: key };
const redact = (s) => s.split(key).join("<KEY>");
const records = [];

async function hit(ep, probe, { value, method = "GET", headers = authed, query = {} } = {}) {
  const url = new URL(ep.path, CONFIG.baseUrl);
  for (const v of value === undefined ? [] : [value].flat()) url.searchParams.append(ep.param, v);
  for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);

  const rec = { endpoint: ep.name, probe, method, url: redact(url.pathname + url.search), at: new Date().toISOString() };
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(CONFIG.timeoutMs) });
    rec.headersMs = Math.round(performance.now() - t0); // headers arrived
    const body = await res.text();
    rec.ms = Math.round(performance.now() - t0); // body fully read
    let json;
    try { json = JSON.parse(body); } catch {}
    Object.assign(rec, { status: res.status, headers: Object.fromEntries(res.headers), bodyLength: body.length });
    rec.shape = !body ? "empty" : json === undefined ? "non-json" : sig(json);
    rec.throttledFor = CONFIG.throttledFor(res, json);
    rec.body = body.slice(0, 4000);
  } catch (err) {
    rec.ms = Math.round(performance.now() - t0);
    rec.error = `${err.name}: ${err.message}`;
  }
  records.push(rec);
  console.log(`[${ep.name}] ${probe.padEnd(26)} ${String(rec.status ?? "ERR").padEnd(4)} ${String(rec.ms).padStart(6)}ms  ${(rec.error ?? rec.body).replace(/\s+/g, " ").slice(0, 90)}`);
  return rec;
}

// Structural signature of a body, e.g. {temp:number,unit:string}, so schema drift stands out.
function sig(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.length ? sig(v[0]) : ""}]`;
  if (typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${k}:${sig(v[k])}`).join(",")}}`;
  if (typeof v === "string" && /^\s*[{[]/.test(v)) return "string(json?)";
  return typeof v;
}

// Waits out throttling and retries, so every probe gets a real answer.
async function paced(ep, probe, opts) {
  for (let attempt = 1; ; attempt++) {
    const rec = await hit(ep, probe, opts);
    if (rec.throttledFor == null || attempt >= 6) return rec;
    console.log(`  ↳ throttled, waiting ${rec.throttledFor + 1}s`);
    await sleep((rec.throttledFor + 1) * 1000);
  }
}

async function probeEndpoint(ep) {
  const s = ep.samples[0];
  for (const v of ep.samples) await paced(ep, `sample:${v}`, { value: v });
  for (const [label, value] of [...edgeInputs(s), ...ep.extras.map((v) => [`extra:${v}`, v])]) {
    await paced(ep, `edge:${label}`, { value });
  }
  await hit(ep, "auth:none", { value: s, headers: {} });
  await hit(ep, "auth:wrong", { value: s, headers: { [CONFIG.auth.header]: "not-a-real-key" } });
  await hit(ep, "auth:query-param", { value: s, headers: {}, query: { api_key: key } });
  await hit(ep, "method:POST", { value: s, method: "POST" });
  for (let i = 0; i < ep.repeats; i++) await paced(ep, `repeat:${i + 1}`, { value: s });
}

// One request every `everyMs`, alternating endpoints, never backing off: shows the
// limit, whether the window is fixed or sliding, and whether endpoints share it.
async function measureLimit(eps, seconds = 75, everyMs = 2000) {
  const inflight = [];
  for (let i = 0, start = Date.now(); Date.now() - start < seconds * 1000; i++) {
    const ep = eps[i % eps.length];
    inflight.push(hit(ep, `ratelimit:+${Math.round((Date.now() - start) / 1000)}s`, { value: ep.samples[0] }));
    await sleep(everyMs);
  }
  await Promise.all(inflight);
}

function summarise(ep) {
  const rs = records.filter((r) => r.endpoint === ep.name);
  if (!rs.length) return;
  const count = (f) => Object.entries(rs.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(3)}× ${k}`).join("\n");
  const ms = rs.filter((r) => r.status && r.throttledFor == null).map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  const notable = new Set(rs.flatMap((r) => Object.keys(r.headers ?? {}))
    .filter((h) => /retry|rate|limit|cache|request-id|warning|deprecat/i.test(h)));

  console.log(`\n=== ${ep.name}: ${rs.length} requests (${rs.filter((r) => r.throttledFor != null).length} throttled)`);
  console.log(`latency ms (unthrottled): min ${ms[0]}  p50 ${pct(0.5)}  p90 ${pct(0.9)}  max ${ms.at(-1)}`);
  console.log(`status:\n${count((r) => r.status ?? r.error)}`);
  console.log(`body shapes:\n${count((r) => `${r.status ?? "ERR"} ${r.shape ?? "-"}`)}`);
  console.log(`content-type:\n${count((r) => r.headers?.["content-type"] ?? "-")}`);
  console.log(`notable headers: ${[...notable].join(", ") || "none"}`);
}

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith("--"));
const targets = CONFIG.endpoints.filter((ep) => !only.length || only.includes(ep.name));
if (args.includes("--ratelimit")) await measureLimit(targets);
else for (const ep of targets) await probeEndpoint(ep);
targets.forEach(summarise);
writeFileSync("probe-results.json", JSON.stringify(records, null, 2));
console.log(`\nraw responses: probe-results.json (${records.length} records)`);
