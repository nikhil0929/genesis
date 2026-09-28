import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { openDb } from "../src/app/db/client.js";
import type { Db } from "../src/app/db/client.js";
import { runs } from "../src/app/db/schema.js";
import type { RunRow } from "../src/app/db/schema.js";
import { serverKey } from "../src/app/server-key.js";
import { finishRun, insertRun } from "../src/app/store.js";
import { rollupVerdict } from "../src/app/verdict.js";
import { parseJudgments, parseRun, parseTarget } from "../src/model.js";
import type { Judgment, Run, Target } from "../src/model.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

function target(source: string): Target {
  const text = `name = "detfix"
source = ${source}
base_image = "node:24"
source_path = "/src"
command = ["node", "server.js"]
`;
  return parseTarget(text, "target.toml");
}

const registryTarget = target(
  `{ kind = "registry", ecosystem = "npm", package = "@modelcontextprotocol/server-filesystem", version = "2025.8.21" }`,
);
const localTarget = target(`{ kind = "local", ecosystem = "npm", path = "fixtures/detfix" }`);

function toolCall(callId: number, sentUs: number): unknown {
  return {
    kind: "tool_call",
    call_id: callId,
    tool: "echo",
    definition: { kind: "not_advertised" },
    arguments: {},
    argument_source: { kind: "scenario", index: callId },
    sent_us: sentUs,
    outcome: { kind: "reply", duration_us: 100, content: [], is_error: false },
    events: [],
  };
}

function runFor(source: Target, serverName = "detfix-server"): Run {
  const document = {
    run_id: `detfix-${randomBytes(4).toString("hex")}`,
    target: { name: source.name, source: source.source, image_id: "sha256:abc", command: source.command },
    network: { kind: "block" },
    canaries: [],
    timeline: [],
    clock_check: { max_violation_us: 0, responses_checked: 1 },
    processes: {
      "100": {
        kind: "root",
        pid: 100,
        threads: [],
        execs: [],
        end: { kind: "alive_at_teardown" },
        owner: { kind: "server" },
      },
    },
    startup: {
      kind: "startup",
      window: { start_us: 0, duration_us: 1_000 },
      messages: [],
      server_info: { name: serverName, version: "1.0.0", protocol_version: "2025-11-25", capabilities: {} },
      advertised_tools: [],
      events: [],
    },
    tool_calls: [toolCall(0, 1_000), toolCall(1, 1_200)],
    shutdown: { kind: "shutdown", trigger: { kind: "stdin_closed", t_us: 2_000 }, duration_us: 10, events: [] },
    unmatched: [],
  };
  return parseRun(JSON.stringify(document), "bundles.json");
}

type Opinion = "matches" | "does_not_match" | "unclear" | "invalid";

function judgments(run: Run, opinions: readonly Opinion[]): readonly Judgment[] {
  const documents = opinions.map((opinion, callId) =>
    opinion === "invalid"
      ? { kind: "invalid", call_id: callId, model: "judge", answered_at_us: 1, raw_text: "{", error: "not json" }
      : {
          kind: "answer",
          call_id: callId,
          model: "judge",
          answered_at_us: 1,
          answer: { opinion, mismatches: [], summary: "checked" },
        },
  );
  return parseJudgments(JSON.stringify(documents), "judgments.json", run);
}

function checkServerKey(): void {
  assert.equal(serverKey(registryTarget.source), "npm:@modelcontextprotocol/server-filesystem");
  assert.equal(
    serverKey({ kind: "registry", ecosystem: "pypi", package: "mcp-server-git", version: "0.6.2" }),
    "pypi:mcp-server-git",
  );
  assert.equal(
    serverKey({ kind: "registry", ecosystem: "pypi", package: "mcp-server-git", version: "0.7.0" }),
    "pypi:mcp-server-git",
  );
  assert.equal(serverKey(localTarget.source), "npm:local:fixtures/detfix");
}

function checkVerdict(): void {
  const run = runFor(registryTarget);
  assert.equal(rollupVerdict(null), "incomplete");
  assert.equal(rollupVerdict([]), "pass");
  assert.equal(rollupVerdict(judgments(run, ["matches", "matches"])), "pass");
  assert.equal(rollupVerdict(judgments(run, ["matches", "unclear"])), "incomplete");
  assert.equal(rollupVerdict(judgments(run, ["matches", "does_not_match"])), "fail");
  assert.equal(rollupVerdict(judgments(run, ["invalid", "matches"])), "fail");
  assert.equal(rollupVerdict(judgments(run, ["unclear", "does_not_match"])), "fail");
  assert.equal(rollupVerdict(judgments(run, ["does_not_match", "unclear"])), "fail");
  assert.equal(rollupVerdict(judgments(run, ["unclear", "invalid"])), "fail");
}

function withSearchPath(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
}

async function rowOf(db: Db, id: string): Promise<RunRow> {
  const rows = await db.select().from(runs).where(eq(runs.id, id));
  assert.equal(rows.length, 1, `expected one row for ${id}`);
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function checkInsertAndFinish(db: Db): Promise<void> {
  const id = randomUUID();
  const startedAt = new Date("2026-09-28T05:00:00.000Z");
  await insertRun(db, { id, target: registryTarget, startedAt });
  assert.deepEqual(await rowOf(db, id), {
    id,
    targetName: "detfix",
    mcpServerName: null,
    serverKey: "npm:@modelcontextprotocol/server-filesystem",
    sourceKind: "registry",
    packageName: "@modelcontextprotocol/server-filesystem",
    packageVersion: "2025.8.21",
    ecosystem: "npm",
    downloadUrl: null,
    startedAt,
    endedAt: null,
    status: "running",
    verdict: null,
  });

  const run = runFor(registryTarget);
  const endedAt = new Date("2026-09-28T05:01:00.000Z");
  const downloadUrl = `https://runs.example/${id}.tar.gz`;
  await finishRun(db, {
    id,
    run,
    judgments: judgments(run, ["matches", "matches"]),
    downloadUrl,
    status: "succeeded",
    endedAt,
  });
  const finished = await rowOf(db, id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.verdict, "pass");
  assert.deepEqual(finished.endedAt, endedAt);
  assert.equal(finished.mcpServerName, "detfix-server");
  assert.equal(finished.downloadUrl, downloadUrl);
  assert.deepEqual(finished.startedAt, startedAt);

  await assert.rejects(
    finishRun(db, { id, run, judgments: null, downloadUrl: null, status: "failed", endedAt }),
    /has no running row to finish/,
  );
  assert.equal((await rowOf(db, id)).verdict, "pass");

  await assert.rejects(
    finishRun(db, { id: run.run_id, run, judgments: null, downloadUrl: null, status: "failed", endedAt }),
    /has no running row to finish/,
  );
}

async function checkLocalWithoutDownload(db: Db): Promise<void> {
  const id = randomUUID();
  await insertRun(db, { id, target: localTarget, startedAt: new Date() });
  const inserted = await rowOf(db, id);
  assert.equal(inserted.serverKey, "npm:local:fixtures/detfix");
  assert.equal(inserted.sourceKind, "local");
  assert.equal(inserted.packageName, null);
  assert.equal(inserted.packageVersion, null);

  const run = runFor(localTarget);
  await finishRun(db, {
    id,
    run,
    judgments: judgments(run, ["unclear", "does_not_match"]),
    downloadUrl: null,
    status: "failed",
    endedAt: new Date(),
  });
  const finished = await rowOf(db, id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.verdict, "fail");
  assert.equal(finished.downloadUrl, null);
  assert.ok(finished.endedAt instanceof Date);
}

async function checkUnjudgedAndCrashed(db: Db): Promise<void> {
  const unjudged = randomUUID();
  await insertRun(db, { id: unjudged, target: registryTarget, startedAt: new Date() });
  const run = runFor(registryTarget);
  await finishRun(db, { id: unjudged, run, judgments: null, downloadUrl: null, status: "succeeded", endedAt: new Date() });
  const judgeSkipped = await rowOf(db, unjudged);
  assert.equal(judgeSkipped.status, "succeeded");
  assert.equal(judgeSkipped.verdict, "incomplete");
  assert.equal(judgeSkipped.mcpServerName, "detfix-server");

  const crashed = randomUUID();
  await insertRun(db, { id: crashed, target: localTarget, startedAt: new Date() });
  const downloadUrl = `https://runs.example/${crashed}.tar.gz`;
  await finishRun(db, { id: crashed, run: null, downloadUrl, status: "failed", endedAt: new Date() });
  const partial = await rowOf(db, crashed);
  assert.equal(partial.status, "failed");
  assert.equal(partial.verdict, "incomplete");
  assert.equal(partial.mcpServerName, null);
  assert.equal(partial.downloadUrl, downloadUrl);
  assert.ok(partial.endedAt instanceof Date);

  const hostile = randomUUID();
  await insertRun(db, { id: hostile, target: registryTarget, startedAt: new Date() });
  const nulRun = runFor(registryTarget, "evil\0server");
  await finishRun(db, {
    id: hostile,
    run: nulRun,
    judgments: judgments(nulRun, ["matches", "matches"]),
    downloadUrl: null,
    status: "succeeded",
    endedAt: new Date(),
  });
  const named = await rowOf(db, hostile);
  assert.equal(named.status, "succeeded");
  assert.equal(named.mcpServerName, "evil\uFFFDserver");
}

function violatedCheck(error: unknown): unknown {
  let current: unknown = error;
  while (current instanceof Error) {
    if ("code" in current && "constraint" in current) {
      return current.code === "23514" ? current.constraint : `sqlstate ${String(current.code)}`;
    }
    current = current.cause;
  }
  return undefined;
}

async function checkIllegalRows(db: Db): Promise<void> {
  const legal = {
    id: "'legal'",
    target_name: "'detfix'",
    server_key: "'npm:detfix'",
    source_kind: "'registry'",
    package_name: "'detfix'",
    package_version: "'1.0.0'",
    ecosystem: "'npm'",
    started_at: "now()",
    ended_at: "null",
    status: "'running'",
    verdict: "null",
  };
  const insert = (row: typeof legal) =>
    db.execute(
      sql.raw(`insert into runs (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")})`),
    );
  const illegal: readonly [string, string, Partial<typeof legal>][] = [
    ["running with a verdict", "runs_finish_check", { verdict: "'pass'" }],
    ["running with an end", "runs_finish_check", { ended_at: "now()" }],
    ["finished without an end", "runs_finish_check", { status: "'succeeded'", verdict: "'pass'" }],
    ["finished without a verdict", "runs_finish_check", { status: "'failed'", ended_at: "now()" }],
    ["unknown status", "runs_status_check", { status: "'done'", ended_at: "now()", verdict: "'pass'" }],
    ["unknown verdict", "runs_verdict_check", { status: "'succeeded'", ended_at: "now()", verdict: "'maybe'" }],
    ["unknown ecosystem", "runs_ecosystem_check", { ecosystem: "'cargo'" }],
    ["unknown source kind", "runs_source_check", { source_kind: "'git'" }],
    ["registry without a version", "runs_source_check", { package_version: "null" }],
    ["registry without a package", "runs_source_check", { package_name: "null" }],
    ["local with a package", "runs_source_check", { source_kind: "'local'", package_version: "null" }],
    ["local with a version", "runs_source_check", { source_kind: "'local'", package_name: "null" }],
  ];
  for (const [name, constraint, change] of illegal) {
    await assert.rejects(insert({ ...legal, ...change }), (error) => {
      assert.equal(violatedCheck(error), constraint, name);
      return true;
    });
  }
  await insert(legal);
  await insert({ ...legal, id: "'local'", source_kind: "'local'", package_name: "null", package_version: "null" });
  await insert({ ...legal, id: "'done'", status: "'succeeded'", ended_at: "now()", verdict: "'incomplete'" });

  const indexes = await db.execute(
    sql`select indexdef from pg_indexes where schemaname = current_schema() and indexname = 'runs_server_key'`,
  );
  assert.equal(indexes.rows.length, 1);
  assert.match(String(indexes.rows[0]?.["indexdef"]), /\(server_key\)$/);

  const checks = await db.execute(
    sql`select conname from pg_constraint where conrelid = 'runs'::regclass and contype = 'c' order by conname`,
  );
  assert.deepEqual(
    checks.rows.map((row: Record<string, unknown>) => row["conname"]),
    [
      "runs_ecosystem_check",
      "runs_finish_check",
      "runs_source_check",
      "runs_source_kind_check",
      "runs_status_check",
      "runs_verdict_check",
    ],
  );
}

async function checkStore(url: string): Promise<void> {
  const schema = `run_store_${randomUUID().replaceAll("-", "")}`;
  const admin = openDb(url);
  await admin.db.execute(sql.raw(`create schema ${schema}`));
  const scoped = openDb(withSearchPath(url, schema));
  try {
    await migrate(scoped.db, { migrationsFolder: join(root, "db/migrations"), migrationsSchema: schema });
    await checkInsertAndFinish(scoped.db);
    await checkLocalWithoutDownload(scoped.db);
    await checkUnjudgedAndCrashed(scoped.db);
    await checkIllegalRows(scoped.db);
  } finally {
    await scoped.close();
    await admin.db.execute(sql.raw(`drop schema ${schema} cascade`));
    await admin.close();
  }
}

checkServerKey();
checkVerdict();
const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set; the store cases need Postgres");
await checkStore(url);
process.stdout.write("run-store ok\n");
