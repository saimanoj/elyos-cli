# API notes

Base URL: `https://elyos-interview-907656039105.europe-west2.run.app`

## Both endpoints

### 1. Rate limiting is returned as HTTP 200

- Body: `{"status":"throttled","message":"Rate limit exceeded. Please wait.","retry_after_seconds":27,"data":null}`.
- No 429 status and no `Retry-After` header. The wait time is only in the body.
- **Risk:** a `res.ok` check passes, and `data: null` reaches the model as if it were a result.
- **Handling:** check `status === "throttled"` on every response before treating it as data.

### 2. Limit: 5 requests per 30 seconds, sliding window, shared across endpoints

- **Evidence:** in `--ratelimit` mode (one request every 2s, alternating weather and research), 5 requests were accepted. Then every request was throttled until 30s after the first accepted one.
- **Sliding, not fixed:** at +66s we were throttled with `retry_after=1`, and +68s was accepted. Only a sliding window explains that: +36, +38, +40, +62 and +64 were all still inside the 30s window at +66.
- **Shared:** research inherits weather's countdown, so weather calls can starve research.
- **Throttled requests don't count** against the limit. **404s do:** the first run got 3×200 + 2×404, then was throttled.
- **Checked before the limiter:** 401, 422 and 405 are returned even while throttled.
- `retry_after_seconds` is accurate. It drops 1s for every 1s of wall clock, and waiting `retry_after + 1`s then retrying worked 8 out of 8 times.
- **Handling:** wait `retry_after + 1`s and retry, up to 3 attempts. The spinner shows "Rate limited by the API, waiting 27s…", and Ctrl+C cancels the wait. Waits over 30s, or a third throttle, go back to the model as an error.
- **Why 30s and not a shorter cap:** after 5 quick calls the wait is ~27s, so a 10s cap would almost never wait. Verified: asking for 7 cities completed all 7, with the 6th waiting ~28s.

### 3. Two error formats

- `{"error": "..."}` for 401 and 404.
- FastAPI's default `{"detail": ...}` for 405 (a string) and 422 (an array of validation errors).
- **Handling:** build error messages from `error ?? detail`.

### 4. Cold start, and latency is never ~200ms

- The first request after the service has been idle took 5.6s. Warm weather requests take 350–860ms (p50 475ms). The docs say ~200ms.
- **Handling:** weather timeout of about 10s.

## Weather

### 5. Two response shapes for the same request

- About 30% of the time (7 of 22), the response is `{location, conditions: [{temperature_c, condition, humidity}, …], note: "Multiple conditions reported"}` instead of the flat `{location, temperature_c, condition, humidity}`.
- It's random. Identical `London` requests returned either shape.
- The second reading always disagrees: London came back as `11.5°C Clear 72%` **and** `10.5°C light rain 85%`.
- **Risk:** code that reads `body.temperature_c` gets `undefined` about 30% of the time.
- **Handling:** convert both shapes to a list of readings. Pass every reading plus the `note` to the model, so it can say the reports disagree.

### 6. Fuzzy geocoding: almost anything resolves to _some_ place

| Sent              | Resolved `location`                                                       |
| ----------------- | ------------------------------------------------------------------------- |
| `12345`           | Schenectady (a US ZIP code)                                               |
| `' OR 1=1 --`     | Oran                                                                      |
| `a&b=c;d/e?f`     | Andrews A F B                                                             |
| `51.5072,-0.1276` | Strand                                                                    |
| `São Paulo`       | San Paulo                                                                 |
| `東京`            | 東京都                                                                    |
| `Paris, TX`       | Paris (the data is for Texas, but the qualifier is dropped from the name) |

- Matching ignores case and trims whitespace. With a repeated `location` parameter, the last one wins.
- **Risk:** the model confidently reports weather for a place the user didn't ask about.
- **Handling:** return both the requested and the resolved location in the tool result. Tell the model to mention it when they differ.

### 7. Unknown location returns 404, and it counts against the quota

- Empty, whitespace, nonsense, emoji and 2,000-character inputs all return `404 {"error":"Location \"…\" not found"}`. An empty string gets 404 rather than 422.
- **Handling:** trim the input and reject it if empty before calling the API, which saves quota. Turn the 404 into "couldn't find that place" for the model.

## Research

### 8. Stale cached results (~20%)

- 6 of 30 successful responses had `cached: true`, `generated_at: "2024-03-15T09:00:00Z"`, and a summary that says it "may not reflect recent developments".
- It's random, not tied to the input. It happened on uppercase, padded, emoji, long and plain repeat requests.
- The metadata contradicts itself. `cache_age_seconds` is always `26784000` (310 days), but `generated_at` is about 960 days old.
- **Handling:** the tool result gets a `stale` field, and the system prompt tells the model to warn the user. Not retried, because each retry costs one of the 5 requests per 30s.

### 9. Hangs for ~15s, then returns `{}` with 200 (~7%)

- 2 of 30 calls took 15.3s and 15.5s, and both bodies were `{}`. It's random, not tied to the input.
- **Handling:** client timeout of 10s. Real results always arrived within 8.2s, so a 10s timeout loses nothing and cuts each hang 5s short. Treat a body with no `summary` as a failure.

### 10. Topics over 50 characters are truncated

- A 2,000-character topic returned `truncated: true`, `original_topic_length: 2000`, and `processed_topic` cut to 50 characters. The summary is about the truncated topic.
- **Handling:** tell the model in the tool description to keep topics short, and pass `truncated` through when it happens.

### 11. No input validation

- Empty, whitespace, nonsense, numeric and SQL-like topics all return a normal-looking "summary". Unlike weather, the topic isn't trimmed: `"  solar energy  "` is echoed as is.
- **Handling:** trim the topic and reject it if empty before calling the API.

### 12. Latency slightly over the documented range

- Real results took 3.5–8.2s against the documented 3–8s. Failed calls took about 15s (see #9).

### 13. Inconsistent `generated_at` formats

- `2024-03-15T09:00:00Z` versus `2026-11-01T17:47:32.604572+00:00`. `Date` parses both, so the impact is low.

## Observed, not acted on

- Research summaries are generic boilerplate, and `sources` are always the same three domains.
