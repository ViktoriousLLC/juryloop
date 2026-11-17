// Local files and pasted text need the same protected review boundary as PRs.
//
// An artifact can be a PR diff, a file, or pasted text. Each source is converted to the
// same input shape so all three receive the same review protections.
//
// PRs read GitHub metadata and local git objects; files read the named local path.

import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, posix } from "node:path";

export const MAX_CHARS_DEFAULT = 500_000;
export const GH_MISSING_MESSAGE = "`gh` is not on PATH; --pr and proof posting need the GitHub CLI; --file and --stdin do not";

/**
 * Secrets are redacted from the FULL text BEFORE truncation.
 *
 * The order is the point and it is not stylistic: truncate first and a secret straddling the
 * boundary has its tail escape masking.
 */
// NO LEADING \b ON THE PREFIXED PATTERNS. `\b` needs a non-word character before the prefix, so a key
// embedded in a run of word characters — inside a base64 blob, a URL path, a minified line —
// would be left in the clear and then sliced by the truncator. A redactor that only works on
// well-spaced input is a redactor that fails on exactly the inputs worth worrying about.
const REDACTIONS = [
  [/(sk-[A-Za-z0-9_-]{16,})/g, "sk-REDACTED"],
  [/(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "gh-REDACTED"],
  [/(AIza[0-9A-Za-z_-]{30,})/g, "AIza-REDACTED"],
  [/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "jwt-REDACTED"],
  // The value may not contain brackets or parentheses, and it must end at a real terminator. A
  // secret never contains either, and code does: a looser rule rewrites an expression such as
  // `const someToken = [encode(header), ...]` mid-line, and every leg then reports the runner's own
  // edit as a syntax error in the author's code. The lookahead stops the regex from backtracking
  // into the first letters of a call like `getAccessToken(...)`. The replacement names the runner,
  // so a leg that does see one cannot mistake it for the author's text.
  [/((?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*["']?)([^\s"',;()[\]{}<>]{12,})(?![^\s"',;()[\]{}<>]|[([{])/gi, "$1[secret removed by the review runner]"],
];

export function redactSensitive(text) {
  let out = String(text ?? "");
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

/**
 * Authorship trailers are stripped so no leg can infer who wrote the thing it is grading.
 * Model names, vendors and ticket ids SURVIVE: in this repo they are routinely the subject
 * matter under review, and stripping them would blind the panel to what it is looking at.
 */
export function stripAuthorshipSignals(text) {
  return String(text ?? "")
    .replace(/^\s*Co-Authored-By:.*$/gim, "")
    .replace(/^\s*Claude-Session:.*$/gim, "")
    .replace(/^\s*🤖 Generated with \[Claude Code\].*$/gim, "")
    .replace(/^\s*https:\/\/claude\.ai\/code\/session_\S*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Neutralise a block's own boundary TAGS — opening and closing — so crafted content cannot forge
 * the structure it sits inside.
 *
 * The invariant:
 * every character survives byte-identical EXCEPT the two angle brackets of a sequence that is a
 * boundary tag for this block. An artifact that discusses these tag names by name therefore does
 * see those two characters escaped. The insides of a matched tag, whitespace included,
 * are left exactly as they were.
 *
 * Blanket substitution of `<` and `>` with lookalikes U+2039 and U+203A would corrupt
 * source: `status >= 500`, `<<'EOF'`, and `Array<string>` must remain byte-identical.
 * Such corruption can also alter quotations of the defect in review input, so
 * `artifact.test.mjs` exercises the transformation directly and compares code points.
 *
 * `tag` is REQUIRED and a missing one throws rather than returning the text unprotected: a
 * boundary function that silently does nothing is the failure mode worth being loud about.
 */
export function neutralizeTag(text, tag) {
  const name = String(tag ?? "");
  if (!name) throw new Error("neutralizeTag needs the tag it is protecting; refusing to return unprotected text");
  // The tag is interpolated into a RegExp, so it is escaped. Today it is always one of our own
  // literals, and that is exactly the assumption worth not depending on.
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Models read whitespace/case/invisible-separator variants as boundaries too. Escape
  // only the angle brackets of boundary openers and closers, leaving their contents and
  // every ordinary source-code character untouched. An entity is clearer than a backslash
  // escape to a model reader. The separator class covers whitespace and Unicode format
  // characters without an ever-growing enumeration of code points.
  //
  // This is defense in depth: attributes and self-closing forms are not matched, and no
  // textual escape is provably inert to a language-model reader. Findings remain data;
  // they never authorize a merge, write or deploy on their own.
  const SEP = "[\\p{White_Space}\\p{Cf}]*";
  return String(text ?? "")
    .replace(new RegExp(`<(${SEP}/${SEP}${safeName}${SEP})>`, "giu"), "&lt;$1&gt;")
    .replace(new RegExp(`<(${SEP}${safeName}${SEP})>`, "giu"), "&lt;$1&gt;");
}

/**
 * Wrap an artifact for a reviewer.
 *
 * Redact, then strip authorship, then neutralise, THEN truncate. A partial read is announced
 * in the text itself, because an empty finding list on a truncated artifact means very little
 * and the reader has no other way to know.
 */
export function buildUserMessage(artifact, { maxChars = MAX_CHARS_DEFAULT } = {}) {
  const kind = artifact.kind || "artifact";
  const tags = [kind, `${kind}_title`, ...(artifact.goal ? ["goal", "goal_context"] : [])];
  const shield = (text) => tags.reduce((out, tag) => neutralizeTag(out, tag), text);
  const safe = shield(stripAuthorshipSignals(redactSensitive(artifact.text)));
  const truncated = safe.length > maxChars;
  const body = truncated ? safe.slice(0, maxChars) : safe;
  const pct = truncated ? Math.floor((maxChars / safe.length) * 100) : 100;
  const header = truncated
    ? `PARTIAL: only the first ${pct}% of this ${kind} is below. An empty finding list covers ONLY the part you were shown.`
    : "";
  return [
    header,
    `<${kind}_title>${shield(artifact.title || basename(artifact.source || "artifact"))}</${kind}_title>`,
    `<${kind}>`,
    body,
    `</${kind}>`,
    ...(artifact.goal ? [
      artifact.goal.item == null
        ? "Check the diff against the goal. All missing-work findings are suggestions and never block. Check unrequested scope against the whole goal."
        : `Check missing work for item ${artifact.goal.item} ONLY; do not report missing work for any other item. Check unrequested scope against the whole goal.`,
      `<goal_context>${shield(redactSensitive(JSON.stringify(goalContext(artifact.goal))))}</goal_context>`,
      "<goal>", shield(stripAuthorshipSignals(redactSensitive(artifact.goal.text))), "</goal>",
    ] : []),
  ].filter(Boolean).join("\n");
}

export function goalContext({ text, ...context }) { return context; }

const MAX_GOAL_BYTES = 50 * 1024;
export const safeGitPath = (path) => typeof path === "string" && path.length > 0
  && !/^[\\/]|^[a-z]:/i.test(path) && !/[\0\r\n]/.test(path)
  && !path.replaceAll("\\", "/").split("/").includes("..");

function readPrGoal(meta, exec) {
  // Goal context is optional. Keep failures separate from the artifact so reviewers
  // still receive the diff, while the report and ledger can explain the omission.
  try { return resolvePrGoal(meta, exec); }
  catch (error) {
    return { refused: true, reason: error instanceof GoalRefusal ? error.message : "goal could not be resolved from the local git trees" };
  }
}

class GoalRefusal extends Error {}

export function gitEntryAt(git, tree, name) {
  const row = git(["ls-tree", "-z", "--full-tree", tree, "--", name]).split("\0")
    .find((row) => row.slice(row.indexOf("\t") + 1) === name);
  if (!row) return null;
  const [mode, type, oid] = row.slice(0, row.indexOf("\t")).split(" ");
  return { mode, type, oid };
}

function prMergeBase(head, base, git) {
  if (![head, base].every((oid) => typeof oid === "string" && /^[a-f0-9]{40,64}$/i.test(oid))) throw new GoalRefusal("PR head and base commit IDs are required");
  try {
    git(["cat-file", "-e", `${head}^{commit}`]);
    git(["cat-file", "-e", `${base}^{commit}`]);
    const mergeBase = git(["merge-base", base, head]).trim();
    if (!/^[a-f0-9]{40,64}$/i.test(mergeBase)) throw new Error("no merge base");
    return mergeBase;
  } catch { throw new GoalRefusal("PR head or merge base is unavailable locally; fetch the PR head and base branch (and deepen shallow history), then retry"); }
}

function relativeToRepository(root, absolutePath) {
  const path = relative(root, absolutePath);
  if (safeGitPath(path || ".")) return path;
  // Git expands repository aliases (including Windows 8.3 names). Locate the
  // same root in the configured path, preserving the suffix as a Git tree path.
  // Do not realpath the whole goalsDir: it need not exist in the working tree.
  const canonicalRoot = realpathSync.native(root);
  for (let ancestor = absolutePath; ; ancestor = dirname(ancestor)) {
    try {
      if (relative(canonicalRoot, realpathSync.native(ancestor)) === "") return relative(ancestor, absolutePath);
    } catch { /* An absent working-tree ancestor does not affect the committed goal. */ }
    if (dirname(ancestor) === ancestor) return path;
  }
}

function goalsDirAt(mergeBase, git) {
  const refuse = (why) => { throw new GoalRefusal(why); };
  let goalsDir = "docs/reference/goals";
  const configEntry = gitEntryAt(git, mergeBase, "tribunal.config.json");
  if (configEntry) {
    if (!["100644", "100755"].includes(configEntry.mode) || configEntry.type !== "blob") refuse("merge-base tribunal.config.json must be a regular file in the selected tree");
    let config;
    try { config = JSON.parse(git(["cat-file", "blob", configEntry.oid])); }
    catch { refuse("merge-base tribunal.config.json could not be read as JSON"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) refuse("merge-base tribunal.config.json must be an object");
    if (Object.hasOwn(config, "goalsDir")) goalsDir = config.goalsDir;
  }
  if (typeof goalsDir !== "string" || !goalsDir.trim()) refuse("merge-base goalsDir must be a nonempty path");
  if (isAbsolute(goalsDir)) goalsDir = relativeToRepository(git(["rev-parse", "--show-toplevel"]).trim(), goalsDir);
  goalsDir = posix.normalize(goalsDir.replaceAll("\\", "/") || ".").replace(/\/$/, "");
  if (!safeGitPath(goalsDir)) refuse("path is outside the merge-base goalsDir");
  return goalsDir;
}

export function readPrGoalsDir(head, base, git) {
  return goalsDirAt(prMergeBase(head, base, git), git);
}

function resolvePrGoal(meta, exec) {
  const lines = String(meta.body || "").split(/\r?\n/).filter((line) => /^Goal:\s*\S/.test(line));
  if (!lines.length) return null;
  const match = /^Goal:\s*(\S+)(?:\s+(.*))?$/.exec(lines[0].trimEnd());
  const suppliedPath = match[1].replaceAll("\\", "/");
  const refuse = (why) => { throw new GoalRefusal(why); };
  const selection = match[2] == null ? null : /^item\s+([1-9]\d*)(?:\s+.*)?$/i.exec(match[2]);
  if (match[2] != null && !selection) refuse("goal paths with spaces are not supported; text after the path must be item N followed by optional notes");
  const item = selection == null ? null : Number(selection[1]);
  if (!safeGitPath(suppliedPath)) refuse("path must be repository-relative with no .. segments or drive letter");
  const path = posix.normalize(suppliedPath);
  if (item != null && !Number.isSafeInteger(item)) refuse("item must be a positive safe integer");
  const git = (args) => exec("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const head = meta.headRefOid, base = meta.baseRefOid;
  const mergeBase = prMergeBase(head, base, git);
  const entryAt = (tree, name) => gitEntryAt(git, tree, name);
  const regular = (entry, name) => {
    if (!entry || !["100644", "100755"].includes(entry.mode) || entry.type !== "blob") refuse(`${name} must be a regular file in the selected tree`);
  };
  const baseEntry = entryAt(mergeBase, path);
  const entry = baseEntry || entryAt(head, path);
  if (!entry) refuse(`${path} was not found in the merge base or PR head`);
  regular(entry, path);
  const size = Number(git(["cat-file", "-s", entry.oid]).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_GOAL_BYTES) refuse("goal exceeds 50 KB or has an invalid blob size");
  const goalsDir = goalsDirAt(mergeBase, git);
  if (goalsDir !== "." && !path.startsWith(`${goalsDir}/`)) refuse("path is outside the merge-base goalsDir");
  return { path, item, goalsDir, source: baseEntry ? "merge base" : "PR head", commit: baseEntry ? mergeBase : head,
    ignored: lines.slice(1), text: git(["cat-file", "blob", entry.oid]) };
}

/** A local file, hashed from the same bytes supplied for review. */
export function fromFile(path) {
  const bytes = readFileSync(path);
  return {
    kind: "document", source: path, title: basename(path), text: bytes.toString("utf8"),
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Pasted text, with no file behind it. Same path, so "proof this report" needs no ceremony. */
export function fromText(text, title = "pasted text") {
  const content = String(text);
  return {
    kind: "document", source: null, title, text: content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

/** A pull request, via `gh`, with its optional goal pinned to git objects. */
export function fromPr(prNumber, { repo, exec = execFileSync } = {}) {
  const gh = (args, maxBuffer) => {
    try { return exec("gh", args, { encoding: "utf8", maxBuffer }); }
    catch (error) {
      if (error.code === "ENOENT") throw Object.assign(new Error(GH_MISSING_MESSAGE), { code: "GH_NOT_FOUND" });
      throw error;
    }
  };
  const args = ["pr", "view", String(prNumber), "--json", "title,body,headRefOid,baseRefName,baseRefOid"];
  if (repo) args.push("--repo", repo);
  const meta = JSON.parse(gh(args, 64 * 1024 * 1024));
  const diffArgs = ["pr", "diff", String(prNumber)];
  if (repo) diffArgs.push("--repo", repo);
  const diff = gh(diffArgs, 64 * 1024 * 1024);

  // Re-read the head AFTER the diff and refuse to certify if it moved.
  //
  // The head and the diff come from two separate `gh` calls, so a push landing between them gives
  // a head from before and a diff from after — and the proof would then certify a commit whose
  // diff the panel never read, which is the one thing the head in that marker is for. A review
  // that raced a push is a review of neither commit.
  //
  // The panel still RUNS and reports on what it read; only `headSha` is withheld, and a null head
  // is exactly what stops `postLocalProof` posting. Withholding the certification is right and
  // refusing the review would not be: the findings are still about real code.
  let headSha = typeof meta.headRefOid === "string" ? meta.headRefOid : null;
  if (headSha) {
    const afterArgs = ["pr", "view", String(prNumber), "--json", "headRefOid"];
    if (repo) afterArgs.push("--repo", repo);
    let after = null;
    try {
      after = JSON.parse(gh(afterArgs, 1024 * 1024));
    } catch (error) {
      if (error.code === "GH_NOT_FOUND") throw error;
      after = null;
    }
    // An unreadable second look is not evidence the head held still, so it withholds too.
    if (!after || after.headRefOid !== headSha) headSha = null;
  }

  const goal = readPrGoal(meta, exec);
  return {
    kind: "diff",
    source: `PR #${prNumber}`,
    title: meta.title,
    text: `${meta.body || ""}\n\n${diff}`,
    prNumber,
    headSha,
    baseSha: meta.baseRefOid ?? null,
    diff,
    // Only a head verified on both sides of the diff identifies the reviewed content.
    contentHash: headSha,
    ...(goal?.refused ? { goalRefusal: { reason: goal.reason } } : goal ? { goal } : {}),
  };
}
