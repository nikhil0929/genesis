import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFindings, parseRun } from "../src/model.js";
import type { CallOutcome, Event, EventId, FileAccess, Finding, Run, ToolCallBundle, ToolCallEntry } from "../src/model.js";

const DECOY = "/home/detonee/.aws/credentials";
const CREATED = "/work/files/new.txt";

type DecoyTouch = {
  readonly stats: readonly Event[];
  readonly failedReadOpens: readonly Event[];
  readonly successfulReadOpens: readonly Event[];
};

function rootPid(run: Run): number {
  for (const process of Object.values(run.processes)) {
    if (process.kind === "root") return process.pid;
  }
  assert.fail("missing root process");
}

function stringArgument(call: ToolCallBundle, name: string): string | null {
  const value = call.arguments[name];
  return typeof value === "string" ? value : null;
}

function scenarioShape(call: ToolCallBundle): { readonly tool: string; readonly path: string | null; readonly content: string | null } {
  return {
    tool: call.tool,
    path: stringArgument(call, "path"),
    content: stringArgument(call, "content"),
  };
}

function errorOutcome(outcome: CallOutcome): "reply" | "rpc_error" | null {
  switch (outcome.kind) {
    case "reply":
      return outcome.is_error ? "reply" : null;
    case "rpc_error":
      return "rpc_error";
    case "no_reply":
      return null;
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

function readsFile(access: FileAccess): boolean {
  switch (access) {
    case "read":
    case "read_write":
      return true;
    case "write":
      return false;
    default: {
      const unreachable: never = access;
      return unreachable;
    }
  }
}

function assertResultPresent(result: Event["result"]): void {
  switch (result.kind) {
    case "ok":
    case "error":
    case "no_return":
      return;
    default: {
      const unreachable: never = result;
      throw new Error(String(unreachable));
    }
  }
}

function decoyTouch(call: ToolCallBundle): DecoyTouch {
  const stats: Event[] = [];
  const failedReadOpens: Event[] = [];
  const successfulReadOpens: Event[] = [];
  for (const entry of call.events) {
    if (entry.event.body.kind !== "file") continue;
    const action = entry.event.body.action;
    if (action.kind === "stat" && action.path === DECOY) {
      stats.push(entry.event);
      continue;
    }
    if (action.kind !== "open" || action.path !== DECOY || !readsFile(action.access)) continue;
    if (entry.event.result.kind === "ok") successfulReadOpens.push(entry.event);
    else failedReadOpens.push(entry.event);
  }
  return { stats, failedReadOpens, successfulReadOpens };
}

function decoyLabel(touch: DecoyTouch): "stat" | "failed_open" | "absent" | "stat+failed_open" {
  if (touch.stats.length > 0 && touch.failedReadOpens.length > 0) return "stat+failed_open";
  if (touch.stats.length > 0) return "stat";
  if (touch.failedReadOpens.length > 0) return "failed_open";
  return "absent";
}

function bundleEntry(call: ToolCallBundle, eventId: EventId): ToolCallEntry {
  for (const item of call.events) {
    if (item.event.event_id === eventId) return item;
  }
  assert.fail(`file_modified evidence ${eventId} is missing from the write_file bundle`);
}

function citesCredential(findings: readonly Finding[], call: ToolCallBundle, event: Event): boolean {
  return findings.some(
    (finding) =>
      finding.kind === "call" &&
      finding.call_id === call.call_id &&
      finding.rule === "credential_access" &&
      finding.subject.kind === "path" &&
      finding.subject.path === DECOY &&
      finding.evidence.includes(event.event_id),
  );
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["dist/src/cli.js", "detonate", "targets/server-filesystem.toml", "--no-judge"],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
  },
);
assert.equal(result.status, 0, result.stderr || result.stdout);
const runDir = result.stdout.trim().split("\n").at(-1) ?? "";
const bundlesPath = join(runDir, "bundles.json");
const findingsPath = join(runDir, "findings.json");
const run = parseRun(readFileSync(bundlesPath, "utf8"), bundlesPath);
const findings = parseFindings(readFileSync(findingsPath, "utf8"), findingsPath, run);

const scenario = run.tool_calls.filter((call) => call.argument_source.kind === "scenario");
assert.deepEqual(scenario.map(scenarioShape), [
  { tool: "list_allowed_directories", path: null, content: null },
  { tool: "read_text_file", path: "/work/files/a.txt", content: null },
  { tool: "write_file", path: CREATED, content: "created by mcpdet" },
  { tool: "read_text_file", path: DECOY, content: null },
]);

const write = scenario[2];
assert.ok(write, "missing write_file scenario call");
const modified = findings.find(
  (finding) =>
    finding.kind === "call" &&
    finding.call_id === write.call_id &&
    finding.rule === "file_modified" &&
    finding.subject.kind === "path" &&
    finding.subject.path === CREATED,
);
assert.ok(modified, "write_file is missing file_modified for /work/files/new.txt");
const serverPid = rootPid(run);
for (const eventId of modified.evidence) {
  const entry = bundleEntry(write, eventId);
  assert.equal(entry.event.pid, serverPid, `${eventId} pid`);
  assert.equal(entry.link.kind, "overlap", `${eventId} link`);
}

const denied = scenario[3];
assert.ok(denied, "missing out-of-bounds read_text_file scenario call");
const outcomeKind = errorOutcome(denied.outcome);
assert.ok(outcomeKind, `out-of-bounds read outcome ${denied.outcome.kind}`);
const touch = decoyTouch(denied);
assert.deepEqual(touch.successfulReadOpens.map((event) => event.event_id), []);
for (const event of touch.stats) {
  assertResultPresent(event.result);
  assert.equal(citesCredential(findings, denied, event), true, `${event.event_id} has no credential_access finding`);
}

console.log(`out_of_bounds_outcome=${outcomeKind}`);
console.log(`decoy_touch=${decoyLabel(touch)}`);
