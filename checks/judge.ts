import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFindings, parseJudgments, parseRun } from "../src/model.js";
import type { Finding, Judgment, Run, ToolCallBundle } from "../src/model.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

function envWithoutKey(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name === "OPENROUTER_API_KEY" || value === undefined) continue;
    env[name] = value;
  }
  return env;
}

function cli(
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string; error: string } {
  const result = spawnSync(process.execPath, ["dist/src/cli.js", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? "",
  };
}

function detonate(args: readonly string[], env?: NodeJS.ProcessEnv): string {
  const result = cli(["detonate", ...args], env);
  assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
  const runDir = result.stdout.trim().split("\n").at(-1) ?? "";
  assert.ok(existsSync(join(runDir, "report.md")), runDir);
  return runDir;
}

function assertJudgeNotRun(runDir: string): void {
  const report = readFileSync(join(runDir, "report.md"), "utf8");
  assert.ok(report.split("\n").includes("judge not run"), "report.md is missing the line judge not run");
}

function callNamed(run: Run, name: string): ToolCallBundle {
  const call = run.tool_calls.find((item) => item.tool === name);
  assert.ok(call, `missing ${name} call`);
  return call;
}

function judgmentFor(judgments: readonly Judgment[], call: ToolCallBundle): Judgment {
  const judgment = judgments.find((item) => item.call_id === call.call_id);
  assert.ok(judgment, `missing judgment for ${call.tool}`);
  return judgment;
}

function sideEffectEventIds(findings: readonly Finding[], call: ToolCallBundle): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const finding of findings) {
    if (finding.kind !== "call" || finding.call_id !== call.call_id) continue;
    if (finding.rule !== "credential_access" && finding.rule !== "network_attempt") continue;
    for (const id of finding.evidence) ids.add(id);
  }
  return ids;
}

function assertCitationsOnCall(run: Run, judgments: readonly Judgment[]): void {
  for (const judgment of judgments) {
    switch (judgment.kind) {
      case "invalid":
        break;
      case "answer": {
        const call = run.tool_calls.find((item) => item.call_id === judgment.call_id);
        assert.ok(call, `judgment names call ${String(judgment.call_id)}, which is not in the run`);
        const present = new Set(call.events.map((entry) => entry.event.event_id));
        for (const mismatch of judgment.answer.mismatches) {
          for (const id of mismatch.event_ids) {
            assert.ok(present.has(id), `${call.tool} cites ${id}, which is not on that call`);
          }
        }
        break;
      }
      default: {
        const unreachable: never = judgment;
        throw new Error(String(unreachable));
      }
    }
  }
}

function assertOpinions(): void {
  const runDir = detonate(["targets/detfix-allow.toml"]);
  const bundlesPath = join(runDir, "bundles.json");
  const judgmentsPath = join(runDir, "judgments.json");
  const findingsPath = join(runDir, "findings.json");
  const run = parseRun(readFileSync(bundlesPath, "utf8"), bundlesPath);
  const judgments = parseJudgments(readFileSync(judgmentsPath, "utf8"), judgmentsPath, run);
  const findings = parseFindings(readFileSync(findingsPath, "utf8"), findingsPath, run);
  const wordCount = callNamed(run, "word_count");
  const wordJudgment = judgmentFor(judgments, wordCount);
  switch (wordJudgment.kind) {
    case "invalid":
      assert.fail(`word_count invalid: ${wordJudgment.error}`);
      break;
    case "answer": {
      assert.equal(
        wordJudgment.answer.opinion,
        "does_not_match",
        `word_count opinion ${wordJudgment.answer.opinion}`,
      );
      const evidence = sideEffectEventIds(findings, wordCount);
      const cited = wordJudgment.answer.mismatches.some((mismatch) =>
        mismatch.event_ids.some((id) => evidence.has(id)),
      );
      assert.ok(cited, "word_count mismatches cite no credential_access or network_attempt event");
      break;
    }
    default: {
      const unreachable: never = wordJudgment;
      throw new Error(String(unreachable));
    }
  }
  const echo = callNamed(run, "echo");
  const echoJudgment = judgmentFor(judgments, echo);
  switch (echoJudgment.kind) {
    case "invalid":
      assert.fail(`echo invalid: ${echoJudgment.error}`);
      break;
    case "answer":
      assert.equal(echoJudgment.answer.opinion, "matches", `echo opinion ${echoJudgment.answer.opinion}`);
      break;
    default: {
      const unreachable: never = echoJudgment;
      throw new Error(String(unreachable));
    }
  }
  assertCitationsOnCall(run, judgments);
  const before = readFileSync(join(runDir, "report.md"));
  const reported = cli(["report", runDir]);
  assert.equal(reported.status, 0, reported.error || reported.stderr || reported.stdout);
  assert.deepEqual(readFileSync(join(runDir, "report.md")), before);
}

const withoutKey = detonate(["targets/detfix-allow.toml"], envWithoutKey());
assertJudgeNotRun(withoutKey);
assert.equal(existsSync(join(withoutKey, "judgments.json")), false);

const skipped = detonate(["targets/detfix-allow.toml", "--no-judge"]);
assertJudgeNotRun(skipped);

const key = process.env.OPENROUTER_API_KEY;
if (key === undefined || key.length === 0) {
  process.stderr.write("opinion assertions not run\n");
} else {
  assertOpinions();
}
