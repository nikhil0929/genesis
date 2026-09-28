import { publishRun } from "../engine/report.js";
import { traceTarget } from "../engine/sandbox.js";
import type { JudgeMode } from "../engine/judge.js";
import type { Target } from "../model.js";

export async function runDetonation(target: Target, mode: JudgeMode, runId?: string): Promise<string> {
  const traced = await traceTarget(target, runId);
  return publishRun(traced.runDir, mode);
}
