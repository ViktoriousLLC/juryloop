#!/usr/bin/env node
// Append-only review evidence and operator marks, joined without changing earlier problem IDs.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sameIssue } from "./panelLogic.mjs";
import { artifactHistory, artifactKey, readLedgerRows } from "./ledger.mjs";
import { resolvePolicy } from "./policy.mjs";

const SEVERITY_RANK = { BLOCKER: 3, SUGGESTION: 2, NIT: 1 };
const union = (a, b) => [...new Set([...a, ...b])];

function addEvidence(problem, finding, round, verdicts) {
  if ((SEVERITY_RANK[finding.severity] || 0) > (SEVERITY_RANK[problem.severity] || 0)) problem.severity = finding.severity;
  problem.foundBy = union(problem.foundBy, finding.foundBy || []);
  if (!problem.rounds.includes(round)) {
    problem.rounds.push(round);
    problem.findings.push({ round, id: finding.id });
  }
  problem.judgeVerdicts.push(...verdicts.map((verdict) => ({ ...verdict, round })));
}

function latestMarks(marks) {
  return new Map(marks.map((mark) => [mark.id, mark]));
}

function duplicateRoot(id, marks, valid) {
  const seen = new Set();
  while (typeof marks.get(id)?.verdict === "string" && marks.get(id).verdict.startsWith("duplicate:")) {
    if (seen.has(id)) throw new Error("duplicate marks must not form a cycle");
    seen.add(id);
    id = marks.get(id).verdict.slice("duplicate:".length);
    if (!valid.has(id)) throw new Error(`unknown duplicate target ${id}; valid ids: ${[...valid].join(", ")}`);
  }
  return id;
}

export function buildScorecard(rows, marks = []) {
  const complete = rows.filter((row) => !["PARTIAL", "UNREADABLE"].includes(row.decision?.reason));
  const models = new Map(), problems = [];
  let total = 0, legacyRounds = 0;
  for (const [index, row] of complete.entries()) {
    for (const leg of row.legs || []) {
      if (!models.has(leg.leg)) models.set(leg.leg, { models: [], found: 0, inProblems: 0, sole: 0, real: 0, notReal: 0 });
      const model = models.get(leg.leg);
      if (leg.model) model.models = union(model.models, [leg.model]);
      model.found += leg.findings || 0;
      total += leg.findings || 0;
    }
    if (!Array.isArray(row.findingList)) { legacyRounds += 1; continue; }
    const round = row.runnerRound ?? row.round ?? index + 1;
    for (const finding of row.findingList) {
      let problem = problems.find((entry) => sameIssue(entry, finding));
      if (!problem) {
        problem = { id: `P${problems.length + 1}`, title: finding.title, severity: finding.severity,
          file: finding.file, rounds: [], foundBy: [], findings: [], judgeVerdicts: [],
          ...(finding.kind ? { kind: finding.kind } : {}),
          ...(finding.kind === "missing-work" ? { goalItem: finding.goalItem } : {}) };
        problems.push(problem);
      }
      const judgeId = Object.hasOwn(finding, "judgeId") ? finding.judgeId : finding.id;
      const verdicts = (row.judge?.verdicts || []).filter((verdict) => judgeId != null && verdict.id === judgeId);
      addEvidence(problem, finding, round, verdicts);
    }
  }
  const latest = latestMarks(marks), valid = new Set(problems.map((problem) => problem.id));
  const roots = new Map(), warnings = [];
  for (const problem of problems) {
    const mark = latest.get(problem.id);
    if (mark && Object.hasOwn(mark, "title") && mark.title !== problem.title) {
      warnings.push(`${problem.id}: marked "${mark.title}" but ${problem.id} is now "${problem.title}"; re-mark it`);
    }
    let root = problem.id, invalid = false;
    try { root = duplicateRoot(problem.id, latest, valid); }
    catch (error) {
      invalid = true;
      warnings.push(`${problem.id}: ${error.message}; left unmarked and unfolded; re-mark it`);
    }
    roots.set(problem.id, root);
    problem.verdict = invalid ? null : mark?.verdict ?? null;
    problem.why = invalid ? "" : mark?.why ?? "";
    problem.duplicateOf = root === problem.id ? null : root;
  }
  const folded = new Map();
  for (const problem of problems) {
    const root = roots.get(problem.id);
    if (!folded.has(root)) {
      const target = problems.find((entry) => entry.id === root);
      folded.set(root, { ...target, rounds: [], foundBy: [], findings: [], judgeVerdicts: [],
        duplicateOf: null });
    }
    const target = folded.get(root);
    if ((SEVERITY_RANK[problem.severity] || 0) > (SEVERITY_RANK[target.severity] || 0)) target.severity = problem.severity;
    target.rounds = union(target.rounds, problem.rounds);
    target.foundBy = union(target.foundBy, problem.foundBy);
    target.findings.push(...problem.findings);
    target.judgeVerdicts.push(...problem.judgeVerdicts);
  }
  const active = [...folded.values()];
  const count = (verdict) => active.filter((problem) => problem.verdict === verdict).length;
  const judge = { demotedButReal: 0, keptButNotReal: 0, demotedAndNotReal: 0, keptAndReal: 0, unmarked: 0 };
  for (const problem of active) {
    for (const leg of problem.foundBy) {
      const model = models.get(leg);
      if (!model) continue;
      model.inProblems += 1;
      if (problem.foundBy.length === 1) model.sole += 1;
      if (problem.verdict === "real") model.real += 1;
      if (problem.verdict === "not-real") model.notReal += 1;
    }
    const verdicts = new Set(problem.judgeVerdicts.map((entry) => entry.verdict));
    if (!verdicts.has("demote") && !verdicts.has("keep")) continue;
    if (problem.verdict === "real") {
      if (verdicts.has("demote")) judge.demotedButReal += 1;
      if (verdicts.has("keep")) judge.keptAndReal += 1;
    } else if (problem.verdict === "not-real") {
      if (verdicts.has("demote")) judge.demotedAndNotReal += 1;
      if (verdicts.has("keep")) judge.keptButNotReal += 1;
    } else judge.unmarked += 1;
  }
  return { rounds: rows.length, complete: complete.length, skipped: rows.length - complete.length,
    total, legacyRounds, uniqueNote: legacyRounds ? `unique: not recorded for ${legacyRounds} round(s) banked before v0.13` : null,
    unique: active.length, real: count("real"), notReal: count("not-real"), unsure: count("unsure"),
    unmarked: count(null), marked: active.length - count(null), models: Object.fromEntries(models),
    problems, activeProblems: active, judge, warnings };
}

export function renderScorecard(card) {
  if (!card.rounds) return "PR scorecard: no review rounds are recorded under this key. Use the selector the runner printed after the round, or the exact --pr / --file you reviewed.";
  const lines = [`PR scorecard: ${card.rounds} rounds, ${card.complete} complete; ${card.skipped} incomplete skipped`,
    "model | found | unique | sole | real | not real"];
  for (const [leg, model] of Object.entries(card.models)) {
    lines.push(`${leg}${model.models.length ? ` (${model.models.join(", ")})` : ""} | ${model.found} | ${model.inProblems} | ${model.sole} | ${model.real} | ${model.notReal}`);
  }
  lines.push(`Totals: ${card.total} findings, ${card.unique} unique problems, ${card.real} real, ${card.notReal} not real, ${card.unsure} unsure, ${card.unmarked} unmarked`);
  if (card.uniqueNote) lines.push(card.uniqueNote);
  const j = card.judge;
  lines.push(`Judge: ${j.demotedButReal} demoted-but-real (Judge wrong), ${j.keptButNotReal} kept-but-not-real, ${j.demotedAndNotReal} demoted-and-not-real, ${j.keptAndReal} kept-and-real, ${j.unmarked} unmarked/unsure`);
  for (const warning of card.warnings) lines.push(`Warning: ${warning}`);
  for (const problem of card.activeProblems.filter((entry) => entry.verdict === null)) {
    lines.push(`${problem.id} [${problem.severity}] ${problem.title} (${problem.file || "no file"}) - found by ${problem.foundBy.join(", ")}`);
  }
  return lines.join("\n");
}

// labels.ndjson: one {key, round, id: "F<n>", label: "real" | "not-real" |
// "cannot-check" | "unsure" | "retry", worth: "yes" | "no" | "unknown",
// votes: [vote with evidence, ...], models: [model id, ...], promptVersion: string} per line.
// The last (key, round, id) wins; a cut-off JSON line, or a parsed line without a valid key, round,
// id and label, is counted as unreadable and skipped.
export function readLabels(ledgerHome) {
  let text;
  try { text = readFileSync(join(ledgerHome, "labels.ndjson"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { entries: [], unreadableLines: 0 }; throw error; }
  const entries = [];
  let unreadableLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch { unreadableLines += 1; }
  }
  return { entries, unreadableLines };
}

const FINAL_LABELS = new Set(["real", "not-real"]);
const CHECKER_LABELS = new Set([...FINAL_LABELS, "unsure", "cannot-check", "retry"]);
const entriesOf = (groups) => groups instanceof Map ? [...groups] : Object.entries(groups);
const getGroup = (groups, key) => groups instanceof Map ? groups.get(key) : groups[key];
const labelKey = (key, round, id) => JSON.stringify([key, round, id]);
const accuracyGroup = () => ({ problems: 0,
  checker: { labelled: 0, real: 0, realWorthYes: 0, realRate: null },
  // Fixer marks do not record worth. Never infer it from a checker label or a fix.
  fixerMarks: { labelled: 0, real: 0, realWorthYes: null, realRate: null } });

function countAccuracy(group, problem, label) {
  group.problems += 1;
  for (const [stats, verdict] of [[group.checker, label?.label], [group.fixerMarks, problem.verdict]]) {
    if (FINAL_LABELS.has(verdict)) stats.labelled += 1;
    if (verdict === "real") stats.real += 1;
    stats.realRate = stats.labelled ? stats.real / stats.labelled : null;
  }
  if (label?.label === "real" && label.worth === "yes") group.checker.realWorthYes += 1;
}

/** Pure aggregation; groups can be Maps or objects. Labels are an array or readLabels' result. */
export function buildAccuracy(rowsByKey, marksByKey = {}, labels = []) {
  const latest = new Map();
  let invalidLabelLines = 0;
  for (const [index, label] of (Array.isArray(labels) ? labels : labels.entries).entries()) {
    if (typeof label?.key !== "string" || !Number.isSafeInteger(label.round)
      || typeof label.id !== "string" || !CHECKER_LABELS.has(label.label)) { invalidLabelLines += 1; continue; }
    latest.set(labelKey(label.key, label.round, label.id), { ...label, index });
  }
  const report = { rounds: 0, complete: 0, skipped: 0, legacyRounds: 0,
    counts: { total: 0, labelled: 0, real: 0, notReal: 0, unsure: 0, cannotCheck: 0, retry: 0, unlabelled: 0 },
    ...accuracyGroup(), bySeverity: {}, bySeat: {},
    byJudge: Object.fromEntries(["kept", "demoted", "not judged"].map((name) => [name, accuracyGroup()])),
    unreadableLabelLines: (Array.isArray(labels) ? 0 : labels.unreadableLines) + invalidLabelLines,
    warnings: [] };
  const severities = new Map(), seats = new Map(), times = new Map();
  const ensure = (map, key) => {
    if (!map.has(key)) map.set(key, accuracyGroup());
    return map.get(key);
  };
  for (const [key, rows] of entriesOf(rowsByKey)) {
    const card = buildScorecard(rows, getGroup(marksByKey, key) || []);
    for (const field of ["rounds", "complete", "skipped", "legacyRounds"]) report[field] += card[field];
    report.warnings.push(...card.warnings.map((warning) => `${key}: ${warning}`));
    // Timing includes failed/incomplete rounds too; missing and null never become zero.
    for (const row of rows) for (const leg of row.legs || []) {
      ensure(seats, leg.leg);
      if (!times.has(leg.leg)) times.set(leg.leg, []);
      if (Number.isFinite(leg.elapsedMs) && leg.elapsedMs >= 0) times.get(leg.leg).push(leg.elapsedMs);
    }
    // A ledger home is one repository, and Juryloop keys every history by pr:<n> inside it. A
    // --repo round of another repository's PR with the same number therefore merges with this
    // one here exactly as it does in the runner's own history (a known limit, see REFERENCE).
    // Say so rather than report it as one repository's numbers.
    const repositories = new Set(rows.map((row) => row.artifact?.repository).filter(Boolean));
    if (repositories.size > 1) report.warnings.push(`${key}: rounds from more than one repository (${[...repositories].join(", ")}) share this key, so their numbers are merged`);
    for (const problem of card.activeProblems) {
      const label = problem.findings.map(({ round, id }) => latest.get(labelKey(key, round, id)))
        .filter(Boolean).sort((a, b) => b.round - a.round || b.index - a.index)[0];
      const counts = report.counts;
      counts.total += 1;
      if (FINAL_LABELS.has(label?.label)) {
        counts.labelled += 1;
        counts[label.label === "real" ? "real" : "notReal"] += 1;
      } else counts[label?.label === "cannot-check" ? "cannotCheck" : label?.label || "unlabelled"] += 1;
      countAccuracy(report, problem, label);
      countAccuracy(ensure(severities, problem.severity || "not recorded"), problem, label);
      for (const seat of problem.foundBy) countAccuracy(ensure(seats, seat), problem, label);
      const calls = new Set(problem.judgeVerdicts.map((entry) => entry.verdict)
        .filter((verdict) => verdict === "keep" || verdict === "demote"));
      // Match the scorecard: at most once per call type, even across repeated rounds.
      for (const call of calls.size ? calls : [null]) {
        countAccuracy(report.byJudge[call === "keep" ? "kept" : call === "demote" ? "demoted" : "not judged"], problem, label);
      }
    }
  }
  report.bySeverity = Object.fromEntries(severities);
  report.bySeat = Object.fromEntries([...seats].map(([seat, group]) => {
    const values = (times.get(seat) || []).sort((a, b) => a - b), middle = Math.floor(values.length / 2);
    const medianElapsedMs = !values.length ? null : values.length % 2 ? values[middle]
      : (values[middle - 1] + values[middle]) / 2;
    return [seat, { ...group, medianElapsedMs }];
  }));
  return report;
}

export function renderAccuracy(report) {
  const lines = [];
  if (!report.rounds) lines.push("no review rounds recorded", "no labels yet");
  else {
    lines.push(`Accuracy: ${report.rounds} rounds, ${report.complete} complete; ${report.skipped} incomplete skipped`);
    const c = report.counts;
    lines.push(`Problems: ${c.total} total, ${c.labelled} labelled (${c.real} real / ${c.notReal} not-real), ${c.unsure} unsure, ${c.cannotCheck} cannot-check, ${c.retry} retry, ${c.unlabelled} unlabelled`);
    if (c.total === c.unlabelled) lines.push("no checker labels yet");
    if (report.legacyRounds) lines.push(`unique: not recorded for ${report.legacyRounds} round(s) without finding lists`);
    const rate = (value) => value === null ? "not recorded" : `${(value * 100).toFixed(1)}%`;
    const cells = (group) => [group.problems, group.checker.labelled, group.checker.real,
      group.checker.realWorthYes, rate(group.checker.realRate), group.fixerMarks.labelled,
      group.fixerMarks.real, "not recorded", rate(group.fixerMarks.realRate)].join(" | ");
    const header = "problems | checker labelled | checker real | checker real & worth yes | checker real rate | fixer marks labelled | fixer marks real | fixer marks real & worth yes | fixer marks real rate";
    for (const [name, groups] of [["severity", report.bySeverity], ["seat", report.bySeat], ["judge call", report.byJudge]]) {
      lines.push("", `${name} | ${header}`);
      for (const [value, group] of Object.entries(groups)) lines.push(`${value} | ${cells(group)}`);
    }
    lines.push("", "seat | median elapsedMs");
    for (const [seat, group] of Object.entries(report.bySeat)) lines.push(`${seat} | ${group.medianElapsedMs ?? "not recorded"}`);
    lines.push("Fixer marks do not record worth. Rates use only real / not-real; unsure is excluded.");
    lines.push("A problem can count under multiple seats or judge call types, once per group.");
  }
  if (report.unreadableLabelLines) lines.push(`${report.unreadableLabelLines} unreadable label line(s) skipped`);
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

export function readMarks(ledgerHome, key) {
  let text;
  try { text = readFileSync(join(ledgerHome, "marks.ndjson"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return text.split("\n").filter((line) => line.trim()).flatMap((line) => {
    // A row without a string id and verdict is not a mark; skipping it keeps one bad line from
    // breaking the scorecard or blocking the correction that would replace it.
    try {
      const mark = JSON.parse(line);
      return typeof mark?.key === "string" && (key === undefined || mark.key === key)
        && typeof mark.id === "string" && typeof mark.verdict === "string"
        && /^(?:real|not-real|unsure|duplicate:P[1-9]\d*)$/.test(mark.verdict) ? [mark] : [];
    }
    catch { return []; } // A partial final append does not hide earlier marks.
  });
}

export function parseMark(text) {
  const match = /^(P[1-9]\d*):(real|not-real|unsure|duplicate=P[1-9]\d*)(?::([\s\S]*))?$/.exec(text);
  if (!match) throw new Error("mark must be P<n>:real|not-real|duplicate=P<n>|unsure[:why]");
  const verdict = match[2].replace("duplicate=", "duplicate:"), why = (match[3] || "").trim();
  if ((verdict === "not-real" || verdict.startsWith("duplicate:")) && !why) throw new Error(`${verdict} requires a why reason`);
  return { id: match[1], verdict, why };
}

export function validateMarks(card, additions, stored = []) {
  const valid = new Set(card.problems.map((problem) => problem.id));
  for (const mark of additions) {
    if (!valid.has(mark.id)) throw new Error(`unknown id ${mark.id}; valid ids: ${[...valid].join(", ") || "none"}`);
    parseMark(`${mark.id}:${mark.verdict.replace("duplicate:", "duplicate=")}:${mark.why || ""}`);
    if (mark.verdict.startsWith("duplicate:") && !valid.has(mark.verdict.slice("duplicate:".length))) {
      throw new Error(`unknown duplicate target ${mark.verdict.slice("duplicate:".length)}; valid ids: ${[...valid].join(", ")}`);
    }
  }
  // Refuse only a cycle THIS addition closes. A broken stored chain (a cycle or a missing target
  // that an older mark left) just ends the walk, so it can never block a correction.
  const latest = latestMarks([...stored, ...additions]);
  for (const mark of additions) {
    const seen = new Set([mark.id]);
    let id = mark.id;
    while (typeof latest.get(id)?.verdict === "string" && latest.get(id).verdict.startsWith("duplicate:")) {
      id = latest.get(id).verdict.slice("duplicate:".length);
      if (id === mark.id) throw new Error(`${mark.id}: duplicate marks must not form a cycle`);
      if (seen.has(id) || !valid.has(id)) break;
      seen.add(id);
    }
  }
}

export function scorecardRunningLine(card, artifact) {
  const label = artifact.prNumber != null ? `PR #${artifact.prNumber}` : artifact.title || artifact.source || "artifact";
  const key = artifactKey(artifact);
  const selector = artifact.prNumber != null ? `--pr ${artifact.prNumber}`
    // PowerShell also closes a single-quoted string on the typographic quotes U+2018 to U+201B.
    : /['‘-‛\r\n]/.test(key) ? null : `--source '${key}'`;
  const command = selector === null ? "(the key contains a quote, so type its selector by hand)"
    // The full path: reviews run from the reviewed repository, not from this plugin's folder.
    : `(node "${fileURLToPath(import.meta.url)}" ${selector})`;
  return `[scorecard] ${label} so far: ${card.total} findings, ${card.unique} unique problems, ${card.marked} of ${card.unique} marked ${command}${card.uniqueNote ? `; ${card.uniqueNote}` : ""}`;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = {}, markTexts = [];
    for (let i = 0; i < argv.length; i += 1) {
      const name = argv[i];
      if (name === "--json") { options.json = true; continue; }
      if (name === "--accuracy") { options.accuracy = true; continue; }
      if (!["--pr", "--file", "--source", "--mark"].includes(name)) throw new Error(`unknown argument: ${name}`);
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--")) throw new Error(`${name} requires a value`);
      if (name === "--mark") markTexts.push(value);
      else {
        if (options[name]) throw new Error(`${name} may only be given once`);
        options[name] = value;
      }
    }
    if (options.accuracy) {
      if (markTexts.length || ["--pr", "--file", "--source"].some((key) => options[key])) {
        throw new Error("--accuracy reads the whole ledger; do not combine it with selectors or --mark");
      }
      const { ledgerHome } = resolvePolicy(process.cwd());
      const groupByKey = (items, keyOf) => {
        const groups = new Map();
        for (const item of items) {
          const key = keyOf(item);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(item);
        }
        return groups;
      };
      const report = buildAccuracy(groupByKey(readLedgerRows(ledgerHome), (row) => artifactKey(row.artifact)),
        groupByKey(readMarks(ledgerHome), (mark) => mark.key), readLabels(ledgerHome));
      console.log(options.json ? JSON.stringify(report, null, 2) : renderAccuracy(report));
      return;
    }
    if (["--pr", "--file", "--source"].filter((key) => options[key]).length !== 1) throw new Error("give exactly one of --pr <n>, --file <path>, or --source <kind:source>");
    let artifact;
    if (options["--pr"]) {
      if (!/^[1-9]\d*$/.test(options["--pr"]) || !Number.isSafeInteger(Number(options["--pr"]))) throw new Error("--pr requires a positive integer");
      artifact = { prNumber: Number(options["--pr"]) };
    } else if (options["--file"]) artifact = { kind: "document", source: options["--file"] };
    else {
      const source = options["--source"];
      // Two letters or more: a bare `c:\notes\a.md` is a drive letter, not an artifact kind.
      const match = /^([a-z]{2,}):([\s\S]*)$/.exec(source);
      artifact = match ? { kind: match[1], source: match[2] } : { kind: "document", source };
    }
    const policy = resolvePolicy(process.cwd()), key = artifactKey(artifact);
    const rows = artifactHistory(artifact, policy.ledgerHome), marks = readMarks(policy.ledgerHome, key);
    let card = buildScorecard(rows, marks);
    const additions = markTexts.map((text) => {
      const mark = parseMark(text);
      return { ts: new Date().toISOString(), key, ...mark,
        title: card.problems.find((problem) => problem.id === mark.id)?.title };
    });
    if (additions.length) {
      validateMarks(card, additions, marks);
      card = buildScorecard(rows, [...marks, ...additions]);
      mkdirSync(policy.ledgerHome, { recursive: true });
      const marksPath = join(policy.ledgerHome, "marks.ndjson");
      let leading = "";
      try { if (!readFileSync(marksPath, "utf8").endsWith("\n")) leading = "\n"; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      appendFileSync(marksPath, leading + additions.map((mark) => JSON.stringify(mark)).join("\n") + "\n", "utf8");
    }
    console.log(options.json ? JSON.stringify(card, null, 2) : renderScorecard(card));
  } catch (error) { console.error(`scorecard: ${error.message}`); process.exitCode = 4; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
