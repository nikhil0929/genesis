import { writeFileSync } from "node:fs";

import { stringify } from "smol-toml";

import { publishRun } from "../engine/report.js";
import { rawPath } from "../engine/run-dir.js";
import { traceTarget } from "../engine/sandbox.js";
import type { JudgeMode } from "../engine/judge.js";
import type { Target } from "../model.js";

export async function runDetonation(target: Target, mode: JudgeMode, runId?: string): Promise<string> {
  const traced = await traceTarget(target, runId);
  writeFileSync(rawPath(traced.runDir, "target.toml"), stringify(target));
  return publishRun(traced.runDir, mode);
}
