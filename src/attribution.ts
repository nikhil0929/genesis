import {
  CLOCK_TOLERANCE_US,
  parseCallToolResult,
  parseInitializeResult,
  parseRun,
  parseToolsPage,
} from "./model.js";
import type { Event, Run, TimelineEntry, TimelineMessage, ToolDefinition } from "./model.js";
import type { RunEnvelope } from "./sandbox.js";
import type { SensorTrace } from "./sensors/index.js";

export type AttributionInput = {
  readonly events: SensorTrace["events"];
  readonly processes: SensorTrace["processes"];
  readonly timeline: readonly TimelineEntry[];
  readonly envelope: RunEnvelope;
};

type Predecessor = { readonly kind: "startup" } | { readonly kind: "call"; readonly call_id: number };

type Outcome =
  | { readonly kind: "reply"; readonly duration_us: number; readonly content: readonly unknown[]; readonly is_error: boolean }
  | { readonly kind: "rpc_error"; readonly duration_us: number; readonly code: number; readonly message: string }
  | { readonly kind: "no_reply"; readonly duration_us: number; readonly reason: "timeout" | "server_exited" };

type Owner =
  | { readonly kind: "server" }
  | { readonly kind: "call"; readonly call_id: number }
  | { readonly kind: "shutdown" }
  | { readonly kind: "gap"; readonly preceded_by: Predecessor };

type Location =
  | { readonly kind: "startup" }
  | { readonly kind: "call"; readonly callId: number }
  | { readonly kind: "shutdown" }
  | { readonly kind: "gap"; readonly precededBy: Predecessor };

type Span = {
  readonly kind: "startup" | "call" | "shutdown";
  readonly callId: number;
  readonly start: number;
  readonly end: number;
};

type Assignment = {
  readonly owner: Owner;
  readonly ancestor: number | null;
};

type BuiltCall = {
  readonly callId: number;
  readonly tool: string;
  readonly definition: { readonly kind: "advertised"; readonly tool: ToolDefinition } | { readonly kind: "not_advertised" };
  readonly arguments: Record<string, unknown>;
  readonly argumentSource: { readonly kind: "scenario"; readonly index: number } | { readonly kind: "schema_probe" };
  readonly sentUs: number;
  readonly outcome: Outcome;
  readonly events: { readonly event: Event; readonly link: { readonly kind: "owned"; readonly ancestor_pid: number } | { readonly kind: "overlap" } }[];
};

const LISTING_METHODS = new Set(["initialize", "tools/list", "resources/list", "prompts/list"]);
const RESPONSE_METHODS = new Set(["initialize", "tools/list", "resources/list", "prompts/list", "tools/call"]);

function locate(tUs: number, spans: readonly Span[]): Location {
  let previous: Predecessor = { kind: "startup" };
  for (const span of spans) {
    if (tUs >= span.start && tUs < span.end) {
      switch (span.kind) {
        case "startup":
          return { kind: "startup" };
        case "call":
          return { kind: "call", callId: span.callId };
        case "shutdown":
          return { kind: "shutdown" };
        default: {
          const unreachable: never = span.kind;
          return unreachable;
        }
      }
    }
    if (tUs < span.start) return { kind: "gap", precededBy: previous };
    if (span.kind === "call") previous = { kind: "call", call_id: span.callId };
  }
  return { kind: "gap", precededBy: previous };
}

function numericId(id: number | string): number {
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) throw new Error(`json-rpc id is not an integer: ${String(id)}`);
  return id;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function callArguments(raw: string): { readonly tool: string; readonly arguments: Record<string, unknown> } {
  const params = recordOf(recordOf(JSON.parse(raw))?.params);
  if (params === null || typeof params.name !== "string") throw new Error("tools/call is missing a tool name");
  const args = recordOf(params.arguments) ?? {};
  return { tool: params.name, arguments: args };
}

function rootPid(processes: SensorTrace["processes"]): number {
  for (const process of Object.values(processes)) {
    if (process.kind === "root") return process.pid;
  }
  throw new Error("trace has no root process");
}

function firstExec(events: readonly Event[], pid: number): number {
  for (const event of events) {
    if (event.pid === pid && event.body.kind === "process" && event.body.action.kind === "exec") return event.t_us;
  }
  throw new Error("root process has no exec");
}

function startupMessages(timeline: readonly TimelineEntry[]): {
  readonly messages: TimelineMessage[];
  readonly serverRaw: string;
  readonly toolRaws: string[];
  readonly endUs: number;
} {
  const ids = new Map<string, string>();
  for (const entry of timeline) {
    if (entry.kind === "message" && entry.rpc.kind === "request" && LISTING_METHODS.has(entry.rpc.method)) {
      ids.set(String(entry.rpc.id), entry.rpc.method);
    }
  }
  const messages: TimelineMessage[] = [];
  let serverRaw: string | null = null;
  const toolRaws: string[] = [];
  let endUs = -1;
  for (const entry of timeline) {
    if (entry.kind !== "message") continue;
    const rpc = entry.rpc;
    switch (rpc.kind) {
      case "request":
        if (LISTING_METHODS.has(rpc.method)) messages.push(entry);
        break;
      case "notification":
        if (rpc.method === "notifications/initialized") messages.push(entry);
        break;
      case "result":
      case "error": {
        if (rpc.id === null) break;
        const method = ids.get(String(rpc.id));
        if (method === undefined) break;
        messages.push(entry);
        if (rpc.kind === "result" && method === "initialize") serverRaw = entry.raw;
        if (rpc.kind === "result" && method === "tools/list") toolRaws.push(entry.raw);
        if (method !== "initialize") endUs = entry.t_us;
        break;
      }
      default: {
        const unreachable: never = rpc;
        throw new Error(unreachable);
      }
    }
  }
  if (serverRaw === null) throw new Error("transcript has no initialize result");
  if (endUs < 0) throw new Error("transcript has no listing reply");
  return { messages, serverRaw, toolRaws, endUs };
}

/**
 * Zip stdout writes with driver reads. One request is in flight, so the nth
 * stdout line is the nth result. For each pair,
 * violation_us = max(0, sent_us - write_us, write_us - read_us).
 * A missing line contributes CLOCK_TOLERANCE_US + 1.
 */
function clockCheck(events: readonly Event[], timeline: readonly TimelineEntry[], pid: number): {
  readonly max_violation_us: number;
  readonly responses_checked: number;
} {
  const sent = new Map<string, { readonly method: string; readonly tUs: number }>();
  const responses: { readonly sentUs: number; readonly readUs: number }[] = [];
  for (const entry of timeline) {
    if (entry.kind !== "message") continue;
    if (entry.rpc.kind === "request") sent.set(String(entry.rpc.id), { method: entry.rpc.method, tUs: entry.t_us });
    if (entry.rpc.kind !== "result" || entry.rpc.id === null) continue;
    const request = sent.get(String(entry.rpc.id));
    if (request !== undefined && RESPONSE_METHODS.has(request.method)) {
      responses.push({ sentUs: request.tUs, readUs: entry.t_us });
    }
  }
  let buffer = "";
  const lines: { readonly writeUs: number }[] = [];
  for (const event of events) {
    if (event.pid !== pid || event.body.kind !== "data" || event.body.target.kind !== "stdout") continue;
    buffer += event.body.preview;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      lines.push({ writeUs: event.t_us });
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  let max = 0;
  responses.forEach((response, index) => {
    const line = lines[index];
    const violation =
      line === undefined
        ? CLOCK_TOLERANCE_US + 1
        : Math.max(0, response.sentUs - line.writeUs, line.writeUs - response.readUs);
    if (violation > max) max = violation;
  });
  return { max_violation_us: max, responses_checked: responses.length };
}

function assignments(processes: SensorTrace["processes"], spans: readonly Span[]): Map<number, Assignment> {
  const assigned = new Map<number, Assignment>();
  const children = Object.values(processes)
    .filter((process) => process.kind === "child")
    .sort((left, right) => left.born_us - right.born_us);
  for (const process of Object.values(processes)) {
    if (process.kind === "root") assigned.set(process.pid, { owner: { kind: "server" }, ancestor: null });
  }
  for (const child of children) {
    const parent = assigned.get(child.parent_pid);
    if (parent === undefined) throw new Error(`process ${String(child.pid)} has no assigned parent`);
    if (parent.owner.kind !== "server") {
      assigned.set(child.pid, { owner: parent.owner, ancestor: parent.ancestor });
      continue;
    }
    const birth = locate(child.born_us, spans);
    switch (birth.kind) {
      case "startup":
        assigned.set(child.pid, { owner: { kind: "server" }, ancestor: null });
        break;
      case "call":
        assigned.set(child.pid, { owner: { kind: "call", call_id: birth.callId }, ancestor: child.pid });
        break;
      case "shutdown":
        assigned.set(child.pid, { owner: { kind: "shutdown" }, ancestor: child.pid });
        break;
      case "gap":
        assigned.set(child.pid, { owner: { kind: "gap", preceded_by: birth.precededBy }, ancestor: child.pid });
        break;
      default: {
        const unreachable: never = birth;
        throw new Error(String(unreachable));
      }
    }
  }
  return assigned;
}

export function attribute(input: AttributionInput): Run {
  const pid = rootPid(input.processes);
  const startup = startupMessages(input.timeline);
  const tools = startup.toolRaws.flatMap((raw) => [...parseToolsPage(raw, "transcript").tools]);
  const calls: BuiltCall[] = [];
  const byId = new Map<number, BuiltCall>();
  let scenarioIndex = 0;
  for (const entry of input.timeline) {
    if (entry.kind === "message" && entry.direction === "to_server" && entry.rpc.kind === "request" && entry.rpc.method === "tools/call") {
      const id = numericId(entry.rpc.id);
      const parsed = callArguments(entry.raw);
      const defined = tools.find((tool) => tool.name === parsed.tool);
      const outcome: Outcome = { kind: "no_reply", duration_us: 0, reason: "server_exited" };
      const call: BuiltCall = {
        callId: id,
        tool: parsed.tool,
        definition: defined === undefined ? { kind: "not_advertised" } : { kind: "advertised", tool: defined },
        arguments: parsed.arguments,
        argumentSource:
          scenarioIndex < input.envelope.scenario.length
            ? { kind: "scenario", index: scenarioIndex }
            : { kind: "schema_probe" },
        sentUs: entry.t_us,
        outcome,
        events: [],
      };
      if (scenarioIndex < input.envelope.scenario.length) scenarioIndex += 1;
      calls.push(call);
      byId.set(id, call);
    }
  }
  const finish = (id: number, outcome: Outcome): void => {
    const call = byId.get(id);
    if (call !== undefined && call.outcome.kind === "no_reply" && call.outcome.duration_us === 0 && call.outcome.reason === "server_exited") {
      byId.set(id, { ...call, outcome });
      const index = calls.findIndex((item) => item.callId === id);
      if (index !== -1) calls[index] = { ...call, outcome, events: call.events };
    }
  };
  for (const entry of input.timeline) {
    if (entry.kind === "message" && entry.direction === "from_server" && entry.rpc.kind === "result" && entry.rpc.id !== null) {
      const id = numericId(entry.rpc.id);
      if (!byId.has(id)) continue;
      const call = byId.get(id);
      if (call === undefined) continue;
      const result = parseCallToolResult(entry.raw, "transcript");
      finish(id, {
        kind: "reply",
        duration_us: Math.max(0, entry.t_us - call.sentUs),
        content: result.content,
        is_error: result.is_error,
      });
    } else if (entry.kind === "message" && entry.direction === "from_server" && entry.rpc.kind === "error" && entry.rpc.id !== null) {
      const id = numericId(entry.rpc.id);
      const call = byId.get(id);
      if (call === undefined) continue;
      finish(id, {
        kind: "rpc_error",
        duration_us: Math.max(0, entry.t_us - call.sentUs),
        code: entry.rpc.code,
        message: entry.rpc.message,
      });
    } else if (entry.kind === "call_timeout") {
      const call = byId.get(entry.call_id);
      if (call === undefined) continue;
      finish(entry.call_id, {
        kind: "no_reply",
        duration_us: Math.max(0, entry.t_us - call.sentUs),
        reason: "timeout",
      });
    } else if (entry.kind === "server_exited") {
      for (const call of calls) {
        finish(call.callId, {
          kind: "no_reply",
          duration_us: Math.max(0, entry.t_us - call.sentUs),
          reason: "server_exited",
        });
      }
    }
  }

  const startUs = firstExec(input.events, pid);
  if (startup.endUs <= startUs) throw new Error("listing reply is not after the root exec");
  const stdin = input.timeline.find((entry) => entry.kind === "stdin_closed");
  const serverExit = input.timeline.find((entry) => entry.kind === "server_exited");
  const trigger =
    serverExit !== undefined && (stdin === undefined || serverExit.t_us < stdin.t_us)
      ? { kind: "server_exited" as const, t_us: serverExit.t_us, end: serverExit.end }
      : stdin !== undefined
        ? { kind: "stdin_closed" as const, t_us: stdin.t_us }
        : null;
  if (trigger === null) throw new Error("transcript has no shutdown");
  let lastUs = trigger.t_us as number;
  for (const event of input.events) lastUs = Math.max(lastUs, event.t_us);
  const shutdownDuration = lastUs >= trigger.t_us ? lastUs - trigger.t_us + 1 : 0;
  const spans: Span[] = [
    { kind: "startup", callId: -1, start: startUs, end: startup.endUs },
    ...calls.map((call) => ({
      kind: "call" as const,
      callId: call.callId,
      start: call.sentUs,
      end: call.sentUs + call.outcome.duration_us,
    })),
    { kind: "shutdown", callId: -1, start: trigger.t_us, end: trigger.t_us + shutdownDuration },
  ];
  const owners = assignments(input.processes, spans);
  const startupEvents: { readonly event: Event; readonly link: { readonly kind: "phase" } }[] = [];
  const shutdownEvents: {
    readonly event: Event;
    readonly link: { readonly kind: "owned"; readonly ancestor_pid: number } | { readonly kind: "phase" };
  }[] = [];
  const unmatched: {
    readonly event: Event;
    readonly reason:
      | { readonly kind: "between_windows"; readonly preceded_by: Predecessor }
      | { readonly kind: "born_between_windows"; readonly ancestor_pid: number; readonly preceded_by: Predecessor }
      | { readonly kind: "orphan_process" };
  }[] = [];
  const callEvents = new Map<number, BuiltCall["events"]>(calls.map((call) => [call.callId, []]));

  const placeOwned = (callId: number | "shutdown", event: Event, ancestor: number): void => {
    if (callId === "shutdown") shutdownEvents.push({ event, link: { kind: "owned", ancestor_pid: ancestor } });
    else callEvents.get(callId)?.push({ event, link: { kind: "owned", ancestor_pid: ancestor } });
  };

  for (const event of input.events) {
    const spawn =
      event.body.kind === "process" && event.body.action.kind === "spawn" && event.result.kind === "ok"
        ? owners.get(event.body.action.child_pid)
        : undefined;
    // The clone runs in the parent, but it is the child's birth.
    if (spawn !== undefined && spawn.owner.kind !== "server" && spawn.ancestor !== null) {
      switch (spawn.owner.kind) {
        case "call":
          placeOwned(spawn.owner.call_id, event, spawn.ancestor);
          break;
        case "shutdown":
          placeOwned("shutdown", event, spawn.ancestor);
          break;
        case "gap":
          unmatched.push({
            event,
            reason: { kind: "born_between_windows", ancestor_pid: spawn.ancestor, preceded_by: spawn.owner.preceded_by },
          });
          break;
        default: {
          const unreachable: never = spawn.owner;
          throw new Error(unreachable);
        }
      }
      continue;
    }
    const process = input.processes[String(event.pid)];
    if (process === undefined) throw new Error(`event ${event.event_id} has no process`);
    if (process.kind === "orphan") {
      unmatched.push({ event, reason: { kind: "orphan_process" } });
      continue;
    }
    const assignment = owners.get(event.pid);
    if (assignment === undefined) throw new Error(`process ${String(event.pid)} has no owner`);
    switch (assignment.owner.kind) {
      case "server": {
        const where = locate(event.t_us, spans);
        switch (where.kind) {
          case "startup":
            startupEvents.push({ event, link: { kind: "phase" } });
            break;
          case "call":
            callEvents.get(where.callId)?.push({ event, link: { kind: "overlap" } });
            break;
          case "shutdown":
            shutdownEvents.push({ event, link: { kind: "phase" } });
            break;
          case "gap":
            unmatched.push({ event, reason: { kind: "between_windows", preceded_by: where.precededBy } });
            break;
          default: {
            const unreachable: never = where;
            throw new Error(unreachable);
          }
        }
        break;
      }
      case "call":
        if (assignment.ancestor === null) throw new Error(`call process ${String(event.pid)} has no ancestor`);
        placeOwned(assignment.owner.call_id, event, assignment.ancestor);
        break;
      case "shutdown":
        if (assignment.ancestor === null) throw new Error(`shutdown process ${String(event.pid)} has no ancestor`);
        placeOwned("shutdown", event, assignment.ancestor);
        break;
      case "gap":
        if (assignment.ancestor === null) throw new Error(`gap process ${String(event.pid)} has no ancestor`);
        unmatched.push({
          event,
          reason: {
            kind: "born_between_windows",
            ancestor_pid: assignment.ancestor,
            preceded_by: assignment.owner.preceded_by,
          },
        });
        break;
      default: {
        const unreachable: never = assignment.owner;
        throw new Error(unreachable);
      }
    }
  }

  const processes: Record<string, unknown> = {};
  for (const key of Object.keys(input.processes).sort((left, right) => Number(left) - Number(right))) {
    const process = input.processes[key];
    if (process === undefined) continue;
    if (process.kind === "orphan") processes[key] = process;
    else if (process.kind === "root") processes[key] = { ...process, owner: { kind: "server" } };
    else {
      const assignment = owners.get(process.pid);
      if (assignment === undefined) throw new Error(`process ${String(process.pid)} has no owner`);
      processes[key] = { ...process, owner: assignment.owner };
    }
  }

  const finishedCalls = calls.map((call) => {
    const current = byId.get(call.callId) ?? call;
    return { ...current, events: callEvents.get(call.callId) ?? [] };
  });

  return parseRun(
    JSON.stringify({
      run_id: input.envelope.runId,
      target: input.envelope.target,
      network: input.envelope.network,
      canaries: input.envelope.canaries,
      timeline: input.timeline,
      clock_check: clockCheck(input.events, input.timeline, pid),
      processes,
      startup: {
        kind: "startup",
        window: { start_us: startUs, duration_us: startup.endUs - startUs },
        messages: startup.messages,
        server_info: parseInitializeResult(startup.serverRaw, "transcript"),
        advertised_tools: tools,
        events: startupEvents,
      },
      tool_calls: finishedCalls.map((call) => ({
        kind: "tool_call",
        call_id: call.callId,
        tool: call.tool,
        definition: call.definition,
        arguments: call.arguments,
        argument_source: call.argumentSource,
        sent_us: call.sentUs,
        outcome: call.outcome,
        events: call.events,
      })),
      shutdown: {
        kind: "shutdown",
        trigger,
        duration_us: shutdownDuration,
        events: shutdownEvents,
      },
      unmatched,
    }),
    "bundles.json",
  );
}
