#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";

import { publishRun } from "../engine/report.js";
import { parseJudgments, parseRun, parseTarget } from "../model.js";
import type { Target } from "../model.js";
import { buildServer } from "./api.js";
import { deleteLocalRun, uploadRun } from "./archive.js";
import { openDb } from "./db/client.js";
import type { Db } from "./db/client.js";
import { runs } from "./db/schema.js";
import { runDetonation } from "./detonate.js";
import type { RunRow, RunsDeps } from "./routes/runs.js";
import { finishRun, insertRun } from "./store.js";
import type { RunOutcome } from "./store.js";

type Command =
  | { readonly kind: "detonate"; readonly targetPath: string; readonly mode: "skip" | "if_absent" }
  | { readonly kind: "report"; readonly runDir: string; readonly mode: "if_absent" | "again" }
  | { readonly kind: "serve" };

function withWorkingSource(target: Target, targetPath: string): Target {
  if (target.source.kind !== "local") return target;
  const absolute = resolve(dirname(resolve(targetPath)), target.source.path);
  return {
    ...target,
    source: { kind: "local", ecosystem: target.source.ecosystem, path: relative(process.cwd(), absolute) },
  };
}

export function loadTarget(targetPath: string): Target {
  const absolute = resolve(targetPath);
  return withWorkingSource(parseTarget(readFileSync(absolute, "utf8"), absolute), absolute);
}

export function scratchDir(id: string): string {
  return join(tmpdir(), "mcpdet", id);
}

export function parseCommand(argv: readonly string[]): Command {
  const [command, path, flag, extra] = argv;
  if (command === "serve") {
    if (path !== undefined) throw new Error("usage");
    return { kind: "serve" };
  }
  if (extra !== undefined || path === undefined) throw new Error("usage");
  switch (command) {
    case "detonate":
      if (flag === undefined) return { kind: "detonate", targetPath: path, mode: "if_absent" };
      if (flag === "--no-judge") return { kind: "detonate", targetPath: path, mode: "skip" };
      throw new Error("usage");
    case "report":
      if (flag === undefined) return { kind: "report", runDir: path, mode: "if_absent" };
      if (flag === "--rejudge") return { kind: "report", runDir: path, mode: "again" };
      throw new Error("usage");
    default:
      throw new Error("usage");
  }
}

function settledOutcome(runDir: string, succeeded: boolean): RunOutcome {
  if (!succeeded) return { status: "failed", run: null };
  const bundlesPath = join(runDir, "bundles.json");
  const run = parseRun(readFileSync(bundlesPath, "utf8"), bundlesPath);
  const judgmentsPath = join(runDir, "judgments.json");
  const judgments = existsSync(judgmentsPath)
    ? parseJudgments(readFileSync(judgmentsPath, "utf8"), judgmentsPath, run)
    : null;
  return { status: "succeeded", run, judgments };
}

export async function detonateCommand(targetPath: string, mode: "skip" | "if_absent"): Promise<string> {
  const target = loadTarget(targetPath);
  const id = randomUUID();
  const runDir = scratchDir(id);
  const handle = openDb();
  try {
    await insertRun(handle.db, { id, target, startedAt: new Date() });
    let failure: { readonly error: unknown } | null = null;
    try {
      await runDetonation(target, mode, id);
    } catch (error) {
      failure = { error };
    }
    if (failure === null || existsSync(runDir)) await uploadRun(runDir, id);
    await finishRun(handle.db, {
      id,
      ...settledOutcome(runDir, failure === null),
      downloadUrl: null,
      endedAt: new Date(),
    });
    if (existsSync(runDir)) deleteLocalRun(runDir);
    if (failure !== null) throw failure.error;
    return id;
  } finally {
    await handle.close();
  }
}

export async function reportCommand(runDir: string, mode: "if_absent" | "again"): Promise<void> {
  await publishRun(resolve(runDir), mode);
}

function archiveClient(): S3Client {
  const endpoint = process.env.MCPDET_S3_ENDPOINT;
  const region = process.env.AWS_REGION ?? "us-east-1";
  if (endpoint === undefined || endpoint.length === 0) return new S3Client({ region });
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

async function readArchive(client: S3Client, id: string, name: string): Promise<string | null> {
  const bucket = process.env.MCPDET_S3_BUCKET;
  if (bucket === undefined || bucket.length === 0) throw new Error("MCPDET_S3_BUCKET is unset");
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `${id}/${name}` }));
    return (await object.Body?.transformToString("utf8")) ?? "";
  } catch (error) {
    if (error instanceof NoSuchKey) return null;
    throw error;
  }
}

async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const [row] = await db
    .select({ id: runs.id, status: runs.status, verdict: runs.verdict })
    .from(runs)
    .where(eq(runs.id, id));
  return row ?? null;
}

function moveRun(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

function serveDeps(db: Db, client: S3Client): RunsDeps {
  return {
    insertRun: (id, target) => insertRun(db, { id, target, startedAt: new Date() }),
    getRun: (id) => getRun(db, id),
    finishRun: (id, outcome) =>
      finishRun(db, {
        id,
        ...settledOutcome(resolve("runs", id), outcome.status === "succeeded"),
        downloadUrl: null,
        endedAt: new Date(),
      }),
    uploadRun: (runDir, id) => uploadRun(runDir, id),
    readArchive: (id, name) => readArchive(client, id, name),
    deleteLocalRun: async (runDir) => {
      if (existsSync(runDir)) deleteLocalRun(runDir);
    },
    runDetonation: async (id, target, runDir) => {
      try {
        await runDetonation(target, "if_absent", id);
      } finally {
        moveRun(scratchDir(id), runDir);
      }
    },
  };
}

function listenAddress(): { readonly host: string; readonly port: number } {
  const value = process.env.MCPDET_LISTEN;
  if (value === undefined || value.length === 0) return { host: "127.0.0.1", port: 8787 };
  const colon = value.lastIndexOf(":");
  const port = Number(value.slice(colon + 1));
  if (colon <= 0 || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MCPDET_LISTEN must be host:port, got ${value}`);
  }
  return { host: value.slice(0, colon).replace(/^\[(.*)\]$/, "$1"), port };
}

export async function serveCommand(): Promise<void> {
  const address = listenAddress();
  const handle = openDb();
  const client = archiveClient();
  const app = await buildServer(serveDeps(handle.db, client)).catch(async (error: unknown) => {
    client.destroy();
    await handle.close();
    throw error;
  });
  const stop = (): void => {
    void app.close().finally(() => {
      client.destroy();
      void handle.close();
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await app.listen(address);
  process.stderr.write(`mcpdet listening on ${address.host}:${String(address.port)}\n`);
}

function fail(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const entry = process.argv[1];
if (entry !== undefined && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  let command: Command;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "usage: mcpdet detonate <target.toml> [--no-judge]\n       mcpdet report <run-dir> [--rejudge]\n",
    );
    process.exit(1);
  }
  switch (command.kind) {
    case "detonate":
      detonateCommand(command.targetPath, command.mode)
        .then((id) => {
          process.stdout.write(`${id}\n`);
        })
        .catch(fail);
      break;
    case "report":
      reportCommand(command.runDir, command.mode).catch(fail);
      break;
    case "serve":
      serveCommand().catch(fail);
      break;
    default: {
      const unreachable: never = command;
      fail(unreachable);
    }
  }
}
