import { spawn } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { DriverPlan, DriverTimelineEntry, JsonObject, JsonValue, RpcSummary } from "./model.js";

type ListedTool = {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
};

type StampedLine = {
  readonly line: string;
  readonly tUs: number;
};

// The host ran parsePlan on this file before copying it in.
function readPlan(planPath: string): DriverPlan {
  const value: unknown = JSON.parse(readFileSync(planPath, "utf8"));
  return value as DriverPlan;
}

function nowUs(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function summarize(
  line: string,
): RpcSummary | { readonly kind: "invalid"; readonly reason: "not_json" | "not_jsonrpc" } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: "not_json" };
  }
  const message = recordOf(value);
  if (message === null || message.jsonrpc !== "2.0") return { kind: "invalid", reason: "not_jsonrpc" };
  if (typeof message.method === "string") {
    if (typeof message.id === "number" || typeof message.id === "string") {
      return { kind: "request", id: message.id, method: message.method };
    }
    return { kind: "notification", method: message.method };
  }
  if ("result" in message && (typeof message.id === "number" || typeof message.id === "string")) {
    return { kind: "result", id: message.id };
  }
  const error = recordOf(message.error);
  if (error !== null && typeof error.code === "number" && typeof error.message === "string") {
    const id = message.id;
    if (id === null || typeof id === "number" || typeof id === "string") {
      return { kind: "error", id, code: error.code, message: error.message };
    }
  }
  return { kind: "invalid", reason: "not_jsonrpc" };
}

function requestLine(id: number, method: string, params: JsonObject | undefined): string {
  const message: Record<string, JsonValue> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) message.params = params;
  return JSON.stringify(message);
}

function probeValue(schema: unknown): JsonValue {
  const record = recordOf(schema);
  if (record === null) return "mcpdet-probe";
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    const first = record.enum[0];
    if (first !== undefined && (first === null || typeof first !== "object")) return first;
  }
  const variants = record.anyOf ?? record.oneOf;
  if (Array.isArray(variants) && variants[0] !== undefined) return probeValue(variants[0]);
  switch (record.type) {
    case "string":
      return "mcpdet-probe";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return probeObject(record);
    default:
      return "mcpdet-probe";
  }
}

function probeObject(schema: Record<string, unknown>): JsonObject {
  const properties = recordOf(schema.properties);
  if (properties === null || !Array.isArray(schema.required)) return {};
  const args: Record<string, JsonValue> = {};
  for (const key of schema.required) {
    if (typeof key !== "string") continue;
    const property = properties[key];
    if (property !== undefined) args[key] = probeValue(property);
  }
  return args;
}

function toolsFromResult(line: string): { readonly tools: readonly ListedTool[]; readonly nextCursor: string | null } {
  const message = recordOf(JSON.parse(line));
  const result = recordOf(message?.result);
  if (result === null || !Array.isArray(result.tools)) throw new Error("tools/list result has no tools array");
  const tools: ListedTool[] = [];
  for (const item of result.tools) {
    const tool = recordOf(item);
    if (tool === null || typeof tool.name !== "string") throw new Error("tools/list entry has no name");
    tools.push({ name: tool.name, inputSchema: recordOf(tool.inputSchema) ?? {} });
  }
  return { tools, nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null };
}

function advertises(line: string, feature: "resources" | "prompts"): boolean {
  const message = recordOf(JSON.parse(line));
  const capabilities = recordOf(recordOf(message?.result)?.capabilities);
  return capabilities !== null && capabilities[feature] !== undefined;
}

class LineQueue {
  private readonly lines: StampedLine[] = [];
  private readonly waiters: ((line: StampedLine | null) => void)[] = [];
  private closed = false;

  push(line: StampedLine): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(line);
    else this.lines.push(line);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  next(timeoutMs: number): Promise<StampedLine | null | "timeout"> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(finish);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve("timeout");
      }, timeoutMs);
      const finish = (line: StampedLine | null): void => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiters.push(finish);
    });
  }
}

export async function runDriver(planPath: string): Promise<void> {
  const plan = readPlan(planPath);
  const transcript = openSync("/transcript.jsonl", "w");
  const stderrLog = openSync("/stderr.log", "w");
  const record = (entry: DriverTimelineEntry): void => {
    writeSync(transcript, `${JSON.stringify(entry)}\n`);
  };
  const child = spawn(
    "strace",
    [
      "-ff",
      "-ttt",
      "-yy",
      "-v",
      "-x",
      "-s",
      "4096",
      "--seccomp-bpf",
      "-u",
      "detonee",
      "-o",
      "/trace/t",
      "-e",
      "trace=%process,%file,%network,write,writev,pwrite64,io_uring_setup",
      "--",
      ...plan.server_command,
    ],
    {
      cwd: "/work",
      env: {
        PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/home/detonee",
        USER: "detonee",
        LOGNAME: "detonee",
        ...plan.server_env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const queue = new LineQueue();
  let stdoutBuf = "";
  let stderrBuf = "";
  let exitRecorded = false;
  let nextId = 1;
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdin === null || stdout === null || stderr === null) throw new Error("strace stdio is not piped");

  const exited = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      setImmediate(() => {
        if (stdoutBuf.length > 0) queue.push({ line: stdoutBuf, tUs: nowUs() });
        stdoutBuf = "";
        if (stderrBuf.length > 0) writeSync(stderrLog, `${String(nowUs())} ${stderrBuf}\n`);
        stderrBuf = "";
        if (!exitRecorded) {
          exitRecorded = true;
          const end =
            signal !== null
              ? { kind: "killed" as const, signal }
              : { kind: "exited" as const, status: code ?? 0 };
          record({ kind: "server_exited", t_us: nowUs(), end });
        }
        queue.close();
        resolve();
      });
    });
  });

  stdout.on("data", (chunk: Buffer) => {
    const tUs = nowUs();
    stdoutBuf += chunk.toString("utf8");
    let newline = stdoutBuf.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuf.slice(0, newline);
      stdoutBuf = stdoutBuf.slice(newline + 1);
      if (line.length > 0) queue.push({ line, tUs });
      newline = stdoutBuf.indexOf("\n");
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
    let newline = stderrBuf.indexOf("\n");
    while (newline !== -1) {
      writeSync(stderrLog, `${String(nowUs())} ${stderrBuf.slice(0, newline)}\n`);
      stderrBuf = stderrBuf.slice(newline + 1);
      newline = stderrBuf.indexOf("\n");
    }
  });

  const sendLine = (text: string): Promise<number> =>
    new Promise((resolve, reject) => {
      stdin.write(`${text}\n`, "utf8", (error) => {
        if (error) reject(error);
        else resolve(nowUs());
      });
    });

  const recordInbound = (stamped: StampedLine): void => {
    const summary = summarize(stamped.line);
    if (summary.kind === "invalid") {
      record({ kind: "invalid_line", t_us: stamped.tUs, raw: stamped.line, reason: summary.reason });
      return;
    }
    record({ kind: "message", direction: "from_server", t_us: stamped.tUs, raw: stamped.line, rpc: summary });
  };

  const waitForReply = async (id: number): Promise<string | null> => {
    const deadline = Date.now() + plan.call_timeout_ms;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        record({ kind: "call_timeout", t_us: nowUs(), call_id: id });
        return null;
      }
      const stamped = await queue.next(remaining);
      if (stamped === "timeout") {
        record({ kind: "call_timeout", t_us: nowUs(), call_id: id });
        return null;
      }
      if (stamped === null) return null;
      recordInbound(stamped);
      const summary = summarize(stamped.line);
      if (summary.kind === "invalid") continue;
      if ((summary.kind === "result" || summary.kind === "error") && summary.id === id) return stamped.line;
      if (summary.kind === "request") {
        const raw = JSON.stringify({
          jsonrpc: "2.0",
          id: summary.id,
          error: { code: -32601, message: "Method not found" },
        });
        const tUs = await sendLine(raw);
        record({
          kind: "message",
          direction: "to_server",
          t_us: tUs,
          raw,
          rpc: { kind: "error", id: summary.id, code: -32601, message: "Method not found" },
        });
      }
    }
  };

  const settle = async (): Promise<boolean> => {
    if (exitRecorded) return false;
    const winner = await Promise.race([
      delay(plan.settle_ms).then(() => "ok" as const),
      exited.then(() => "exited" as const),
    ]);
    return winner === "ok" && !exitRecorded;
  };

  const exchange = async (method: string, params: JsonObject | undefined): Promise<string | null> => {
    const id = nextId;
    nextId += 1;
    const raw = requestLine(id, method, params);
    const tUs = await sendLine(raw);
    record({ kind: "message", direction: "to_server", t_us: tUs, raw, rpc: { kind: "request", id, method } });
    return waitForReply(id);
  };

  const listPages = async (method: "resources/list" | "prompts/list"): Promise<boolean> => {
    let cursor: string | null = null;
    for (;;) {
      const page = await exchange(method, cursor === null ? {} : { cursor });
      if (page === null) return false;
      const next = recordOf(recordOf(JSON.parse(page))?.result)?.nextCursor;
      if (typeof next !== "string") return true;
      cursor = next;
      if (!(await settle())) return false;
    }
  };

  try {
    const initialized = await exchange("initialize", {
      protocolVersion: plan.protocol_version,
      capabilities: {},
      clientInfo: { name: plan.client_name, version: "0.0.0" },
    });
    if (initialized === null) return;
    const notified = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const notifiedAt = await sendLine(notified);
    record({
      kind: "message",
      direction: "to_server",
      t_us: notifiedAt,
      raw: notified,
      rpc: { kind: "notification", method: "notifications/initialized" },
    });
    if (!(await settle())) return;

    const listed: ListedTool[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await exchange("tools/list", cursor === null ? {} : { cursor });
      if (page === null) return;
      const parsed = toolsFromResult(page);
      listed.push(...parsed.tools);
      if (parsed.nextCursor === null) break;
      cursor = parsed.nextCursor;
      if (!(await settle())) return;
    }
    if (!(await settle())) return;
    if (advertises(initialized, "resources") && !(await listPages("resources/list"))) return;
    if (advertises(initialized, "resources") && !(await settle())) return;
    if (advertises(initialized, "prompts") && !(await listPages("prompts/list"))) return;
    if (advertises(initialized, "prompts") && !(await settle())) return;

    const called = new Set(plan.scenario.map((entry) => entry.tool));
    for (const entry of plan.scenario) {
      const reply = await exchange("tools/call", { name: entry.tool, arguments: entry.arguments });
      if (reply === null || !(await settle())) return;
    }
    for (const tool of listed) {
      if (called.has(tool.name)) continue;
      const reply = await exchange("tools/call", {
        name: tool.name,
        arguments: probeObject(tool.inputSchema),
      });
      if (reply === null || !(await settle())) return;
    }
  } finally {
    if (!exitRecorded) {
      const tUs = nowUs();
      stdin.end();
      record({ kind: "stdin_closed", t_us: tUs });
    }
    await Promise.race([exited, delay(plan.shutdown_wait_ms)]);
    if (!exitRecorded) {
      child.kill("SIGKILL");
      await Promise.race([exited, delay(1_000)]);
    }
    fsyncSync(transcript);
    fsyncSync(stderrLog);
    closeSync(transcript);
    closeSync(stderrLog);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const planPath = process.argv[2];
  if (planPath === undefined) process.exit(1);
  runDriver(planPath)
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
