import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterReply,
  assertExactPlacement,
  clockPassed,
  outlivedReply,
  ownedProcesses,
  parseRun,
} from "../src/model.js";
import type { Event, ToolCallBundle } from "../src/model.js";
import { readEnvelope } from "../src/engine/host-seal.js";
import { readSensors } from "../src/engine/sensors/index.js";

function isFileWrite(event: Event): boolean {
  switch (event.body.kind) {
    case "data":
      return event.body.target.kind === "file";
    case "file":
      switch (event.body.action.kind) {
        case "open":
          return event.body.action.access === "write" || event.body.action.access === "read_write";
        case "rename":
        case "link":
        case "symlink":
        case "unlink":
        case "mkdir":
        case "rmdir":
        case "chmod":
        case "chown":
        case "truncate":
        case "mknod":
          return true;
        case "stat":
        case "access":
        case "readlink":
        case "chdir":
        case "utime":
        case "xattr":
        case "other":
          return false;
        default: {
          const unreachable: never = event.body.action;
          return unreachable;
        }
      }
    case "process":
    case "net":
    case "other":
      return false;
    default: {
      const unreachable: never = event.body;
      return unreachable;
    }
  }
}

function pathsOf(event: Event): readonly string[] {
  switch (event.body.kind) {
    case "file":
      switch (event.body.action.kind) {
        case "rename":
        case "link":
        case "symlink":
          return [event.body.action.path, event.body.action.second_path];
        case "open":
        case "stat":
        case "access":
        case "readlink":
        case "unlink":
        case "mkdir":
        case "rmdir":
        case "chmod":
        case "chown":
        case "truncate":
        case "utime":
        case "chdir":
        case "mknod":
        case "xattr":
        case "other":
          return [event.body.action.path];
        default: {
          const unreachable: never = event.body.action;
          return unreachable;
        }
      }
    case "data":
      return event.body.target.kind === "file" ? [event.body.target.path] : [];
    case "process":
      return event.body.action.kind === "exec" ? [event.body.action.path] : [];
    case "net":
    case "other":
      return [];
    default: {
      const unreachable: never = event.body;
      return unreachable;
    }
  }
}

function callNamed(calls: readonly ToolCallBundle[], name: string): ToolCallBundle {
  const call = calls.find((item) => item.tool === name);
  assert.ok(call, `missing ${name} call`);
  return call;
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const result = spawnSync(process.execPath, ["dist/src/app/cli.js", "detonate", "targets/detfix.toml"], {
  cwd: root,
  encoding: "utf8",
  timeout: 600_000,
});
assert.equal(result.status, 0, result.stderr || result.stdout);
const runDir = result.stdout.trim().split("\n").at(-1) ?? "";
const bundlesPath = join(runDir, "bundles.json");
const run = parseRun(readFileSync(bundlesPath, "utf8"), bundlesPath);
const { events } = readSensors(runDir, readEnvelope(runDir).network);

const echo = callNamed(run.tool_calls, "echo");
for (const entry of echo.events) {
  if (entry.event.body.kind === "process" && entry.event.body.action.kind === "spawn") {
    assert.fail(`echo has spawn ${entry.event.event_id}`);
  }
  if (entry.event.body.kind === "net") assert.fail(`echo has network ${entry.event.event_id}`);
  assert.equal(isFileWrite(entry.event), false, `echo has file write ${entry.event.event_id}`);
}

const linger = callNamed(run.tool_calls, "spawn_and_linger");
const exec = linger.events.find(
  (entry) =>
    entry.event.body.kind === "process" &&
    entry.event.body.action.kind === "exec" &&
    entry.event.result.kind === "ok" &&
    entry.event.body.action.path.endsWith("/sh") &&
    entry.link.kind === "owned",
);
assert.ok(exec, "spawn_and_linger is missing an owned sh exec");
const lingerWrite = linger.events.find(
  (entry) => entry.link.kind === "owned" && pathsOf(entry.event).includes("/tmp/linger.txt") && isFileWrite(entry.event),
);
assert.ok(lingerWrite, "spawn_and_linger is missing an owned /tmp/linger.txt write");
assert.equal(afterReply(linger, lingerWrite), true);
const child = ownedProcesses(run, linger).find((process) => process.execs.some((item) => item.path.endsWith("/sh")));
assert.ok(child, "spawn_and_linger owns no sh process");
assert.equal(outlivedReply(linger, child), true);

const delayedCall = callNamed(run.tool_calls, "delayed_write");
const delayed = run.unmatched.filter((entry) => pathsOf(entry.event).includes("/tmp/delayed.txt"));
assert.ok(delayed.length > 0, "no /tmp/delayed.txt event");
for (const entry of delayed) {
  assert.equal(entry.reason.kind, "between_windows");
  if (entry.reason.kind !== "between_windows") continue;
  assert.equal(entry.reason.preceded_by.kind, "call");
  if (entry.reason.preceded_by.kind !== "call") continue;
  assert.equal(entry.reason.preceded_by.call_id, delayedCall.call_id);
}

const conf = run.startup.events.find(
  (entry) =>
    entry.event.body.kind === "file" &&
    entry.event.body.action.kind === "open" &&
    entry.event.body.action.path === "/work/detfix.conf" &&
    entry.event.body.action.access === "read",
);
assert.ok(conf, "startup is missing the read of /work/detfix.conf");

assert.equal(assertExactPlacement(events, run, bundlesPath), events.length);
assert.equal(
  clockPassed(run.clock_check),
  true,
  `max_violation_us=${String(run.clock_check.max_violation_us)} responses_checked=${String(run.clock_check.responses_checked)}`,
);
