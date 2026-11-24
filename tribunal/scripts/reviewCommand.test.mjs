// The fixer instruction in commands/review.md is the whole of DEV-1670 item 2: an agent reads it,
// no code enforces it. This fails if the instruction is deleted or loses one of its three rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const reviewMd = readFileSync(fileURLToPath(new URL("../commands/review.md", import.meta.url)), "utf8");

test("review.md tells the fixer to defer requested features but never a blocker", () => {
  const start = reviewMd.indexOf("## Fixing findings: fix the problem, defer the new feature");
  assert.ok(start >= 0, "the fixer section is missing");
  const end = reviewMd.indexOf("\n## ", start + 1);
  const section = reviewMd.slice(start, end < 0 ? undefined : end);
  assert.match(section, /SUGGESTION or NIT asks for a new capability/);
  assert.match(section, /do not build it in this pull request/);
  assert.match(section, /Work the goal asked for is not a new capability/);
  assert.match(section, /fix that defect in scope another way and defer only\s+the new capability/);
  assert.match(section, /follow-up in a pull request comment of your own/);
  assert.match(section, /BLOCKER is never deferred this way/);
  assert.match(section, /fix it, or argue it\s+false in writing/);
  assert.match(section, /round continues, and the stop-patching choice or `--override "reason"`/);
});
