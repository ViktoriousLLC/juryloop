import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFindings } from "./legRunner.mjs";
import { runDemo } from "./demo.mjs";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
const replies = JSON.parse(readFileSync(new URL("./demo/replies.json", import.meta.url), "utf8"));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tribunal-demo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), cwd = join(dir, "cwd"), preload = join(dir, "preload.mjs");
  mkdirSync(home); mkdirSync(cwd);
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, "tribunal.config.json"), "{}\n");
  writeFileSync(preload, `
import childProcess from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dns from "node:dns";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const deny = (name) => () => { throw new Error("demo forbidden: " + name); };
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[key] = deny(key);
for (const key of ["connect", "createConnection"]) net[key] = deny("net." + key);
net.Socket.prototype.connect = deny("net.Socket.prototype.connect");
tls.connect = deny("tls.connect");
for (const key of ["request", "get"]) {
  http[key] = deny("http." + key);
  https[key] = deny("https." + key);
}
http2.connect = deny("http2.connect");
dns.lookup = deny("dns.lookup");
dns.promises.lookup = deny("dns.promises.lookup");
globalThis.fetch = deny("fetch");
for (const key of ["writeFileSync", "appendFileSync", "mkdirSync", "openSync", "rmSync", "unlinkSync", "renameSync"]) fs[key] = deny("fs." + key);
for (const key of ["writeFile", "appendFile", "mkdir", "open"]) fs.promises[key] = deny("fs.promises." + key);
for (const [target, keys] of [[fs, ["readFileSync", "readFile"]], [fs.promises, ["readFile"]]]) {
  for (const key of keys) {
    const readFile = target[key];
    target[key] = (path, ...args) => {
      if (String(path).endsWith("tribunal.config.json")) throw new Error("demo forbidden: config read");
      return readFile(path, ...args);
    };
  }
}
syncBuiltinESMExports();
`);
  return { dir, home, cwd, run: (args) => spawnSync(process.execPath,
    ["--import", pathToFileURL(preload).href, ...args], {
      cwd, env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    }) };
}

test("demo renders a full recorded panel without processes, network, config reads or saved files", (t) => {
  const f = fixture(t), result = f.run([runner, "--demo"]);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split(/\r?\n/)[0], /^DEMO.*recorded.*No model.*no login.*nothing was saved/);
  assert.ok(result.stdout.includes(`**${replies[0].findings[0].title}**`));
  assert.match(result.stdout, /2 legs: opus, sol/);
  assert.match(result.stdout, /only astra/);
  assert.match(result.stdout, /Blinded judge did not run: demo/);
  assert.match(result.stdout, /Next:\*\* CONTINUE/);
  assert.equal(existsSync(join(f.home, ".tribunal")), false);
  assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(readdirSync(f.cwd).sort(), [".git", "tribunal.config.json"]);
  assert.deepEqual(readdirSync(join(f.cwd, ".git")), []);
  assert.equal(readFileSync(join(f.cwd, "tribunal.config.json"), "utf8"), "{}\n");
});

for (const [name, source] of [
  ["spawnSync", 'import { spawnSync } from "node:child_process"; spawnSync(process.execPath, ["--version"]);'],
  ["fetch", 'await fetch("https://example.invalid");'],
  ["https.get", 'import https from "node:https"; https.get("https://example.invalid");'],
  ["net.Socket.prototype.connect", 'import net from "node:net"; new net.Socket().connect(443, "example.invalid");'],
  ["fs.writeFileSync", 'import fs from "node:fs"; fs.writeFileSync("forbidden.txt", "forbidden");'],
  ["config read", `import { resolvePolicy } from ${JSON.stringify(new URL("./policy.mjs", import.meta.url).href)}; resolvePolicy(process.cwd());`],
]) {
  test(`demo preload negative control blocks ${name}`, (t) => {
    const f = fixture(t), script = join(f.dir, "control.mjs");
    writeFileSync(script, source);
    const result = f.run([script]);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`demo forbidden: ${name}`), result.stderr);
  });
}

test("recorded seats use bundled model ids and parser-compatible findings", () => {
  const registry = JSON.parse(readFileSync(new URL("./models.default.json", import.meta.url), "utf8")).legs;
  assert.equal(replies.length, 3);
  assert.equal(new Set(replies.map((reply) => reply.leg)).size, 3);
  for (const reply of replies) {
    assert.equal(reply.model, registry.find((leg) => leg.leg === reply.leg).id);
    assert.deepEqual(parseFindings(JSON.stringify({ findings: reply.findings })),
      { findings: reply.findings, parseError: null });
  }
  assert.match(runDemo(), /^DEMO/);
});
