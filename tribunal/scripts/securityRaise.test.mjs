import test from "node:test";
import assert from "node:assert/strict";
import { replayRound, replies, seats } from "./fixtures/replayRound.mjs";

const reply = (overrides) => JSON.stringify({ findings: JSON.parse(replies.security).findings.map((f) => ({ ...f, ...overrides })) });

function raised(output, reason, from = "SUGGESTION", to = "BLOCKER") {
  const finding = output.clusters.find((f) => f.raised);
  assert.ok(finding);
  assert.equal(finding.severity, to);
  assert.deepEqual(finding.raised, { from, to, reason, ...(reason === "cross-vendor" ? { makers: 2 } : {}) });
  assert.deepEqual(output.record.findingList.find((f) => f.raised).raised, finding.raised);
  assert.match(output.text, reason === "cross-vendor" ? /raised: security, 2 makers/ : /raised: security, judge kept/);
}

test("item 7: an Opus and ChatGPT security suggestion is raised before the stop decision", (t) => {
  const output = replayRound(t, { byLeg: { opus: replies.security, sol: replies.security } });
  raised(output, "cross-vendor");
  assert.equal(output.decision.action, "CONTINUE");
  assert.equal(output.summary.actionable[0].severity, "BLOCKER");
  assert.equal(output.record.actionableFindings[0].severity, "BLOCKER");
  assert.equal(output.judge.ran, false);
  // Two-seat suggestions already continue under the existing stop rule, even with raises off.
  const off = replayRound(t, { byLeg: { opus: replies.security, sol: replies.security }, config: { securityRaise: false } });
  assert.equal(off.clusters[0].severity, "SUGGESTION");
  assert.equal(off.clusters[0].raised, undefined);
  assert.equal(off.decision.action, "CONTINUE");
});

test("item 7: a lone security suggestion the blinded judge keeps turns QUIET into CONTINUE", (t) => {
  const byLeg = { opus: replies.security };
  const before = replayRound(t, { byLeg, config: { securityRaise: false } });
  assert.equal(before.decision.reason, "QUIET");
  const output = replayRound(t, { byLeg });
  raised(output, "judge-kept");
  assert.equal(output.decision.action, "CONTINUE");
  assert.equal(output.judgeMessage, before.judgeMessage);
  const block = /<findings>\n([\s\S]*?)\n<\/findings>/.exec(output.judgeMessage)[1];
  assert.equal(JSON.parse(block)[0].severity, "SUGGESTION");
  assert.doesNotMatch(block, /Anthropic|OpenAI|foundBy|vendor|opus|sol|raised/);
});

test("item 7: a lone security suggestion the judge demotes leaves the round QUIET", (t) => {
  const output = replayRound(t, { byLeg: { opus: replies.security }, judgeReply: replies.demote });
  assert.equal(output.decision.reason, "QUIET");
  assert.equal(output.clusters[0].severity, "SUGGESTION");
  assert.equal(output.clusters[0].raised, undefined);
  assert.doesNotMatch(output.text, /raised: security/);
  assert.equal(output.record.findingList[0].raised, undefined);
});

test("item 7: switching securityRaise off leaves a would-be CONTINUE round QUIET", (t) => {
  const byLeg = { opus: replies.security };
  const on = replayRound(t, { byLeg });
  const off = replayRound(t, { byLeg, config: { securityRaise: false } });
  assert.equal(on.decision.action, "CONTINUE");
  assert.equal(off.decision.reason, "QUIET");
  assert.equal(off.judge.kept, 1);
  assert.equal(off.clusters[0].severity, "SUGGESTION");
  assert.equal(off.clusters[0].raised, undefined);
});

test("unjudged or disabled-judge lone security findings are not raised", (t) => {
  for (const options of [{ judgeReply: replies.unjudged }, { judgeReply: "unparseable" }, { config: { judge: false } }]) {
    const output = replayRound(t, { byLeg: { opus: replies.security }, ...options });
    assert.equal(output.decision.reason, "QUIET");
    assert.equal(output.clusters[0].raised, undefined);
  }
});

test("security raises exactly one rung, with no raise above BLOCKER", (t) => {
  for (const severity of ["NIT", "SUGGESTION", "BLOCKER"]) {
    const output = replayRound(t, { byLeg: { opus: reply({ severity }), sol: reply({ severity }) } });
    if (severity === "BLOCKER") assert.equal(output.clusters[0].raised, undefined);
    else raised(output, "cross-vendor", severity, severity === "NIT" ? "SUGGESTION" : "BLOCKER");
  }
});

test("same-maker or unknown-maker agreement cannot raise security without a judge keep", (t) => {
  const same = replayRound(t, { byLeg: { opus: replies.security, fable: replies.security } });
  assert.equal(same.clusters[0].severity, "SUGGESTION");
  assert.equal(same.clusters[0].raised, undefined);
  const registry = seats.map(({ vendor, ...row }) => row);
  registry[0].vendor = "Anthropic";
  const unknown = replayRound(t, { registry, byLeg: { opus: replies.security, sol: replies.security } });
  assert.equal(unknown.clusters[0].raised, undefined);
});

test("non-security findings remain unchanged even when the judge keeps them or makers agree", (t) => {
  const kept = replayRound(t, { byLeg: { opus: replies.sameMaker } });
  assert.equal(kept.judge.kept, 1);
  assert.equal(kept.decision.reason, "QUIET");
  const agreed = replayRound(t, { byLeg: { opus: replies.sameMaker, sol: replies.sameMaker } });
  for (const output of [kept, agreed]) {
    assert.equal(output.clusters[0].severity, "SUGGESTION");
    assert.equal(output.clusters[0].raised, undefined);
  }
});

test("raises preserve judge ids through severity reordering and duplicate titles", (t) => {
  const output = replayRound(t, { byLeg: { opus: JSON.stringify({ findings: [
    ...JSON.parse(reply({ file: "first.js" })).findings,
    ...JSON.parse(reply({ file: "second.js" })).findings,
  ] }) }, judgeReply: JSON.stringify({ findings: [
    { id: "F1", verdict: "demote", why: "Handled in first.js." },
    { id: "F2", verdict: "keep", why: "Missing in second.js." },
  ] }) });
  assert.equal(output.clusters[0].file, "second.js");
  assert.equal(output.record.findingList[0].judgeId, "F2");
  assert.equal(output.record.findingList[1].judgeId, "F1");
  assert.match(output.text, /Missing ownership check.*judge: keep: Missing in second.js.*raised: security, judge kept/);
  assert.match(output.text, /Missing ownership check.*judge: likely false positive: Handled in first.js/);
});

test("the tenth round still stops at the ceiling after a security raise", (t) => {
  const output = replayRound(t, { byLeg: { opus: replies.security }, round: 10 });
  raised(output, "judge-kept");
  assert.equal(output.decision.action, "STOP");
  assert.equal(output.decision.reason, "CEILING");
});

test("a later seat classifying a merged finding as security is not lost", (t) => {
  const output = replayRound(t, { byLeg: { opus: reply({ category: "correctness" }), sol: replies.security } });
  raised(output, "cross-vendor");
});

test("an advisory seat cannot supply cross-vendor corroboration for a raise", (t) => {
  const registry = seats.map((row) => ({ ...row, advisory: row.leg === "sol" }));
  const output = replayRound(t, { registry, byLeg: { opus: replies.security, sol: replies.security }, config: { judge: false } });
  assert.equal(output.clusters[0].crossVendor, false);
  assert.equal(output.clusters[0].raised, undefined);
  assert.equal(output.decision.reason, "QUIET");
});
