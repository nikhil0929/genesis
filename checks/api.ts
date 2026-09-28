import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";

import { buildServer } from "../src/app/api.js";
import type { RunOutcome, RunRow, RunsDeps } from "../src/app/routes/runs.js";
import type { Target } from "../src/model.js";

const TOKEN = "check-token";
process.env["MCPDET_API_TOKEN"] = TOKEN;
const auth = { authorization: `Bearer ${TOKEN}` };

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
};

function fake(runsDir: string): Fake {
  const state: Fake = {
    calls: [],
    inserted: [],
    finished: [],
    rows: new Map(),
    archive: new Map(),
    detonation: deferred(),
    settled: deferred(),
    deps: {
      runsDir,
      insertRun: async (id, target) => {
        state.calls.push(`insert ${id}`);
        state.inserted.push(target);
        state.rows.set(id, { id, status: "running" });
      },
      getRun: async (id) => state.rows.get(id) ?? null,
      finishRun: async (id, outcome) => {
        state.calls.push(`finish ${id} ${outcome.status}`);
        state.finished.push(outcome);
        state.rows.set(id, { id, status: outcome.status });
      },
      uploadRun: async (id, runDir) => {
        assert.equal(runDir, join(runsDir, id));
        state.calls.push(`upload ${id}`);
      },
      readArchive: async (id, name) => state.archive.get(`${id}/${name}`) ?? null,
      deleteLocalRun: async (runDir) => {
        state.calls.push(`delete ${runDir}`);
        state.settled.resolve();
      },
      runDetonation: async (id, _target, runDir) => {
        assert.equal(runDir, join(runsDir, id));
        state.calls.push(`detonate ${id}`);
        await state.detonation.promise;
      },
    },
  };
  return state;
}

function idOf(payload: string): string {
  const value: unknown = JSON.parse(payload);
  assert.ok(typeof value === "object" && value !== null && "id" in value && typeof value.id === "string");
  return value.id;
}

const runsDir = mkdtempSync(join(tmpdir(), "mcpdet-api-"));
try {
  const state = fake(runsDir);
  const app = await buildServer(state.deps);

  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: `Basic ${TOKEN}` }]) {
    const denied = await app.inject({ method: "POST", url: "/runs", headers, payload: body });
    assert.equal(denied.statusCode, 401);
  }
  assert.equal((await app.inject({ method: "GET", url: `/runs/${crypto.randomUUID()}` })).statusCode, 401);
  assert.deepEqual(state.calls, []);

  const invalid = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: { name: "detfix" } });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(state.calls, []);

  const accepted = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: body });
  assert.equal(accepted.statusCode, 202);
  const id = idOf(accepted.payload);
  assert.deepEqual(JSON.parse(accepted.payload), { id, status: "running" });
  assert.equal(state.inserted[0]?.source.kind === "local" && state.inserted[0].source.path, "fixtures/detfix");
  await tick();
  assert.deepEqual(state.calls, [`insert ${id}`, `detonate ${id}`]);
  assert.deepEqual(state.finished, []);

  const busy = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: body });
  assert.equal(busy.statusCode, 409);
  assert.equal(idOf(busy.payload), id);
  assert.match(JSON.parse(busy.payload).error, new RegExp(id));

  const running = await app.inject({ method: "GET", url: `/runs/${id}`, headers: auth });
  assert.equal(running.statusCode, 200);
  assert.deepEqual(JSON.parse(running.payload), { run: { id, status: "running" }, judgments: null });

  state.archive.set(`${id}/bundles.json`, JSON.stringify(runDocument));
  state.archive.set(`${id}/judgments.json`, JSON.stringify(judgments));
  state.detonation.resolve();
  await state.settled.promise;
  await tick();
  assert.deepEqual(state.calls.slice(2), [`upload ${id}`, `finish ${id} succeeded`, `delete ${join(runsDir, id)}`]);

  const finished = await app.inject({ method: "GET", url: `/runs/${id}`, headers: auth });
  assert.equal(finished.statusCode, 200);
  assert.deepEqual(JSON.parse(finished.payload), { run: { id, status: "succeeded" }, judgments });

  const missing = await app.inject({ method: "GET", url: `/runs/${crypto.randomUUID()}`, headers: auth });
  assert.equal(missing.statusCode, 404);

  state.calls.length = 0;
  state.detonation = deferred();
  state.settled = deferred();
  const second = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: body });
  assert.equal(second.statusCode, 202);
  const failedId = idOf(second.payload);
  await tick();
  mkdirSync(join(runsDir, failedId));
  state.detonation.reject(new Error("write EPIPE"));
  await state.settled.promise;
  await tick();
  assert.deepEqual(state.calls, [
    `insert ${failedId}`,
    `detonate ${failedId}`,
    `upload ${failedId}`,
    `finish ${failedId} failed`,
    `delete ${join(runsDir, failedId)}`,
  ]);
  assert.deepEqual(state.finished.at(-1), { status: "failed", verdict: "incomplete" });

  const failed = await app.inject({ method: "GET", url: `/runs/${failedId}`, headers: auth });
  assert.equal(failed.statusCode, 200);
  assert.deepEqual(JSON.parse(failed.payload), { run: { id: failedId, status: "failed" }, judgments: null });

  state.calls.length = 0;
  state.detonation = deferred();
  state.settled = deferred();
  const third = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: body });
  const emptyId = idOf(third.payload);
  await tick();
  state.detonation.reject(new Error("image build failed"));
  await state.settled.promise;
  assert.deepEqual(state.calls, [
    `insert ${emptyId}`,
    `detonate ${emptyId}`,
    `finish ${emptyId} failed`,
    `delete ${join(runsDir, emptyId)}`,
  ]);

  await app.close();
} finally {
  rmSync(runsDir, { recursive: true, force: true });
}

process.stdout.write("api check passed\n");
