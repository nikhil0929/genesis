import { decode } from "dns-packet";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BoundaryError, CLOCK_TOLERANCE_US, parseEvents, parseProcesses } from "../model.js";
import type { Event, ProxyFlow, RunNetwork, SensorProcesses } from "../model.js";

export type SensorTrace = {
  readonly events: readonly Event[];
  readonly processes: SensorProcesses;
};

type ResultJson =
  | { readonly kind: "ok"; readonly value: number }
  | { readonly kind: "error"; readonly errno: string }
  | { readonly kind: "no_return" };

type YySocket = {
  readonly protocol: "TCP" | "UDP";
  readonly local: { readonly address: string; readonly port: number };
  readonly peer: { readonly address: string; readonly port: number };
};

type NetCapture = {
  readonly yy: YySocket | null;
  readonly payload: Buffer | null;
  readonly fd: number | null;
};

type NetAnnotation =
  | { readonly kind: "dns"; readonly name: string }
  | { readonly kind: "flow"; readonly flowId: string }
  | { readonly kind: "plain" };

type Annotatable = {
  readonly body: Record<string, unknown>;
  readonly tUs: number;
  readonly capture: NetCapture | null;
};

type RawCall = {
  readonly tUs: number;
  readonly tid: number;
  readonly line: number;
  readonly file: string;
  readonly syscall: string;
  readonly result: ResultJson;
  readonly body: Record<string, unknown>;
  readonly capture: NetCapture | null;
};

const FLOW_JOIN_SLACK_US = 2_000_000;
const YY_SOCKET = /(TCP|UDP):\[(\d{1,3}(?:\.\d{1,3}){3}):(\d+)->(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\]/;
const NET_SYSCALLS = new Set([
  "socket",
  "connect",
  "bind",
  "listen",
  "accept",
  "accept4",
  "send",
  "sendto",
  "sendmsg",
  "sendmmsg",
]);
const SEND_SYSCALLS = new Set(["send", "sendto", "sendmsg", "sendmmsg"]);

const FILE_KIND: Readonly<Record<string, string>> = {
  unlink: "unlink",
  unlinkat: "unlink",
  mkdir: "mkdir",
  mkdirat: "mkdir",
  rmdir: "rmdir",
  chmod: "chmod",
  fchmod: "chmod",
  fchmodat: "chmod",
  chown: "chown",
  lchown: "chown",
  fchown: "chown",
  fchownat: "chown",
  truncate: "truncate",
  ftruncate: "truncate",
  utime: "utime",
  utimes: "utime",
  utimensat: "utime",
  futimesat: "utime",
  chdir: "chdir",
  fchdir: "chdir",
  mknod: "mknod",
  mknodat: "mknod",
  stat: "stat",
  lstat: "stat",
  fstat: "stat",
  newfstatat: "stat",
  statx: "stat",
  fstatat: "stat",
  fstatat64: "stat",
  access: "access",
  faccessat: "access",
  faccessat2: "access",
  readlink: "readlink",
  readlinkat: "readlink",
  rename: "rename",
  renameat: "rename",
  renameat2: "rename",
  link: "link",
  linkat: "link",
  symlink: "symlink",
  symlinkat: "symlink",
};

function stampToUs(whole: string, frac: string): number {
  const micros = (frac + "000000").slice(0, 6);
  return Number(whole) * 1_000_000 + Number(micros);
}

function decodeStrace(body: string): string {
  let out = "";
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char !== "\\") {
      out += char ?? "";
      index += 1;
      continue;
    }
    const next = body[index + 1];
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "\\") out += "\\";
    else if (next === '"') out += '"';
    else if (next === "x") {
      const hex = body.slice(index + 2, index + 4);
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    } else if (next !== undefined && next >= "0" && next <= "7") {
      const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1));
      if (octal?.[0] !== undefined) {
        out += String.fromCharCode(Number.parseInt(octal[0], 8));
        index += 1 + octal[0].length;
        continue;
      }
      out += next;
    } else out += next ?? "";
    index += 2;
  }
  return out;
}

function takeAnnotation(text: string, start: number): { readonly text: string; readonly next: number } | null {
  if (text[start] !== "<") return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "<") depth += 1;
    else if (text[index] === ">") {
      depth -= 1;
      if (depth === 0) return { text: text.slice(start + 1, index), next: index + 1 };
    }
  }
  return null;
}

function annotationPath(annotation: string | null): string | null {
  if (annotation === null || !annotation.startsWith("/")) return null;
  const nested = annotation.indexOf("<");
  return nested === -1 ? annotation : annotation.slice(0, nested);
}

function splitCall(text: string): { readonly name: string; readonly args: string; readonly tail: string } | null {
  const name = /^([A-Za-z0-9_]+)\(/.exec(text);
  if (name?.[1] === undefined) return null;
  let index = name[1].length + 1;
  let depth = 1;
  let quote = false;
  while (index < text.length && depth > 0) {
    if (!quote && text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') quote = false;
      index += 1;
      continue;
    }
    if (char === '"') quote = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    index += 1;
  }
  if (depth !== 0) return null;
  return { name: name[1], args: text.slice(name[1].length + 1, index - 1), tail: text.slice(index).trim() };
}

function parseTail(tail: string): { readonly result: ResultJson; readonly annotation: string | null } | { readonly result: "unfinished" } {
  if (tail.startsWith("<unfinished")) return { result: "unfinished" };
  if (tail.startsWith("= ?")) return { result: { kind: "no_return" }, annotation: null };
  const error = /^= -?\d+ (E[A-Z0-9]+)/.exec(tail);
  if (error?.[1] !== undefined) return { result: { kind: "error", errno: error[1] }, annotation: null };
  const ok = /^= (-?\d+)/.exec(tail);
  if (ok?.[1] !== undefined) {
    const rest = tail.slice(ok[0].length).trim();
    const annotation = rest.startsWith("<") ? (takeAnnotation(rest, 0)?.text ?? null) : null;
    return { result: { kind: "ok", value: Number(ok[1]) }, annotation };
  }
  return { result: { kind: "no_return" }, annotation: null };
}

function readQuoted(text: string, start: number): { readonly text: string; readonly truncated: boolean; readonly next: number } | null {
  if (text[start] !== '"') return null;
  let raw = "";
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      raw += text[index] + (text[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (text[index] === '"') {
      const truncated = text.slice(index + 1).trimStart().startsWith("...");
      return { text: decodeStrace(raw), truncated, next: index + 1 };
    }
    raw += text[index] ?? "";
    index += 1;
  }
  return null;
}

function quotedStrings(text: string): { readonly text: string; readonly truncated: boolean }[] {
  const found: { text: string; truncated: boolean }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"') continue;
    const quoted = readQuoted(text, index);
    if (quoted === null) break;
    found.push({ text: quoted.text, truncated: quoted.truncated });
    index = quoted.next - 1;
  }
  return found;
}

function cwdOf(args: string): string {
  const match = /AT_FDCWD<([^>]*)>/.exec(args);
  const cwd = match?.[1] ?? "/";
  return cwd.startsWith("/") ? cwd : `/${cwd}`;
}

function resolvePath(cwd: string, path: string): string | null {
  if (path.startsWith("/")) return path;
  if (path === "" || path === ".") return cwd;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  const joined = `${base}/${path}`;
  return joined.startsWith("/") ? joined : null;
}

function pathFromArgs(args: string): string | null {
  const cwd = cwdOf(args);
  const quoted = quotedStrings(args)[0];
  if (quoted !== undefined && quoted.text !== "") return resolvePath(cwd, quoted.text);
  const fd = /^(\d+)</.exec(args);
  if (fd !== null) {
    const annotation = takeAnnotation(args, fd[0].length - 1);
    return annotationPath(annotation?.text ?? null);
  }
  return annotationPath(takeAnnotation(args, args.indexOf("<"))?.text ?? null);
}

function accessOf(flags: string): "read" | "write" | "read_write" {
  if (flags.includes("O_RDWR")) return "read_write";
  if (flags.includes("O_WRONLY")) return "write";
  return "read";
}

function other(unparsed: string | null): Record<string, unknown> {
  return { kind: "other", unparsed };
}

function fileBody(kind: string, path: string, second?: string): Record<string, unknown> {
  if (kind === "rename" || kind === "link" || kind === "symlink") {
    return { kind, path, second_path: second ?? path };
  }
  return { kind, path };
}

function openBody(args: string, resultAnnotation: string | null): Record<string, unknown> | null {
  const quoted = quotedStrings(args)[0];
  const fromResult = annotationPath(resultAnnotation);
  const path = fromResult ?? (quoted === undefined ? null : resolvePath(cwdOf(args), quoted.text));
  if (path === null) return null;
  return {
    kind: "open",
    path,
    access: accessOf(args),
    created: args.includes("O_CREAT") || args.includes("O_TMPFILE"),
  };
}

function bracketGroups(args: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  let quote = false;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    else if (char === "[") {
      if (depth === 0) start = index + 1;
      depth += 1;
    } else if (char === "]" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) groups.push(args.slice(start, index));
    }
  }
  return groups;
}

function execBody(args: string): Record<string, unknown> | null {
  const groups = bracketGroups(args);
  const argvGroup = groups[0];
  const envGroup = groups[1];
  if (argvGroup === undefined) return null;
  const argv = quotedStrings(argvGroup).map((item) => item.text);
  const path = quotedStrings(args)[0]?.text ?? argv[0];
  if (path === undefined) return null;
  const envNames = (envGroup === undefined ? [] : quotedStrings(envGroup).map((item) => item.text))
    .map((item) => {
      const eq = item.indexOf("=");
      return eq === -1 ? item : item.slice(0, eq);
    })
    .filter((name) => name.length > 0);
  return { kind: "exec", path, argv, env_names: envNames };
}

function writeTarget(fd: number, annotation: string | null): Record<string, unknown> {
  if (annotation !== null && annotation.startsWith("pipe:[")) {
    if (fd === 1) return { kind: "stdout" };
    if (fd === 2) return { kind: "stderr" };
    const inode = annotation.slice("pipe:[".length, -1);
    return { kind: "pipe", inode: inode.length > 0 ? inode : "0" };
  }
  const path = annotationPath(annotation);
  if (fd === 1 && (path === null || path.startsWith("/dev/pts") || path.startsWith("/dev/tty"))) return { kind: "stdout" };
  if (fd === 2 && (path === null || path.startsWith("/dev/pts") || path.startsWith("/dev/tty"))) return { kind: "stderr" };
  if (path !== null) return { kind: "file", path };
  if (annotation !== null && (annotation.startsWith("TCP:") || annotation.startsWith("UDP:") || annotation.includes("socket"))) {
    return { kind: "socket", peer: { kind: "none" } };
  }
  if (fd === 1) return { kind: "stdout" };
  if (fd === 2) return { kind: "stderr" };
  return { kind: "pipe", inode: "unknown" };
}

function leadingFd(args: string): { readonly fd: number; readonly annotation: string | null; readonly rest: string } | null {
  const match = /^(\d+)/.exec(args);
  if (match?.[1] === undefined) return null;
  let index = match[1].length;
  let annotation: string | null = null;
  if (args[index] === "<") {
    const taken = takeAnnotation(args, index);
    if (taken === null) return null;
    annotation = taken.text;
    index = taken.next;
  }
  if (args[index] === ",") index += 1;
  return { fd: Number(match[1]), annotation, rest: args.slice(index).trim() };
}

function dataBody(args: string): Record<string, unknown> | null {
  const fd = leadingFd(args);
  if (fd === null) return null;
  const pieces = quotedStrings(fd.rest);
  let preview = pieces.map((piece) => piece.text).join("");
  let truncated = pieces.some((piece) => piece.truncated);
  if (preview.length > 4096) {
    preview = preview.slice(0, 4096);
    truncated = true;
  }
  const count = /, (-?\d+)\s*$/.exec(fd.rest);
  const byteCount = count?.[1] === undefined ? preview.length : Math.max(0, Number(count[1]));
  return {
    kind: "data",
    target: writeTarget(fd.fd, fd.annotation),
    byte_count: byteCount,
    preview,
    truncated,
  };
}

function peerFrom(args: string): Record<string, unknown> {
  const unix = /sun_path="([^"]*)"/.exec(args);
  if (unix?.[1] !== undefined) return { kind: "unix", path: unix[1] };
  const address = /inet_addr\("([^"]+)"\)/.exec(args);
  const port = /htons\((\d+)\)/.exec(args);
  if (address?.[1] !== undefined && port?.[1] !== undefined) {
    return { kind: "ip", address: address[1], port: Number(port[1]) };
  }
  const bracket = /\[([0-9a-fA-F:.]+)\]:(\d+)/.exec(args);
  if (bracket?.[1] !== undefined && bracket[2] !== undefined) {
    return { kind: "ip", address: bracket[1], port: Number(bracket[2]) };
  }
  return { kind: "none" };
}

function netBody(name: string, args: string): Record<string, unknown> {
  const op =
    name === "accept" || name === "accept4"
      ? "accept"
      : name === "sendto" || name === "sendmsg" || name === "sendmmsg"
        ? "send"
        : name;
  const family = args.includes("AF_INET6")
    ? "inet6"
    : args.includes("AF_INET")
      ? "inet"
      : args.includes("AF_UNIX")
        ? "unix"
        : args.includes("AF_NETLINK")
          ? "netlink"
          : "other";
  const protocol = args.includes("SOCK_DGRAM")
    ? family === "unix"
      ? "unix_dgram"
      : "udp"
    : args.includes("SOCK_STREAM")
      ? family === "unix"
        ? "unix_stream"
        : "tcp"
      : family === "unix"
        ? "unix_stream"
        : "other";
  const fd = leadingFd(args);
  const local = fd === null ? { kind: "none" } : peerFrom(fd.annotation ?? "");
  return {
    kind: "net",
    op,
    family,
    protocol,
    local,
    peer: peerFrom(args),
    dns_name: null,
    proxy_flow_id: null,
  };
}

function processBody(name: string, args: string, result: ResultJson): Record<string, unknown> | null {
  if (name === "execve" || name === "execveat") return execBody(args);
  if (name === "exit" || name === "exit_group") {
    const status = /^\s*(-?\d+)/.exec(args);
    return { kind: "exit", end: { kind: "exited", status: status?.[1] === undefined ? 0 : Number(status[1]) } };
  }
  if (name !== "clone" && name !== "clone3" && name !== "fork" && name !== "vfork") return null;
  if (result.kind !== "ok" || result.value <= 0) return null;
  if (args.includes("CLONE_THREAD")) return { kind: "thread", tid: result.value };
  return { kind: "spawn", child_pid: result.value, untraced: args.includes("CLONE_UNTRACED") };
}

function bodyFor(name: string, args: string, result: ResultJson, resultAnnotation: string | null): Record<string, unknown> {
  if (name === "write" || name === "writev" || name === "pwrite64") return dataBody(args) ?? other(null);
  if (name === "open" || name === "openat" || name === "creat") {
    const opened = openBody(args, resultAnnotation);
    if (opened === null) return other(null);
    if (name === "creat") {
      opened.access = "write";
      opened.created = true;
    }
    return { kind: "file", action: opened };
  }
  const spawned = processBody(name, args, result);
  if (spawned !== null) return { kind: "process", action: spawned };
  if (
    name === "socket" ||
    name === "connect" ||
    name === "bind" ||
    name === "listen" ||
    name === "accept" ||
    name === "accept4" ||
    name === "send" ||
    name === "sendto" ||
    name === "sendmsg" ||
    name === "sendmmsg"
  ) {
    return netBody(name, args);
  }
  const fileKind = FILE_KIND[name];
  if (fileKind !== undefined) {
    const path = annotationPath(resultAnnotation) ?? pathFromArgs(args);
    if (path !== null) {
      const paths = quotedStrings(args).map((item) => item.text).filter((item) => item.startsWith("/"));
      return { kind: "file", action: fileBody(fileKind, path, paths[1]) };
    }
  }
  return other(null);
}

function processAction(body: Record<string, unknown>): Record<string, unknown> | null {
  if (body.kind !== "process" || typeof body.action !== "object" || body.action === null) return null;
  return body.action as Record<string, unknown>;
}

function callFrom(text: string, tUs: number, tid: number, line: number, file: string): RawCall | null {
  const split = splitCall(text);
  if (split === null) {
    return {
      tUs,
      tid,
      line,
      file,
      syscall: "unparsed",
      result: { kind: "no_return" },
      body: other(text),
      capture: null,
    };
  }
  const tail = parseTail(split.tail);
  if (tail.result === "unfinished") return null;
  const annotation = "annotation" in tail ? tail.annotation : null;
  return {
    tUs,
    tid,
    line,
    file,
    syscall: split.name,
    result: tail.result,
    body: bodyFor(split.name, split.args, tail.result, annotation),
    capture: captureOf(split.name, split.args, annotation),
  };
}

function marker(rest: string, tUs: number, tid: number, line: number, file: string): RawCall | null {
  const exited = /^\+\+\+ exited with (-?\d+) \+\+\+$/.exec(rest);
  if (exited?.[1] !== undefined) {
    return {
      tUs,
      tid,
      line,
      file,
      syscall: "exited",
      result: { kind: "no_return" },
      body: { kind: "process", action: { kind: "exit", end: { kind: "exited", status: Number(exited[1]) } } },
      capture: null,
    };
  }
  const killed = /^\+\+\+ killed by ([A-Za-z0-9]+) \+\+\+$/.exec(rest);
  if (killed?.[1] !== undefined) {
    return {
      tUs,
      tid,
      line,
      file,
      syscall: "killed",
      result: { kind: "no_return" },
      body: { kind: "process", action: { kind: "exit", end: { kind: "killed", signal: killed[1] } } },
      capture: null,
    };
  }
  const signal = /^--- ([A-Z0-9]+) /.exec(rest);
  if (signal?.[1] !== undefined) {
    return {
      tUs,
      tid,
      line,
      file,
      syscall: signal[1],
      result: { kind: "no_return" },
      body: other(rest),
      capture: null,
    };
  }
  return {
    tUs,
    tid,
    line,
    file,
    syscall: "unparsed",
    result: { kind: "no_return" },
    body: other(rest),
    capture: null,
  };
}

function observeSocket(text: string): { readonly fd: number; readonly yy: YySocket } | null {
  const match = YY_SOCKET.exec(text);
  if (match === null || match.index === undefined) return null;
  const yy = parseYySocket(match[0]);
  if (yy === null) return null;
  const fd = /(\d+)<[^<]*$/.exec(text.slice(0, match.index))?.[1];
  return fd === undefined ? null : { fd: Number(fd), yy };
}

// connect() returns before the tuple exists. The established socket shows up on the next syscall for that fd.
function bindEstablishedSockets(
  calls: readonly RawCall[],
  seen: readonly { readonly line: number; readonly fd: number; readonly yy: YySocket }[],
): RawCall[] {
  return calls.map((call) => {
    const capture = call.capture;
    if (capture === null || capture.yy !== null || capture.fd === null) return call;
    const reuse = calls.find(
      (other) => other.line > call.line && other.syscall === "connect" && other.capture?.fd === capture.fd,
    );
    const limit = reuse?.line ?? Number.POSITIVE_INFINITY;
    const found = seen.find((item) => item.fd === capture.fd && item.line >= call.line && item.line < limit);
    if (found === undefined) return call;
    return { ...call, capture: { yy: found.yy, payload: capture.payload, fd: capture.fd } };
  });
}

// A blocking call is stamped when it starts. The resumed line only carries the return.
function parseFile(file: string, tid: number, text: string): RawCall[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const calls: RawCall[] = [];
  const seen: { line: number; fd: number; yy: YySocket }[] = [];
  let pending: { readonly tUs: number; readonly line: number; readonly name: string; readonly args: string } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const stamp = /^(\d+)\.(\d+)\s+([\s\S]*)$/.exec(line);
    if (stamp?.[1] === undefined || stamp[2] === undefined || stamp[3] === undefined) continue;
    const tUs = stampToUs(stamp[1], stamp[2]);
    const rest = stamp[3];
    const lineNo = index + 1;
    const socket = observeSocket(rest);
    if (socket !== null) seen.push({ line: lineNo, fd: socket.fd, yy: socket.yy });
    if (rest.includes("<unfinished ...>")) {
      const name = /^([A-Za-z0-9_]+)\(/.exec(rest);
      pending =
        name?.[1] === undefined
          ? null
          : { tUs, line: lineNo, name: name[1], args: rest.slice(name[1].length + 1).replace(/\s*<unfinished \.\.\.>\s*$/, "") };
      continue;
    }
    const resumed = /^<\.\.\. ([A-Za-z0-9_]+) resumed>([\s\S]*)$/.exec(rest);
    if (resumed?.[1] !== undefined && resumed[2] !== undefined && pending !== null && pending.name === resumed[1]) {
      const parsed = callFrom(`${pending.name}(${pending.args}${resumed[2]}`, pending.tUs, tid, pending.line, file);
      pending = null;
      if (parsed !== null) calls.push(parsed);
      continue;
    }
    if (rest.startsWith("+++") || rest.startsWith("---")) {
      const parsed = marker(rest, tUs, tid, lineNo, file);
      if (parsed !== null) calls.push(parsed);
      continue;
    }
    const parsed = callFrom(rest, tUs, tid, lineNo, file);
    if (parsed !== null) calls.push(parsed);
  }
  if (pending !== null) {
    calls.push({
      tUs: pending.tUs,
      tid,
      line: pending.line,
      file,
      syscall: pending.name,
      result: { kind: "no_return" },
      body: other(null),
      capture: null,
    });
  }
  return bindEstablishedSockets(calls, seen);
}

function resolvePid(tid: number, threadOwner: ReadonlyMap<number, number>): number {
  let current = tid;
  const seen = new Set<number>();
  while (threadOwner.has(current) && !seen.has(current)) {
    seen.add(current);
    current = threadOwner.get(current) ?? current;
  }
  return current;
}

type EndJson =
  | { readonly kind: "exited"; readonly t_us: number; readonly status: number }
  | { readonly kind: "killed"; readonly t_us: number; readonly signal: string }
  | { readonly kind: "alive_at_teardown" };

type ProcessJson = {
  kind: "root" | "child" | "orphan";
  pid: number;
  threads: { tid: number; born_us: number; event_id: string }[];
  execs: { event_id: string; t_us: number; path: string; argv: string[] }[];
  end: EndJson;
  parent_pid?: number;
  born_us?: number;
  spawn_event_id?: string;
  first_seen_us?: number;
};

function buildTrace(calls: readonly RawCall[]): { readonly events: Record<string, unknown>[]; readonly processes: Record<string, ProcessJson> } {
  const sorted = [...calls].sort((left, right) => left.tUs - right.tUs || left.tid - right.tid || left.line - right.line);
  const threadOwner = new Map<number, number>();
  const spawns = new Map<number, { readonly parent: number; readonly bornUs: number; readonly eventId: string }>();
  const identified = sorted.map((call, index) => {
    const eventId = `e${String(index + 1)}`;
    const action = processAction(call.body);
    if (action?.kind === "thread" && typeof action.tid === "number") {
      threadOwner.set(action.tid, resolvePid(call.tid, threadOwner));
    }
    if (action?.kind === "spawn" && typeof action.child_pid === "number" && call.result.kind === "ok") {
      spawns.set(action.child_pid, {
        parent: resolvePid(call.tid, threadOwner),
        bornUs: call.tUs,
        eventId,
      });
    }
    return { call, eventId, pid: 0 };
  });
  for (const item of identified) item.pid = resolvePid(item.call.tid, threadOwner);

  const firstSeen = new Map<number, number>();
  for (const item of identified) {
    if (!firstSeen.has(item.pid)) firstSeen.set(item.pid, item.call.tUs);
  }
  let rootPid = -1;
  let rootSeen = Number.POSITIVE_INFINITY;
  for (const [pid, seen] of firstSeen) {
    if (spawns.has(pid)) continue;
    if (seen < rootSeen) {
      rootPid = pid;
      rootSeen = seen;
    }
  }
  const processes = new Map<number, ProcessJson>();
  const ensure = (pid: number): ProcessJson => {
    const existing = processes.get(pid);
    if (existing !== undefined) return existing;
    const spawn = spawns.get(pid);
    const created: ProcessJson =
      pid === rootPid
        ? { kind: "root", pid, threads: [], execs: [], end: { kind: "alive_at_teardown" } }
        : spawn === undefined
          ? {
              kind: "orphan",
              pid,
              threads: [],
              execs: [],
              end: { kind: "alive_at_teardown" },
              first_seen_us: firstSeen.get(pid) ?? 0,
            }
          : {
              kind: "child",
              pid,
              threads: [],
              execs: [],
              end: { kind: "alive_at_teardown" },
              parent_pid: spawn.parent,
              born_us: spawn.bornUs,
              spawn_event_id: spawn.eventId,
            };
    processes.set(pid, created);
    return created;
  };
  if (rootPid !== -1) ensure(rootPid);
  for (const pid of spawns.keys()) ensure(pid);

  for (const item of identified) {
    const process = ensure(item.pid);
    const action = processAction(item.call.body);
    if (action?.kind === "thread" && typeof action.tid === "number") {
      process.threads.push({ tid: action.tid, born_us: item.call.tUs, event_id: item.eventId });
    }
    if (action?.kind === "exec" && typeof action.path === "string" && Array.isArray(action.argv)) {
      process.execs.push({
        event_id: item.eventId,
        t_us: item.call.tUs,
        path: action.path,
        argv: action.argv.filter((arg): arg is string => typeof arg === "string"),
      });
    }
    if (action?.kind === "exit" && typeof action.end === "object" && action.end !== null) {
      const end = action.end as { kind?: string; status?: number; signal?: string };
      const main = item.call.tid === item.pid;
      if (end.kind === "killed" && typeof end.signal === "string") {
        process.end = { kind: "killed", t_us: item.call.tUs, signal: end.signal };
      } else if (
        process.end.kind === "alive_at_teardown" &&
        end.kind === "exited" &&
        typeof end.status === "number" &&
        (item.call.syscall === "exit_group" || (item.call.syscall === "exited" && main))
      ) {
        process.end = { kind: "exited", t_us: item.call.tUs, status: end.status };
      }
    }
  }

  const events = identified.map((item) => ({
    event_id: item.eventId,
    t_us: item.call.tUs,
    pid: item.pid,
    tid: item.call.tid,
    syscall: item.call.syscall,
    result: item.call.result,
    raw_ref: { file: item.call.file, line: item.call.line },
    body: item.call.body,
  }));
  const table: Record<string, ProcessJson> = {};
  for (const pid of [...processes.keys()].sort((left, right) => left - right)) {
    const process = processes.get(pid);
    if (process !== undefined) table[String(pid)] = process;
  }
  return { events, processes: table };
}

function traceFiles(traceDir: string): { readonly file: string; readonly tid: number; readonly text: string }[] {
  const found: { file: string; tid: number; text: string }[] = [];
  for (const name of readdirSync(traceDir)) {
    const tid = /^t\.([1-9][0-9]*)$/.exec(name)?.[1];
    if (tid === undefined) continue;
    found.push({ file: name, tid: Number(tid), text: readFileSync(join(traceDir, name), "utf8") });
  }
  return found;
}

function ipv4(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function portOf(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port <= 65535 ? port : null;
}

function parseYySocket(annotation: string): YySocket | null {
  const match = YY_SOCKET.exec(annotation);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined ||
    match[5] === undefined
  ) {
    return null;
  }
  if (match[1] !== "TCP" && match[1] !== "UDP") return null;
  const localPort = portOf(match[3]);
  const peerPort = portOf(match[5]);
  if (!ipv4(match[2]) || !ipv4(match[4]) || localPort === null || peerPort === null) return null;
  return {
    protocol: match[1],
    local: { address: match[2], port: localPort },
    peer: { address: match[4], port: peerPort },
  };
}

function captureOf(name: string, args: string, resultAnnotation: string | null): NetCapture | null {
  if (!NET_SYSCALLS.has(name)) return null;
  const fdText = /^(\d+)/.exec(args)?.[1];
  // takeAnnotation stops at the '>' inside '->', so the socket is read from the raw text.
  const yy = parseYySocket(args) ?? (resultAnnotation === null ? null : parseYySocket(resultAnnotation));
  const quoted = SEND_SYSCALLS.has(name) ? quotedStrings(args)[0] : undefined;
  return {
    yy,
    payload: quoted === undefined ? null : Buffer.from(quoted.text, "latin1"),
    fd: fdText === undefined ? null : Number(fdText),
  };
}

function questionName(payload: Buffer): string | null {
  try {
    const name = decode(payload).questions?.[0]?.name;
    if (name === undefined || name.length === 0) return null;
    return name;
  } catch {
    return null;
  }
}

function resolverAddress(address: string, port: number): boolean {
  return port === 53 && (address === "127.0.0.1" || address === "::1");
}

function ipPeer(value: unknown): { readonly address: string; readonly port: number } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("kind" in value) || value.kind !== "ip") return null;
  if (!("address" in value) || typeof value.address !== "string") return null;
  if (!("port" in value) || typeof value.port !== "number") return null;
  return { address: value.address, port: value.port };
}

function dnsQuestion(event: Annotatable): string | null {
  const capture = event.capture;
  if (capture === null || event.body.kind !== "net" || event.body.op !== "send") return null;
  if (capture.yy !== null) {
    if (capture.yy.protocol !== "UDP" || !resolverAddress(capture.yy.peer.address, capture.yy.peer.port)) return null;
  } else {
    const peer = ipPeer(event.body.peer);
    if (peer === null || event.body.protocol === "tcp" || !resolverAddress(peer.address, peer.port)) return null;
  }
  if (capture.payload === null) return null;
  return questionName(capture.payload);
}

function applyAnnotation(body: Record<string, unknown>, note: NetAnnotation): void {
  switch (note.kind) {
    case "dns":
      body.dns_name = note.name;
      body.proxy_flow_id = null;
      return;
    case "flow":
      body.proxy_flow_id = note.flowId;
      body.dns_name = null;
      return;
    case "plain":
      body.dns_name = null;
      body.proxy_flow_id = null;
      return;
    default: {
      const unreachable: never = note;
      throw new Error(String(unreachable));
    }
  }
}

function opRank(op: unknown): number {
  if (op === "connect") return 0;
  if (op === "send") return 1;
  return 2;
}

function claimFlows(events: readonly Annotatable[], notes: NetAnnotation[], flows: readonly ProxyFlow[]): void {
  const claimed = new Set<number>();
  const ordered = [...flows].sort((left, right) => left.start_us - right.start_us);
  for (const flow of ordered) {
    let best: { readonly index: number; readonly distance: number; readonly tUs: number; readonly rank: number } | null = null;
    for (let index = 0; index < events.length; index += 1) {
      if (claimed.has(index) || notes[index]?.kind === "dns") continue;
      const event = events[index];
      const yy = event?.capture?.yy;
      if (event === undefined || yy == null) continue;
      if (yy.protocol !== "TCP" || yy.peer.port !== 8080) continue;
      if (yy.local.address !== flow.client.address || yy.local.port !== flow.client.port) continue;
      if (event.tUs < flow.start_us - FLOW_JOIN_SLACK_US || event.tUs > flow.start_us + CLOCK_TOLERANCE_US) continue;
      const candidate = {
        index,
        distance: Math.abs(event.tUs - flow.start_us),
        tUs: event.tUs,
        rank: opRank(event.body.op),
      };
      if (
        best === null ||
        candidate.distance < best.distance ||
        (candidate.distance === best.distance && candidate.tUs < best.tUs) ||
        (candidate.distance === best.distance && candidate.tUs === best.tUs && candidate.rank < best.rank)
      ) {
        best = candidate;
      }
    }
    if (best !== null) {
      claimed.add(best.index);
      notes[best.index] = { kind: "flow", flowId: flow.flow_id };
    }
  }
}

function annotateNet(events: Annotatable[], network: RunNetwork): void {
  const notes: NetAnnotation[] = events.map(() => ({ kind: "plain" }));
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    const yy = event.capture?.yy;
    if (yy != null && event.body.kind === "net") {
      event.body.local = { kind: "ip", address: yy.local.address, port: yy.local.port };
    }
    const name = dnsQuestion(event);
    if (name !== null) notes[index] = { kind: "dns", name };
  }
  switch (network.kind) {
    case "block":
      break;
    case "allow":
      claimFlows(events, notes, network.flows);
      break;
    default: {
      const unreachable: never = network;
      throw new Error(String(unreachable));
    }
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const note = notes[index];
    if (event === undefined || note === undefined || event.body.kind !== "net") continue;
    applyAnnotation(event.body, note);
  }
  const seen = new Set<string>();
  for (const event of events) {
    const flowId = event.body.proxy_flow_id;
    if (typeof flowId !== "string") continue;
    if (seen.has(flowId)) throw new BoundaryError("events.jsonl", null, `proxy flow ${flowId} is claimed twice`);
    seen.add(flowId);
  }
}

export function readSensors(runDir: string, network: RunNetwork): SensorTrace {
  const calls = traceFiles(join(runDir, "trace")).flatMap((file) => parseFile(file.file, file.tid, file.text));
  const sorted = [...calls].sort((left, right) => left.tUs - right.tUs || left.tid - right.tid || left.line - right.line);
  annotateNet(
    sorted.map((call) => ({ body: call.body, tUs: call.tUs, capture: call.capture })),
    network,
  );
  const built = buildTrace(sorted);
  const eventsPath = join(runDir, "events.jsonl");
  const processesPath = join(runDir, "processes.json");
  const events = parseEvents(
    built.events.map((event) => JSON.stringify(event)).join("\n") + (built.events.length > 0 ? "\n" : ""),
    eventsPath,
  );
  const processes = parseProcesses(JSON.stringify(built.processes), processesPath);
  const eventsText = events.map((event) => JSON.stringify(event)).join("\n");
  writeFileSync(eventsPath, events.length > 0 ? `${eventsText}\n` : "");
  writeFileSync(processesPath, JSON.stringify(processes));
  return { events, processes };
}
