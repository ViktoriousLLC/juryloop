import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { render } from "../render.mjs";

export const seats = [
  { leg: "opus", id: "opus", vendor: "Anthropic", runner: "claude-cli" },
  { leg: "fable", id: "fable", vendor: "Anthropic", runner: "claude-cli" },
  { leg: "sol", id: "gpt-test", vendor: "OpenAI", runner: "codex-cli" },
].map((row) => ({ ...row, billing: "plan", envKeys: [], enabled: true }));

export const replies = JSON.parse(readFileSync(new URL("./seat-replies.json", import.meta.url), "utf8"));

export function replayRound(t, { registry = seats, byLeg = {}, judgeReply = replies.keep, config = {}, round = 1, pr = null } = {}) {
  const root = pr?.root || mkdtempSync(join(tmpdir(), "tribunal-replay-"));
  if (!pr) {
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".git"));
  }
  mkdirSync(join(root, ".tribunal"));
  const ledgerHome = join(root, "ledger");
  mkdirSync(ledgerHome);
  const file = join(root, "artifact.md");
  writeFileSync(file, "The record endpoint writes the requested id without checking its owner.\n");
  writeFileSync(join(root, "models.json"), JSON.stringify({ legs: registry }));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ modelsFile: "models.json", ledgerHome, ...config }));
  writeFileSync(join(root, ".tribunal", "trust.json"), JSON.stringify({ bindings: registry
    .filter((leg) => leg.runner === "openai-api").map((leg) => ({ env: leg.envKeys[0], origin: new URL(leg.baseUrl).origin })) }));
  if (round > 1) writeFileSync(join(ledgerHome, "2026-01.ndjson"), JSON.stringify({
    artifact: { kind: "document", source: file }, runnerRound: round - 1, decision: { action: "CONTINUE", reason: "ACTIONABLE" },
  }) + "\n");
  const wrapper = join(root, "invoke.mjs");
  writeFileSync(wrapper, `import { main } from ${JSON.stringify(new URL("../run.mjs", import.meta.url).href)};
    import { parseFindings, argsForLeg } from ${JSON.stringify(new URL("../legRunner.mjs", import.meta.url).href)};
    import { createHash } from "node:crypto";
    import { writeFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const pr = ${JSON.stringify(pr)}, gitCalls = [], reviewerMessages = [];
    const artifactOptions = pr ? { exec: (cmd, args, options) => {
      if (cmd === "gh") return args[1] === "diff" ? pr.diff : JSON.stringify(pr.meta);
      gitCalls.push(args);
      return execFileSync(cmd, args, options);
    }} : {};
    const registry = ${JSON.stringify(registry)}, replies = ${JSON.stringify(byLeg)};
    const cli = [...new Map(registry.filter((l) => l.enabled && l.runner.endsWith("-cli")).map((l) => [l.runner, l])).values()];
    const executable = ${JSON.stringify(join(root, "fixture-cli"))};
    const record = { schemaVersion: 1, probeVersion: "fixture", measuredAt: new Date().toISOString(),
      enabledCliRunners: cli.map((l) => l.runner), cli: Object.fromEntries(cli.map((l) => [l.runner, {
        executablePath: executable, executablePrefix: [], version: "fixture 1.0",
        argvShapeHash: createHash("sha256").update(JSON.stringify(argsForLeg({ ...l, id: "" }))).digest("hex"),
        verdict: "PASS", why: "recorded fixture",
      }])), overall: { ok: true, verdict: cli.length ? "PASS" : "NO-AGENT-BOUNDARY", why: "recorded fixture" } };
    const probeOptions = { readFile: () => "\u0060\u0060\u0060json\\n" + JSON.stringify(record) + "\\n\u0060\u0060\u0060\\n",
      resolveExecutable: () => ({ file: executable, prefix: [], found: true }),
      spawnVersion: () => ({ status: 0, stdout: "fixture 1.0\\n", stderr: "" }) };
    await main({ probeOptions, probe: null, artifactOptions, reviewLeg: async (leg, message, options) => {
      if (options?.contract) writeFileSync(${JSON.stringify(join(root, "judge-message.txt"))}, message);
      else reviewerMessages.push(message);
      const raw = options?.contract ? ${JSON.stringify(judgeReply)} : replies[leg.leg] || '{"findings":[]}';
      const { findings, parseError } = parseFindings(raw);
      return { leg: leg.leg, model: leg.id, kind: "answered", answered: true,
        raw, findings, parseFailed: Boolean(parseError), error: parseError };
    }});
    writeFileSync(${JSON.stringify(join(root, "replay-context.json"))}, JSON.stringify({ gitCalls, reviewerMessages }));`);
  const result = spawnSync(process.execPath, [wrapper, ...(pr ? ["--pr", "7"] : ["--file", file]), "--json"], {
    cwd: root, encoding: "utf8", timeout: 15000,
    env: { ...process.env, HOME: root, USERPROFILE: root, REPLAY_API_KEY: "fixture-only" },
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr || String(result.error));
  const output = JSON.parse(result.stdout);
  const rows = readdirSync(ledgerHome).filter((name) => name.endsWith(".ndjson"))
    .flatMap((name) => readFileSync(join(ledgerHome, name), "utf8").trim().split("\n").map(JSON.parse));
  assert.deepEqual(rows.find((row) => row.runnerRound === round), output.record);
  const text = render({ ...output, artifact: output.record.artifact, legs: output.record.legs, round, elapsedMs: 0 });
  const judgeMessage = output.judge.ran ? readFileSync(join(root, "judge-message.txt"), "utf8") : null;
  return { ...output, text, judgeMessage, ...JSON.parse(readFileSync(join(root, "replay-context.json"), "utf8")) };
}
