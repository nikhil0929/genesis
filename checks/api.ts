import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as tick } from "node:timers/promises";

import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/app/api.js";
import type { RunOutcome, RunRow, RunsDeps } from "../src/app/routes/runs.js";
import type { Target } from "../src/model.js";

const body = {
  name: "detfix",
  source: { kind: "local", ecosystem: "npm", path: "./fixtures/../fixtures/detfix" },
  base_image: "node:24",
  source_path: "/src",
  command: ["node", "server.js"],
};

const runDocument = {
  run_id: "api-1",
  target: {
    name: "detfix",
    source: { kind: "local", ecosystem: "npm", path: "fixtures/detfix" },
    image_id: "sha256:abc",
    command: ["node", "server.js"],
  },
  network: { kind: "block" },
  canaries: [],
  timeline: [],
  clock_check: { max_violation_us: 0, responses_checked: 1 },
  processes: {
    "10": { kind: "root", pid: 10, threads: [], execs: [], end: { kind: "alive_at_teardown" }, owner: { kind: "server" } },
  },
  startup: {
    kind: "startup",
    window: { start_us: 0, duration_us: 100 },
    messages: [],
    server_info: { name: "detfix", version: "1.0.0", protocol_version: "2025-11-25", capabilities: {} },
    advertised_tools: [],
    events: [],
  },
  tool_calls: [
    {
      kind: "tool_call",
      call_id: 0,
      tool: "echo",
      definition: { kind: "not_advertised" },
      arguments: {},
      argument_source: { kind: "schema_probe" },
      sent_us: 100,
      outcome: { kind: "reply", duration_us: 10, content: [], is_error: false },
      events: [],
    },
  ],
  shutdown: { kind: "shutdown", trigger: { kind: "stdin_closed", t_us: 200 }, duration_us: 10, events: [] },
  unmatched: [],
};

const judgments = [
  {
    kind: "answer",
    call_id: 0,
    model: "judge-model",
    answered_at_us: 300,
    answer: { opinion: "matches", mismatches: [], summary: "The call did what it said." },
  },
];

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void; readonly reject: (error: Error) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Fake = {
  readonly deps: RunsDeps;
  readonly calls: string[];
  readonly inserted: Target[];
  readonly finished: RunOutcome[];
  readonly rows: Map<string, RunRow>;
  readonly archive: Map<string, string>;
  detonation: Deferred;
  settled: Deferred;
  inserting: Deferred;
  insertGate: Promise<void>;
  uploadError: Error | null;
  finishError: Error | null;
};

function fake(): Fake {
  const state: Fake = {
    calls: [],
    inserted: [],
    finished: [],
    rows: new Map(),
    archive: new Map(),
    detonation: deferred(),
    settled: deferred(),
    inserting: deferred(),
    insertGate: Promise.resolve(),
    uploadError: null,
    finishError: null,
    deps: {
      insertRun: async (id, target) => {
        state.calls.push(`insert ${id}`);
        state.inserting.resolve();
        await state.insertGate;
        state.inserted.push(target);
        state.rows.set(id, { id, status: "running", verdict: null });
      },
      getRun: async (id) => state.rows.get(id) ?? null,
      finishRun: async (id, outcome) => {
        state.calls.push(`finish ${id} ${outcome.status}`);
        state.finished.push(outcome);
        const verdict = outcome.status === "failed" ? outcome.verdict : "clean";
        state.rows.set(id, { id, status: outcome.status, verdict });
        state.settled.resolve();
        if (state.finishError !== null) throw state.finishError;
      },
      uploadRun: async (runDir, id) => {
        assert.equal(runDir, resolve("runs", id));
        state.calls.push(`upload ${id}`);
        if (state.uploadError !== null) throw state.uploadError;
      },
      readArchive: async (id, name) => state.archive.get(`${id}/${name}`) ?? null,
      deleteLocalRun: async (runDir) => {
        state.calls.push(`delete ${runDir}`);
      },
      runDetonation: async (id, _target, runDir) => {
        assert.equal(runDir, resolve("runs", id));
        state.calls.push(`detonate ${id}`);
        await state.detonation.promise;
      },
    },
  };
  return state;
}

function reset(state: Fake): void {
  state.calls.length = 0;
  state.detonation = deferred();
  state.settled = deferred();
  state.inserting = deferred();
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  assert.fail("condition never held");
}

async function accept(app: FastifyInstance): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/runs", payload: body });
  assert.equal(response.statusCode, 202);
  await tick();
  return idOf(response.payload);
}

function idOf(payload: string): string {
  const value: unknown = JSON.parse(payload);
  assert.ok(typeof value === "object" && value !== null && "id" in value && typeof value.id === "string");
  return value.id;
}

const home = process.cwd();
const workDir = mkdtempSync(join(tmpdir(), "mcpdet-api-"));
process.chdir(workDir);
try {
  const state = fake();
  const app = await buildServer(state.deps);

  const invalid = await app.inject({ method: "POST", url: "/runs", payload: { name: "detfix" } });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(state.calls, []);

  const accepted = await app.inject({ method: "POST", url: "/runs", payload: body });
  assert.equal(accepted.statusCode, 202);
  const id = idOf(accepted.payload);
  assert.deepEqual(JSON.parse(accepted.payload), { id, status: "running" });
  assert.equal(state.inserted[0]?.source.kind === "local" && state.inserted[0].source.path, "fixtures/detfix");
  await tick();
  assert.deepEqual(state.calls, [`insert ${id}`, `detonate ${id}`]);
  assert.deepEqual(state.finished, []);

  const busy = await app.inject({ method: "POST", url: "/runs", payload: body });
  assert.equal(busy.statusCode, 409);
  assert.equal(idOf(busy.payload), id);
  assert.match(JSON.parse(busy.payload).error, new RegExp(id));

  const running = await app.inject({ method: "GET", url: `/runs/${id}` });
  assert.equal(running.statusCode, 200);
  assert.deepEqual(JSON.parse(running.payload), { run: { id, status: "running", verdict: null }, judgments: null });

  state.archive.set(`${id}/bundles.json`, JSON.stringify(runDocument));
  state.archive.set(`${id}/judgments.json`, JSON.stringify(judgments));
  state.detonation.resolve();
  await state.settled.promise;
  await tick();
  assert.deepEqual(state.calls.slice(2), [`upload ${id}`, `finish ${id} succeeded`, `delete ${resolve("runs", id)}`]);

  const finished = await app.inject({ method: "GET", url: `/runs/${id}` });
  assert.equal(finished.statusCode, 200);
  assert.deepEqual(JSON.parse(finished.payload), { run: { id, status: "succeeded", verdict: "clean" }, judgments });

  const missing = await app.inject({ method: "GET", url: `/runs/${crypto.randomUUID()}` });
  assert.equal(missing.statusCode, 404);

  reset(state);
  const quietId = await accept(app);
  state.detonation.resolve();
  await state.settled.promise;
  await tick();
  const quiet = await app.inject({ method: "GET", url: `/runs/${quietId}` });
  assert.equal(quiet.statusCode, 200);
  assert.deepEqual(JSON.parse(quiet.payload), { run: { id: quietId, status: "succeeded", verdict: "clean" }, judgments: null });

  reset(state);
  const failedId = await accept(app);
  mkdirSync(resolve("runs", failedId), { recursive: true });
  state.detonation.reject(new Error("write EPIPE"));
  await state.settled.promise;
  await tick();
  assert.deepEqual(state.calls, [
    `insert ${failedId}`,
    `detonate ${failedId}`,
    `upload ${failedId}`,
    `finish ${failedId} failed`,
    `delete ${resolve("runs", failedId)}`,
  ]);
  assert.deepEqual(state.finished.at(-1), { status: "failed", verdict: "incomplete" });

  const failed = await app.inject({ method: "GET", url: `/runs/${failedId}` });
  assert.equal(failed.statusCode, 200);
  assert.deepEqual(JSON.parse(failed.payload), { run: { id: failedId, status: "failed", verdict: "incomplete" }, judgments: null });

  reset(state);
  const emptyId = await accept(app);
  state.detonation.reject(new Error("image build failed"));
  await state.settled.promise;
  await tick();
  assert.deepEqual(state.calls, [
    `insert ${emptyId}`,
    `detonate ${emptyId}`,
    `finish ${emptyId} failed`,
    `delete ${resolve("runs", emptyId)}`,
  ]);

  reset(state);
  state.uploadError = new Error("archive unavailable");
  const keptId = await accept(app);
  state.detonation.resolve();
  await waitFor(() => state.calls.includes(`upload ${keptId}`));
  await tick();
  assert.deepEqual(state.calls, [`insert ${keptId}`, `detonate ${keptId}`, `upload ${keptId}`]);
  state.uploadError = null;

  reset(state);
  state.finishError = new Error("database unavailable");
  const unrecordedId = await accept(app);
  state.detonation.resolve();
  await state.settled.promise;
  await tick();
  assert.deepEqual(state.calls, [
    `insert ${unrecordedId}`,
    `detonate ${unrecordedId}`,
    `upload ${unrecordedId}`,
    `finish ${unrecordedId} succeeded`,
  ]);
  state.finishError = null;

  reset(state);
  const gate = deferred();
  state.insertGate = gate.promise;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  const connection = once(app.server, "connection");
  const aborted = request({ host: "127.0.0.1", port: address.port, method: "POST", path: "/runs" });
  aborted.setHeader("content-type", "application/json");
  aborted.on("error", () => {});
  aborted.end(JSON.stringify(body));
  const [socket] = (await connection) as [Socket];
  await state.inserting.promise;
  aborted.destroy();
  await once(socket, "close");
  gate.resolve();
  await waitFor(() => state.calls.some((call) => call.startsWith("detonate ")));
  state.detonation.resolve();
  await state.settled.promise;
  await tick();
  state.insertGate = Promise.resolve();
  const after = await app.inject({ method: "POST", url: "/runs", payload: body });
  assert.equal(after.statusCode, 202);

  await app.close();
} finally {
  process.chdir(home);
  rmSync(workDir, { recursive: true, force: true });
}

process.stdout.write("api check passed\n");
