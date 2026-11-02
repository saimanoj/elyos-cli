// Terminal front end: reads input, prints the streamed answer, shows a spinner
// while tools run, and maps Ctrl+C to cancelling the current turn.

import * as readline from "node:readline";
import { createAgent, type AgentEvent } from "./agent.ts";

for (const key of ["ANTHROPIC_API_KEY", "ELYOS_API_KEY"]) {
  if (!process.env[key]) {
    console.error(
      `${key} is not set. Copy .env.example to .env and fill it in.`,
    );
    process.exit(1);
  }
}

const out = process.stdout;
const FRAMES = "⠋⠙⠹⠼⠴⠦⠧⠇⠏";

// One-line spinner: "⠹ Researching solar energy… 3s (Ctrl+C to cancel)".
function createSpinner() {
  let timer: NodeJS.Timeout | undefined;
  let label = "";
  let status = "";
  let startedAt = 0;
  let shownSince = 0; // the elapsed counter restarts when the status changes
  const draw = (frame: number) => {
    const secs = Math.floor((Date.now() - shownSince) / 1000);
    out.write(
      `\r\x1b[K${FRAMES[frame % FRAMES.length]} ${status || label}… ${secs}s (Ctrl+C to cancel)`,
    );
  };
  return {
    start(text: string) {
      [label, status, startedAt, shownSince] = [
        text,
        "",
        Date.now(),
        Date.now(),
      ];
      let frame = 0;
      draw(frame);
      timer = setInterval(() => draw(++frame), 100);
    },
    update(text: string) {
      [status, shownSince] = [text, Date.now()];
    },
    // Replaces the spinner with a permanent line, e.g. "Researching solar energy: done (5.2s)".
    stop(outcome: string) {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      out.write(
        `\r\x1b[K${label}: ${outcome} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)\n`,
      );
    },
  };
}

const agent = createAgent();
const spinner = createSpinner();
const rl = readline.createInterface({
  input: process.stdin,
  output: out,
  prompt: "\nYou: ",
});
let turn: AbortController | undefined;

// Ctrl+C cancels the running turn; at an idle prompt it exits.
rl.on("SIGINT", () => (turn ? turn.abort() : rl.close()));

console.log(
  "Chat with Claude (weather + research tools). Ctrl+C cancels, 'exit' quits.",
);
rl.prompt();

for await (const line of rl) {
  const input = line.trim();
  if (["exit", "quit", "q"].includes(input.toLowerCase())) break;
  if (!input) {
    rl.prompt();
    continue;
  }

  turn = new AbortController();
  let speaking = false; // is the assistant mid-sentence on the current line?
  let toolCancelled = false; // the spinner line already says "cancelled"
  const render = (event: AgentEvent) => {
    if (event.type === "text") {
      if (!speaking) out.write("Assistant: ");
      speaking = true;
      out.write(event.text);
    } else if (event.type === "tool_start") {
      if (speaking) out.write("\n");
      speaking = false;
      spinner.start(event.label);
    } else if (event.type === "tool_status") {
      spinner.update(event.status);
    } else {
      toolCancelled = event.outcome === "cancelled";
      spinner.stop(event.outcome);
    }
  };

  try {
    await agent.send(input, turn.signal, render);
    if (turn.signal.aborted && speaking) out.write(" (interrupted)");
    else if (turn.signal.aborted && !toolCancelled) out.write("(cancelled)\n");
  } catch (err) {
    spinner.stop("failed");
    out.write(
      `${speaking ? "\n" : ""}Error: ${err instanceof Error ? err.message : err}\n`,
    );
    speaking = false;
  }
  if (speaking) out.write("\n"); // finish the assistant's line
  turn = undefined;
  rl.prompt();
}
rl.close();
