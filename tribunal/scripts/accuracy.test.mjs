// Numerical fixtures keep checker labels independent of fixer marks and count repeated
// problems once. All CLI reads use disposable local files; no model calls are needed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildAccuracy, buildScorecard, readLabels, renderAccuracy } from "./scorecard.mjs";

const KEY = "pr:42";
const finding = (id, severity, seat, file = `${id}.js`) => ({ id, severity, foundBy: [seat], file,
  title: `Missing ownership validation in ${file}`, judgeId: id });
const round = (runnerRound, findingList, legs = []) => ({ artifact: { prNumber: 42 }, runnerRound,
  decision: { reason: "ACTIONABLE" }, findingList, legs });
const label = (round, id, value, worth = "unknown", key = KEY) => ({ key, round, id,
  label: value, worth, votes: [{ label: value, evidence: "fixture evidence" }],
  models: ["fixture-model"], promptVersion: "fixture-v1" });

function data() {
  const first = round(1, [finding("F1", "BLOCKER", "opus"), finding("F2", "SUGGESTION", "sol"),
    finding("F3", "NIT", "opus"), finding("F4", "BLOCKER", "sol"),
    finding("F5", "SUGGESTION", "sol"), finding("F6", "NIT", "old-seat"),
    finding("F7", "BLOCKER", "opus"), finding("F8", "SUGGESTION", "sol")],
  [{ leg: "opus", elapsedMs: 0 }, { leg: "sol", elapsedMs: 10 }, { leg: "old-seat" }]);
  first.judge = { verdicts: [{ id: "F1", verdict: "keep" }, { id: "F2", verdict: "demote" }] };
  const second = round(2, [finding("F1", "BLOCKER", "sol")],
    [{ leg: "opus", elapsedMs: 20 }, { leg: "sol", elapsedMs: 100 }, { leg: "old-seat", elapsedMs: null }]);
  second.judge = { verdicts: [{ id: "F1", verdict: "demote" }] };
  const partial = { ...round(3, [finding("F9", "BLOCKER", "sol")], [{ leg: "sol", elapsedMs: 30 }]),
    decision: { reason: "PARTIAL" } };
  const rows = [first, second, partial];
  const marks = [{ id: "P1", verdict: "real" }, { id: "P1", verdict: "not-real" },
    { id: "P2", verdict: "real" }, { id: "P3", verdict: "unsure" },
    { id: "P7", verdict: "not-real" }, { id: "P8", verdict: "duplicate:P1" }].map((m) => ({ key: KEY, ...m }));
  const labels = [label(2, "F1", "real", "yes"), label(1, "F2", "real", "yes"),
    label(1, "F3", "unsure"), label(1, "F4", "cannot-check"), label(1, "F5", "retry"),
    label(1, "F7", "real", "no"), label(1, "F8", "not-real"),
    label(1, "F1", "not-real"), // Appended later, but an earlier round cannot replace round 2.
    label(1, "F2", "not-real"), // Same tuple: last line wins.
    label(3, "F9", "real", "yes")]; // Incomplete round excluded by buildScorecard.
  return { rows, marks, labels };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "juryloop-accuracy-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, ".git"));
  const ledger = join(root, "history");
  // A registry with no enabled seats keeps even CLI discovery out of this local report.
  writeFileSync(join(root, "models.json"), JSON.stringify({ legs: [
    { leg: "fixture", id: "fixture-model", runner: "claude-cli", billing: "plan", envKeys: [], enabled: false },
  ] }));
  writeFileSync(join(root, "tribunal.config.json"), JSON.stringify({ ledgerHome: "history", modelsFile: "models.json" }));
  const invoke = (...args) => spawnSync(process.execPath,
    [fileURLToPath(new URL("./scorecard.mjs", import.meta.url)), "--accuracy", ...args],
    { cwd: root, encoding: "utf8", timeout: 15_000, windowsHide: true });
  return { root, ledger, invoke };
}

test("accuracy deduplicates problems, resolves labels by tuple then latest round, and separates sources", () => {
  const { rows, marks, labels } = data();
  const original = JSON.stringify({ rows, marks, labels });
  const report = buildAccuracy({ [KEY]: rows }, { [KEY]: marks }, labels);
  assert.equal(report.rounds, 3);
  assert.equal(report.complete, 2);
  assert.equal(report.skipped, 1);
  assert.deepEqual(report.counts, { total: 7, labelled: 3, real: 2, notReal: 1, unsure: 1,
    cannotCheck: 1, retry: 1, unlabelled: 1 });
  assert.deepEqual(report.checker, { labelled: 3, real: 2, realWorthYes: 1, realRate: 2 / 3 });
  assert.deepEqual(report.fixerMarks, { labelled: 3, real: 1, realWorthYes: null, realRate: 1 / 3 });
  assert.deepEqual(report.bySeverity.BLOCKER.checker, { labelled: 2, real: 2, realWorthYes: 1, realRate: 1 });
  assert.deepEqual(report.bySeverity.BLOCKER.fixerMarks, { labelled: 2, real: 0, realWorthYes: null, realRate: 0 });
  assert.equal(report.bySeverity.NIT.checker.realRate, null);
  assert.equal(report.bySeat.opus.problems, 3);
  assert.equal(report.bySeat.opus.checker.realRate, 1);
  assert.equal(report.bySeat.opus.fixerMarks.realRate, 0);
  assert.equal(report.bySeat.sol.problems, 4);
  assert.equal(report.bySeat.sol.checker.realRate, 0.5);
  assert.equal(report.bySeat.sol.fixerMarks.realRate, 0.5);
  assert.equal(report.byJudge.kept.problems, 1);
  assert.equal(report.byJudge.kept.checker.realRate, 1);
  assert.equal(report.byJudge.kept.fixerMarks.realRate, 0);
  assert.equal(report.byJudge.demoted.problems, 2);
  assert.equal(report.byJudge.demoted.checker.realRate, 0.5);
  assert.equal(report.byJudge["not judged"].problems, 5);
  assert.equal(report.bySeat.opus.medianElapsedMs, 10, "zero is a recorded duration");
  assert.equal(report.bySeat.sol.medianElapsedMs, 30, "failed rounds contribute timing");
  assert.equal(report.bySeat["old-seat"].medianElapsedMs, null);
  assert.equal(JSON.stringify({ rows, marks, labels }), original, "pure aggregation does not mutate inputs");
  const text = renderAccuracy(report);
  assert.match(text, /checker real rate.*fixer marks real rate/);
  assert.match(text, /BLOCKER \| 3 \| 2 \| 2 \| 1 \| 100\.0% \| 2 \| 0 \| not recorded \| 0\.0%/);
  assert.match(text, /old-seat \| not recorded/);
});

test("labels on folded duplicate findings map to the root problem, with deterministic same-round ties", () => {
  const rows = [round(1, [finding("F1", "BLOCKER", "opus"), finding("F2", "BLOCKER", "sol")])];
  const marks = [{ id: "P2", verdict: "duplicate:P1" }, { id: "P1", verdict: "real" }];
  const report = buildAccuracy({ [KEY]: rows }, { [KEY]: marks }, [
    label(1, "F1", "not-real"), label(1, "F2", "real", "yes"),
  ]);
  assert.equal(report.counts.total, 1);
  assert.equal(report.counts.real, 1);
  assert.equal(report.checker.realWorthYes, 1);
  assert.equal(report.fixerMarks.real, 1);
  assert.equal(report.bySeat.sol.checker.real, 1);
});

test("old rows still load and absent fields are not synthesized", () => {
  const old = round(1, [finding("F1", "BLOCKER", "old-seat")], [{ leg: "old-seat", findings: 1 }]);
  const beforeFindingLists = { artifact: old.artifact, runnerRound: 2, legs: [{ leg: "old-seat" }] };
  const card = buildScorecard([old, beforeFindingLists]);
  assert.equal(card.unique, 1);
  const report = buildAccuracy({ [KEY]: [old, beforeFindingLists] });
  assert.equal(report.counts.total, 1);
  assert.equal(report.legacyRounds, 1);
  assert.equal(report.bySeat["old-seat"].medianElapsedMs, null);
  assert.equal(old.findingList[0].why, undefined);
  assert.equal(old.findingList[0].check, undefined);
  assert.equal(old.artifact.repository, undefined);
  assert.equal(old.artifact.baseSha, undefined);
  assert.match(renderAccuracy(report), /not recorded for 1 round/);
  assert.match(renderAccuracy(report), /no checker labels yet/);
});

test("label reader tolerates a cut-off line and preserves last-line-wins", (t) => {
  const f = fixture(t), { rows, marks, labels } = data();
  mkdirSync(f.ledger);
  writeFileSync(join(f.ledger, "labels.ndjson"), labels.map(JSON.stringify).join("\r\n") + '\r\n\r\n{"key":');
  const loaded = readLabels(f.ledger);
  assert.equal(loaded.unreadableLines, 1);
  const report = buildAccuracy(new Map([[KEY, rows]]), new Map([[KEY, marks]]), loaded);
  assert.equal(report.counts.labelled, 3);
  assert.equal(report.counts.notReal, 1);
  assert.equal(report.unreadableLabelLines, 1);
  assert.match(renderAccuracy(report), /1 unreadable label line\(s\) skipped/);
});

test("accuracy CLI groups the whole ledger by artifact key and reads each key's marks", (t) => {
  const f = fixture(t), { rows, marks, labels } = data();
  mkdirSync(f.ledger);
  const file = join(f.root, "plan.md"), key = `document:${file}`;
  const fileRow = { ...round(1, [finding("F1", "BLOCKER", "file-seat")]), artifact: { kind: "document", source: file } };
  writeFileSync(join(f.ledger, "2026-10.ndjson"), JSON.stringify(rows[0]) + "\n");
  writeFileSync(join(f.ledger, "2026-11.ndjson"), [...rows.slice(1), fileRow].map(JSON.stringify).join("\n") + '\n{"artifact":');
  writeFileSync(join(f.ledger, "marks.ndjson"), [...marks, { key, id: "P1", verdict: "real" }].map(JSON.stringify).join("\n"));
  writeFileSync(join(f.ledger, "labels.ndjson"), [...labels, label(1, "F1", "not-real", "no", key)].map(JSON.stringify).join("\n") + '\n{"key":');
  // Snapshot the local files: reporting must not append marks, labels or review rows.
  const before = Object.fromEntries(readdirSync(f.ledger).map((name) => [name, readFileSync(join(f.ledger, name), "utf8")]));
  const result = f.invoke("--json");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.rounds, 4);
  assert.equal(report.counts.total, 8);
  assert.equal(report.checker.labelled, 4);
  assert.equal(report.checker.realRate, 0.5);
  assert.equal(report.fixerMarks.realRate, 0.5);
  assert.equal(report.bySeat["file-seat"].checker.realRate, 0);
  assert.equal(report.bySeat["file-seat"].fixerMarks.realRate, 1);
  assert.equal(report.unreadableLabelLines, 1);
  const human = f.invoke();
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /1 unreadable label line\(s\) skipped/);
  assert.deepEqual(Object.fromEntries(readdirSync(f.ledger).map((name) => [name, readFileSync(join(f.ledger, name), "utf8")])), before);
});

test("empty and unlabelled ledgers report missing data and retain fixer columns", (t) => {
  const f = fixture(t);
  assert.deepEqual(readLabels(f.ledger), { entries: [], unreadableLines: 0 });
  const empty = f.invoke();
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /no review rounds recorded/);
  assert.match(empty.stdout, /no labels yet/);
  assert.equal(readdirSync(f.root).includes("history"), false, "reading an absent home creates nothing");
  const { rows, marks } = data();
  mkdirSync(f.ledger);
  writeFileSync(join(f.ledger, "2026-11.ndjson"), rows.map(JSON.stringify).join("\n"));
  writeFileSync(join(f.ledger, "marks.ndjson"), marks.map(JSON.stringify).join("\n"));
  const result = f.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no checker labels yet/);
  assert.match(result.stdout, /fixer marks real rate/);
  const report = JSON.parse(f.invoke("--json").stdout);
  assert.equal(report.checker.realRate, null);
  assert.equal(report.fixerMarks.realRate, 1 / 3);
});

test("accuracy rejects marks and artifact selectors instead of silently ignoring them", (t) => {
  const f = fixture(t);
  for (const args of [["--mark", "P1:real"], ["--pr", "42"], ["--file", join(f.root, "plan.md")], ["--source", KEY]]) {
    const result = f.invoke(...args);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /--accuracy reads the whole ledger/);
  }
});

test("a key shared by two repositories is warned about, and an invalid label line is counted", () => {
  const one = round(1, [finding("F1", "BLOCKER", "opus", "one.js")]);
  one.artifact = { prNumber: 42, repository: "owner/first" };
  const two = round(2, [finding("F1", "BLOCKER", "sol", "two.js")]);
  two.artifact = { prNumber: 42, repository: "owner/second" };
  const labels = [label(1, "F1", "real", "yes"), { key: KEY, round: 1, label: "real" }]; // no id
  const report = buildAccuracy(new Map([[KEY, [one, two]]]), {}, labels);
  assert.equal(report.counts.real, 1);
  assert.equal(report.unreadableLabelLines, 1);
  assert.ok(report.warnings.some((w) => w.includes("more than one repository")));
});
