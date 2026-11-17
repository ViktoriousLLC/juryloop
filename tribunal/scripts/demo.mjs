import { readFileSync } from "node:fs";
import { clusterFindings } from "./panelLogic.mjs";
import { panelRound } from "./run.mjs";
import { render } from "./render.mjs";

export function runDemo() {
  const diff = readFileSync(new URL("./demo/sample.diff", import.meta.url), "utf8");
  const replies = JSON.parse(readFileSync(new URL("./demo/replies.json", import.meta.url), "utf8"));
  const clusters = clusterFindings(replies);
  const { remaining, summary, decision } = panelRound(replies, clusters, { round: 1 });
  return [
    "DEMO: a recorded sample round. No model was called, no login was used, and nothing was saved.",
    "", "Sample diff:", "```diff", diff.trimEnd(), "```", "",
    render({ artifact: { title: "Recorded sample: catalog pagination" }, clusters, summary, decision,
      legs: remaining, round: 1, elapsedMs: 0,
      metered: { rows: replies.map(({ leg }) => ({ leg, usd: 0, basis: "demo: recorded reply, no model call" })),
        totalUsd: 0, unmeasured: [] },
      judge: { ran: false, reason: "demo uses recorded reviewer replies; no judge was called" } }),
  ].join("\n");
}
