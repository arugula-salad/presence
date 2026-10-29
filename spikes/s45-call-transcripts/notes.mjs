// S45 spike: Granola-style notes from a spike transcript. Reads a run's
// final segments (attributed per speaker by the transcriber), asks Claude
// for a summary, decisions and action items with names, and writes
// runs/<run>/notes-<model>.md with the tokens and cost.
//
//   ./with-anthropic.sh node notes.mjs <run> [claude-sonnet-5-5|claude-opus-5-5]

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const [run, model = "claude-sonnet-5-5"] = process.argv.slice(2);
const dir = join(here, "runs", run);
const PRICE = { "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] }; // $ per MTok in, out

const agent = readFileSync(join(dir, "agent.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const finals = agent.filter((e) => e.ev === "final");
const t0 = finals[0].t;
// Consecutive finals from one person merge into one line, as a transcript
// view would show them.
const lines = [];
for (const f of finals) {
  const last = lines.at(-1);
  if (last && last.name === f.name && f.t - last.t < 4000) {
    last.text += " " + f.text;
    last.t = f.t;
  } else lines.push({ name: f.name, at: f.t - t0, t: f.t, text: f.text });
}
const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const transcript = lines.map((l) => `[${mmss(l.at)}] ${l.name}: ${l.text}`).join("\n");

const system = `You write meeting notes from a call transcript. Each line is "[mm:ss] Name: words", and the names are reliable (each person's microphone was transcribed separately). The text is speech-to-text, so expect small recognition errors.

Write Markdown with exactly these sections:
## Summary — 3 to 6 bullets of what was discussed, naming who said what.
## Decisions — only decisions someone actually stated or the group agreed. If there were none, say "None stated."
## Action items — "- [ ] Name: task" for commitments someone actually made or was asked to do. If none, say "None stated."
## Open questions — if any.
Never invent decisions, owners or dates that aren't in the transcript.`;

const client = new Anthropic();
const t = Date.now();
const response = await client.beta.messages.create({
  model,
  max_tokens: 4000,
  output_config: { effort: "low" },
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  system,
  messages: [{ role: "user", content: `Transcript:\n\n${transcript}` }],
});
const ms = Date.now() - t;
const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const u = response.usage;
const [pi, po] = PRICE[model] ?? [0, 0];
const cost = (u.input_tokens * pi + u.output_tokens * po) / 1e6;
const md = `# Notes from ${run} (${model})\n\n${text}\n\n---\n\n${lines.length} transcript lines, ${transcript.length} characters. ${u.input_tokens} input tokens, ${u.output_tokens} output tokens, $${cost.toFixed(4)}, ${(ms / 1000).toFixed(1)} s, stop: ${response.stop_reason}.\n\n<details><summary>The transcript it was given</summary>\n\n\`\`\`\n${transcript}\n\`\`\`\n</details>\n`;
writeFileSync(join(dir, `notes-${model}.md`), md);
console.log(md.split("---")[0]);
console.log(`${u.input_tokens} in / ${u.output_tokens} out, $${cost.toFixed(4)}, ${(ms / 1000).toFixed(1)} s, stop ${response.stop_reason}`);
