import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { gitEntryAt, readPrGoalsDir, safeGitPath } from "./artifact.mjs";

export const MAX_FILE_BYTES = 100 * 1024;
export const MAX_ROUND_BYTES = 300 * 1024;

export function normalizeDiffPath(value, { stripSidePrefix = false } = {}) {
  if (typeof value !== "string") return null;
  let path = value;
  if (/[^\x20-\x7e]|["\\]/.test(path) || !safeGitPath(path)) return null;
  path = path.replace(/^(?:\.\/)+/, "");
  if (stripSidePrefix) path = path.replace(/^[ab]\//, "");
  return safeGitPath(path) ? posix.normalize(path) : null;
}

function touchedPaths(diff) {
  const paths = new Set();
  let header = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) header = true;
    else if (line.startsWith("@@") || line === "GIT binary patch") header = false;
    else if (header && line.startsWith("+++ ")) {
      const path = normalizeDiffPath(line.slice(4).replace(/\t$/, ""), { stripSidePrefix: true });
      if (path) paths.add(path);
      header = false;
    }
  }
  return paths;
}

export function readWholeFiles(artifact, lone, { exec = execFileSync } = {}) {
  const files = [], records = [];
  if (artifact?.kind !== "diff" || !artifact.headSha || typeof artifact.diff !== "string") return { files, records };
  const touched = touchedPaths(artifact.diff), seen = new Set();
  const git = (args) => exec("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rank = { BLOCKER: 3, SUGGESTION: 2, NIT: 1 };
  let total = 0, goalsDir, goalsFailed = false;
  for (const { cluster } of [...lone].sort((a, b) => (rank[b.cluster.severity] || 0) - (rank[a.cluster.severity] || 0))) {
    const path = normalizeDiffPath(cluster.file), key = path ?? cluster.file;
    if (seen.has(key)) continue;
    seen.add(key);
    const record = { path: path ?? cluster.file ?? null, bytes: null, reason: "invalid path" };
    records.push(record);
    if (!path) continue;
    if (!touched.has(path)) { record.reason = "outside diff"; continue; }
    if (goalsDir === undefined && !goalsFailed) {
      try { goalsDir = readPrGoalsDir(artifact.headSha, artifact.baseSha, git); }
      catch { goalsFailed = true; }
    }
    if (goalsFailed) { record.reason = "goals directory unavailable"; continue; }
    if (goalsDir === "." || path === goalsDir || path.startsWith(`${goalsDir}/`)) { record.reason = "goals directory"; continue; }
    try {
      const entry = gitEntryAt(git, artifact.headSha, path);
      if (!entry || !["100644", "100755"].includes(entry.mode) || entry.type !== "blob") { record.reason = "not a regular file at head"; continue; }
      const bytes = Number(git(["cat-file", "-s", entry.oid]).trim());
      if (!Number.isSafeInteger(bytes) || bytes < 0) { record.reason = "invalid blob size"; continue; }
      record.bytes = bytes;
      if (bytes > MAX_FILE_BYTES) { record.reason = "over 100 KB"; continue; }
      if (total + bytes > MAX_ROUND_BYTES) { record.reason = "over 300 KB round budget"; continue; }
      const text = git(["cat-file", "blob", entry.oid]);
      const textBytes = Buffer.byteLength(text);
      if (textBytes > MAX_FILE_BYTES || total + textBytes > MAX_ROUND_BYTES) { record.reason = "decoded text exceeds byte budget"; continue; }
      files.push({ path, text });
      total += Math.max(bytes, textBytes);
      record.reason = "sent";
    } catch { record.reason = "git read failed"; }
  }
  return { files, records };
}
