// The two tools Claude can call. Each turns a raw API response into the JSON
// the model sees, smoothing over the response-shape quirks (NOTES.md #5-#11).

import type Anthropic from "@anthropic-ai/sdk";
import { elyosGet, type OnStatus } from "./elyos.ts";

export const tools: Anthropic.Tool[] = [
  {
    name: "get_weather",
    description: "Get current weather for a city. Fast response.",
    input_schema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name, e.g. London, Tokyo",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "research_topic",
    description:
      "Research a topic in depth. Takes 3-8 seconds. Use for questions requiring detailed research.",
    input_schema: {
      type: "object",
      properties: {
        // The API silently truncates topics past 50 characters (#10).
        topic: {
          type: "string",
          description: "Short topic under 50 characters, e.g. 'solar energy'",
        },
      },
      required: ["topic"],
    },
  },
];

export type ToolOutput = { content: string; isError: boolean };

// What the user sees while a tool runs, e.g. "Researching solar energy".
export function toolLabel(name: string, input: unknown): string {
  const args = input as Record<string, unknown>;
  return name === "get_weather"
    ? `Checking weather in ${args.location}`
    : `Researching ${args.topic}`;
}

export async function runTool(
  name: string,
  input: unknown,
  signal: AbortSignal,
  onStatus: OnStatus,
): Promise<ToolOutput> {
  const args = input as Record<string, unknown>;
  if (name === "get_weather")
    return getWeather(String(args.location ?? "").trim(), signal, onStatus);
  if (name === "research_topic")
    return researchTopic(String(args.topic ?? "").trim(), signal, onStatus);
  return fail(`unknown tool ${name}`);
}

async function getWeather(
  location: string,
  signal: AbortSignal,
  onStatus: OnStatus,
): Promise<ToolOutput> {
  // An empty location is a 404 that still uses up rate-limit quota (#7).
  if (!location) return fail("location is required");
  const res = await elyosGet("/weather", { location }, signal, onStatus);
  if (!res.ok) return fail(res.error);

  // Two shapes for the same request: flat fields, or `conditions: [...]` with
  // readings that disagree (#5). Normalise both into a list of readings.
  const { location: resolved, conditions, note, ...flat } = res.data;
  const readings = Array.isArray(conditions) ? conditions : [flat];
  if (
    !readings.length ||
    readings.some((r) => typeof r?.temperature_c !== "number")
  ) {
    return fail(`unexpected weather response: ${JSON.stringify(res.data)}`);
  }
  // Fuzzy geocoding can resolve to a different place than asked (#6), so pass both.
  return ok({
    requested_location: location,
    resolved_location: resolved,
    readings,
    note,
  });
}

async function researchTopic(
  topic: string,
  signal: AbortSignal,
  onStatus: OnStatus,
): Promise<ToolOutput> {
  // The API "researches" empty or whitespace topics without complaint (#11).
  if (!topic) return fail("topic is required");
  const res = await elyosGet("/research", { topic }, signal, onStatus);
  if (!res.ok) return fail(res.error);

  // A slow call can come back as `{}` with HTTP 200 (#9).
  const { summary, sources, generated_at, cached, truncated, processed_topic } =
    res.data;
  if (typeof summary !== "string")
    return fail("the research service returned an empty result");
  return ok({
    topic,
    summary,
    sources,
    generated_at,
    // Some answers are a stale cache from 2024 (#8); others research a truncated topic (#10).
    ...(cached && {
      stale: `cached result from ${generated_at}, may be out of date`,
    }),
    ...(truncated && { researched_topic: processed_topic }),
  });
}

const ok = (data: object): ToolOutput => ({
  content: JSON.stringify(data),
  isError: false,
});
const fail = (error: string): ToolOutput => ({ content: error, isError: true });
