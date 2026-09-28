import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { z } from "zod";

import { parseJudgments, parseRun, runIdSchema, targetSchema } from "../../model.js";
import type { Judgment, Target } from "../../model.js";

export type RunStatus = "running" | "succeeded" | "failed";

export type RunRow = {
  readonly id: string;
  readonly status: RunStatus;
  readonly verdict: string | null;
};

export type RunOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly verdict: "incomplete" };

export type RunsDeps = {
  readonly insertRun: (id: string, target: Target) => Promise<void>;
  readonly getRun: (id: string) => Promise<RunRow | null>;
  readonly finishRun: (id: string, outcome: RunOutcome) => Promise<void>;
  readonly uploadRun: (runDir: string, id: string) => Promise<void>;
  readonly readArchive: (id: string, name: string) => Promise<string | null>;
  readonly deleteLocalRun: (runDir: string) => Promise<void>;
  readonly runDetonation: (id: string, target: Target, runDir: string) => Promise<void>;
};

function withWorkingSource(target: Target): Target {
  if (target.source.kind !== "local") return target;
  const path = relative(process.cwd(), resolve(process.cwd(), target.source.path)) || ".";
  return { ...target, source: { ...target.source, path } };
}

export const runsRoutes: FastifyPluginAsyncZod<RunsDeps> = async (app, deps) => {
  let inFlight: string | null = null;

  async function settle(id: string, target: Target): Promise<void> {
    const runDir = resolve("runs", id);
    try {
      const outcome = await deps.runDetonation(id, target, runDir).then(
        (): RunOutcome => ({ status: "succeeded" }),
        (error: unknown): RunOutcome => {
          app.log.error({ err: error, id }, "detonation failed");
          return { status: "failed", verdict: "incomplete" };
        },
      );
      if (outcome.status === "succeeded" || existsSync(runDir)) await deps.uploadRun(runDir, id);
      await deps.finishRun(id, outcome);
      await deps.deleteLocalRun(runDir);
    } catch (error) {
      app.log.error({ err: error, id, runDir }, "run did not settle, keeping the local run");
    } finally {
      inFlight = null;
    }
  }

  async function loadJudgments(id: string): Promise<readonly Judgment[] | null> {
    const judgmentsText = await deps.readArchive(id, "judgments.json");
    if (judgmentsText === null) return null;
    const bundlesText = await deps.readArchive(id, "bundles.json");
    if (bundlesText === null) throw new Error(`${id}/judgments.json exists without ${id}/bundles.json`);
    const run = parseRun(bundlesText, `${id}/bundles.json`);
    return parseJudgments(judgmentsText, `${id}/judgments.json`, run);
  }

  app.post("/runs", { schema: { body: targetSchema } }, async (request, reply) => {
    if (inFlight !== null) {
      return reply.code(409).send({ error: `run ${inFlight} is already in flight`, id: inFlight });
    }
    const id = randomUUID();
    inFlight = id;
    const target = withWorkingSource(request.body);
    try {
      await deps.insertRun(id, target);
    } catch (error) {
      inFlight = null;
      throw error;
    }
    const start = (): void => void settle(id, target);
    if (reply.raw.closed) start();
    else reply.raw.once("close", start);
    return reply.code(202).send({ id, status: "running" });
  });

  app.get("/runs/:id", { schema: { params: z.object({ id: runIdSchema }) } }, async (request, reply) => {
    const { id } = request.params;
    const run = await deps.getRun(id);
    if (run === null) return reply.code(404).send({ error: `run ${id} not found` });
    switch (run.status) {
      case "running":
        return { run, judgments: null };
      case "succeeded":
      case "failed":
        return { run, judgments: await loadJudgments(id) };
      default: {
        const unreachable: never = run.status;
        throw new Error(String(unreachable));
      }
    }
  });
};
