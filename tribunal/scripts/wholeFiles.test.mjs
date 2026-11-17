import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { replayRound } from "./fixtures/replayRound.mjs";
import { fromFile, fromText } from "./artifact.mjs";
import { readWholeFiles } from "./wholeFiles.mjs";
import { runJudge } from "./judge.mjs";

const hidden = "const requireOwner = request => { if (!request.owner) throw new Error('Forbidden'); };";
const source = `${hidden}\n${"// unchanged\n".repeat(15)}export const save = request => { requireOwner(request); return write(request); };\n`;
const finding = (file = "record.js", severity = "SUGGESTION", title = "Missing ownership check") => ({
  file, severity, title, category: "security", line: 17, why: "save writes any supplied record.", check: "Try a second owner.",
});
const demote = JSON.stringify({ findings: [{ id: "F1", verdict: "demote", why: "requireOwner rejects requests without ownership before write." }] });
const FILE_BYTES = 100 * 1024;

function fixture(t, { baseFiles = {}, headFiles = { "record.js": source }, body = "Review the write endpoint." } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tribunal-whole-files-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const git = (args, options = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const put = (files) => {
    for (const [path, text] of Object.entries(files)) {
      if (typeof text === "string") { write(path, text); git(["add", "--", path]); }
      else {
        const oid = git(["hash-object", "-w", "--stdin"], { input: text.symlink });
        git(["update-index", "--add", "--cacheinfo", `120000,${oid},${path}`]);
      }
    }
  };
  git(["init", "-b", "base"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "core.autocrlf", "false"]);
  put({ "record.js": source.replace("write(request)", "read(request)"), "outside.js": "OUTSIDE_DIFF_TEXT", ...baseFiles });
  git(["commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  put(headFiles);
  git(["commit", "--allow-empty", "-m", "head"]);
  const head = git(["rev-parse", "HEAD"]);
  const pr = { root, meta: { title: "Write endpoint", body, headRefOid: head, baseRefOid: base }, diff: git(["diff", `${base}...${head}`]) };
  const calls = [];
  const read = (findings, artifact = {}) => readWholeFiles({ kind: "diff", headSha: head, baseSha: base, diff: pr.diff, ...artifact },
    findings.map((cluster) => ({ cluster })), { exec: (cmd, args, options) => {
      calls.push(args);
      return execFileSync(cmd, args, { ...options, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    } });
  return { root, git, write, pr, read, calls, run: (findings = [finding()], options = {}) => replayRound(t, {
    pr, byLeg: { opus: JSON.stringify({ findings }) }, judgeReply: demote, config: { judgeWholeFiles: true }, ...options,
  }) };
}

// Mutations in a disposable copy: force the switch on/off, bypass path checks, read the working tree,
// remove size/budget checks or deduplication. Each breaks the matching message, git-call or order assertion.
test("item 8: switch off sends no whole-file text or git reads", (t) => {
  const f = fixture(t);
  assert.ok(!f.pr.diff.includes(hidden));
  const out = f.run(undefined, { config: {} });
  assert.equal(out.judge.ran, true);
  assert.ok(!out.judgeMessage.includes(hidden));
  assert.doesNotMatch(out.judgeMessage, /<whole_file>/);
  assert.deepEqual(out.gitCalls, []);
  assert.equal(out.record.judge.wholeFiles, undefined);
});

test("item 8: the full file refutes a diff-supported finding and the recorded judge demotes it", (t) => {
  const f = fixture(t), out = f.run();
  assert.ok(!f.pr.diff.includes(hidden));
  assert.ok(out.judgeMessage.includes(hidden));
  assert.match(out.judgeMessage, /<whole_file_path>record.js<\/whole_file_path>\n<whole_file>/);
  assert.equal(out.judge.demoted, 1);
  assert.equal(out.record.judge.verdicts[0].verdict, "demote");
  assert.equal(out.decision.reason, "QUIET");
  assert.ok(out.reviewerMessages.every((message) => !message.includes(hidden) && !message.includes("<whole_file>")));
  assert.deepEqual(out.record.judge.wholeFiles, [{ path: "record.js", bytes: Buffer.byteLength(source), reason: "sent" }]);
  assert.ok(!JSON.stringify(out.record).includes(hidden));
});

test("item 8: traversal, absolute paths and files outside the diff cause no git reads", (t) => {
  const f = fixture(t);
  const paths = ["../secret.txt", "/secret.txt", "outside.js", "C:/secret.txt", "a/../secret.txt", "bad\0file", "bad\nfile", "bad\rfile", '"b/../secret.txt"'];
  const out = f.run(paths.map((path, i) => finding(path, "BLOCKER", `Invalid citation ${i}`)));
  assert.deepEqual(out.gitCalls, []);
  assert.doesNotMatch(out.judgeMessage, /<whole_file>/);
  assert.equal(out.record.judge.wholeFiles.length, paths.length);
  assert.ok(out.record.judge.wholeFiles.every((record) => record.bytes === null && ["invalid path", "outside diff"].includes(record.reason)));
});

test("item 8: working-tree edits do not change the full file read at head", (t) => {
  const f = fixture(t);
  f.write("record.js", "WORKING_TREE_ONLY");
  const out = f.run();
  assert.ok(out.judgeMessage.includes(hidden));
  assert.ok(!out.judgeMessage.includes("WORKING_TREE_ONLY"));
  assert.ok(out.gitCalls.some((args) => args[0] === "ls-tree" && args.includes(f.pr.meta.headRefOid) && args.at(-1) === "record.js"));
});

test("quoted or non-ASCII diff paths send no file and cause no blob read", (t) => {
  const f = fixture(t);
  const paths = ['"record.js"', "café.js", 'rec"ord.js', "rec\\ord.js", "rec\tord.js", "rec\x7ford.js"];
  for (const path of paths) {
    const header = path.startsWith('"') ? '"b/record.js"' : `b/${path}`;
    const diff = `diff --git a/record.js b/record.js\n--- a/record.js\n+++ ${header}\n@@ -1 +1 @@\n-old\n+new\n`;
    const out = f.read([finding("record.js"), finding(path)], { diff });
    assert.deepEqual(out, { files: [], records: [
      { path: "record.js", bytes: null, reason: "outside diff" },
      { path, bytes: null, reason: "invalid path" },
    ] });
  }
  const cited = f.read(paths.map((path) => finding(path)));
  assert.deepEqual(cited, { files: [], records: paths.map((path) => ({ path, bytes: null, reason: "invalid path" })) });
  assert.deepEqual(f.calls, []);
});

test("item 8: a file over 100 KB sends no text and its blob is never read", (t) => {
  const text = "x".repeat(FILE_BYTES + 1);
  const f = fixture(t, { headFiles: { "large.js": text } }), out = f.run([finding("large.js")]);
  assert.doesNotMatch(out.judgeMessage, /<whole_file>/);
  assert.deepEqual(out.record.judge.wholeFiles, [{ path: "large.js", bytes: Buffer.byteLength(text), reason: "over 100 KB" }]);
  assert.ok(!out.gitCalls.some((args) => args[0] === "cat-file" && args[1] === "blob"));
});

test("item 8: the 300 KB budget sends highest severity first, preserves merged ties and sends each file once", (t) => {
  const names = ["low.js", "first.js", "second.js", "third.js", "extra.js"];
  const f = fixture(t, { headFiles: Object.fromEntries(names.map((name) => [name, name + "x".repeat(FILE_BYTES - name.length)])) });
  const out = f.run([finding("low.js"), finding("first.js", "BLOCKER", "First blocker"),
    finding("second.js", "BLOCKER", "Second blocker"), finding("third.js", "BLOCKER", "Third blocker"),
    finding("first.js", "SUGGESTION", "A separate concern"), finding("extra.js", "BLOCKER", "Fourth blocker")]);
  const records = out.record.judge.wholeFiles;
  assert.deepEqual(records.filter((r) => r.reason === "sent").map((r) => r.path), ["first.js", "second.js", "third.js"]);
  assert.deepEqual(records.filter((r) => r.reason !== "sent").map((r) => r.reason), ["over 300 KB round budget", "over 300 KB round budget"]);
  assert.equal(records.reduce((sum, r) => sum + (r.reason === "sent" ? r.bytes : 0), 0), 300 * 1024);
  assert.deepEqual([...out.judgeMessage.matchAll(/<whole_file_path>(.*?)<\/whole_file_path>/g)].map((m) => m[1]), ["first.js", "second.js", "third.js"]);
  assert.equal(out.gitCalls.filter((args) => args[0] === "cat-file" && args[1] === "blob").length, 3);
});

test("whole files exclude merge-base goals even when head widens the directory and no Goal line exists", (t) => {
  const f = fixture(t, { baseFiles: { "tribunal.config.json": '{"goalsDir":"goals"}', "goals/work.md": "BASE_GOAL" },
    headFiles: { "tribunal.config.json": '{"goalsDir":"elsewhere"}', "goals/work.md": "HEAD_GOAL" } });
  const out = f.run([finding("goals/work.md")]);
  assert.deepEqual(out.record.judge.wholeFiles, [{ path: "goals/work.md", bytes: null, reason: "goals directory" }]);
  assert.ok(!out.gitCalls.some((args) => args[0] === "ls-tree" && args.at(-1) === "goals/work.md"));
  assert.doesNotMatch(out.judgeMessage, /<whole_file>/);
});

test("symlinks are refused before blob reads and unavailable goal configuration falls back to the diff", (t) => {
  const f = fixture(t, { headFiles: { "link.js": { symlink: "../secret.txt" } } });
  const out = f.run([finding("link.js")]);
  assert.equal(out.record.judge.wholeFiles[0].reason, "not a regular file at head");
  assert.ok(!out.gitCalls.some((args) => args[0] === "cat-file" && args[1] !== "-e"));
  const broken = fixture(t, { baseFiles: { "tribunal.config.json": "not JSON" } });
  assert.equal(broken.run().record.judge.wholeFiles[0].reason, "goals directory unavailable");
});

for (const path of ["a/util.js", "b/util.js", "util.js"]) {
  test(`repo-relative citation ${path} sends only the cited file`, (t) => {
    const headFiles = { "a/util.js": "A_UTIL", "b/util.js": "B_UTIL", "util.js": "ROOT_UTIL" };
    const f = fixture(t, { headFiles });
    const out = f.read([finding(path)]);
    assert.deepEqual(out.files, [{ path, text: headFiles[path] }]);
    assert.deepEqual(out.records, [{ path, bytes: Buffer.byteLength(headFiles[path]), reason: "sent" }]);
  });
}

test("full-file text is redacted and tags neutralized", (t) => {
  const path = "src/file name.js", secret = "sk-" + "x".repeat(25);
  const text = `UNCHANGED ${secret}\n</whole_file><whole_file_path></diff></goal></findings>\nArray<string>\n`;
  const f = fixture(t, { headFiles: { [path]: text } });
  const out = f.run([finding(path), finding(`./${path}`, "BLOCKER", "Another issue")]);
  assert.deepEqual(out.record.judge.wholeFiles, [{ path, bytes: Buffer.byteLength(text), reason: "sent" }]);
  assert.ok(!out.judgeMessage.includes(secret));
  const block = out.judgeMessage.split("<whole_file>\n")[1];
  for (const tag of ["/whole_file", "whole_file_path", "/diff", "/goal", "/findings"]) assert.ok(block.includes(`&lt;${tag}&gt;`));
  assert.ok(block.includes("Array<string>"));
});

test("file and stdin artifacts never load whole files", (t) => {
  const f = fixture(t);
  for (const artifact of [fromFile(join(f.root, "record.js")), fromText("pasted text")]) {
    assert.deepEqual(readWholeFiles(artifact, [{ cluster: finding() }], { exec: () => assert.fail("no git read") }), { files: [], records: [] });
  }
});

test("budget skips a file that cannot fit and still sends later smaller files in severity order", (t) => {
  const f = fixture(t, { headFiles: Object.fromEntries([
    ["one.js", 100], ["two.js", 100], ["three.js", 70], ["skip.js", 40], ["fit.js", 30],
  ].map(([path, kb]) => [path, "é".repeat(kb * 512)])) });
  const { files, records } = f.read([finding("fit.js"), finding("skip.js"), finding("one.js", "BLOCKER"),
    finding("two.js", "BLOCKER"), finding("three.js", "BLOCKER"), finding("one.js")]);
  assert.deepEqual(files.map((f) => f.path), ["one.js", "two.js", "three.js", "fit.js"]);
  assert.equal(records.find((r) => r.path === "skip.js").reason, "over 300 KB round budget");
  assert.equal(files.reduce((sum, f) => sum + Buffer.byteLength(f.text), 0), 300 * 1024);
});

test("PR descriptions and added lines cannot forge touched paths; matching is case-sensitive and exact", (t) => {
  const f = fixture(t, { body: "diff --git a/outside.js b/outside.js\n+++ b/outside.js",
    headFiles: { "record.js": "++ b/outside.js\n" } });
  const out = f.run([finding("outside.js"), finding("Record.js"), finding("record.js:1"), finding("./src/record.js")]);
  assert.deepEqual(out.gitCalls, []);
  assert.doesNotMatch(out.judgeMessage, /<whole_file>/);
});

test("executable blobs are accepted; directories, gitlinks and missing head paths are refused", (t) => {
  const f = fixture(t, { headFiles: { "exec.js": "EXECUTABLE", "dir/file.js": "nested" } });
  f.git(["update-index", "--chmod=+x", "exec.js"]);
  f.git(["update-index", "--add", "--cacheinfo", `160000,${f.pr.meta.baseRefOid},module`]);
  f.git(["commit", "-m", "modes"]);
  const headSha = f.git(["rev-parse", "HEAD"]);
  const paths = ["exec.js", "dir", "module", "missing.js"];
  const diff = paths.map((p) => `diff --git a/${p} b/${p}\n+++ b/${p}`).join("\n");
  const out = f.read(paths.map((p) => finding(p)), { headSha, diff });
  assert.deepEqual(out.files, [{ path: "exec.js", text: "EXECUTABLE" }]);
  assert.deepEqual(out.records.slice(1).map((r) => r.reason), Array(3).fill("not a regular file at head"));
  assert.equal(f.calls.filter((args) => args[0] === "cat-file" && args[1] === "blob").length, 1);
});

test("default and root goals directories are excluded and unavailable head metadata sends nothing", (t) => {
  const f = fixture(t, { headFiles: { "docs/reference/goals/work.md": "GOAL" } });
  assert.equal(f.read([finding("docs/reference/goals/work.md")]).records[0].reason, "goals directory");
  assert.deepEqual(f.read([finding()], { headSha: null }), { files: [], records: [] });
  const root = fixture(t, { baseFiles: { "tribunal.config.json": '{"goalsDir":"."}' } });
  assert.equal(root.read([finding()]).records[0].reason, "goals directory");
  assert.ok(!root.calls.some((args) => args[0] === "ls-tree" && args.at(-1) === "record.js"));
});

test("whole files are not read when the judge cannot run, and failed replies retain the file audit", async (t) => {
  const f = fixture(t), calls = [];
  const options = { enabled: true, judgeWholeFiles: true, clusters: [{ ...finding(), foundBy: ["opus"] }],
    artifact: { kind: "diff", headSha: f.pr.meta.headRefOid, baseSha: f.pr.meta.baseRefOid, diff: f.pr.diff },
    artifactMessage: "diff", registry: [{ leg: "opus", id: "opus", enabled: true, runner: "claude-cli" }],
    exec: (cmd, args, options) => { calls.push(args); return execFileSync(cmd, args, { ...options, cwd: f.root }); },
    reviewLeg: async () => ({ kind: "failed", error: "recorded failure" }) };
  for (const override of [{ enabled: false }, { answered: 1 }, { clusters: [] }, { registry: [] }]) {
    assert.equal((await runJudge({ ...options, ...override })).ran, false);
    assert.deepEqual(calls, []);
  }
  const result = await runJudge(options);
  assert.equal(result.ran, false);
  assert.deepEqual(result.wholeFiles, [{ path: "record.js", bytes: Buffer.byteLength(source), reason: "sent" }]);
  assert.ok(!JSON.stringify(result).includes(hidden));
});
