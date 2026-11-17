// The old user-facing names may survive only where the rename says they do. The kept internal
// names (~/.tribunal/, tribunal.config.json, TRIBUNAL_*, the tribunal/ folder, the tribunal-proof
// and eval-data markers) never match these patterns, so they need no allowance here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const OLD_NAMES = /tribunal-review|Tribunal/; // capital T only: every kept internal name is lowercase
// References to the old plugin's install key or placeholder folder, which must keep the old name.
const COMPAT_TOKENS = /tribunal-review-moved|tribunal-review@viktorious|`tribunal-review`|"tribunal-review"/g;

// THE ALLOWLIST. Anything else that names the old product fails the test.
const WHOLE_FILES = [
  "tribunal/scripts/renameNames.test.mjs", // states the patterns it searches for
];
const WHOLE_FOLDERS = ["docs/history/", "tribunal-review-moved/"]; // historical records and migration placeholder
const REFERENCE_NOTE_HEADING = "## Internal names that keep the old name"; // to the end of docs/REFERENCE.md
const CHANGELOG_HISTORY_FROM = /^## v0\.15\.0\b/; // entries before 0.16.0 keep their history text

function allowed(file, lines, index) {
  if (WHOLE_FILES.includes(file) || WHOLE_FOLDERS.some((folder) => file.startsWith(folder))) return true;
  if (file === "README.md") {
    const start = lines.findIndex((l) => l === "## Coming from Tribunal Review");
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    return start !== -1 && index >= start && (end === -1 || index < end);
  }
  if (file === "docs/REFERENCE.md") {
    const start = lines.findIndex((l) => l.trim() === REFERENCE_NOTE_HEADING);
    return start !== -1 && index >= start;
  }
  if (file === "CHANGELOG.md") {
    const start = lines.findIndex((l) => CHANGELOG_HISTORY_FROM.test(l));
    return start !== -1 && index >= start;
  }
  return false;
}

test("the old user-facing names appear only in the allowlisted places", (t) => {
  let files;
  try { files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean); }
  catch { t.skip("not a git checkout"); return; }
  const hits = [];
  for (const file of files) {
    if (/\.(png|jpe?g|gif|ico)$/i.test(file)) continue;
    let text;
    try { text = readFileSync(resolve(ROOT, file), "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (OLD_NAMES.test(line.replace(COMPAT_TOKENS, "")) && !allowed(file, lines, index)) hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], "old name outside the allowlist");
});

// Tokenize literals, regexes and comments before looking for output calls, so source examples
// and comments are not treated as live calls. Track parentheses for multiline,
// concatenated, and nested arguments instead of stopping at the first ')'.
function messageLiterals(source) {
  const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?<=[=(:,!&|?;{}]\s*|\b(?:return|throw|case)\s+)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n[])+\/[dgimsuvy]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\b(?:console\s*\.\s*(?:log|error)|process\s*\.\s*stderr\s*\.\s*write|throw\s+new\s+Error)\s*\(|[()]/g;
  const messages = [];
  let depth = 0;
  const calls = [];
  for (const token of source.matchAll(tokens)) {
    const value = token[0];
    if (value.startsWith("/")) continue; // comments and regex literals are not output strings
    if (/^["'`]/.test(value)) {
      if (calls.length) messages.push({ value, index: token.index });
    } else if (value === ")") {
      if (calls.at(-1) === depth) calls.pop();
      depth -= 1;
    } else {
      depth += 1;
      if (value !== "(") calls.push(depth);
    }
  }
  return messages;
}

function hasLowercaseStray(value) {
  const withoutInternals = value.replace(/~?\/\.tribunal\b|\.tribunal\b|\btribunal\.config(?:\.schema)?\.json\b|\btribunal-(?:proof|wall-breakglass|reminder)\b|\bTRIBUNAL_\w*|\btribunal\//g, "");
  return /\btribunal\b/.test(withoutInternals);
}

test("lowercase product names in output literals are caught without flagging internal names", () => {
  // Negative control: these injected output strings must all be reported.
  const source = 'console.log("tribunal ready"); console.error(`tribunal failed`); process.stderr.write("tribunal" + details()); throw new Error(\'tribunal failed\');';
  assert.equal(messageLiterals(source).filter(({ value }) => hasLowercaseStray(value)).length, 4);
  assert.equal(messageLiterals('// console.log("tribunal");\nconst example = \'console.error("tribunal")\';').length, 0);
  for (const name of ["~/.tribunal", ".tribunal", "tribunal.config.json", "tribunal.config.schema.json", "tribunal-proof", "tribunal-wall-breakglass", "tribunal-reminder", "TRIBUNAL_HOME", "tribunal/scripts"]) {
    assert.equal(hasLowercaseStray(name), false, name);
    assert.equal(hasLowercaseStray(`${name}: tribunal failed`), true, name);
  }
});

test("hook and script output literals use Juryloop, except kept internal names", () => {
  const hits = [];
  for (const [folder, extension] of [["tribunal/hooks", ".js"], ["tribunal/scripts", ".mjs"]]) {
    for (const name of readdirSync(resolve(ROOT, folder)).filter((name) => name.endsWith(extension))) {
      const file = `${folder}/${name}`;
      const source = readFileSync(resolve(ROOT, file), "utf8");
      // An earlier regex/template must not swallow later output calls. Mutation:
      // append an old-name message to each real source and require its detection.
      const mutation = '\nconsole.error("tribunal injected stray");';
      assert.ok(messageLiterals(source + mutation).some(({ value }) =>
        value === '"tribunal injected stray"' && hasLowercaseStray(value)), `scanner missed mutation in ${file}`);
      for (const { value, index } of messageLiterals(source)) {
        if (hasLowercaseStray(value)) hits.push(`${file}:${source.slice(0, index).split("\n").length}: ${value}`);
      }
    }
  }
  assert.deepEqual(hits, [], "lowercase old product name in a user-facing message");
});
