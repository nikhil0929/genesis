import { and, eq } from "drizzle-orm";

import type { Judgment, Run, Target } from "../model.js";
import type { Db } from "./db/client.js";
import { runs } from "./db/schema.js";
import { serverKey } from "./server-key.js";
import { rollupVerdict } from "./verdict.js";
import type { Verdict } from "./verdict.js";

export type RunStart = {
  readonly id: string;
  readonly target: Target;
  readonly startedAt: Date;
};

export type RunOutcome =
  | {
      readonly status: "succeeded" | "failed";
      readonly run: Run;
      readonly judgments: readonly Judgment[] | null;
    }
  | { readonly status: "failed"; readonly run: null };

export type RunFinish = RunOutcome & {
  readonly id: string;
  readonly downloadUrl: string | null;
  readonly endedAt: Date;
};

function outcomeColumns(outcome: RunOutcome): { mcpServerName: string | null; verdict: Verdict } {
  if (outcome.run === null) return { mcpServerName: null, verdict: "incomplete" };
  return {
    mcpServerName: outcome.run.startup.server_info.name.replaceAll("\0", "\uFFFD"),
    verdict: rollupVerdict(outcome.judgments),
  };
}

function packageColumns(target: Target): { packageName: string | null; packageVersion: string | null } {
  switch (target.source.kind) {
    case "registry":
      return { packageName: target.source.package, packageVersion: target.source.version };
    case "local":
      return { packageName: null, packageVersion: null };
    default: {
      const _exhaustive: never = target.source;
      return _exhaustive;
    }
  }
}

export async function insertRun(db: Db, start: RunStart): Promise<void> {
  await db.insert(runs).values({
    id: start.id,
    targetName: start.target.name,
    serverKey: serverKey(start.target.source),
    sourceKind: start.target.source.kind,
    ...packageColumns(start.target),
    ecosystem: start.target.source.ecosystem,
    startedAt: start.startedAt,
    status: "running",
    verdict: null,
    endedAt: null,
  });
}

export async function finishRun(db: Db, finish: RunFinish): Promise<void> {
  const updated = await db
    .update(runs)
    .set({
      endedAt: finish.endedAt,
      ...outcomeColumns(finish),
      downloadUrl: finish.downloadUrl,
      status: finish.status,
    })
    .where(and(eq(runs.id, finish.id), eq(runs.status, "running")))
    .returning({ id: runs.id });
  if (updated.length !== 1) throw new Error(`run ${finish.id} has no running row to finish`);
}
