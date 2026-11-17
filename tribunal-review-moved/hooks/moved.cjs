#!/usr/bin/env node
// Standalone migration guard. Copy only the merge parser and its dependencies from
// tribunal/hooks/tribunal-reminder.js; never load the active plugin or its state.
const { readFileSync } = require("node:fs");
const MESSAGE = "Tribunal Review is now Juryloop. This old plugin no longer reviews anything, so merges are held. Run: claude plugin install juryloop@viktorious, then claude plugin uninstall tribunal-review@viktorious, and restart Claude Code. A repository that turns the plugin on in .claude/settings.json must change tribunal-review@viktorious to juryloop@viktorious.";

function shellSegments(cmd, dialect = "bash", { heredocBody = false } = {}) {
  const ps = dialect === "powershell";
  const escape = ps ? "`" : "\\";
  const s = ps ? cmd.replace(/`\r?\n/g, " ") : cmd.replace(/\\\r?\n/g, "");
  const out = [];
  let cur = heredocBody ? "\0" : "";
  // null, "'", '"', or "H": a heredoc body, which behaves like a double quote no `"` can close.
  let quote = heredocBody ? "H" : null;
  const frames = []; // one per open substitution: the piece and quote it interrupted, its closer, paren depth
  const heredocs = [];
  const cut = () => { out.push(cur); cur = ""; };
  const enter = (closer) => { frames.push({ outer: cur, quote, closer, depth: 0 }); quote = null; cur = ""; };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; cur += c; continue; }
    if (c === escape && i + 1 < s.length) { cur += c + s[i + 1]; i += 1; continue; }
    const top = frames[frames.length - 1];
    if (top && quote === null) {
      if (c === "(") { top.depth += 1; cut(); continue; }
      if (c === top.closer && (c !== ")" || top.depth === 0)) {
        frames.pop();
        quote = top.quote;
        cut();
        cur = `${top.outer}X`; // the interrupted piece resumes; X stands for the substitution's output
        continue;
      }
      if (c === ")") { top.depth -= 1; cut(); continue; }
    }
    if (c === "$" && s[i + 1] === "(") { enter(")"); i += 1; continue; }
    if (!ps && c === "`") { enter("`"); continue; }
    if (quote === '"' || quote === "H") { if (c === '"' && quote === '"') quote = null; cur += c; continue; }
    if (ps && c === "@" && (s[i + 1] === "'" || s[i + 1] === '"') && /^[ \t]*\r?\n/.test(s.slice(i + 2))) {
      // A PowerShell here-string runs to a line that starts with its closer ('@ or "@). Quotes
      // inside it are text, so an apostrophe in "it's" cannot open a quote that swallows the
      // next command. A double-quoted one still runs its $(...) substitutions.
      const closer = `\n${s[i + 1]}@`;
      const start = s.indexOf("\n", i) + 1;
      const end = s.indexOf(closer, start - 1);
      const stop = end === -1 ? s.length : end;
      if (s[i + 1] === '"') out.push(...shellSegments(s.slice(start, stop), dialect, { heredocBody: true }));
      cur += "X";
      i = end === -1 ? s.length : end + closer.length - 1;
      continue;
    }
    if (ps && c === "<" && s[i + 1] === "#") { // a PowerShell block comment
      const end = s.indexOf("#>", i + 2);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    // A comment starts only where a word can start; `${#ARRAY[@]}` is an expansion, not a comment.
    if (c === "#" && (i === 0 || /[\s;&|]/.test(s[i - 1]))) {
      // A comment: skip to the end of the line, leaving the newline to end the piece.
      const end = s.indexOf("\n", i);
      i = (end === -1 ? s.length : end) - 1;
      continue;
    }
    if (!ps && c === "<" && s[i + 1] === "<" && s[i + 2] === "<") { cur += "<<<"; i += 2; continue; } // a here-string, one word
    if (!ps && c === "<" && s[i + 1] === "<") {
      const m = /^<<(-?)\s*(\\?)(["']?)([A-Za-z0-9_.-]+)\3/.exec(s.slice(i));
      if (m) {
        heredocs.push({ word: m[4], tabs: m[1] === "-", runs: !m[2] && !m[3] });
        cur += m[0]; i += m[0].length - 1; continue;
      }
    }
    if (c === "\n" && heredocs.length) {
      // Each pending body runs through its terminating line, in order.
      cut();
      let at = i + 1;
      for (const { word, tabs, runs } of heredocs.splice(0)) {
        const body = [];
        for (;;) {
          const end = s.indexOf("\n", at);
          const line = (end === -1 ? s.slice(at) : s.slice(at, end)).replace(/\r$/, "");
          at = end === -1 ? s.length : end + 1;
          if ((tabs ? line.replace(/^\t+/, "") : line) === word) break;
          body.push(line);
          if (end === -1) break;
        }
        if (runs) out.push(...shellSegments(body.join("\n"), dialect, { heredocBody: true }));
      }
      i = at - 1;
      continue;
    }
    if ("\n\r;&|(){}".includes(c)) { cut(); continue; }
    cur += c;
  }
  cut();
  return out;
}

/**
 * What may come before `gh` in a piece that runs it: shell keywords (`if`, `then`, `!`, ...),
 * wrappers (`sudo`, `env`, `exec`, `timeout 60`, `xargs`, `nice`, `winpty`, `npx`, `cmd /c`, ...),
 * a leading redirection (`2>/dev/null`), Bash `VAR=value` and PowerShell `$out =`, then a bare,
 * full or quoted path. Case-insensitive, because Windows runs `GH` and `gh.exe` alike.
 */
const BEFORE_GH = String.raw`^\s*(?:(?:if|then|else|elif|do|while|until|!)\s+|(?:sudo|env|command|builtin|exec|time|nohup|xargs|winpty|npx)(?:\s+-\S+)*\s+|nice(?:\s+-n\s*-?\d+|\s+-(?!n\b)\S+)*\s+|timeout(?:\s+-\S+)*\s+\S+\s+|cmd(?:\.exe)?\s+\/[ck]\s+["']?|\d*[<>]+\s*\S+\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|\$[\w:]+\s*=\s*)*` +
  String.raw`(?:"[^"]*[\\/]|'[^']*[\\/]|\S*[\\/]|["'])?gh(?:\.exe)?["']?`;
/** gh's own flags may come before the subcommand: `gh -R owner/repo pr merge 7`, `--repo=x`, `-Rx`. */
const GH_FLAGS = String.raw`(?:\s+(?:-R|--repo|--hostname)(?:=|\s+)?\S+)*`;
const MERGE_SEGMENT = new RegExp(`${BEFORE_GH}${GH_FLAGS}\\s+pr\\s+merge\\b`, "i");
/**
 * The same merge through the REST API: `gh api -X PUT repos/o/r/pulls/7/merge`. Only a PUT
 * merges; a plain `gh api .../pulls/7/merge` is the read-only "is it merged?" check.
 */
/** Shell words: runs of unquoted text and quoted parts, so `k='a b'` and `"x y"` are each ONE word. */
const SHELL_WORDS = /(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g;
const API_SEGMENT = new RegExp(`${BEFORE_GH}${GH_FLAGS}\\s+api\\b`, "i");
const API_REST_MERGE = /\bpulls\/([^/\s"']+)\/merge\b/i;
/** Or through GraphQL, which names the PR by node id, never by number (anywhere in the call). */
const API_GRAPHQL_MERGE = /\bmergePullRequest\b/;

/**
 * Every merge a command runs, as PR numbers plus a count of merges that name NO number (the
 * current branch, a branch name, a variable, a GraphQL node id). The gate cannot check an
 * unnumbered merge against the ledger, so the caller blocks it as UNVERIFIED and asks for the
 * number instead of letting it pass silently.
 */
function mergesInCommand(cmd, dialect = "bash") {
  const prs = new Set();
  let unnumbered = 0;
  if (typeof cmd !== "string") return { prs: [], unnumbered };
  const VALUE_FLAGS = new Set(["-b", "--body", "-F", "--body-file", "-t", "--subject", "--match-head-commit", "--author-email", "-R", "--repo", "--hostname"]);
  for (const seg of shellSegments(cmd, dialect)) {
    if (API_SEGMENT.test(seg)) {
      // Any `gh api` call: a PUT to pulls/<x>/merge, or a mergePullRequest mutation, wherever
      // the endpoint, flags or newlines sit. A literal number is that PR; anything else
      // (`$PR`, a node id) is a merge the gate cannot check. A query read from a file is not seen.
      // The endpoint is the positional argument (quoted or not); a `-f key=value` field that
      // mentions pulls/7/merge is a value, so words carrying `=` or starting with `-` are skipped.
      const words = (seg.match(SHELL_WORDS) || []).slice(1);
      const endpoint = words
        .map((t) => t.replace(/["']/g, "").replace(/\?.*$/, ""))
        .find((t) => !t.startsWith("-") && !t.includes("=") && API_REST_MERGE.test(t));
      const rest = endpoint && endpoint.match(API_REST_MERGE);
      // gh sends a GET unless a method is given or fields are added (then POST). Only a literal
      // GET, or no method and no fields, is a read; a `$METHOD` might be PUT, so it counts.
      const method = seg.match(/(?:^|\s)(?:-X|--method)(?:=|\s+)?["']?([^\s"']+)/i);
      const fields = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:=|\s)/.test(seg);
      const mayWrite = method ? !/^GET$/i.test(method[1]) : fields;
      if (API_GRAPHQL_MERGE.test(seg)) unnumbered += 1;
      else if (mayWrite && rest && /^\d+$/.test(rest[1])) prs.add(String(Number(rest[1])));
      // A write to a merge endpoint the parser cannot pin: `pulls/$PR/merge`, or an endpoint held
      // in a variable (`"$URL"`, not a flag's value such as `--method "$METHOD"`).
      else if (mayWrite && (rest || words.some((w, i) => /^\$\{?\w+\}?$/.test(w.replace(/["']/g, ""))
        && !(words[i - 1] || "").startsWith("-")))) unnumbered += 1;
      continue;
    }
    const m = seg.match(MERGE_SEGMENT);
    if (!m) continue;
    // Arguments after THIS gh's `pr merge` (never an earlier phrase in a prefix), with a quoted
    // value kept whole so `--body "fixes 123 issues"` is one value.
    const rest = seg.slice(m[0].length).match(SHELL_WORDS) || [];
    let found = null;
    let help = false;
    for (let i = 0; i < rest.length; i += 1) {
      // A wholly quoted number is still the PR ("7"); so is the end of a quoted command
      // (`cmd /c "gh pr merge 7"` leaves `7"`). Values were already kept whole above.
      const t = rest[i].replace(/^(["'])(.*)\1$/, "$2").replace(/^(\d+)["']$/, "$1");
      if (VALUE_FLAGS.has(t)) { i += 1; continue; } // its value, even `--help`, is text
      if (t === "-h" || t === "--help") { help = true; continue; }
      if (t.startsWith("-")) continue;
      if (found !== null) continue; // the first positional argument is the PR selector, whatever it is
      const n = t.match(/^#?(\d+)$|^https?:\/\/\S+?\/pull\/(\d+)(?:[/?#]\S*)?$/);
      found = n ? String(Number(n[1] || n[2])) : "";
    }
    if (help) continue; // reading the help merges nothing
    if (found) prs.add(found);
    else unnumbered += 1;
  }
  return { prs: [...prs], unnumbered };
}

function isMerge(command, dialect) {
  const { prs, unnumbered } = mergesInCommand(command, dialect);
  return prs.length > 0 || unnumbered > 0;
}

function block() {
  process.stderr.write(MESSAGE + "\n");
  process.exitCode = 2;
}

function sessionStart() {
  // systemMessage is shown to the user; additionalContext reaches the model. Goal reviews are off
  // until the switch, so the person must see this, not only the assistant.
  console.log(JSON.stringify({ systemMessage: `${MESSAGE} Until then, goal statements are not reviewed.`,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: MESSAGE } }));
}

function malformed(raw) {
  // Decode JSON escapes even when the surrounding envelope is truncated. Do not
  // treat an unreadable/unknown command as proof that no merge was requested.
  const decoded = raw.replace(/\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/g, (escape) => JSON.parse('"' + escape + '"'));
  if (/\bgh(?:\.exe)?\b[\s\S]*?\b(?:merge|api)\b|\bmergePullRequest\b|\bpulls\/[^\s/]+\/merge\b/i.test(decoded)) return block();
  const field = raw.match(/"command"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (field) {
    try {
      const command = JSON.parse(field[1]);
      if (!isMerge(command, "bash") && !isMerge(command, "powershell")) return;
    } catch { /* Cannot establish a safe command. */ }
  }
  block();
}

function main() {
  // The registration supplies the event out of band, so malformed Stop input
  // cannot block, and SessionStart can still explain how to restore protection.
  const registeredEvent = process.argv[2];
  if (registeredEvent === "Stop") return;
  if (registeredEvent === "SessionStart") return sessionStart();
  let raw;
  try { raw = readFileSync(0, "utf8"); } catch { return block(); }
  let payload;
  try { payload = JSON.parse(raw); } catch { return malformed(raw); }
  const event = registeredEvent || payload?.hook_event_name || "PreToolUse";
  if (event === "Stop") return;
  if (event === "SessionStart") return sessionStart();
  if (event !== "PreToolUse") return;
  const tool = payload?.tool_name;
  if (tool && tool !== "Bash" && tool !== "PowerShell") return;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string") return block();
  if (isMerge(command, tool === "PowerShell" ? "powershell" : "bash")) block();
}

if (require.main === module) main();
module.exports = { mergesInCommand };
