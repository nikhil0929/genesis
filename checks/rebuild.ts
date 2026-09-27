import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFindings, parseRun } from "../src/model.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const derived = ["events.jsonl", "processes.json", "bundles.json", "static_profile.json", "findings.json", "report.md"];

function detonate(target: string): string {
  const result = spawnSync(process.execPath, ["dist/src/cli.js", "detonate", target], {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const runDir = result.stdout.trim().split("\n").at(-1) ?? "";
  assert.ok(runDir.startsWith(`${join(root, "runs")}/`), runDir);
  return runDir;
}

function report(runDir: string): void {
  const result = spawnSync(process.execPath, ["dist/src/cli.js", "report", runDir], {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function bytes(runDir: string, name: string): Buffer {
  return readFileSync(join(runDir, name));
}

function toolSection(reportText: string, tool: string): string {
  const lines = reportText.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^# Tool call .*: ${tool}$`).test(line));
  assert.ok(start >= 0, `missing tool call section for ${tool}`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("# "));
  return lines.slice(start, next === -1 ? lines.length : next).join("\n");
}

const runDir = detonate("targets/detfix-allow.toml");
assert.ok(existsSync(join(runDir, "host.json")), "host.json is missing");
const savedBundles = bytes(runDir, "bundles.json");
const savedReport = bytes(runDir, "report.md");
const savedHost = bytes(runDir, "host.json");
for (const name of derived) rmSync(join(runDir, name));

report(runDir);
assert.deepEqual(bytes(runDir, "bundles.json"), savedBundles, "bundles.json changed after report");
assert.deepEqual(bytes(runDir, "report.md"), savedReport, "report.md changed after report");
assert.deepEqual(bytes(runDir, "host.json"), savedHost, "host.json changed after report");

report(runDir);
assert.deepEqual(bytes(runDir, "bundles.json"), savedBundles, "bundles.json changed after the second report");
assert.deepEqual(bytes(runDir, "report.md"), savedReport, "report.md changed after the second report");
assert.deepEqual(bytes(runDir, "host.json"), savedHost, "host.json changed after the second report");

const bundlesPath = join(runDir, "bundles.json");
const findingsPath = join(runDir, "findings.json");
const run = parseRun(readFileSync(bundlesPath, "utf8"), bundlesPath);
const reportText = readFileSync(join(runDir, "report.md"), "utf8");
const toolCallLines = reportText.split("\n").filter((line) => /^# Tool call /.test(line));
assert.equal(toolCallLines.length, run.tool_calls.length);
const wordCall = run.tool_calls.find((call) => call.tool === "word_count");
assert.ok(wordCall, "missing word_count call");
const findings = parseFindings(readFileSync(findingsPath, "utf8"), findingsPath, run);
assert.ok(
  findings.some(
    (finding) =>
      finding.kind === "call" &&
      finding.call_id === wordCall.call_id &&
      finding.rule === "network_attempt" &&
      finding.claim_check.interface_mentions === null &&
      finding.source_hints.some((hint) => hint.file === "src/server.ts" && hint.line === 76),
  ),
  "word_count network_attempt is missing the src/server.ts:76 hint",
);
const section = toolSection(reportText, "word_count");
assert.ok(section.includes("none"), "word_count section is missing none");
assert.ok(section.includes("src/server.ts:76"), "word_count section is missing src/server.ts:76");
