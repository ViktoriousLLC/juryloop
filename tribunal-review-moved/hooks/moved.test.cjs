const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, sep } = require("node:path");

const HOOK = join(__dirname, "moved.cjs");
const ROOT = resolve(__dirname, "../..");
const MESSAGE = "Tribunal Review is now Juryloop. This old plugin no longer reviews anything, so merges are held. Run: claude plugin install juryloop@viktorious, then claude plugin uninstall tribunal-review@viktorious, and restart Claude Code. A repository that turns the plugin on in .claude/settings.json must change tribunal-review@viktorious to juryloop@viktorious.";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "juryloop-moved-"));
  const home = join(root, "home");
  mkdirSync(home);
  t.after(() => {
    try { assert.deepEqual(readdirSync(home), [], "the placeholder must never write to HOME"); }
    finally {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      rmSync(root, { recursive: true, force: true });
    }
  });
  const fire = (input, event = "PreToolUse", hook = HOOK) => {
    const result = spawnSync(process.execPath, [hook, event], {
      input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", cwd: root,
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root,
        TRIBUNAL_ALLOW_UNREVIEWED_MERGE: "1", TRIBUNAL_HOOK_BUDGET_MS: "0" },
    });
    assert.ifError(result.error);
    return result;
  };
  return { root, fire };
}

const payload = (command, tool_name = "Bash") => ({ hook_event_name: "PreToolUse", tool_name, tool_input: { command } });
function assertBlocked(result) {
  assert.equal(result.status, 2, "merges must remain held until the old plugin is removed");
  assert.equal(result.stderr, MESSAGE + "\n");
  assert.equal(result.stdout, "");
}

test("gh pr merge 5 blocks with the exact migration message in both shells", (t) => {
  const { fire } = fixture(t);
  for (const tool of ["Bash", "PowerShell"]) assertBlocked(fire(payload("gh pr merge 5", tool)));
});

test("non-merges pass silently, including quoted prose, help and read-only API calls", (t) => {
  const { fire } = fixture(t);
  for (const command of ["git status", 'echo "gh pr merge 5"', 'git commit -m "gh pr merge 5"', "gh pr merge --help", "gh api repos/o/r/pulls/5/merge"]) {
    const result = fire(payload(command));
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout + result.stderr, "", command);
  }
});

test("wrappers, compound commands, substitutions and API merges stay blocked", (t) => {
  const { fire } = fixture(t);
  for (const [command, tool] of [
    ["git status; gh -R owner/repo pr merge 5", "Bash"],
    ['echo "$(gh pr merge 5)"', "Bash"],
    ['& "C:\\bin\\gh.exe" pr merge 5', "PowerShell"],
    ["gh pr `\nmerge branch-name", "PowerShell"],
    ["gh api -X PUT repos/o/r/pulls/5/merge", "Bash"],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'", "Bash"],
  ]) assertBlocked(fire(payload(command, tool)));
});

test("malformed merge-looking input and unknown commands fail closed", (t) => {
  const { fire } = fixture(t);
  for (const input of [
    '{"tool_input":{"command":"gh pr merge 5"}',
    '{"tool_input":{"command":"gh pr merge',
    '{"tool_input":{"command":"\\u0067h pr \\u006derge 5"}',
    "not json", "", "null", "{}", '{"tool_input":{"command":5}}',
  ]) assertBlocked(fire(input));
});

test("a recoverable, clearly unrelated command in malformed input passes", (t) => {
  const { fire } = fixture(t);
  const result = fire('{"tool_input":{"command":"git status"}');
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, "");
});

test("SessionStart emits additional context even with malformed stdin", (t) => {
  const { fire } = fixture(t);
  for (const input of [{ hook_event_name: "SessionStart" }, "not json"]) {
    const result = fire(input, "SessionStart");
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { systemMessage: `${MESSAGE} Until then, goal statements are not reviewed.`,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: MESSAGE } });
  }
});

test("Stop never blocks or emits output, including malformed stdin", (t) => {
  const { fire } = fixture(t);
  for (const input of [payload("gh pr merge 5"), "not json", ""]) {
    const result = fire(input, "Stop");
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, "");
  }
});

test("both plugins enabled and repeated attempts cannot bypass or write gate state", (t) => {
  const { root, fire } = fixture(t);
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: {
    "juryloop@viktorious": true, "tribunal-review@viktorious": true,
  } }));
  writeFileSync(join(root, ".claude", "tribunal-wall-breakglass"), "");
  for (let i = 0; i < 5; i += 1) assertBlocked(fire(payload("gh pr merge 5")));
});

test("marketplace and all hook registrations point at the standalone placeholder", () => {
  const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json")));
  assert.equal(marketplace.plugins.find((plugin) => plugin.name === "juryloop").source, "./tribunal");
  assert.equal(marketplace.plugins.find((plugin) => plugin.name === "tribunal-review").source, "./tribunal-review-moved");
  const manifest = JSON.parse(readFileSync(join(__dirname, "../.claude-plugin/plugin.json")));
  assert.equal(manifest.name, "tribunal-review");
  assert.equal(manifest.version, "0.16.0");
  const { hooks } = JSON.parse(readFileSync(join(__dirname, "hooks.json")));
  assert.deepEqual(Object.keys(hooks).sort(), ["PreToolUse", "SessionStart", "Stop"]);
  assert.equal(hooks.PreToolUse[0].matcher, "Bash|PowerShell");
  for (const event of Object.keys(hooks)) {
    assert.equal(hooks[event][0].hooks[0].command, `node "${'${CLAUDE_PLUGIN_ROOT}'}/hooks/moved.cjs" ${event}`);
  }
});

test("the standalone parser is an exact copy of the active merge matcher", () => {
  const original = readFileSync(join(ROOT, "tribunal/hooks/tribunal-reminder.js"), "utf8").replace(/\r\n/g, "\n");
  const copy = readFileSync(HOOK, "utf8").replace(/\r\n/g, "\n");
  const start = original.indexOf("function shellSegments("), end = original.indexOf("/**\n * All identifiable PR numbers");
  assert.ok(start !== -1 && end > start, "the active merge matcher anchors moved; update this check");
  const parser = original.slice(start, end);
  assert.ok(copy.includes(parser.trim()), "update the standalone parser when merge recognition changes");
});

test("negative control: a do-nothing guard fails the merge-blocking assertion", (t) => {
  // Mutation: replace the hook with an empty script. The same assertion used by
  // the positive blocking fixture must reject its silent successful exit.
  const { root, fire } = fixture(t);
  const noop = join(root, "noop.cjs");
  writeFileSync(noop, "");
  const result = fire(payload("gh pr merge 5"), "PreToolUse", noop);
  assert.equal(result.status, 0);
  assert.throws(() => assertBlocked(result), /merges must remain held/);
});
