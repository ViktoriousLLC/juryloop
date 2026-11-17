import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { initConfig } from "./doctor.mjs";
import { resolvePolicy } from "./policy.mjs";
import { fileURLToPath } from "node:url";

function assertPolicy(f, preset, seats) {
  let policy;
  assert.doesNotThrow(() => {
    policy = resolvePolicy(f.cwd, { resolveExecutable: f.options.resolveExeFn });
  });
  assert.equal(policy.configFile, f.path);
  assert.equal(policy.modelsFile, fileURLToPath(new URL(`./presets/${preset}.json`, import.meta.url)));
  assert.deepEqual(policy.registry.filter((leg) => leg.enabled).map((leg) => leg.leg), seats);
}

function fixture(t, { claude = false, codex = false, missing = [], worktree = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tribunal-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (worktree) writeFileSync(join(dir, ".git"), "gitdir: elsewhere\n");
  else mkdirSync(join(dir, ".git"));
  const cwd = join(dir, "nested"), path = join(dir, "tribunal.config.json"), calls = [];
  mkdirSync(cwd);
  const options = { cwd, sourceEnv: {},
    resolveExeFn: (command) => ({ found: !missing.includes(command), file: join(dir, command), prefix: [] }),
    spawnFn: (file, args, opts) => {
      calls.push({ file, args, opts });
      const command = basename(file), loggedIn = command === "claude" ? claude : codex;
      assert.equal(opts.cwd, dir);
      assert.equal(opts.shell, false);
      if (args.at(-1) === "status") return { status: loggedIn ? 0 : 1,
        stdout: command === "claude" ? JSON.stringify({ loggedIn, authMethod: "claude.ai" }) : "",
        stderr: command === "codex" ? loggedIn ? "Logged in using ChatGPT" : "Not logged in" : "" };
      assert.equal(args.at(-1), "--help");
      return { status: 0, stdout: args.length === 1
        ? `Commands:\n  ${command === "claude" ? "auth" : "login"} Manage login\n`
        : "Commands:\n  status Show login status\n", stderr: "" };
    },
  };
  return { dir, cwd, path, calls, options, run: (extra = {}) => initConfig({ ...options, ...extra }) };
}

for (const [claude, codex, preset, seats, exitCode, why] of [
  [true, true, "claude-plus-chatgpt", ["opus", "sol", "astra"], 0, "Claude and Codex are both logged in"],
  [true, false, "claude-only", ["opus"], 0, "only Claude is logged in"],
  [false, true, "claude-plus-chatgpt", ["opus", "sol", "astra"], 1, "only Codex is logged in"],
  [false, false, "claude-only", ["opus"], 1, "neither CLI is logged in"],
]) {
  test(`init chooses ${preset} with claude=${claude}, codex=${codex}`, (t) => {
    const f = fixture(t, { claude, codex, worktree: codex }), result = f.run();
    const expected = { preset, judge: true, gates: { goalWall: true, mergeGate: true } };
    assert.equal(result.exitCode, exitCode);
    assert.equal(readFileSync(f.path, "utf8"), `${JSON.stringify(expected, null, 2)}\n`);
    assertPolicy(f, preset, seats);
    const output = result.lines.join("\n");
    assert.ok(output.includes(f.path));
    assert.ok(output.includes(`Preset: ${preset}`));
    assert.ok(output.includes(why));
    if (!claude) assert.match(output, /Claude seat .*not logged in.*claude auth login/);
    if (!claude) assert.match(output, /Claude seat \(opus\) must sign in before a panel can run/);
    else assert.doesNotMatch(output, /must sign in before a panel can run/);
    if (!codex) assert.match(output, /Codex seats .*not logged in.*codex login/);
    assert.deepEqual(f.calls.filter(({ args }) => args.at(-1) === "status").map(({ args }) => args),
      [["auth", "status"], ["login", "status"]]);
    assert.deepEqual(readdirSync(f.dir).sort(), [".git", "nested", "tribunal.config.json"]);
    assert.deepEqual(readdirSync(f.cwd), []);
  });
}

test("init leaves an existing config byte-for-byte untouched without checking logins", (t) => {
  const f = fixture(t), content = Buffer.from("owner content, even invalid JSON\r\n\0");
  writeFileSync(f.path, content);
  const result = f.run({ resolveExeFn: () => assert.fail("existing config must skip detection") });
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join("\n"), /exists and was left untouched/);
  assert.deepEqual(readFileSync(f.path), content);
  assert.equal(f.calls.length, 0);
});

test("init never overwrites a config created during login detection", (t) => {
  const f = fixture(t), content = "created by another process\n";
  const result = f.run({ spawnFn: (...args) => {
    writeFileSync(f.path, content);
    return f.options.spawnFn(...args);
  } });
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join("\n"), /exists and was left untouched/);
  assert.equal(readFileSync(f.path, "utf8"), content);
});

test("init uses claude-only and sign-in guidance when both CLIs are missing", (t) => {
  const f = fixture(t, { missing: ["claude", "codex"] }), result = f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).preset, "claude-only");
  assertPolicy(f, "claude-only", ["opus"]);
  assert.match(result.lines.join("\n"), /Claude seat \(opus\) must sign in before a panel can run/);
  assert.match(result.lines.join("\n"), /claude auth login/);
  assert.match(result.lines.join("\n"), /codex login/);
  assert.equal(f.calls.length, 0);
});
