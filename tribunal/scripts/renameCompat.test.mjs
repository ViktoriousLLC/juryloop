// The Juryloop rename changed names a user reads, not the internal names (~/.tribunal/,
// tribunal.config.json, TRIBUNAL_*). This fixture is a v0.15.0 user home: ledger rows plus a
// trust.json binding, with a config that never names the ledger home. The renamed code must give
// the decisions v0.15.0 gave on it. Assertions avoid the plugin's display name so the same file
// passes against the v0.15.0 tag; that is how the expectations were checked.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactHistory } from "./ledger.mjs";
import { resolvePolicy } from "./policy.mjs";
import { runnableLegs } from "./registry.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const HOOKS = resolve(HERE, "..", "hooks");
const TWO_LEGS = [{ leg: "a", model: "m-a", answered: true, kind: "answered", parseFailed: false },
  { leg: "b", model: "m-b", answered: true, kind: "answered", parseFailed: false }];
const sha = (v) => createHash("sha256").update(v).digest("hex");
const GOAL = "docs/reference/goals/work.md";
const GOAL_TEXT = "# goal\n\nreviewed under v0.15.0\n";

let savedInternalEnv;
beforeEach(() => {
  savedInternalEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("TRIBUNAL_")));
  for (const key of Object.keys(savedInternalEnv)) delete process.env[key];
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("TRIBUNAL_")) delete process.env[key];
  Object.assign(process.env, savedInternalEnv);
});

/** A v0.15.0 home: ledger rows under ~/.tribunal/<slug>/, trust.json, and a repo with a config. */
function v015Home(t) {
  const base = mkdtempSync(join(tmpdir(), "juryloop-compat-"));
  t.after(() => {
    assert.ok(resolve(base).startsWith(resolve(tmpdir()) + sep));
    rmSync(base, { recursive: true, force: true });
  });
  const home = join(base, "home");
  const repo = join(base, "repo");
  mkdirSync(join(home, ".tribunal"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "docs", "reference", "goals"), { recursive: true });
  writeFileSync(join(repo, "tribunal.config.json"), JSON.stringify({}));
  const slug = `${basename(repo)}-${sha(resolve(repo)).slice(0, 8)}`;
  const ledger = join(home, ".tribunal", slug);
  mkdirSync(ledger);
  const row = (artifact, runnerRound, decision, extra = {}) => ({ ts: "2026-09-01T00:00:00.000Z", artifact, runnerRound, decision, legs: TWO_LEGS, ...extra });
  const rows = [
    row({ kind: "diff", source: "PR #4242", prNumber: 4242 }, 1, { action: "CONTINUE", reason: "ACTIONABLE" }),
    row({ kind: "diff", source: "PR #4242", prNumber: 4242 }, 2, { action: "STOP", reason: "QUIET" }),
    row({ kind: "document", source: GOAL }, 1, { action: "STOP", reason: "QUIET" }, { contentHash: sha(Buffer.from(GOAL_TEXT)) }),
  ];
  writeFileSync(join(ledger, "2026-09.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(home, ".tribunal", "trust.json"), JSON.stringify({ bindings: [{ env: "BOUND_API_KEY", origin: "https://gateway.example.com" }] }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: repo };
  for (const key of Object.keys(env)) if (key.startsWith("TRIBUNAL_")) delete env[key];
  return { base, home, repo, ledger, env };
}

function merge(f, pr) {
  return spawnSync(process.execPath, [join(HOOKS, "tribunal-reminder.js")], {
    input: JSON.stringify({ cwd: f.repo, session_id: `compat-${pr}`, tool_name: "Bash", tool_input: { command: `gh pr merge ${pr}` } }),
    encoding: "utf8", cwd: f.repo, env: f.env });
}

function withHome(t, f) {
  const originalHome = process.env.HOME, originalProfile = process.env.USERPROFILE;
  process.env.HOME = f.home; process.env.USERPROFILE = f.home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
  });
}

test("v0.15.0 home: the merge gate allows the PR with a quiet row and blocks one with none", (t) => {
  const f = v015Home(t);
  assert.equal(merge(f, 4242).status, 0, "reviewed PR passes");
  const blocked = merge(f, 4243);
  assert.equal(blocked.status, 2, "unreviewed PR is blocked");
  assert.match(blocked.stderr, /PR #4243 has no recorded local panel/);
});

test("v0.15.0 home: the goal wall blocks changed goal bytes and allows the bytes a row recorded", (t) => {
  const f = v015Home(t);
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], { cwd: f.repo, encoding: "utf8" });
  rmSync(join(f.repo, ".git"), { recursive: true, force: true });
  git("init", "-q");
  writeFileSync(join(f.repo, GOAL), "# goal\n\nolder text\n");
  git("add", "--", GOAL);
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const wall = () => spawnSync(process.execPath, [join(HOOKS, "goal-wall.js")], {
    input: JSON.stringify({ session_id: "compat-wall", stop_hook_active: false, hook_event_name: "Stop" }),
    encoding: "utf8", cwd: f.repo, env: f.env });
  writeFileSync(join(f.repo, GOAL), "# goal\n\nchanged and never reviewed\n");
  assert.equal(wall().status, 2, "bytes with no row block");
  writeFileSync(join(f.repo, GOAL), GOAL_TEXT);
  assert.equal(wall().status, 0, "the bytes the v0.15.0 row recorded pass");
});

test("v0.15.0 home: the next round number continues from the ledger rows", (t) => {
  const f = v015Home(t);
  withHome(t, f);
  const policy = resolvePolicy(f.repo);
  assert.equal(policy.ledgerHome, f.ledger, "the ledger stays at ~/.tribunal/<slug>");
  const history = artifactHistory({ kind: "diff", source: "PR #4242", prNumber: 4242 }, policy.ledgerHome);
  assert.equal(history.length, 2);
  // The runner's own formula (run.mjs): 1 + the highest recorded runnerRound.
  assert.equal(1 + Math.max(0, ...history.map((r) => Number.isSafeInteger(r.runnerRound) ? r.runnerRound : 0)), 3);
});

test("v0.15.0 home: trust.json still authorizes its binding and still refuses any other", (t) => {
  const f = v015Home(t);
  withHome(t, f);
  const leg = (envKey, baseUrl) => ({ leg: "x", id: "m-1", vendor: "v", runner: "openai-api", billing: "metered", baseUrl,
    envKeys: [envKey], requiredEnv: [envKey], enabled: true, pricesUSDPer1M: {} });
  const bound = runnableLegs([leg("BOUND_API_KEY", "https://gateway.example.com/v1")], { BOUND_API_KEY: "k" });
  assert.equal(bound.run.length, 1);
  assert.equal(bound.trustRefused, undefined);
  const other = runnableLegs([leg("BOUND_API_KEY", "https://elsewhere.example.com/v1")], { BOUND_API_KEY: "k" });
  assert.deepEqual(other.run, []);
  assert.equal(other.trustRefused.length, 1);
  assert.match(other.trustRefused[0].reason, /BOUND_API_KEY/);
  assert.match(other.trustRefused[0].reason, /https:\/\/elsewhere\.example\.com/);
  assert.match(other.trustRefused[0].reason, /trust\.json/);
  assert.ok(readFileSync(join(f.home, ".tribunal", "trust.json"), "utf8").includes("gateway.example.com"));
});
