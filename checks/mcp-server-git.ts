import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFindings, parseRun } from "../src/model.js";
import { profileSources } from "../src/static-profile.js";
import type { Finding, Run, ToolCallBundle } from "../src/model.js";

const scenarioGit: readonly { readonly tool: string; readonly subcommand: string }[] = [
  { tool: "git_status", subcommand: "status" },
  { tool: "git_log", subcommand: "rev-list" },
  { tool: "git_diff_unstaged", subcommand: "diff" },
  { tool: "git_add", subcommand: "add" },
  { tool: "git_commit", subcommand: "hash-object" },
  { tool: "git_show", subcommand: "diff-tree" },
];

type GitExec = {
  readonly argv: readonly string[];
  readonly linkKind: "owned" | "overlap";
};

function scenarioCall(run: Run, tool: string): ToolCallBundle {
  const call = run.tool_calls.find((item) => item.tool === tool && item.argument_source.kind === "scenario");
  assert.ok(call, `missing scenario ${tool}`);
  return call;
}

function gitExecs(call: ToolCallBundle): readonly GitExec[] {
  const execs: GitExec[] = [];
  for (const entry of call.events) {
    const body = entry.event.body;
    if (body.kind !== "process" || body.action.kind !== "exec") continue;
    if (body.action.path.split("/").at(-1) !== "git") continue;
    execs.push({ argv: body.action.argv, linkKind: entry.link.kind });
  }
  return execs;
}

function assertOwnedGit(call: ToolCallBundle, subcommand: string): void {
  const execs = gitExecs(call);
  const match = execs.find((item) => item.argv.includes(subcommand));
  assert.ok(
    match,
    `${call.tool} git argv ${JSON.stringify(execs.map((item) => item.argv))} does not include ${subcommand}`,
  );
  assert.equal(match.linkKind, "owned", `${call.tool} ${subcommand} argv ${JSON.stringify(match.argv)}`);
}

function gitCommitWroteDotGit(findings: readonly Finding[], call: ToolCallBundle): boolean {
  return findings.some(
    (finding) =>
      finding.kind === "call" &&
      finding.call_id === call.call_id &&
      finding.rule === "file_modified" &&
      finding.subject.kind === "path" &&
      finding.subject.path.startsWith("/work/repo/.git"),
  );
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["dist/src/cli.js", "detonate", "targets/mcp-server-git.toml", "--no-judge"],
  { cwd: root, encoding: "utf8", timeout: 900_000 },
);
assert.equal(result.status, 0, result.stderr || result.stdout);
const runDir = result.stdout.trim().split("\n").at(-1) ?? "";
assert.ok(runDir.startsWith(join(root, "runs")), runDir);

const bundlesPath = join(runDir, "bundles.json");
const findingsPath = join(runDir, "findings.json");
const run = parseRun(readFileSync(bundlesPath, "utf8"), bundlesPath);
const findings = parseFindings(readFileSync(findingsPath, "utf8"), findingsPath, run);
const profile = profileSources(runDir);

for (const row of scenarioGit) {
  assertOwnedGit(scenarioCall(run, row.tool), row.subcommand);
}

const commit = scenarioCall(run, "git_commit");
assert.ok(gitCommitWroteDotGit(findings, commit), "git_commit is missing file_modified under /work/repo/.git");

assert.ok(
  profile.dependencies.some((dependency) => dependency.name.toLowerCase() === "gitpython"),
  "static profile dependencies do not list gitpython",
);
const spawnHint = profile.api_hints.find((hint) => hint.category === "spawned_process");
assert.equal(
  spawnHint,
  undefined,
  spawnHint === undefined ? "" : `${spawnHint.file}:${String(spawnHint.line)} ${spawnHint.snippet}`,
);
assert.equal(
  run.unmatched.some((entry) => entry.reason.kind === "orphan_process"),
  false,
  "unmatched has an orphan_process",
);
