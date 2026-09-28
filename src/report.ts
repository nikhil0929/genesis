import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  afterReply,
  assertExactPlacement,
  CLOCK_TOLERANCE_US,
  clockPassed,
  descriptionTooLong,
  findingStrength,
  outcomeTime,
  parseFindings,
  parseJudgments,
  parseRun,
  parseTranscript,
  PREVIEW_LIMIT_BYTES,
  toolCallSeq,
} from "./model.js";
import type {
  ArgumentSource,
  CallDefinition,
  CallId,
  Event,
  Finding,
  FindingSubject,
  GapPredecessor,
  HttpBody,
  Judgment,
  Peer,
  ProxyFlow,
  Run,
  RunNetwork,
  StaticProfile,
  TargetSource,
  ToolCallBundle,
  UnmatchedReason,
} from "./model.js";
import { attribute } from "./attribution.js";
import { readEnvelope } from "./host-seal.js";
import { judgeRun } from "./judge.js";
import type { JudgeMode } from "./judge.js";
import { applyRules } from "./rules.js";
import { rawPath } from "./run-dir.js";
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

function bulletList(items: readonly string[]): string[] {
  if (items.length === 0) return [];
  return ["", ...items.map((item) => `- ${item}`)];
}

function jsonBlock(value: unknown): string[] {
  return ["", "```json", JSON.stringify(value, null, 2), "```"];
}

function inlineCode(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
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
      return "Network: allow. The container could contact real internet hosts. Proxy log: raw/proxy/flows.jsonl";
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



function eventsOf(entries: readonly { readonly event: Event }[]): Event[] {
  return entries.map((entry) => entry.event);
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

function citedIds(findings: readonly Finding[]): Set<string> {
  const ids = new Set<string>();
  for (const finding of findings) {
    for (const id of finding.evidence) ids.add(id);
  }
  return ids;
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


function flowSummaries(run: Run, events: readonly Event[]): string[] {
  return joinedFlows(run, events).map((flow) => {
    const hits = canaryHits(run, flow);
    const canary = hits === "none" ? "" : ` Canary ${hits}.`;
    return `${flow.request.method} ${flow.request.url} status ${flowStatus(flow)}.${canary}`;
  });
}

function judgmentFor(judgments: readonly Judgment[] | null, callId: CallId): Judgment | null | undefined {
  if (judgments === null) return null;
  return judgments.find((judgment) => judgment.call_id === callId);
}


type Glance = "matches" | "does_not_match" | "unclear" | "invalid" | "judge not run" | "no judgment";

function glanceOf(judgments: readonly Judgment[] | null, callId: CallId): Glance {
  const judgment = judgmentFor(judgments, callId);
  if (judgment === null) return "judge not run";
  if (judgment === undefined) return "no judgment";
  switch (judgment.kind) {
    case "invalid":
      return "invalid";
    case "answer":
      return judgment.answer.opinion;
    default: {
      const _exhaustive: never = judgment;
      return _exhaustive;
    }
  }
}

function glanceWords(glance: Glance): string {
  switch (glance) {
    case "matches":
      return "matches";
    case "does_not_match":
      return "does not match";
    case "unclear":
      return "unclear";
    case "invalid":
      return "invalid";
    case "judge not run":
      return "judge not run";
    case "no judgment":
      return "no judgment";
    default: {
      const _exhaustive: never = glance;
      return _exhaustive;
    }
  }
}

function judgeLines(call: ToolCallBundle, judgments: readonly Judgment[] | null): string[] {
  const lines = ["LLM opinion, not evidence"];
  const judgment = judgmentFor(judgments, call.call_id);
  if (judgment === null) return [...lines, ...bulletList(["judge not run"])];
  if (judgment === undefined) return [...lines, ...bulletList(["no judgment"])];
  switch (judgment.kind) {
    case "invalid":
      return [...lines, ...bulletList(["invalid", judgment.error])];
    case "answer": {
      const items = [glanceWords(judgment.answer.opinion)];
      if (judgment.answer.opinion !== "matches" || judgment.answer.mismatches.length > 0) {
        items.push(judgment.answer.summary);
      }
      for (const mismatch of judgment.answer.mismatches) {
        items.push(`Mismatch ${mismatch.event_ids.join(", ")}: ${mismatch.explanation}`);
      }
      return [...lines, ...bulletList(items)];
    }
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


function clip(text: string, limit: number): string {
  const flat = text.replaceAll("\n", " ").replaceAll(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}...`;
}

function findingPhrase(finding: Finding): string {
  const subject = subjectText(finding.subject);
  switch (finding.rule) {
    case "spawned_process":
      return `Spawned ${subject}`;
    case "file_modified":
      return `Changed ${subject}`;
    case "credential_access":
      return `Read ${subject}`;
    case "network_attempt":
      return `Network ${subject}`;
    case "late_code_load":
      return `Loaded ${subject}`;
    case "canary_exposed":
      return `Canary in ${subject}`;
    default: {
      const _exhaustive: never = finding.rule;
      return _exhaustive;
    }
  }
}

function contentText(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("text" in value)) return null;
  return typeof value.text === "string" ? value.text : null;
}

function replyText(run: Run, call: ToolCallBundle): string {
  switch (call.outcome.kind) {
    case "reply": {
      const texts: string[] = [];
      for (const item of call.outcome.content) {
        const text = contentText(item);
        if (text !== null) texts.push(text);
      }
      const body = texts.length > 0 ? texts.join(" ") : (driverReply(run, call) ?? JSON.stringify(call.outcome.content));
      return clip(call.outcome.is_error ? `error ${body}` : body, 240);
    }
    case "rpc_error":
      return clip(`error ${call.outcome.code} ${call.outcome.message}`, 240);
    case "no_reply":
      return `no reply (${call.outcome.reason})`;
    default: {
      const _exhaustive: never = call.outcome;
      return _exhaustive;
    }
  }
}

function sourceCell(finding: Finding): string {
  if (finding.source_hints.length === 0) return "none";
  return finding.source_hints.map((hint) => `${hint.file}:${hint.line}`).join(", ");
}

function unmatchedWhen(run: Run, finding: Finding): string {
  if (finding.kind !== "unmatched") return "";
  const reasons: string[] = [];
  for (const id of finding.evidence) {
    const entry = run.unmatched.find((item) => item.event.event_id === id);
    if (entry === undefined) continue;
    const text = reasonText(run, entry.reason);
    if (!reasons.includes(text)) reasons.push(text);
  }
  return reasons.join(", ");
}

function whatCell(run: Run, finding: Finding): string {
  const subject = subjectText(finding.subject);
  const conflict =
    finding.kind === "call" && finding.claim_check.annotation_conflict !== null
      ? ` (annotation ${finding.claim_check.annotation_conflict})`
      : "";
  const when = unmatchedWhen(run, finding);
  const timing = when === "" ? "" : ` (${when})`;
  return `${subject}${conflict}${timing}`;
}

function conciseFindings(run: Run, findings: readonly Finding[]): string[] {
  if (findings.length === 0) return [];
  const rows = findings.map((finding) => [
    whatCell(run, finding),
    finding.rule,
    strengthCell(run, finding),
    afterReplyCell(run, finding),
    sourceCell(finding),
  ]);
  return [markdownTable(["What happened", "Rule", "Link", "After reply", "Source"], rows)];
}

function localNoise(finding: Finding): boolean {
  switch (finding.subject.kind) {
    case "peer":
      switch (finding.subject.peer.kind) {
        case "unix":
          return true;
        case "ip":
          return finding.subject.peer.address === "127.0.0.1" || finding.subject.peer.address === "::1";
        case "none":
          return false;
        default: {
          const _exhaustive: never = finding.subject.peer;
          return _exhaustive;
        }
      }
    case "path":
      return finding.subject.path.endsWith("/nscd/socket");
    case "dns_name":
    case "argv":
    case "flow":
      return false;
    default: {
      const _exhaustive: never = finding.subject;
      return _exhaustive;
    }
  }
}

function glanceRank(finding: Finding): number {
  switch (finding.rule) {
    case "canary_exposed":
      return 0;
    case "credential_access":
      return 1;
    case "late_code_load":
      return 2;
    case "network_attempt":
      return localNoise(finding) ? 6 : 3;
    case "spawned_process":
      return 4;
    case "file_modified":
      return 5;
    default: {
      const _exhaustive: never = finding.rule;
      return _exhaustive;
    }
  }
}

function activityText(run: Run, call: ToolCallBundle, findings: readonly Finding[]): string {
  if (findings.length === 0) return replyText(run, call);
  const ranked = [...findings].sort((left, right) => glanceRank(left) - glanceRank(right));
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const finding of ranked) {
    const subject = subjectText(finding.subject);
    if (seen.has(subject)) continue;
    seen.add(subject);
    labels.push(findingPhrase(finding));
  }
  const shown = labels.slice(0, 3);
  const extra = labels.length - shown.length;
  const body = shown.join(". ");
  return extra > 0 ? `${body}. +${extra} more` : body;
}

function unmentioned(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.kind === "call" && finding.claim_check.interface_mentions === null);
}

function headline(glances: readonly Glance[], unexpected: number, callCount: number): string {
  if (callCount === 0) return "No tool calls.";
  const bad = glances.filter((glance) => glance === "does_not_match").length;
  const muddy = glances.filter((glance) => glance === "unclear" || glance === "invalid").length;
  const pending = glances.filter((glance) => glance === "judge not run" || glance === "no judgment").length;
  const noun = callCount === 1 ? "call" : "calls";
  if (bad > 0) return `Does not match. ${bad} of ${callCount} ${noun} did something the description does not cover.`;
  if (muddy > 0) return `Unclear. ${muddy} of ${callCount} ${noun} could not be judged.`;
  if (pending > 0) {
    if (unexpected > 0) {
      return `Judge not run. ${unexpected} of ${callCount} ${noun} did something the description does not mention.`;
    }
    return "Judge not run. No call had an unmentioned side effect.";
  }
  return `Matches. All ${callCount} ${noun} did what they claim.`;
}

function phaseGlance(label: string, findings: readonly Finding[]): string | null {
  if (findings.length === 0) return null;
  return `${label}: ${findings.map((finding) => findingPhrase(finding)).join(". ")}.`;
}

function verdictSection(run: Run, findings: readonly Finding[], judgments: readonly Judgment[] | null): string {
  const glances: Glance[] = [];
  let unexpected = 0;
  const rows: string[][] = [];
  for (const call of run.tool_calls) {
    const glance = glanceOf(judgments, call.call_id);
    glances.push(glance);
    const forCall = callFindings(findings, call.call_id);
    if (unmentioned(forCall)) unexpected += 1;
    rows.push([
      String(toolCallSeq(run, call.call_id) ?? "none"),
      call.tool,
      glanceWords(glance),
      activityText(run, call, forCall),
    ]);
  }
  const clock = run.clock_check;
  const lines = ["# Verdict", "", headline(glances, unexpected, run.tool_calls.length)];
  if (clock.max_violation_us > CLOCK_TOLERANCE_US) {
    lines.push(...bulletList([`Warning: max_violation_us ${clock.max_violation_us} exceeds ${CLOCK_TOLERANCE_US}`]));
  }
  if (rows.length > 0) lines.push("", markdownTable(["Call", "Tool", "Verdict", "What happened"], rows));
  const notes = [
    phaseGlance("Startup", startupFindings(findings)),
    phaseGlance("Shutdown", shutdownFindings(findings)),
    phaseGlance("Unmatched", unmatchedFindings(findings)),
  ].filter((note): note is string => note !== null);
  lines.push(...bulletList(notes));
  const meta = [
    `${run.target.name} ${run.startup.server_info.version}. ${sourceText(run.target.source)}. Run ${run.run_id}.`,
    networkText(run.network),
    `Clock check: ${clockPassed(clock) ? "passed" : "failed"} (max_violation_us ${clock.max_violation_us}, responses_checked ${clock.responses_checked})`,
  ];
  if (judgments !== null) {
    meta.push("This run sent tool descriptions, source snippets, and each event's parsed body to Anthropic.");
  }
  meta.push("Event detail is in bundles.json.");
  lines.push(...bulletList(meta));
  return lines.join("\n");
}

function hiddenTextLines(profile: StaticProfile): string[] {
  const lines: string[] = [];
  for (const text of profile.tool_texts) {
    const notes: string[] = [];
    if (text.escaped_description.includes("\\u") || text.escaped_description.includes("\\x")) {
      notes.push(inlineCode(clip(text.escaped_description, 180)));
    }
    if (descriptionTooLong(text)) notes.push("description longer than 1000 characters");
    for (const flag of text.flags) notes.push(`phrase "${flag.phrase}"`);
    if (notes.length > 0) lines.push(`${text.tool}: ${notes.join(". ")}`);
  }
  return lines;
}

function packageSection(profile: StaticProfile): string {
  const items = [
    `${profile.package.name} ${profile.package.version ?? "none"}. ${profile.package.ecosystem}. Manifest ${profile.package.manifest_path ?? "none"}.`,
  ];
  if (profile.dependencies.length === 0) items.push("Dependencies: none");
  else items.push(`Dependencies: ${profile.dependencies.map((item) => `${item.name} ${item.spec}`).join(", ")}`);
  if (profile.install_scripts.length === 0) items.push("Install scripts: none");
  else items.push("Install scripts: ran at build time, not observed");
  const lines = ["# Package", ...bulletList(items)];
  for (const script of profile.install_scripts) lines.push(`  - ${script.hook}: ${inlineCode(script.command)}`);
  const hidden = hiddenTextLines(profile);
  if (hidden.length > 0) {
    lines.push("- Hidden description text:");
    for (const line of hidden) lines.push(`  - ${line}`);
  }
  if (profile.api_hints.length === 0) lines.push("- API hints: none");
  else {
    lines.push("- API hints:");
    for (const hint of profile.api_hints) {
      lines.push(`  - ${hint.category} ${hint.file}:${hint.line} ${inlineCode(clip(hint.snippet.trim(), 100))}`);
    }
  }
  return lines.join("\n");
}

function phaseSection(title: string, run: Run, findings: readonly Finding[]): string {
  const table = conciseFindings(run, findings);
  return [title, "", ...(table.length === 0 ? ["No findings."] : table)].join("\n");
}

function toolSection(
  run: Run,
  findings: readonly Finding[],
  judgments: readonly Judgment[] | null,
  call: ToolCallBundle,
): string {
  const seq = toolCallSeq(run, call.call_id);
  const glance = glanceOf(judgments, call.call_id);
  const forCall = callFindings(findings, call.call_id);
  const lines = [
    `# Tool call ${seq ?? "none"}: ${call.tool}`,
    "",
    `${glanceWords(glance)}. ${clip(claimText(call.definition), 180)}`,
    "",
    `Arguments (${argumentSourceText(call.argument_source)}):`,
    ...jsonBlock(call.arguments),
    "",
    "Reply:",
  ];
  switch (call.outcome.kind) {
    case "reply":
      lines.push(...jsonBlock(call.outcome.content));
      break;
    case "rpc_error":
      lines.push(...bulletList([`error ${call.outcome.code} ${call.outcome.message}`]));
      break;
    case "no_reply":
      lines.push(...bulletList([`no reply (${call.outcome.reason})`]));
      break;
    default: {
      const _exhaustive: never = call.outcome;
      return _exhaustive;
    }
  }
  const flows = flowSummaries(run, eventsOf(call.events));
  lines.push(...bulletList(flows));
  const table = conciseFindings(run, forCall);
  if (table.length > 0) lines.push("", ...table);
  lines.push("", ...judgeLines(call, judgments));
  return lines.join("\n");
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
  const relevant = unmatchedFindings(findings);
  const cited = citedIds(relevant);
  const hidden = run.unmatched.filter((entry) => !cited.has(entry.event.event_id)).length;
  const lines = ["# Unmatched"];
  const table = conciseFindings(run, relevant);
  if (table.length > 0) lines.push("", ...table);
  const notes: string[] = [];
  if (hidden > 0) notes.push(`${hidden} other unmatched events are in bundles.json.`);
  if (table.length === 0 && notes.length === 0) notes.push("none");
  lines.push(...bulletList(notes));
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
    for (const hint of platform) lines.push(`  - ${hint.file}:${hint.line} ${inlineCode(hint.snippet)}`);
  }
  return lines.join("\n");
}

function readJudgments(runDir: string, run: Run): readonly Judgment[] | null {
  const path = join(runDir, "judgments.json");
  if (!existsSync(path)) return null;
  return parseJudgments(readFileSync(path, "utf8"), "judgments.json", run);
}


function render(run: Run, profile: StaticProfile, findings: readonly Finding[], judgments: readonly Judgment[] | null): string {
  const parts = [verdictSection(run, findings, judgments)];
  for (const call of run.tool_calls) parts.push(toolSection(run, findings, judgments, call));
  parts.push(
    phaseSection("# Startup", run, startupFindings(findings)),
    phaseSection("# Shutdown", run, shutdownFindings(findings)),
    unmatchedSection(run, findings),
    packageSection(profile),
    limitsSection(profile),
  );
  return document(parts);
}

export function renderReport(runDir: string, profile: StaticProfile): string {
  const run = parseRun(readFileSync(join(runDir, "bundles.json"), "utf8"), "bundles.json");
  const findings = parseFindings(readFileSync(join(runDir, "findings.json"), "utf8"), "findings.json", run);
  const judgments = readJudgments(runDir, run);
  const markdown = render(run, profile, findings, judgments);
  writeAtomic(runDir, "report.md", markdown);
  return markdown;
}

export async function publishRun(runDir: string, mode: JudgeMode): Promise<string> {
  const envelope = readEnvelope(runDir);
  const sensed = readSensors(runDir, envelope.network);
  const transcriptPath = rawPath(runDir, "transcript.jsonl");
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
  return renderReport(runDir, profile);
}
