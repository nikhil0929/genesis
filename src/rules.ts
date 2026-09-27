import { Buffer } from "node:buffer";

import { RULE_NAMES } from "./model.js";
import type {
  CallDefinition,
  Canary,
  ConflictingAnnotation,
  Event,
  EventId,
  FileAccess,
  FileAction,
  Finding,
  FindingSubject,
  HttpBody,
  JsonObject,
  Peer,
  ProxyFlow,
  RuleName,
  Run,
  SourceHint,
  StaticProfile,
  WriteTarget,
} from "./model.js";

const RULE_TABLE: {
  readonly keywords: { readonly [Rule in RuleName]: readonly string[] };
  readonly credentialExact: readonly string[];
  readonly credentialPrefixes: readonly string[];
  readonly historyRoots: readonly string[];
  readonly historyNames: readonly string[];
  readonly procEnviron: RegExp;
  readonly codeExtensions: readonly string[];
  readonly writeSkip: readonly string[];
} = {
  keywords: {
    spawned_process: ["run", "execute", "command", "shell", "spawn", "process"],
    file_modified: ["write", "save", "create", "edit", "delete", "move", "rename"],
    credential_access: ["credential", "secret", "token", "password", "env", "config"],
    network_attempt: ["http", "url", "fetch", "download", "upload", "web", "api", "request"],
    late_code_load: ["plugin", "load", "install", "module", "script", "eval"],
    canary_exposed: [],
  },
  credentialExact: [
    "/home/detonee/.aws/credentials",
    "/home/detonee/.ssh/id_ed25519",
    "/home/detonee/.config/gh/hosts.yml",
    "/home/detonee/.npmrc",
    "/home/detonee/.netrc",
    "/home/detonee/.docker/config.json",
    "/home/detonee/.kube/config",
    "/work/.env",
    "/etc/shadow",
  ],
  credentialPrefixes: [
    "/home/detonee/.config/google-chrome",
    "/home/detonee/.config/chromium",
    "/home/detonee/.mozilla/firefox",
  ],
  historyRoots: ["/home/detonee", "/root"],
  historyNames: [".bash_history", ".zsh_history"],
  procEnviron: /^\/proc\/[0-9]+\/environ$/,
  codeExtensions: [".py", ".pyc", ".js", ".mjs", ".cjs", ".node", ".so", ".sh"],
  writeSkip: ["/dev/null"],
};

type Slot =
  | { readonly kind: "startup" }
  | { readonly kind: "shutdown" }
  | { readonly kind: "unmatched" }
  | {
      readonly kind: "call";
      readonly callId: Run["tool_calls"][number]["call_id"];
      readonly tool: string;
      readonly definition: CallDefinition;
    };

type Placed = { readonly event: Event; readonly slot: Slot };

type Match = {
  readonly rule: RuleName;
  readonly subject: FindingSubject;
  readonly unix: boolean;
};

type Evidence = [EventId, ...EventId[]];

type Group = {
  readonly slot: Slot;
  readonly rule: RuleName;
  readonly subject: FindingSubject;
  readonly evidence: Evidence;
  unix: boolean;
};

type FileFacts = {
  readonly modifiedPath: string | null;
  readonly credentialPath: string | null;
  readonly readPath: string | null;
  readonly writtenPaths: readonly string[];
  readonly paths: readonly string[];
};

const QUIET_FILE: FileFacts = {
  modifiedPath: null,
  credentialPath: null,
  readPath: null,
  writtenPaths: [],
  paths: [],
};

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot);
}

function isCodeFile(path: string): boolean {
  return RULE_TABLE.codeExtensions.includes(extensionOf(path));
}

function isSkippedWrite(path: string): boolean {
  return RULE_TABLE.writeSkip.includes(path);
}

function isCredentialPath(path: string): boolean {
  if (RULE_TABLE.credentialExact.includes(path)) return true;
  if (RULE_TABLE.credentialPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return true;
  if (RULE_TABLE.procEnviron.test(path)) return true;
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  if (!RULE_TABLE.historyNames.includes(name)) return false;
  const dir = slash === -1 ? "" : path.slice(0, slash);
  return RULE_TABLE.historyRoots.some((root) => dir === root || dir.startsWith(`${root}/`));
}

function credentialOrNull(path: string): string | null {
  return isCredentialPath(path) ? path : null;
}

function createsOrWrites(access: FileAccess, created: boolean): boolean {
  switch (access) {
    case "write":
    case "read_write":
      return true;
    case "read":
      return created;
    default: {
      const _exhaustive: never = access;
      return _exhaustive;
    }
  }
}

function openedForRead(access: FileAccess): boolean {
  switch (access) {
    case "read":
    case "read_write":
      return true;
    case "write":
      return false;
    default: {
      const _exhaustive: never = access;
      return _exhaustive;
    }
  }
}

function classifyFile(action: FileAction): FileFacts {
  switch (action.kind) {
    case "open": {
      const writes = createsOrWrites(action.access, action.created);
      return {
        modifiedPath: writes && !isSkippedWrite(action.path) ? action.path : null,
        credentialPath: credentialOrNull(action.path),
        readPath: openedForRead(action.access) ? action.path : null,
        writtenPaths: writes ? [action.path] : [],
        paths: [action.path],
      };
    }
    case "stat":
      return { ...QUIET_FILE, credentialPath: credentialOrNull(action.path), paths: [action.path] };
    case "truncate":
      return {
        ...QUIET_FILE,
        modifiedPath: isSkippedWrite(action.path) ? null : action.path,
        writtenPaths: [action.path],
        paths: [action.path],
      };
    case "unlink":
    case "mkdir":
    case "rmdir":
    case "chmod":
    case "chown":
      return { ...QUIET_FILE, modifiedPath: action.path, paths: [action.path] };
    case "rename":
    case "link":
    case "symlink":
      return { ...QUIET_FILE, modifiedPath: action.path, paths: [action.path, action.second_path] };
    case "access":
    case "readlink":
    case "utime":
    case "chdir":
    case "mknod":
    case "xattr":
    case "other":
      return { ...QUIET_FILE, paths: [action.path] };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function place(run: Run): { readonly slots: readonly Slot[]; readonly placed: readonly Placed[] } {
  const slots: Slot[] = [];
  const placed: Placed[] = [];
  const startup: Slot = { kind: "startup" };
  slots.push(startup);
  for (const entry of run.startup.events) placed.push({ event: entry.event, slot: startup });
  for (const call of run.tool_calls) {
    const slot: Slot = { kind: "call", callId: call.call_id, tool: call.tool, definition: call.definition };
    slots.push(slot);
    for (const entry of call.events) placed.push({ event: entry.event, slot });
  }
  const shutdown: Slot = { kind: "shutdown" };
  slots.push(shutdown);
  for (const entry of run.shutdown.events) placed.push({ event: entry.event, slot: shutdown });
  const unmatched: Slot = { kind: "unmatched" };
  slots.push(unmatched);
  for (const entry of run.unmatched) placed.push({ event: entry.event, slot: unmatched });
  return { slots, placed };
}

function rootPid(run: Run): number | null {
  for (const process of Object.values(run.processes)) {
    if (process.kind === "root") return process.pid;
  }
  return null;
}

function rootFirstExec(placed: readonly Placed[], root: number | null): EventId | null {
  if (root === null) return null;
  let best: Event | null = null;
  for (const { event } of placed) {
    if (event.pid !== root) continue;
    if (event.body.kind !== "process" || event.body.action.kind !== "exec") continue;
    if (best === null || event.t_us < best.t_us) best = event;
  }
  return best === null ? null : best.event_id;
}

function noteWrite(writes: Map<string, number>, path: string, tUs: number): void {
  const prior = writes.get(path);
  if (prior === undefined || tUs < prior) writes.set(path, tUs);
}

function writtenPaths(placed: readonly Placed[]): Map<string, number> {
  const writes = new Map<string, number>();
  for (const { event } of placed) {
    const body = event.body;
    switch (body.kind) {
      case "file":
        for (const path of classifyFile(body.action).writtenPaths) noteWrite(writes, path, event.t_us);
        break;
      case "data":
        if (body.target.kind === "file") noteWrite(writes, body.target.path, event.t_us);
        break;
      case "process":
      case "net":
      case "other":
        break;
      default: {
        const _exhaustive: never = body;
        return _exhaustive;
      }
    }
  }
  return writes;
}

function loadsCode(path: string, tUs: number, slot: Slot, writes: ReadonlyMap<string, number>): boolean {
  if (!isCodeFile(path)) return false;
  if (slot.kind === "call" || slot.kind === "shutdown") return true;
  const wroteAt = writes.get(path);
  return wroteAt !== undefined && wroteAt < tUs;
}

function argvOf(run: Run, pid: number): readonly string[] {
  const process = run.processes[String(pid)];
  if (process === undefined) return [];
  let earliest: (typeof process.execs)[number] | null = null;
  for (const exec of process.execs) {
    if (earliest === null || exec.t_us < earliest.t_us) earliest = exec;
  }
  return earliest === null ? [] : earliest.argv;
}

function processMatches(
  event: Event,
  slot: Slot,
  run: Run,
  firstExec: EventId | null,
  writes: ReadonlyMap<string, number>,
): Match[] {
  if (event.body.kind !== "process") return [];
  const action = event.body.action;
  const found: Match[] = [];
  switch (action.kind) {
    case "exec":
      // The root's first execve is the server image. A later execve is a new command.
      if (event.event_id !== firstExec) {
        found.push({ rule: "spawned_process", subject: { kind: "argv", argv: action.argv }, unix: false });
      }
      if (loadsCode(action.path, event.t_us, slot, writes)) {
        found.push({ rule: "late_code_load", subject: { kind: "path", path: action.path }, unix: false });
      }
      break;
    case "spawn":
      if (action.untraced) {
        // CLONE_UNTRACED is the parent's clone. The subject is the child's exec argv when the trace has one.
        found.push({
          rule: "spawned_process",
          subject: { kind: "argv", argv: argvOf(run, action.child_pid) },
          unix: false,
        });
      }
      break;
    case "thread":
    case "exit":
      break;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
  return found;
}

function fileMatches(event: Event, slot: Slot, writes: ReadonlyMap<string, number>): Match[] {
  if (event.body.kind !== "file") return [];
  const facts = classifyFile(event.body.action);
  const found: Match[] = [];
  if (facts.modifiedPath !== null) {
    found.push({ rule: "file_modified", subject: { kind: "path", path: facts.modifiedPath }, unix: false });
  }
  if (facts.credentialPath !== null) {
    found.push({ rule: "credential_access", subject: { kind: "path", path: facts.credentialPath }, unix: false });
  }
  if (facts.readPath !== null && loadsCode(facts.readPath, event.t_us, slot, writes)) {
    found.push({ rule: "late_code_load", subject: { kind: "path", path: facts.readPath }, unix: false });
  }
  return found;
}

function peerIsUnix(peer: Peer): boolean {
  switch (peer.kind) {
    case "unix":
      return true;
    case "ip":
    case "none":
      return false;
    default: {
      const _exhaustive: never = peer;
      return _exhaustive;
    }
  }
}

function destinationIsUnix(body: Extract<Event["body"], { kind: "net" }>): boolean {
  switch (body.family) {
    case "unix":
      return true;
    case "inet":
    case "inet6":
    case "netlink":
    case "other":
      return peerIsUnix(body.peer) || peerIsUnix(body.local);
    default: {
      const _exhaustive: never = body.family;
      return _exhaustive;
    }
  }
}

function netOpFires(body: Extract<Event["body"], { kind: "net" }>): boolean {
  switch (body.op) {
    case "connect":
    case "bind":
    case "listen":
      return true;
    case "send":
      return body.peer.kind !== "none";
    case "socket":
    case "accept":
      return false;
    default: {
      const _exhaustive: never = body.op;
      return _exhaustive;
    }
  }
}

function lookupFlow(run: Run, flowId: string | null): ProxyFlow | null {
  if (flowId === null) return null;
  switch (run.network.kind) {
    case "allow":
      return run.network.flows.find((flow) => flow.flow_id === flowId) ?? null;
    case "block":
      return null;
    default: {
      const _exhaustive: never = run.network;
      return _exhaustive;
    }
  }
}

function netMatches(event: Event, run: Run): Match[] {
  if (event.body.kind !== "net") return [];
  const body = event.body;
  if (!netOpFires(body) && body.dns_name === null) return [];
  const flow = lookupFlow(run, body.proxy_flow_id);
  // A joined flow replaces the proxy address. A decoded DNS name replaces the resolver address.
  if (flow !== null) {
    return [
      {
        rule: "network_attempt",
        subject: { kind: "flow", method: flow.request.method, url: flow.request.url },
        unix: false,
      },
    ];
  }
  if (body.dns_name !== null) {
    return [{ rule: "network_attempt", subject: { kind: "dns_name", name: body.dns_name }, unix: false }];
  }
  return [{ rule: "network_attempt", subject: { kind: "peer", peer: body.peer }, unix: destinationIsUnix(body) }];
}

function textHasCanary(text: string, canaries: readonly Canary[], ignoreCase: boolean): boolean {
  const haystack = ignoreCase ? text.toLowerCase() : text;
  return canaries.some((canary) => {
    const needle = ignoreCase ? canary.value.toLowerCase() : canary.value;
    return needle.length > 0 && haystack.includes(needle);
  });
}

function bodyText(body: HttpBody): string {
  switch (body.kind) {
    case "text":
      return body.text;
    case "base64":
      return Buffer.from(body.base64, "base64").toString("utf8");
    default: {
      const _exhaustive: never = body;
      return _exhaustive;
    }
  }
}

function flowHasCanary(flow: ProxyFlow, canaries: readonly Canary[]): boolean {
  if (textHasCanary(bodyText(flow.request.body), canaries, false)) return true;
  switch (flow.result.kind) {
    case "response":
      return textHasCanary(bodyText(flow.result.response.body), canaries, false);
    case "error":
      return false;
    default: {
      const _exhaustive: never = flow.result;
      return _exhaustive;
    }
  }
}

function unixPath(peer: Peer): string | null {
  switch (peer.kind) {
    case "unix":
      return peer.path;
    case "ip":
    case "none":
      return null;
    default: {
      const _exhaustive: never = peer;
      return _exhaustive;
    }
  }
}

// Streams and pipes have no filesystem path, so the subject names the stream or the inode.
function writeSubject(target: WriteTarget): FindingSubject {
  switch (target.kind) {
    case "file":
      return { kind: "path", path: target.path };
    case "socket":
      return { kind: "peer", peer: target.peer };
    case "pipe":
      return { kind: "path", path: target.inode };
    case "stdout":
      return { kind: "path", path: "stdout" };
    case "stderr":
      return { kind: "path", path: "stderr" };
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function canarySubjects(event: Event, run: Run): FindingSubject[] {
  const canaries = run.canaries;
  if (canaries.length === 0) return [];
  const subjects: FindingSubject[] = [];
  const add = (subject: FindingSubject): void => {
    const key = JSON.stringify(subject);
    if (subjects.some((item) => JSON.stringify(item) === key)) return;
    subjects.push(subject);
  };
  const hit = (text: string, ignoreCase = false): boolean => textHasCanary(text, canaries, ignoreCase);
  const body = event.body;
  switch (body.kind) {
    case "process":
      switch (body.action.kind) {
        case "exec":
          // A decoy name in env_names is inheritance. The canary value has to appear on its own.
          if (hit(body.action.path)) add({ kind: "path", path: body.action.path });
          if (body.action.argv.some((arg) => hit(arg))) add({ kind: "argv", argv: body.action.argv });
          break;
        case "spawn":
        case "thread":
        case "exit":
          break;
        default: {
          const _exhaustive: never = body.action;
          return _exhaustive;
        }
      }
      break;
    case "file":
      for (const path of classifyFile(body.action).paths) {
        if (hit(path)) add({ kind: "path", path });
      }
      break;
    case "net": {
      if (body.dns_name !== null && hit(body.dns_name, true)) add({ kind: "dns_name", name: body.dns_name });
      const peerPath = unixPath(body.peer);
      const localPath = unixPath(body.local);
      if (peerPath !== null && hit(peerPath)) add({ kind: "path", path: peerPath });
      if (localPath !== null && hit(localPath)) add({ kind: "path", path: localPath });
      const flow = lookupFlow(run, body.proxy_flow_id);
      if (flow !== null && flowHasCanary(flow, canaries)) {
        add({ kind: "flow", method: flow.request.method, url: flow.request.url });
      }
      break;
    }
    case "data":
      if (hit(body.preview)) add(writeSubject(body.target));
      if (body.target.kind === "file" && hit(body.target.path)) add({ kind: "path", path: body.target.path });
      break;
    case "other":
      break;
    default: {
      const _exhaustive: never = body;
      return _exhaustive;
    }
  }
  return subjects;
}

function eventMatches(
  event: Event,
  slot: Slot,
  run: Run,
  firstExec: EventId | null,
  writes: ReadonlyMap<string, number>,
): Match[] {
  return [
    ...processMatches(event, slot, run, firstExec, writes),
    ...fileMatches(event, slot, writes),
    ...netMatches(event, run),
    ...canarySubjects(event, run).map((subject) => ({ rule: "canary_exposed" as const, subject, unix: false })),
  ];
}

function addGroup(groups: Group[], slot: Slot, eventId: EventId, match: Match): void {
  const key = JSON.stringify(match.subject);
  const existing = groups.find(
    (group) => group.slot === slot && group.rule === match.rule && JSON.stringify(group.subject) === key,
  );
  if (existing === undefined) {
    groups.push({ slot, rule: match.rule, subject: match.subject, evidence: [eventId], unix: match.unix });
    return;
  }
  if (!existing.evidence.includes(eventId)) existing.evidence.push(eventId);
  if (!match.unix) existing.unix = false;
}

function schemaProperties(schema: JsonObject): readonly string[] {
  const properties = schema["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [];
  return Object.keys(properties).sort();
}

function interfaceMentions(rule: RuleName, tool: string, definition: CallDefinition): string | null {
  const keywords = RULE_TABLE.keywords[rule];
  let description = "";
  let properties: readonly string[] = [];
  switch (definition.kind) {
    case "advertised":
      description = definition.tool.description ?? "";
      properties = schemaProperties(definition.tool.input_schema);
      break;
    case "not_advertised":
      break;
    default: {
      const _exhaustive: never = definition;
      return _exhaustive;
    }
  }
  const haystacks = [tool, description, ...properties];
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    if (haystacks.some((haystack) => haystack.toLowerCase().includes(needle))) return keyword;
  }
  return null;
}

function annotationConflict(rule: RuleName, definition: CallDefinition, unix: boolean): ConflictingAnnotation | null {
  switch (definition.kind) {
    case "advertised": {
      const annotations = definition.tool.annotations;
      if (rule === "file_modified" && annotations.read_only_hint === true) return "readOnlyHint";
      if (rule === "network_attempt" && annotations.open_world_hint === false && !unix) return "openWorldHint";
      return null;
    }
    case "not_advertised":
      return null;
    default: {
      const _exhaustive: never = definition;
      return _exhaustive;
    }
  }
}

function sourceHints(profile: StaticProfile, rule: RuleName, tool: string | null): SourceHint[] {
  const files =
    tool === null
      ? null
      : new Set(
          profile.tool_sites.filter((sites) => sites.tool === tool).flatMap((sites) => sites.sites.map((site) => site.file)),
        );
  const matched = profile.api_hints.filter((hint) => {
    if (hint.category !== rule) return false;
    if (files !== null && !files.has(hint.file)) return false;
    return true;
  });
  matched.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line));
  const hints: SourceHint[] = [];
  for (const hint of matched) {
    const last = hints.at(-1);
    if (last !== undefined && last.file === hint.file && last.line === hint.line) continue;
    hints.push({ file: hint.file, line: hint.line });
  }
  return hints;
}

function toFinding(group: Group, profile: StaticProfile): Finding {
  const tool = group.slot.kind === "call" ? group.slot.tool : null;
  const source_hints = sourceHints(profile, group.rule, tool);
  const base = {
    rule: group.rule,
    evidence: group.evidence,
    subject: group.subject,
    source_hints,
  };
  switch (group.slot.kind) {
    case "call":
      return {
        kind: "call",
        call_id: group.slot.callId,
        ...base,
        claim_check: {
          interface_mentions: interfaceMentions(group.rule, group.slot.tool, group.slot.definition),
          annotation_conflict: annotationConflict(group.rule, group.slot.definition, group.unix),
        },
      };
    case "startup":
      return { kind: "startup", ...base };
    case "shutdown":
      return { kind: "shutdown", ...base };
    case "unmatched":
      return { kind: "unmatched", ...base };
    default: {
      const _exhaustive: never = group.slot;
      return _exhaustive;
    }
  }
}

export function applyRules(run: Run, profile: StaticProfile): readonly Finding[] {
  const { slots, placed } = place(run);
  const firstExec = rootFirstExec(placed, rootPid(run));
  const writes = writtenPaths(placed);
  const groups: Group[] = [];
  for (const item of placed) {
    for (const match of eventMatches(item.event, item.slot, run, firstExec, writes)) {
      addGroup(groups, item.slot, item.event.event_id, match);
    }
  }
  const findings: Finding[] = [];
  for (const slot of slots) {
    for (const rule of RULE_NAMES) {
      for (const group of groups) {
        if (group.slot === slot && group.rule === rule) findings.push(toFinding(group, profile));
      }
    }
  }
  return findings;
}
