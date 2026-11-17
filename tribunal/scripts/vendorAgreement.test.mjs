import test from "node:test";
import assert from "node:assert/strict";
import { loadRegistry, validateLegs } from "./registry.mjs";
import { fileURLToPath } from "node:url";
import { replayRound, replies, seats } from "./fixtures/replayRound.mjs";

test("item 6: Opus and Fable agreement is labelled Anthropic only", (t) => {
  const output = replayRound(t, { byLeg: { opus: replies.sameMaker, fable: replies.sameMaker } });
  assert.equal(output.clusters[0].crossVendor, false);
  assert.match(output.text, /Connection pool leaks handles.*Anthropic only/);
  assert.equal(output.clusters[0].severity, "SUGGESTION");
  assert.equal(output.decision.action, "CONTINUE");
});

test("item 6: Opus and ChatGPT agreement is unlabelled and listed first within its severity", (t) => {
  const combined = JSON.stringify({ findings: [
    ...JSON.parse(replies.security).findings.map((f) => ({ ...f, category: "correctness" })),
    ...JSON.parse(replies.sameMaker).findings,
  ] });
  const same = JSON.stringify({ findings: JSON.parse(replies.security).findings.map((f) => ({ ...f, category: "correctness" })) });
  const output = replayRound(t, { byLeg: { opus: combined, fable: same, sol: replies.sameMaker } });
  assert.equal(output.clusters[0].title, "Connection pool leaks handles");
  assert.equal(output.clusters[0].crossVendor, true);
  assert.equal(output.clusters[0].vendorLabel, null);
  assert.ok(output.text.indexOf("Connection pool leaks handles") < output.text.indexOf("Missing ownership check"));
  assert.doesNotMatch(output.text.split("\n").find((line) => line.includes("**Connection pool leaks handles**")), /Anthropic|OpenAI|unknown maker/);
  assert.equal(output.clusters[0].severity, "SUGGESTION");
});

test("item 6: compatible API seats declaring different makers count as cross-vendor", (t) => {
  const registry = ["Anthropic", "OpenAI"].map((vendor, i) => ({ leg: `api${i}`, id: `model${i}`, vendor,
    runner: "openai-api", billing: "metered", enabled: true, baseUrl: "https://fixture.invalid/v1",
    envKeys: ["REPLAY_API_KEY"], requiredEnv: ["REPLAY_API_KEY"] }));
  const output = replayRound(t, { registry, byLeg: { api0: replies.sameMaker, api1: replies.sameMaker } });
  assert.equal(output.clusters[0].crossVendor, true);
  assert.equal(output.clusters[0].vendorLabel, null);
  assert.deepEqual(output.clusters[0].vendors, ["Anthropic", "OpenAI"]);
});

test("a registry row with no vendor renders as unknown maker, which cannot corroborate a named maker", (t) => {
  const registry = seats.map(({ vendor, ...row }) => row);
  const unknown = replayRound(t, { registry, byLeg: { opus: replies.sameMaker, sol: replies.sameMaker } });
  assert.equal(unknown.clusters[0].crossVendor, false);
  assert.match(unknown.text, /Connection pool leaks handles.*unknown maker/);
  registry[0].vendor = "Anthropic";
  const mixed = replayRound(t, { registry, byLeg: { opus: replies.sameMaker, sol: replies.sameMaker } });
  assert.equal(mixed.clusters[0].crossVendor, false);
  assert.match(mixed.text, /Connection pool leaks handles.*Anthropic and unknown maker/);
});

test("vendor is optional but rejects non-strings and empty strings", () => {
  const { vendor, ...row } = seats[0];
  assert.deepEqual(validateLegs([row]), []);
  for (const vendor of [false, 2, null, [], {}, "", "  "]) {
    assert.ok(validateLegs([{ ...row, vendor }]).some((p) => /vendor must be a nonempty string/.test(p)));
  }
});

test("all bundled registry rows name the model maker, with an unknown maker for the unnamed API template", () => {
  const expected = { "claude-cli": "Anthropic", "codex-cli": "OpenAI", "genai-sdk": "Google", "agy-cli": "Google" };
  for (const path of ["models.default.json", "presets/claude-only.json", "presets/claude-plus-chatgpt.json", "presets/claude-plus-api-keys.json"]) {
    for (const row of loadRegistry(fileURLToPath(new URL(path, import.meta.url)))) {
      assert.equal(row.vendor, expected[row.runner], `${path}: ${row.leg}`);
    }
  }
});
