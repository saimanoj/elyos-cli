// HTTP client for the Elyos weather/research API. The API quirks we found while
// probing (NOTES.md, numbered #1-#13) are handled here, so callers get either
// data or a readable error. The only thing that throws is a user cancel.

import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL =
  process.env.ELYOS_API_URL ??
  "https://elyos-interview-907656039105.europe-west2.run.app";
const TIMEOUT_MS = 10_000; // real research answers took ≤8.2s; the ~15s ones came back as {} anyway (#9)
const MAX_THROTTLE_WAIT_S = 30; // the limit is a 30s window, so waits beyond that mean something is off (#2)
const MAX_ATTEMPTS = 3;

export type ApiResult = { ok: true; data: any } | { ok: false; error: string };
export type OnStatus = (status: string) => void;

export async function elyosGet(
  path: string,
  params: Record<string, string>,
  signal: AbortSignal,
  onStatus: OnStatus,
): Promise<ApiResult> {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);

  for (let attempt = 1; ; attempt++) {
    let status: number;
    let text: string;
    try {
      const res = await fetch(url, {
        headers: { "X-API-Key": process.env.ELYOS_API_KEY ?? "" },
        // Either the user's Ctrl+C or our timeout aborts the request (and the socket).
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      status = res.status;
      text = await res.text(); // inside the try: a cancel or timeout can also land mid-body
    } catch (err) {
      if (signal.aborted) throw err; // user cancelled: let it propagate
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      return {
        ok: false,
        error: timedOut
          ? `no response within ${TIMEOUT_MS / 1000}s`
          : `network error: ${err}`,
      };
    }
    const body = JSON.parse(text) ?? null;

    // Rate limiting arrives as HTTP 200 with the wait time in the body (#1).
    if (body?.status === "throttled" || status === 429) {
      const waitS = Number(body?.retry_after_seconds) || 5;
      if (waitS > MAX_THROTTLE_WAIT_S || attempt >= MAX_ATTEMPTS) {
        return {
          ok: false,
          error: `rate limited by the API, try again in ${waitS}s`,
        };
      }
      onStatus(`Rate limited by the API, waiting ${waitS}s`);
      await sleep((waitS + 1) * 1000, undefined, { signal }); // throws if the user cancels
      continue;
    }

    if (status >= 400) {
      // Two error formats: {"error": "..."} and FastAPI's {"detail": ...} (#3).
      const detail = body?.error ?? body?.detail;
      return {
        ok: false,
        error: `HTTP ${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
      };
    }
    if (body === null || typeof body !== "object")
      return { ok: false, error: `unreadable response (HTTP ${status})` };
    return { ok: true, data: body };
  }
}
