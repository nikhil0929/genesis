import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  afterReply,
  assertExactPlacement,
  CLOCK_TOLERANCE_US,
  clockPassed,
  descriptionTooLong,
  findingStrength,
  linkStrength,
  outcomeTime,
  outlivedReply,
  ownedProcesses,
  parseFindings,
  parseJudgments,
  parseRun,
  parseStaticProfile,
  parseTranscript,
  PREVIEW_LIMIT_BYTES,
  RULE_NAMES,
  shutdownEnd,
  toolCallSeq,
} from "./model.js";
import type {
  ArgumentSource,
  AttributedProcess,
  CallDefinition,
  CallId,
  CallOutcome,
  Event,
  ExitEnd,
  FileAction,
  Finding,
  FindingSubject,
  GapPredecessor,
  HttpBody,
  Judgment,
  Link,
  NetBody,
  Peer,
  ProcessAction,
  ProcessEnd,
  ProxyFlow,
  Run,
  RunNetwork,
  ShutdownTrigger,
  StaticProfile,
  TargetSource,
  ToolAnnotations,
  ToolCallBundle,
  ToolDefinition,
  ToolText,
  UnmatchedReason,
  WriteTarget,
} from "./model.js";
import { attribute } from "./attribution.js";
import { readEnvelope } from "./host-seal.js";
import { judgeRun } from "./judge.js";
import type { JudgeMode } from "./judge.js";
import { applyRules } from "./rules.js";
import { readSensors } from "./sensors/index.js";
import { profileSources } from "./static-profile.js";

function writeAtomic(directory: string, name: string, text: string): void {
  const temporary = join(directory, `.${name}.${process.pid}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, join(directory, name));
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(tableCell).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function document(parts: readonly string[]): string {
  return `${parts.join("\n\n")}\n`;
}

function boolText(value: boolean | null): string {
  if (value === null) return "null";
  return value ? "true" : "false";
}

function annotationLines(annotations: ToolAnnotations): string[] {
  return [
    "Annotations:",
    `title: ${annotations.title ?? "null"}`,
    `read_only_hint: ${boolText(annotations.read_only_hint)}`,
    `destructive_hint: ${boolText(annotations.destructive_hint)}`,
    `idempotent_hint: ${boolText(annotations.idempotent_hint)}`,
    `open_world_hint: ${boolText(annotations.open_world_hint)}`,
  ];
}

function sourceText(source: TargetSource): string {
  switch (source.kind) {
    case "registry":
      return `registry package ${source.package} ${source.version} (${source.ecosystem})`;
    case "local":
      return `local folder ${source.path} (${source.ecosystem})`;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function networkText(network: RunNetwork): string {
  switch (network.kind) {
    case "allow":
      return "Network: allow. The container could contact real internet hosts. Proxy log: proxy/flows.jsonl";
    case "block":
      return "Network: block";
    default: {
      const _exhaustive: never = network;
      return _exhaustive;
    }
  }
}

function describePeer(peer: Peer): string {
  switch (peer.kind) {
    case "ip":
      return `${peer.address}:${peer.port}`;
    case "unix":
      return peer.path;
    case "none":
      return "none";
    default: {
      const _exhaustive: never = peer;
      return _exhaustive;
    }
  }
}

function describeEnd(end: ProcessEnd): string {
  switch (end.kind) {
    case "exited":
      return `exited ${end.status} at ${end.t_us}`;
    case "killed":
      return `killed ${end.signal} at ${end.t_us}`;
    case "alive_at_teardown":
      return "alive_at_teardown";
    default: {
      const _exhaustive: never = end;
      return _exhaustive;
    }
  }
}

function describeExit(end: ExitEnd): string {
  switch (end.kind) {
    case "exited":
      return `exited ${end.status}`;
    case "killed":
      return `killed ${end.signal}`;
    default: {
      const _exhaustive: never = end;
      return _exhaustive;
    }
  }
}

function describeProcess(action: ProcessAction): string {
  switch (action.kind) {
    case "spawn":
      return `spawn ${action.child_pid}${action.untraced ? " untraced" : ""}`;
    case "thread":
      return `thread ${action.tid}`;
    case "exec":
      return `exec ${action.path} ${action.argv.join(" ")}`;
    case "exit":
      return `exit ${describeExit(action.end)}`;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function describeFile(action: FileAction): string {
  switch (action.kind) {
    case "open":
      return `open ${action.access}${action.created ? " created" : ""} ${action.path}`;
    case "rename":
    case "link":
    case "symlink":
      return `${action.kind} ${action.path} ${action.second_path}`;
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
      return `${action.kind} ${action.path}`;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function describeTarget(target: WriteTarget): string {
  switch (target.kind) {
    case "file":
      return `file ${target.path}`;
    case "socket":
      return `socket ${describePeer(target.peer)}`;
    case "pipe":
      return `pipe ${target.inode}`;
    case "stdout":
      return "stdout";
    case "stderr":
      return "stderr";
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function describeNet(body: NetBody): string {
  const dns = body.dns_name ?? "none";
  const flow = body.proxy_flow_id ?? "none";
  return `${body.op} ${body.family} ${body.protocol} ${describePeer(body.peer)} dns ${dns} flow ${flow}`;
}

function describeEvent(event: Event): string {
  switch (event.body.kind) {
    case "file":
      return describeFile(event.body.action);
    case "data":
      return `data ${describeTarget(event.body.target)} ${event.body.byte_count} bytes`;
    case "net":
      return describeNet(event.body);
    case "process":
      return describeProcess(event.body.action);
    case "other":
      return event.body.unparsed === null ? "other" : `other ${event.body.unparsed}`;
    default: {
      const _exhaustive: never = event.body;
      return _exhaustive;
    }
  }
}

function subjectText(subject: FindingSubject): string {
  switch (subject.kind) {
    case "path":
      return subject.path;
    case "peer":
      return describePeer(subject.peer);
    case "dns_name":
      return subject.name;
    case "argv":
      return subject.argv.join(" ");
    case "flow":
      return `${subject.method} ${subject.url}`;
    default: {
      const _exhaustive: never = subject;
      return _exhaustive;
    }
  }
}

function argumentSourceText(source: ArgumentSource): string {
  switch (source.kind) {
    case "scenario":
      return `scenario ${source.index}`;
    case "schema_probe":
      return "schema probe";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function outcomeLabel(outcome: CallOutcome): string {
  switch (outcome.kind) {
    case "reply":
      return outcome.is_error ? "reply error" : "reply";
    case "rpc_error":
      return "rpc_error";
    case "no_reply":
      return `no_reply ${outcome.reason}`;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function shutdownLabel(trigger: ShutdownTrigger): string {
  switch (trigger.kind) {
    case "stdin_closed":
      return "stdin_closed";
    case "server_exited":
      return "server_exited";
    default: {
      const _exhaustive: never = trigger;
      return _exhaustive;
    }
  }
}

function eventsOf(entries: readonly { readonly event: Event }[]): Event[] {
  return entries.map((entry) => entry.event);
}

function countStrength(entries: readonly { readonly link: Link }[]): { strong: number; weak: number } {
  let strong = 0;
  let weak = 0;
  for (const entry of entries) {
    const strength = linkStrength(entry.link);
    switch (strength) {
      case "strong":
        strong += 1;
        break;
      case "weak":
        weak += 1;
        break;
      default: {
        const _exhaustive: never = strength;
        return _exhaustive;
      }
    }
  }
  return { strong, weak };
}

function spawnCount(events: readonly Event[]): number {
  let count = 0;
  for (const event of events) {
    if (event.body.kind === "process" && event.body.action.kind === "spawn") count += 1;
  }
  return count;
}

function countAfterReply(call: ToolCallBundle): number {
  let count = 0;
  for (const entry of call.events) {
    if (afterReply(call, entry)) count += 1;
  }
  return count;
}

function ruleCounts(findings: readonly Finding[]): number[] {
  return RULE_NAMES.map((rule) => findings.filter((finding) => finding.rule === rule).length);
}

function startupFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.kind === "startup");
}

function shutdownFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.kind === "shutdown");
}

function unmatchedFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.kind === "unmatched");
}

function callFindings(findings: readonly Finding[], callId: CallId): Finding[] {
  return findings.filter((finding) => finding.kind === "call" && finding.call_id === callId);
}

function bundleEvents(run: Run, finding: Finding): readonly Event[] {
  switch (finding.kind) {
    case "startup":
      return eventsOf(run.startup.events);
    case "call": {
      const call = run.tool_calls.find((item) => item.call_id === finding.call_id);
      return call === undefined ? [] : eventsOf(call.events);
    }
    case "shutdown":
      return eventsOf(run.shutdown.events);
    case "unmatched":
      return run.unmatched.map((entry) => entry.event);
    default: {
      const _exhaustive: never = finding;
      return _exhaustive;
    }
  }
}

function actingProcess(run: Run, finding: Finding): string {
  const events = new Map(bundleEvents(run, finding).map((event) => [event.event_id, event]));
  const pids: number[] = [];
  for (const id of finding.evidence) {
    const event = events.get(id);
    if (event === undefined || pids.includes(event.pid)) continue;
    pids.push(event.pid);
  }
  return pids.length === 0 ? "none" : pids.join(", ");
}

function afterReplyCell(run: Run, finding: Finding): string {
  if (finding.kind !== "call") return "-";
  const call = run.tool_calls.find((item) => item.call_id === finding.call_id);
  if (call === undefined) return "-";
  const after = finding.evidence.some((id) => {
    const entry = call.events.find((item) => item.event.event_id === id);
    return entry !== undefined && afterReply(call, entry);
  });
  return after ? "yes" : "no";
}

function strengthCell(run: Run, finding: Finding): string {
  return findingStrength(run, finding) ?? "none";
}

function findingsTable(run: Run, findings: readonly Finding[]): string[] {
  if (findings.length === 0) return ["Findings:", "none"];
  const rows = findings.map((finding) => [
    finding.rule,
    subjectText(finding.subject),
    actingProcess(run, finding),
    strengthCell(run, finding),
    afterReplyCell(run, finding),
    finding.kind === "call" ? (finding.claim_check.interface_mentions ?? "none") : "-",
    finding.kind === "call" ? (finding.claim_check.annotation_conflict ?? "none") : "-",
    finding.source_hints.length === 0
      ? "none"
      : finding.source_hints.map((hint) => `${hint.file}:${hint.line}`).join(", "),
  ]);
  return [
    "Findings:",
    markdownTable(
      [
        "rule",
        "subject",
        "acting process",
        "link strength",
        "after reply",
        "interface mentions",
        "annotation conflict",
        "source hints",
      ],
      rows,
    ),
  ];
}

function processLine(process: AttributedProcess, call: ToolCallBundle | null): string {
  const exec = process.execs[0];
  const command = exec === undefined ? "no exec" : `${exec.path} ${exec.argv.join(" ")}`;
  const outlived =
    call !== null && process.kind === "child" ? ` outlived reply ${outlivedReply(call, process) ? "yes" : "no"}` : "";
  return `${process.pid} ${process.kind} ${command} ${describeEnd(process.end)}${outlived}`;
}

function processTree(run: Run, include: (process: AttributedProcess) => boolean, call: ToolCallBundle | null): string[] {
  const included = Object.values(run.processes).filter(include);
  const includedPids = new Set(included.map((process) => process.pid));
  const roots = included
    .filter((process) => process.kind !== "child" || !includedPids.has(process.parent_pid))
    .sort((left, right) => left.pid - right.pid);
  const lines: string[] = [];
  const walk = (process: AttributedProcess, depth: number): void => {
    lines.push(`${"  ".repeat(depth)}- ${processLine(process, call)}`);
    const children = Object.values(run.processes)
      .filter(
        (item): item is AttributedProcess & { kind: "child"; parent_pid: number } =>
          item.kind === "child" && item.parent_pid === process.pid && includedPids.has(item.pid),
      )
      .sort((left, right) => left.pid - right.pid);
    for (const child of children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return lines.length === 0 ? ["none"] : lines;
}

function startupProcess(process: AttributedProcess): boolean {
  switch (process.kind) {
    case "root":
      return true;
    case "child":
      return process.owner.kind === "server";
    case "orphan":
      return false;
    default: {
      const _exhaustive: never = process;
      return _exhaustive;
    }
  }
}

function shutdownProcess(process: AttributedProcess): boolean {
  switch (process.kind) {
    case "root":
    case "orphan":
      return false;
    case "child":
      return process.owner.kind === "shutdown";
    default: {
      const _exhaustive: never = process;
      return _exhaustive;
    }
  }
}

// These paths stay listed. The rules module owns the same set, and this file cannot import it.
function sensitivePath(path: string): boolean {
  const exact = new Set([
    "/home/detonee/.aws/credentials",
    "/home/detonee/.ssh/id_ed25519",
    "/home/detonee/.config/gh/hosts.yml",
    "/home/detonee/.npmrc",
    "/home/detonee/.netrc",
    "/home/detonee/.docker/config.json",
    "/home/detonee/.kube/config",
    "/work/.env",
    "/etc/shadow",
    "/home/detonee/.bash_history",
    "/home/detonee/.zsh_history",
    "/root/.bash_history",
    "/root/.zsh_history",
  ]);
  if (exact.has(path) || /^\/proc\/[0-9]+\/environ$/.test(path)) return true;
  const prefixes = [
    "/home/detonee/.config/google-chrome",
    "/home/detonee/.config/chromium",
    "/home/detonee/.mozilla/firefox",
  ];
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function fileActionPaths(action: FileAction): readonly string[] {
  switch (action.kind) {
    case "rename":
    case "link":
    case "symlink":
      return [action.path, action.second_path];
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
      return [action.path];
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function eventPaths(event: Event): readonly string[] {
  switch (event.body.kind) {
    case "file":
      return fileActionPaths(event.body.action);
    case "data":
      return event.body.target.kind === "file" ? [event.body.target.path] : [];
    case "process":
    case "net":
    case "other":
      return [];
    default: {
      const _exhaustive: never = event.body;
      return _exhaustive;
    }
  }
}

function citedIds(findings: readonly Finding[]): Set<string> {
  const ids = new Set<string>();
  for (const finding of findings) {
    for (const id of finding.evidence) ids.add(id);
  }
  return ids;
}

function routineRead(event: Event, cited: ReadonlySet<string>): boolean {
  if (cited.has(event.event_id)) return false;
  if (event.body.kind !== "file" || event.body.action.kind !== "open") return false;
  const action = event.body.action;
  return action.access === "read" && !action.created && !sensitivePath(action.path);
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "/";
  return path.slice(0, slash);
}

function fileActivity(events: readonly Event[], findings: readonly Finding[]): string[] {
  const cited = citedIds(findings);
  const listed: string[] = [];
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.body.kind === "data" && event.body.target.kind === "file") {
      listed.push(`${event.event_id} ${describeEvent(event)}`);
      continue;
    }
    if (event.body.kind !== "file") continue;
    if (routineRead(event, cited) && event.body.action.kind === "open") {
      const directory = directoryOf(event.body.action.path);
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
      continue;
    }
    listed.push(`${event.event_id} ${describeEvent(event)}`);
  }
  const summaries = [...counts.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([directory, count]) => `${count} ${count === 1 ? "read" : "reads"} in ${directory}`);
  const lines = [...listed, ...summaries];
  return lines.length === 0 ? ["none"] : lines;
}

function credentialLines(events: readonly Event[], findings: readonly Finding[]): string[] {
  const cited = new Set(
    findings.filter((finding) => finding.rule === "credential_access").flatMap((finding) => [...finding.evidence]),
  );
  const lines: string[] = [];
  for (const event of events) {
    if (!cited.has(event.event_id) && !eventPaths(event).some((path) => sensitivePath(path))) continue;
    lines.push(`${event.event_id} ${describeEvent(event)}`);
  }
  return lines.length === 0 ? ["none"] : lines;
}

function bodyText(body: HttpBody): string | null {
  switch (body.kind) {
    case "text":
      return body.text;
    case "base64":
      return null;
    default: {
      const _exhaustive: never = body;
      return _exhaustive;
    }
  }
}

function canaryHits(run: Run, flow: ProxyFlow): string {
  const chunks: string[] = [];
  const request = bodyText(flow.request.body);
  if (request !== null) chunks.push(request);
  switch (flow.result.kind) {
    case "response": {
      const response = bodyText(flow.result.response.body);
      if (response !== null) chunks.push(response);
      break;
    }
    case "error":
      break;
    default: {
      const _exhaustive: never = flow.result;
      return _exhaustive;
    }
  }
  const haystack = chunks.join("\n");
  const hits = run.canaries.filter((canary) => haystack.includes(canary.value)).map((canary) => canary.name);
  return hits.length === 0 ? "none" : hits.join(", ");
}

function flowStatus(flow: ProxyFlow): string {
  switch (flow.result.kind) {
    case "response":
      return String(flow.result.response.status);
    case "error":
      return flow.result.message;
    default: {
      const _exhaustive: never = flow.result;
      return _exhaustive;
    }
  }
}

function responseBytes(flow: ProxyFlow): string {
  switch (flow.result.kind) {
    case "response":
      return String(flow.result.response.body.byte_count);
    case "error":
      return "-";
    default: {
      const _exhaustive: never = flow.result;
      return _exhaustive;
    }
  }
}

function joinedFlows(run: Run, events: readonly Event[]): ProxyFlow[] {
  if (run.network.kind !== "allow") return [];
  const byId = new Map(run.network.flows.map((flow) => [flow.flow_id, flow]));
  const seen = new Set<string>();
  const flows: ProxyFlow[] = [];
  for (const event of events) {
    if (event.body.kind !== "net" || event.body.proxy_flow_id === null) continue;
    const id = event.body.proxy_flow_id;
    if (seen.has(id)) continue;
    seen.add(id);
    const flow = byId.get(id);
    if (flow !== undefined) flows.push(flow);
  }
  return flows;
}

function networkLines(run: Run, events: readonly Event[]): string[] {
  const attempts = events.filter((event) => event.body.kind === "net");
  const lines = ["Network:"];
  if (attempts.length === 0) lines.push("none");
  else for (const event of attempts) lines.push(`${event.event_id} ${describeEvent(event)}`);
  const flows = joinedFlows(run, events);
  if (flows.length === 0) return lines;
  lines.push(
    markdownTable(
      ["method", "url", "status", "request bytes", "response bytes", "canary hits"],
      flows.map((flow) => [
        flow.request.method,
        flow.request.url,
        flowStatus(flow),
        String(flow.request.body.byte_count),
        responseBytes(flow),
        canaryHits(run, flow),
      ]),
    ),
  );
  return lines;
}

function judgmentFor(judgments: readonly Judgment[] | null, callId: CallId): Judgment | null | undefined {
  if (judgments === null) return null;
  return judgments.find((judgment) => judgment.call_id === callId);
}

function judgeSummary(judgments: readonly Judgment[] | null, callId: CallId): string {
  const judgment = judgmentFor(judgments, callId);
  if (judgment === null) return "judge not run";
  if (judgment === undefined) return "no judgment";
  switch (judgment.kind) {
    case "answer":
      return judgment.answer.opinion;
    case "invalid":
      return "invalid";
    default: {
      const _exhaustive: never = judgment;
      return _exhaustive;
    }
  }
}

function judgeLines(call: ToolCallBundle, judgments: readonly Judgment[] | null): string[] {
  const lines = ["LLM opinion, not evidence"];
  const judgment = judgmentFor(judgments, call.call_id);
  if (judgment === null) {
    lines.push("judge not run");
    return lines;
  }
  if (judgment === undefined) {
    lines.push("no judgment");
    return lines;
  }
  switch (judgment.kind) {
    case "invalid":
      lines.push("invalid");
      lines.push(`Model: ${judgment.model}`);
      lines.push(`Answered at: ${judgment.answered_at_us}`);
      lines.push(`Error: ${judgment.error}`);
      lines.push("Raw:");
      lines.push(judgment.raw_text);
      return lines;
    case "answer":
      lines.push(judgment.answer.opinion);
      lines.push(judgment.answer.summary);
      lines.push(`Model: ${judgment.model}`);
      lines.push(`Answered at: ${judgment.answered_at_us}`);
      if (judgment.answer.mismatches.length === 0) lines.push("Mismatches: none");
      for (const mismatch of judgment.answer.mismatches) {
        lines.push(`Mismatch ${mismatch.event_ids.join(", ")}: ${mismatch.explanation}`);
      }
      return lines;
    default: {
      const _exhaustive: never = judgment;
      return _exhaustive;
    }
  }
}

function driverReply(run: Run, call: ToolCallBundle): string | null {
  const at = outcomeTime(call);
  for (const entry of run.timeline) {
    if (entry.kind !== "message" || entry.direction !== "from_server" || entry.t_us !== at) continue;
    switch (entry.rpc.kind) {
      case "result":
      case "error":
        return entry.raw;
      case "request":
      case "notification":
        continue;
      default: {
        const _exhaustive: never = entry.rpc;
        return _exhaustive;
      }
    }
  }
  return null;
}

function claimText(definition: CallDefinition): string {
  switch (definition.kind) {
    case "advertised":
      return definition.tool.description ?? "";
    case "not_advertised":
      return "not advertised";
    default: {
      const _exhaustive: never = definition;
      return _exhaustive;
    }
  }
}

function outcomeLines(run: Run, call: ToolCallBundle): string[] {
  const claim = claimText(call.definition);
  const raw = driverReply(run, call);
  const lines = [`Claim: ${claim}`];
  switch (call.outcome.kind) {
    case "reply":
      lines.push(`Outcome: ${outcomeLabel(call.outcome)}`);
      lines.push("Reply:");
      lines.push(raw ?? JSON.stringify(call.outcome.content));
      return lines;
    case "rpc_error":
      lines.push(`Outcome: rpc_error ${call.outcome.code} ${call.outcome.message}`);
      if (raw !== null) {
        lines.push("Reply:");
        lines.push(raw);
      }
      return lines;
    case "no_reply":
      lines.push(`Outcome: no reply (${call.outcome.reason})`);
      return lines;
    default: {
      const _exhaustive: never = call.outcome;
      return _exhaustive;
    }
  }
}

function toolText(profile: StaticProfile, name: string): ToolText | undefined {
  return profile.tool_texts.find((text) => text.tool === name);
}

function definitionLines(call: ToolCallBundle, profile: StaticProfile): string[] {
  const text = toolText(profile, call.tool);
  const sites = profile.tool_sites.find((entry) => entry.tool === call.tool);
  const lines: string[] = [];
  switch (call.definition.kind) {
    case "advertised": {
      const tool = call.definition.tool;
      lines.push(`Description: ${tool.description ?? ""}`);
      lines.push(...escapedLines(text));
      lines.push("Schema:", JSON.stringify(tool.input_schema, null, 2));
      lines.push(...annotationLines(tool.annotations));
      break;
    }
    case "not_advertised":
      lines.push("Description: not advertised");
      lines.push(...escapedLines(text));
      lines.push("Schema: none");
      lines.push("Annotations: none");
      break;
    default: {
      const _exhaustive: never = call.definition;
      return _exhaustive;
    }
  }
  lines.push("Source sites:");
  if (sites === undefined || sites.sites.length === 0) lines.push("none");
  else for (const site of sites.sites) lines.push(`${site.file}:${site.line} ${site.snippet}`);
  return lines;
}

function escapedLines(text: ToolText | undefined): string[] {
  if (text === undefined) return [];
  const lines = [`Escaped description: ${text.escaped_description}`, `Length: ${text.length}`];
  if (descriptionTooLong(text)) lines.push("Description is longer than 1000 characters.");
  for (const flag of text.flags) lines.push(`Flag: ${flag.kind} ${flag.phrase}`);
  return lines;
}

function advertisedTool(run: Run, name: string): ToolDefinition | undefined {
  return run.startup.advertised_tools.find((tool) => tool.name === name);
}

function runHeader(run: Run, judgments: readonly Judgment[] | null): string {
  const duration = shutdownEnd(run.shutdown) - run.startup.window.start_us;
  const clock = run.clock_check;
  const lines = [
    "# Run",
    "",
    `Run: ${run.run_id}`,
    `Target: ${run.target.name}`,
    `Version: ${run.startup.server_info.version}`,
    `Source: ${sourceText(run.target.source)}`,
    `Image: ${run.target.image_id}`,
    `Command: ${run.target.command.map((arg) => JSON.stringify(arg)).join(" ")}`,
    networkText(run.network),
    `Duration: ${duration} us`,
    `Clock check: ${clockPassed(clock) ? "passed" : "failed"} (max_violation_us ${clock.max_violation_us}, responses_checked ${clock.responses_checked})`,
  ];
  if (clock.max_violation_us > CLOCK_TOLERANCE_US) {
    lines.push(`Warning: max_violation_us ${clock.max_violation_us} exceeds ${CLOCK_TOLERANCE_US}`);
  }
  if (judgments !== null) {
    lines.push("This run sent tool descriptions, source snippets, and each event's parsed body to Anthropic.");
  }
  return lines.join("\n");
}

function summaryRow(
  label: string,
  outcome: string,
  findings: readonly Finding[],
  entries: readonly { readonly event: Event; readonly link: Link }[],
  spawned: number,
  after: string,
  judge: string,
): string[] {
  const strength = countStrength(entries);
  return [
    label,
    outcome,
    ...ruleCounts(findings).map(String),
    String(strength.strong),
    String(strength.weak),
    String(spawned),
    after,
    judge,
  ];
}

function summarySection(run: Run, findings: readonly Finding[], judgments: readonly Judgment[] | null): string {
  const rows: string[][] = [];
  const startupEvents = eventsOf(run.startup.events);
  rows.push(
    summaryRow(
      "startup",
      "startup",
      startupFindings(findings),
      run.startup.events,
      spawnCount(startupEvents),
      "-",
      "-",
    ),
  );
  for (const call of run.tool_calls) {
    const seq = toolCallSeq(run, call.call_id);
    rows.push(
      summaryRow(
        `tool call ${seq ?? "none"} ${call.tool}`,
        outcomeLabel(call.outcome),
        callFindings(findings, call.call_id),
        call.events,
        spawnCount(eventsOf(call.events)),
        String(countAfterReply(call)),
        judgeSummary(judgments, call.call_id),
      ),
    );
  }
  const shutdownEvents = eventsOf(run.shutdown.events);
  rows.push(
    summaryRow(
      "shutdown",
      shutdownLabel(run.shutdown.trigger),
      shutdownFindings(findings),
      run.shutdown.events,
      spawnCount(shutdownEvents),
      "-",
      "-",
    ),
  );
  return [
    "# Summary",
    "",
    markdownTable(
      ["bundle", "outcome", ...RULE_NAMES, "strong", "weak", "spawned", "after reply", "judge"],
      rows,
    ),
  ].join("\n");
}

function staticProfileSection(run: Run, profile: StaticProfile): string {
  const lines = [
    "# Static profile",
    "",
    `Package: ${profile.package.name}`,
    `Version: ${profile.package.version ?? "none"}`,
    `Ecosystem: ${profile.package.ecosystem}`,
    `Manifest: ${profile.package.manifest_path ?? "none"}`,
    "Dependencies:",
  ];
  if (profile.dependencies.length === 0) lines.push("none");
  else for (const dependency of profile.dependencies) lines.push(`${dependency.name}: ${dependency.spec}`);
  if (profile.install_scripts.length === 0) lines.push("Install scripts: none");
  else {
    lines.push("Install scripts: ran at build time, not observed");
    for (const script of profile.install_scripts) lines.push(`${script.hook}: ${script.command}`);
  }
  lines.push("Advertised tools:");
  if (profile.tool_texts.length === 0) lines.push("none");
  for (const text of profile.tool_texts) {
    lines.push(`### ${text.tool}`);
    lines.push(...escapedLines(text));
    const tool = advertisedTool(run, text.tool);
    if (tool === undefined) {
      lines.push("Schema: none");
      lines.push("Annotations: none");
      continue;
    }
    lines.push("Schema:", JSON.stringify(tool.input_schema, null, 2));
    lines.push(...annotationLines(tool.annotations));
  }
  lines.push("API hints:");
  if (profile.api_hints.length === 0) lines.push("none");
  else {
    for (const hint of profile.api_hints) {
      lines.push(`${hint.category} ${hint.file}:${hint.line} ${hint.pattern} ${hint.snippet}`);
    }
  }
  return lines.join("\n");
}

function phaseSection(
  title: string,
  run: Run,
  findings: readonly Finding[],
  events: readonly Event[],
  tree: string[],
): string {
  return [
    title,
    "",
    ...findingsTable(run, findings),
    "Process tree:",
    ...tree,
    ...networkLines(run, events),
    "Credential access:",
    ...credentialLines(events, findings),
    "File activity:",
    ...fileActivity(events, findings),
  ].join("\n");
}

function toolSection(
  run: Run,
  profile: StaticProfile,
  findings: readonly Finding[],
  judgments: readonly Judgment[] | null,
  call: ToolCallBundle,
): string {
  const seq = toolCallSeq(run, call.call_id);
  const owned = new Set(ownedProcesses(run, call).map((process) => process.pid));
  const events = eventsOf(call.events);
  const callFindingsFor = callFindings(findings, call.call_id);
  return [
    `# Tool call ${seq ?? "none"}: ${call.tool}`,
    "",
    "Does this match what the tool claims?",
    ...definitionLines(call, profile),
    `Arguments (${argumentSourceText(call.argument_source)}):`,
    JSON.stringify(call.arguments, null, 2),
    ...outcomeLines(run, call),
    ...networkLines(run, events),
    ...findingsTable(run, callFindingsFor),
    "Process subtree:",
    ...processTree(run, (process) => process.kind === "child" && owned.has(process.pid), call),
    "File activity:",
    ...fileActivity(events, callFindingsFor),
    ...judgeLines(call, judgments),
  ].join("\n");
}

function afterHint(run: Run, preceded: GapPredecessor): string {
  switch (preceded.kind) {
    case "startup":
      return "after startup";
    case "call": {
      const seq = toolCallSeq(run, preceded.call_id);
      return seq === null ? "after call" : `after call ${seq}`;
    }
    default: {
      const _exhaustive: never = preceded;
      return _exhaustive;
    }
  }
}

function reasonText(run: Run, reason: UnmatchedReason): string {
  switch (reason.kind) {
    case "between_windows":
      return `between_windows ${afterHint(run, reason.preceded_by)}`;
    case "born_between_windows":
      return `born_between_windows ${afterHint(run, reason.preceded_by)} ancestor ${reason.ancestor_pid}`;
    case "orphan_process":
      return "orphan_process";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function unmatchedSection(run: Run, findings: readonly Finding[]): string {
  const lines = ["# Unmatched", ""];
  if (run.unmatched.length === 0) lines.push("none");
  for (const entry of run.unmatched) {
    lines.push(`${entry.event.event_id} ${reasonText(run, entry.reason)}`);
    lines.push(describeEvent(entry.event));
  }
  lines.push(...findingsTable(run, unmatchedFindings(findings)));
  return lines.join("\n");
}

function limitsSection(profile: StaticProfile): string {
  const lines = [
    "# Limits",
    "",
    "- A getenv call is invisible. Canaries catch a secret only when its value moves.",
    "- A process can detect ptrace, for example through TracerPid in /proc/self/status, and change its behavior. The read of that file is itself traced.",
    "- A child created with CLONE_UNTRACED escapes the trace.",
    `- Buffers longer than ${PREVIEW_LIMIT_BYTES} bytes are cut, so a canary past that point is missed. The truncated flag marks every cut buffer.`,
    "- A weak link can be wrong when the server has background activity. Unmatched between_windows events show whether it does.",
    "- Behavior that depends on inputs the scenario did not choose does not appear.",
    "- In block mode, anything after a failed connection is unseen.",
    "- In allow mode, a client that ignores the proxy variables behaves as if blocked, and a client that pins certificates shows only the host and a failed handshake.",
    "- In allow mode, the server really reaches the internet. The remote host sees the person's public address and receives whatever the server sends.",
    "- ptrace slows the server.",
  ];
  const platform = profile.api_hints.filter((hint) => hint.category === "platform");
  if (platform.length === 0) lines.push("- Platform branches: none");
  else {
    lines.push("- Platform branches:");
    for (const hint of platform) lines.push(`  - ${hint.file}:${hint.line} ${hint.snippet}`);
  }
  return lines.join("\n");
}

function readJudgments(runDir: string, run: Run): readonly Judgment[] | null {
  const path = join(runDir, "judgments.json");
  if (!existsSync(path)) return null;
  return parseJudgments(readFileSync(path, "utf8"), "judgments.json", run);
}

function render(run: Run, profile: StaticProfile, findings: readonly Finding[], judgments: readonly Judgment[] | null): string {
  const startupEvents = eventsOf(run.startup.events);
  const shutdownEvents = eventsOf(run.shutdown.events);
  const parts = [
    runHeader(run, judgments),
    summarySection(run, findings, judgments),
    staticProfileSection(run, profile),
    phaseSection(
      "# Startup",
      run,
      startupFindings(findings),
      startupEvents,
      processTree(run, startupProcess, null),
    ),
  ];
  for (const call of run.tool_calls) parts.push(toolSection(run, profile, findings, judgments, call));
  parts.push(
    phaseSection(
      "# Shutdown",
      run,
      shutdownFindings(findings),
      shutdownEvents,
      processTree(run, shutdownProcess, null),
    ),
    unmatchedSection(run, findings),
    limitsSection(profile),
  );
  return document(parts);
}

export function renderReport(runDir: string): string {
  const run = parseRun(readFileSync(join(runDir, "bundles.json"), "utf8"), "bundles.json");
  const profile = parseStaticProfile(readFileSync(join(runDir, "static_profile.json"), "utf8"), "static_profile.json");
  const findings = parseFindings(readFileSync(join(runDir, "findings.json"), "utf8"), "findings.json", run);
  const judgments = readJudgments(runDir, run);
  const markdown = render(run, profile, findings, judgments);
  writeAtomic(runDir, "report.md", markdown);
  return markdown;
}

export async function publishRun(runDir: string, mode: JudgeMode): Promise<string> {
  const envelope = readEnvelope(runDir);
  const sensed = readSensors(runDir, envelope.network);
  const transcriptPath = join(runDir, "transcript.jsonl");
  const timeline = parseTranscript(readFileSync(transcriptPath, "utf8"), transcriptPath);
  const run = attribute({
    events: sensed.events,
    processes: sensed.processes,
    timeline,
    envelope,
  });
  const bundlesPath = join(runDir, "bundles.json");
  const bundlesText = JSON.stringify(run);
  writeAtomic(runDir, "bundles.json", bundlesText);
  const parsed = parseRun(bundlesText, bundlesPath);
  assertExactPlacement(sensed.events, parsed, bundlesPath);
  const profile = profileSources(runDir);
  const findings = applyRules(parsed, profile);
  const findingsPath = join(runDir, "findings.json");
  const findingsText = JSON.stringify(findings);
  writeAtomic(runDir, "findings.json", findingsText);
  parseFindings(findingsText, findingsPath, parsed);
  await judgeRun(runDir, parsed, profile, findings, mode);
  return renderReport(runDir);
}
