// The conversation with Claude: keeps history and runs the streaming tool loop.
// It knows nothing about the terminal; it reports progress through `emit`.

import Anthropic from "@anthropic-ai/sdk";
import { runTool, toolLabel, tools } from "./tools.ts";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";
const SYSTEM = `You are a helpful assistant in a terminal chat. Keep answers short, in plain text without markdown.
Tool results can be imperfect. If a weather result's resolved_location differs from what the user asked for, say which place the data is for. If it has several readings, say the reports disagree. If a research result is marked stale, say it may be out of date.
Only state facts that appear in tool results. If a tool fails, briefly tell the user why.`;

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; label: string }
  | { type: "tool_status"; status: string }
  | { type: "tool_end"; outcome: "done" | "failed" | "cancelled" };

export function createAgent() {
  const client = new Anthropic();
  // Append-only: every assistant tool_use is always followed by its tool_result,
  // even after a cancel, so the next request is valid.
  const history: Anthropic.MessageParam[] = [];

  // Runs one user turn. Resolves when Claude is done or the turn was cancelled.
  async function send(
    input: string,
    signal: AbortSignal,
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    history.push({ role: "user", content: input });

    while (true) {
      let text = ""; // what the user has seen so far in this step
      let message: Anthropic.Message;
      try {
        const stream = client.messages.stream(
          {
            model: MODEL,
            max_tokens: 64000,
            system: SYSTEM,
            tools,
            messages: history,
            output_config: { effort: "low" },
          },
          { signal },
        );
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            text += event.delta.text;
            emit({ type: "text", text: event.delta.text });
          }
        }
        message = await stream.finalMessage();
      } catch (err) {
        if (!signal.aborted) throw err;
        // Cancelled mid-stream: keep the partial answer so Claude knows it was cut off.
        // Only the text is kept; an unfinished thinking or tool_use block can't be sent back.
        history.push({
          role: "assistant",
          content: text
            ? `${text}\n[interrupted by user]`
            : "[cancelled by user before replying]",
        });
        return;
      }

      history.push({ role: "assistant", content: message.content });
      if (message.stop_reason === "refusal")
        emit({ type: "text", text: "(Claude declined to answer.)" });
      if (message.stop_reason !== "tool_use") return;

      // Tools run one at a time. Every tool_use gets a result: real, failed, or cancelled.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        if (signal.aborted) {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: "Not run: the user cancelled first.",
          });
          continue;
        }
        emit({ type: "tool_start", label: toolLabel(block.name, block.input) });
        try {
          const out = await runTool(block.name, block.input, signal, (status) =>
            emit({ type: "tool_status", status }),
          );
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: out.isError,
            content: out.content,
          });
          emit({ type: "tool_end", outcome: out.isError ? "failed" : "done" });
        } catch (err) {
          if (!signal.aborted) throw err;
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: "Cancelled by the user while running.",
          });
          emit({ type: "tool_end", outcome: "cancelled" });
        }
      }
      history.push({ role: "user", content: results });
      if (signal.aborted) return; // back to the prompt; don't ask Claude to respond to the cancel
    }
  }

  return { send };
}
