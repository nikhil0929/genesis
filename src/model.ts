// The mcpdet data shape. Every variant in the technical design lives here as a
// readonly discriminated union with a literal `kind`, next to the zod schema
// that parses it at a file boundary. Times are integer microseconds since the
// Unix epoch. "Absent" values are `null`, never missing keys, so derived JSON
// files serialize deterministically.

import { parse as parseToml } from "smol-toml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Micros = number;
export type Pid = number;
export type Tid = number;
/** `e<n>`, assigned after sorting all events by time, thread id, and trace line. */
export type EventId = string;
/** The JSON-RPC request id of a `tools/call`. The driver assigns it from a counter. */
export type CallId = number;
export type Argv = readonly [string, ...string[]];
export type NonEmpty<T> = readonly [T, ...T[]];

export const MicrosSchema = z.int().nonnegative();
export const PidSchema = z.int().positive();
export const EventIdSchema = z.string().regex(/^e[0-9]+$/);
export const CallIdSchema = z.int().nonnegative();
export const ArgvSchema = z.tuple([z.string().min(1)], z.string());
const AbsolutePathSchema = z.string().startsWith("/");

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema) satisfies z.ZodType<JsonObject>;

export type Ecosystem = "pypi" | "npm";
export const EcosystemSchema = z.enum(["pypi", "npm"]) satisfies z.ZodType<Ecosystem>;

// ---------------------------------------------------------------------------
// Target file (targets/<name>.toml)
// ---------------------------------------------------------------------------

export interface RegistrySource {
  readonly kind: "registry";
  readonly ecosystem: Ecosystem;
  readonly package: string;
  /** An exact version. Ranges are rejected. */
  readonly version: string;
}

export interface LocalSource {
  readonly kind: "local";
  readonly ecosystem: Ecosystem;
  /** A source folder, relative to the target file, copied into the image build. */
  readonly path: string;
}

export type TargetSource = RegistrySource | LocalSource;

export type NetworkMode = "allow" | "block";

export interface ScenarioEntry {
  readonly tool: string;
  readonly arguments: JsonObject;
}

export interface Target {
  readonly name: string;
  readonly source: TargetSource;
  readonly base_image: string;
  readonly install: readonly string[];
  /** Commands that create working data, such as a sample git repository. */
  readonly setup: readonly string[];
  /** The installed package's source directory inside the image. */
  readonly source_path: string;
  readonly command: Argv;
  /** Extra non-secret environment variables for the server. */
  readonly env: Readonly<Record<string, string>>;
  readonly network: NetworkMode;
  readonly scenario: readonly ScenarioEntry[];
}

const PinnedVersionSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/, "must be an exact version, not a range");

export const TargetSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("registry"),
    ecosystem: EcosystemSchema,
    package: z.string().min(1),
    version: PinnedVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("local"),
    ecosystem: EcosystemSchema,
    path: z.string().min(1),
  }),
]) satisfies z.ZodType<TargetSource>;

export const NetworkModeSchema = z.enum(["allow", "block"]) satisfies z.ZodType<NetworkMode>;

export const ScenarioEntrySchema = z.strictObject({
  tool: z.string().min(1),
  arguments: JsonObjectSchema.default({}),
}) satisfies z.ZodType<ScenarioEntry>;

export const TargetSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  source: TargetSourceSchema,
  base_image: z.string().min(1),
  install: z.array(z.string()).default([]),
  setup: z.array(z.string()).default([]),
  source_path: AbsolutePathSchema,
  command: ArgvSchema,
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  network: NetworkModeSchema.default("allow"),
  scenario: z.array(ScenarioEntrySchema).default([]),
}) satisfies z.ZodType<Target>;

// ---------------------------------------------------------------------------
// Driver plan (plan.json, written by the host, read by the in-container driver)
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = "2025-11-25";
export const CLIENT_NAME = "mcpdet";

/** The driver imports only Node built-ins, so it reads this type with `import type`. */
export interface DriverPlan {
  readonly server_command: Argv;
  readonly server_env: Readonly<Record<string, string>>;
  readonly scenario: readonly ScenarioEntry[];
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly client_name: typeof CLIENT_NAME;
  readonly call_timeout_ms: number;
  readonly settle_ms: number;
  readonly shutdown_wait_ms: number;
}

export const DriverPlanSchema = z.strictObject({
  server_command: ArgvSchema,
  server_env: z.record(z.string(), z.string()),
  scenario: z.array(ScenarioEntrySchema),
  protocol_version: z.literal(PROTOCOL_VERSION),
  client_name: z.literal(CLIENT_NAME),
  call_timeout_ms: z.int().positive(),
  settle_ms: z.int().nonnegative(),
  shutdown_wait_ms: z.int().positive(),
}) satisfies z.ZodType<DriverPlan>;

// ---------------------------------------------------------------------------
// Transcript (transcript.jsonl, one entry per line, in driver order)
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number;
export const JsonRpcIdSchema = z.union([z.string(), z.int()]) satisfies z.ZodType<JsonRpcId>;

export type Direction = "to_server" | "from_server";

export interface RpcRequest {
  readonly kind: "request";
  readonly id: JsonRpcId;
  readonly method: string;
}
export interface RpcNotification {
  readonly kind: "notification";
  readonly method: string;
}
export interface RpcResult {
  readonly kind: "result";
  readonly id: JsonRpcId;
}
export interface RpcError {
  readonly kind: "error";
  readonly id: JsonRpcId | null;
  readonly code: number;
  readonly message: string;
}
/** The parsed JSON-RPC id and method of one line. The full message stays in `raw`. */
export type RpcSummary = RpcRequest | RpcNotification | RpcResult | RpcError;

/** One JSON-RPC line. `t_us` is when the driver finished writing it or read it. */
export interface TimelineMessage {
  readonly kind: "message";
  readonly direction: Direction;
  readonly t_us: Micros;
  readonly raw: string;
  readonly rpc: RpcSummary;
}

/** A server stdout line that is not JSON, or is JSON but not JSON-RPC. */
export interface InvalidLine {
  readonly kind: "invalid_line";
  readonly t_us: Micros;
  readonly raw: string;
  readonly reason: "not_json" | "not_jsonrpc";
}

export interface CallTimeout {
  readonly kind: "call_timeout";
  readonly t_us: Micros;
  readonly call_id: CallId;
}

export interface StdinClosed {
  readonly kind: "stdin_closed";
  readonly t_us: Micros;
}

export interface ServerExited {
  readonly kind: "server_exited";
  readonly t_us: Micros;
  readonly end: ExitEnd;
}

export type TimelineEntry = TimelineMessage | InvalidLine | CallTimeout | StdinClosed | ServerExited;

export interface ExitedEnd {
  readonly kind: "exited";
  readonly status: number;
}
export interface KilledEnd {
  readonly kind: "killed";
  /** A signal name such as `SIGKILL`. */
  readonly signal: string;
}
export type ExitEnd = ExitedEnd | KilledEnd;

export const ExitEndSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exited"), status: z.int() }),
  z.strictObject({ kind: z.literal("killed"), signal: z.string().min(1) }),
]) satisfies z.ZodType<ExitEnd>;

export const RpcSummarySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("request"), id: JsonRpcIdSchema, method: z.string() }),
  z.strictObject({ kind: z.literal("notification"), method: z.string() }),
  z.strictObject({ kind: z.literal("result"), id: JsonRpcIdSchema }),
  z.strictObject({
    kind: z.literal("error"),
    id: JsonRpcIdSchema.nullable(),
    code: z.int(),
    message: z.string(),
  }),
]) satisfies z.ZodType<RpcSummary>;

export const TimelineMessageSchema = z.strictObject({
  kind: z.literal("message"),
  direction: z.enum(["to_server", "from_server"]),
  t_us: MicrosSchema,
  raw: z.string(),
  rpc: RpcSummarySchema,
}) satisfies z.ZodType<TimelineMessage>;

export const TimelineEntrySchema = z.discriminatedUnion("kind", [
  TimelineMessageSchema,
  z.strictObject({
    kind: z.literal("invalid_line"),
    t_us: MicrosSchema,
    raw: z.string(),
    reason: z.enum(["not_json", "not_jsonrpc"]),
  }),
  z.strictObject({ kind: z.literal("call_timeout"), t_us: MicrosSchema, call_id: CallIdSchema }),
  z.strictObject({ kind: z.literal("stdin_closed"), t_us: MicrosSchema }),
  z.strictObject({ kind: z.literal("server_exited"), t_us: MicrosSchema, end: ExitEndSchema }),
]) satisfies z.ZodType<TimelineEntry>;

// ---------------------------------------------------------------------------
// MCP wire messages (the `raw` of a timeline message)
// ---------------------------------------------------------------------------

export const JsonRpcMessageSchema = z.union([
  z.looseObject({ jsonrpc: z.literal("2.0"), id: JsonRpcIdSchema, method: z.string(), params: JsonValueSchema.optional() }),
  z.looseObject({ jsonrpc: z.literal("2.0"), method: z.string(), params: JsonValueSchema.optional() }),
  z.looseObject({ jsonrpc: z.literal("2.0"), id: JsonRpcIdSchema, result: JsonValueSchema }),
  z.looseObject({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema.nullable(),
    error: z.looseObject({ code: z.int(), message: z.string(), data: JsonValueSchema.optional() }),
  }),
]);

export const InitializeResultSchema = z.looseObject({
  protocolVersion: z.string(),
  capabilities: JsonObjectSchema,
  serverInfo: z.looseObject({ name: z.string(), version: z.string() }),
});

export const WireToolSchema = z.looseObject({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: JsonObjectSchema,
  annotations: JsonObjectSchema.optional(),
});

export const ListToolsResultSchema = z.looseObject({
  tools: z.array(JsonObjectSchema),
  nextCursor: z.string().optional(),
});

export const CallToolResultSchema = z.looseObject({
  content: z.array(JsonValueSchema),
  isError: z.boolean().optional(),
});

/** MCP tool annotations. A hint the server omitted, or sent with a non-boolean value, is `null`. */
export interface ToolAnnotations {
  readonly title: string | null;
  readonly read_only_hint: boolean | null;
  readonly destructive_hint: boolean | null;
  readonly idempotent_hint: boolean | null;
  readonly open_world_hint: boolean | null;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly input_schema: JsonObject;
  readonly annotations: ToolAnnotations;
  /** The tool object exactly as the server sent it in `tools/list`. */
  readonly raw: JsonObject;
}

export const ToolAnnotationsSchema = z.strictObject({
  title: z.string().nullable(),
  read_only_hint: z.boolean().nullable(),
  destructive_hint: z.boolean().nullable(),
  idempotent_hint: z.boolean().nullable(),
  open_world_hint: z.boolean().nullable(),
}) satisfies z.ZodType<ToolAnnotations>;

export const ToolDefinitionSchema = z.strictObject({
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  input_schema: JsonObjectSchema,
  annotations: ToolAnnotationsSchema,
  raw: JsonObjectSchema,
}) satisfies z.ZodType<ToolDefinition>;

/** Parses one entry of a `tools/list` result into a tool definition. */
export function toolDefinitionFromWire(raw: JsonObject): ToolDefinition {
  const tool = WireToolSchema.parse(raw);
  const annotations = tool.annotations ?? {};
  const hint = (key: string): boolean | null => {
    const value = annotations[key];
    return typeof value === "boolean" ? value : null;
  };
  const title = annotations["title"];
  return {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    input_schema: tool.inputSchema,
    annotations: {
      title: typeof title === "string" ? title : null,
      read_only_hint: hint("readOnlyHint"),
      destructive_hint: hint("destructiveHint"),
      idempotent_hint: hint("idempotentHint"),
      open_world_hint: hint("openWorldHint"),
    },
    raw,
  };
}

// ---------------------------------------------------------------------------
// Canaries (canaries.json)
// ---------------------------------------------------------------------------

export interface EnvPlacement {
  readonly kind: "env";
  readonly variable: string;
}
export interface FilePlacement {
  readonly kind: "file";
  readonly path: string;
}
export type CanaryPlacement = EnvPlacement | FilePlacement;

/** A decoy value planted for one run. Each value embeds that run's random token. */
export interface Canary {
  readonly name: string;
  readonly placement: CanaryPlacement;
  readonly value: string;
}

export const CanarySchema = z.strictObject({
  name: z.string().min(1),
  placement: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("env"), variable: z.string().min(1) }),
    z.strictObject({ kind: z.literal("file"), path: AbsolutePathSchema }),
  ]),
  value: z.string().min(1),
}) satisfies z.ZodType<Canary>;

export const CanariesFileSchema = z.array(CanarySchema) satisfies z.ZodType<readonly Canary[]>;

// ---------------------------------------------------------------------------
// Proxy flows (proxy/flows.jsonl, one flow per line, written by the mitmproxy addon)
// ---------------------------------------------------------------------------

export const PROXY_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export interface TextBody {
  readonly kind: "text";
  readonly text: string;
  readonly byte_count: number;
  /** The body was longer than `PROXY_BODY_LIMIT_BYTES` and was cut there. */
  readonly truncated: boolean;
}
export interface BinaryBody {
  readonly kind: "base64";
  readonly base64: string;
  readonly byte_count: number;
  readonly truncated: boolean;
}
export type HttpBody = TextBody | BinaryBody;

/** Header name and value pairs in wire order, duplicates kept. */
export type HttpHeaders = readonly (readonly [string, string])[];

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly host: string;
  readonly headers: HttpHeaders;
  readonly body: HttpBody;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: HttpHeaders;
  readonly body: HttpBody;
}

export interface FlowResponse {
  readonly kind: "response";
  readonly response: HttpResponse;
}
/** An upstream DNS failure, a TLS handshake the client refused, or any other flow error. */
export interface FlowError {
  readonly kind: "error";
  readonly message: string;
}
export type FlowResult = FlowResponse | FlowError;

export interface ProxyFlow {
  readonly flow_id: string;
  /** The client's address and source port, which joins the flow to a traced socket. */
  readonly client: { readonly address: string; readonly port: number };
  readonly start_us: Micros;
  readonly end_us: Micros;
  readonly request: HttpRequest;
  readonly result: FlowResult;
}

const PortSchema = z.int().min(0).max(65535);

export const HttpBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    text: z.string(),
    byte_count: z.int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("base64"),
    base64: z.base64(),
    byte_count: z.int().nonnegative(),
    truncated: z.boolean(),
  }),
]) satisfies z.ZodType<HttpBody>;

const HttpHeadersSchema = z.array(z.tuple([z.string(), z.string()]));

export const ProxyFlowSchema = z.strictObject({
  flow_id: z.string().min(1),
  client: z.strictObject({ address: z.string().min(1), port: PortSchema }),
  start_us: MicrosSchema,
  end_us: MicrosSchema,
  request: z.strictObject({
    method: z.string().min(1),
    url: z.string(),
    host: z.string(),
    headers: HttpHeadersSchema,
    body: HttpBodySchema,
  }),
  result: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("response"),
      response: z.strictObject({ status: z.int(), headers: HttpHeadersSchema, body: HttpBodySchema }),
    }),
    z.strictObject({ kind: z.literal("error"), message: z.string() }),
  ]),
}) satisfies z.ZodType<ProxyFlow>;

// ---------------------------------------------------------------------------
// Events (events.jsonl, one normalized syscall per line)
// ---------------------------------------------------------------------------

export interface OkResult {
  readonly kind: "ok";
  readonly value: number;
}
export interface ErrorResult {
  readonly kind: "error";
  /** The errno name, such as `ENOENT`. */
  readonly errno: string;
}
/** The task ended inside the call. */
export interface NoReturnResult {
  readonly kind: "no_return";
}
export type SyscallResult = OkResult | ErrorResult | NoReturnResult;

/** The trace file name and line number the event came from. */
export interface RawRef {
  readonly file: string;
  readonly line: number;
}

export interface SpawnAction {
  readonly kind: "spawn";
  readonly child_pid: Pid;
  /** The spawn set `CLONE_UNTRACED`, so the child's own events are missing. */
  readonly untraced: boolean;
}
export interface ThreadAction {
  readonly kind: "thread";
  readonly tid: Tid;
}
export interface ExecAction {
  readonly kind: "exec";
  readonly path: string;
  readonly argv: readonly string[];
  readonly env_names: readonly string[];
}
export interface ExitAction {
  readonly kind: "exit";
  readonly end: ExitEnd;
}
export type ProcessAction = SpawnAction | ThreadAction | ExecAction | ExitAction;

export type FileAccess = "read" | "write" | "read_write";

export interface OpenAction {
  readonly kind: "open";
  readonly path: string;
  readonly access: FileAccess;
  readonly created: boolean;
}

export type TwoPathOp = "rename" | "link" | "symlink";
/**
 * `path` is the path the call creates or moves: the old path of a rename, the
 * new link of a link or symlink. `second_path` is the rename's new path, the
 * link's existing file, or the symlink's target as written.
 */
export interface TwoPathAction {
  readonly kind: TwoPathOp;
  readonly path: string;
  readonly second_path: string;
}

export type PathOp =
  | "stat"
  | "access"
  | "readlink"
  | "unlink"
  | "mkdir"
  | "rmdir"
  | "chmod"
  | "chown"
  | "truncate"
  | "utime"
  | "chdir"
  | "mknod"
  | "xattr"
  | "other";
export interface PathAction {
  readonly kind: PathOp;
  readonly path: string;
}

export type FileAction = OpenAction | TwoPathAction | PathAction;

export type NetOp = "socket" | "connect" | "bind" | "listen" | "accept" | "send";
export type AddressFamily = "inet" | "inet6" | "unix" | "netlink" | "other";
export type SocketProtocol = "tcp" | "udp" | "unix_stream" | "unix_dgram" | "other";

export interface IpPeer {
  readonly kind: "ip";
  readonly address: string;
  readonly port: number;
}
export interface UnixPeer {
  readonly kind: "unix";
  readonly path: string;
}
export interface NoPeer {
  readonly kind: "none";
}
export type Peer = IpPeer | UnixPeer | NoPeer;

export interface ProcessBody {
  readonly kind: "process";
  readonly action: ProcessAction;
}

export interface FileBody {
  readonly kind: "file";
  readonly action: FileAction;
}

export interface NetBody {
  readonly kind: "net";
  readonly op: NetOp;
  readonly family: AddressFamily;
  readonly protocol: SocketProtocol;
  readonly local: Peer;
  readonly peer: Peer;
  /** Set when a send to port 53 decodes as a DNS query. */
  readonly dns_name: string | null;
  /** Set when the socket's source port joins a flow the proxy logged. */
  readonly proxy_flow_id: string | null;
}

export interface FileTarget {
  readonly kind: "file";
  readonly path: string;
}
export interface SocketTarget {
  readonly kind: "socket";
  readonly peer: Peer;
}
export interface PipeTarget {
  readonly kind: "pipe";
  readonly inode: string;
}
export interface StdoutTarget {
  readonly kind: "stdout";
}
export interface StderrTarget {
  readonly kind: "stderr";
}
export type WriteTarget = FileTarget | SocketTarget | PipeTarget | StdoutTarget | StderrTarget;

export const PREVIEW_LIMIT_BYTES = 4096;

export interface DataBody {
  readonly kind: "data";
  readonly target: WriteTarget;
  readonly byte_count: number;
  /** Up to `PREVIEW_LIMIT_BYTES` of the buffer. Non-printing bytes stay `\xNN` escapes. */
  readonly preview: string;
  readonly truncated: boolean;
}

export interface OtherBody {
  readonly kind: "other";
  /** The raw trace text when the parser could not read the line, otherwise `null`. */
  readonly unparsed: string | null;
}

export type EventBody = ProcessBody | FileBody | NetBody | DataBody | OtherBody;

export interface Event {
  readonly event_id: EventId;
  /** The syscall entry time from the trace. */
  readonly t_us: Micros;
  /** For a thread, the process that owns it. */
  readonly pid: Pid;
  readonly tid: Tid;
  readonly syscall: string;
  readonly result: SyscallResult;
  readonly raw_ref: RawRef;
  readonly body: EventBody;
}

export const SyscallResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ok"), value: z.int() }),
  z.strictObject({ kind: z.literal("error"), errno: z.string().regex(/^E[A-Z0-9]+$/) }),
  z.strictObject({ kind: z.literal("no_return") }),
]) satisfies z.ZodType<SyscallResult>;

export const PeerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ip"), address: z.string().min(1), port: PortSchema }),
  z.strictObject({ kind: z.literal("unix"), path: z.string() }),
  z.strictObject({ kind: z.literal("none") }),
]) satisfies z.ZodType<Peer>;

const ProcessActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("spawn"), child_pid: PidSchema, untraced: z.boolean() }),
  z.strictObject({ kind: z.literal("thread"), tid: PidSchema }),
  z.strictObject({
    kind: z.literal("exec"),
    path: z.string(),
    argv: z.array(z.string()),
    env_names: z.array(z.string()),
  }),
  z.strictObject({ kind: z.literal("exit"), end: ExitEndSchema }),
]) satisfies z.ZodType<ProcessAction>;

const FileActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("open"),
    path: AbsolutePathSchema,
    access: z.enum(["read", "write", "read_write"]),
    created: z.boolean(),
  }),
  z.strictObject({
    kind: z.enum(["rename", "link", "symlink"]),
    path: AbsolutePathSchema,
    second_path: z.string(),
  }),
  z.strictObject({
    kind: z.enum([
      "stat",
      "access",
      "readlink",
      "unlink",
      "mkdir",
      "rmdir",
      "chmod",
      "chown",
      "truncate",
      "utime",
      "chdir",
      "mknod",
      "xattr",
      "other",
    ]),
    path: AbsolutePathSchema,
  }),
]) satisfies z.ZodType<FileAction>;

const WriteTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), path: AbsolutePathSchema }),
  z.strictObject({ kind: z.literal("socket"), peer: PeerSchema }),
  z.strictObject({ kind: z.literal("pipe"), inode: z.string().min(1) }),
  z.strictObject({ kind: z.literal("stdout") }),
  z.strictObject({ kind: z.literal("stderr") }),
]) satisfies z.ZodType<WriteTarget>;

export const EventBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("process"), action: ProcessActionSchema }),
  z.strictObject({ kind: z.literal("file"), action: FileActionSchema }),
  z.strictObject({
    kind: z.literal("net"),
    op: z.enum(["socket", "connect", "bind", "listen", "accept", "send"]),
    family: z.enum(["inet", "inet6", "unix", "netlink", "other"]),
    protocol: z.enum(["tcp", "udp", "unix_stream", "unix_dgram", "other"]),
    local: PeerSchema,
    peer: PeerSchema,
    dns_name: z.string().min(1).nullable(),
    proxy_flow_id: z.string().min(1).nullable(),
  }),
  z.strictObject({
    kind: z.literal("data"),
    target: WriteTargetSchema,
    byte_count: z.int().nonnegative(),
    preview: z.string(),
    truncated: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("other"), unparsed: z.string().nullable() }),
]) satisfies z.ZodType<EventBody>;

export const EventSchema = z.strictObject({
  event_id: EventIdSchema,
  t_us: MicrosSchema,
  pid: PidSchema,
  tid: PidSchema,
  syscall: z.string(),
  result: SyscallResultSchema,
  raw_ref: z.strictObject({ file: z.string().min(1), line: z.int().positive() }),
  body: EventBodySchema,
}) satisfies z.ZodType<Event>;

// ---------------------------------------------------------------------------
// Processes (processes.json from sensors, owners added by attribution)
// ---------------------------------------------------------------------------

export interface ThreadRecord {
  readonly tid: Tid;
  readonly born_us: Micros;
  /** The `thread` event that created it. */
  readonly event_id: EventId;
}

export interface ExecRecord {
  readonly event_id: EventId;
  readonly t_us: Micros;
  readonly path: string;
  readonly argv: readonly string[];
}

export interface ExitedProcessEnd {
  readonly kind: "exited";
  readonly t_us: Micros;
  readonly status: number;
}
export interface KilledProcessEnd {
  readonly kind: "killed";
  readonly t_us: Micros;
  readonly signal: string;
}
export interface AliveAtTeardown {
  readonly kind: "alive_at_teardown";
}
export type ProcessEnd = ExitedProcessEnd | KilledProcessEnd | AliveAtTeardown;

interface ProcessCommon {
  readonly pid: Pid;
  readonly threads: readonly ThreadRecord[];
  readonly execs: readonly ExecRecord[];
  readonly end: ProcessEnd;
}

/** The server process the tracer started. */
export interface RootProcess extends ProcessCommon {
  readonly kind: "root";
}

export interface ChildProcess extends ProcessCommon {
  readonly kind: "child";
  readonly parent_pid: Pid;
  readonly born_us: Micros;
  readonly spawn_event_id: EventId;
}

/** A task id seen in the trace with no recorded spawn. Any orphan means a sensor or parser gap. */
export interface OrphanProcess extends ProcessCommon {
  readonly kind: "orphan";
  readonly first_seen_us: Micros;
}

export type ProcessRecord = RootProcess | ChildProcess | OrphanProcess;

/** Keyed by decimal pid. */
export type ProcessTable<P> = Readonly<Record<string, P>>;

export interface StartupRef {
  readonly kind: "startup";
}
export interface CallRef {
  readonly kind: "call";
  readonly call_id: CallId;
}
export interface ShutdownRef {
  readonly kind: "shutdown";
}

/** The bundle whose reply opened a gap. A hint for the reader, never an attribution. */
export type GapPredecessor = StartupRef | CallRef;

export interface ServerOwner {
  readonly kind: "server";
}
export interface GapOwner {
  readonly kind: "gap";
  readonly preceded_by: GapPredecessor;
}
export type ProcessOwner = ServerOwner | CallRef | ShutdownRef | GapOwner;

export interface AttributedRootProcess extends RootProcess {
  readonly owner: ServerOwner;
}
export interface AttributedChildProcess extends ChildProcess {
  readonly owner: ProcessOwner;
}
/** Orphans get no owner. Their events go to unmatched with `orphan_process`. */
export type AttributedProcess = AttributedRootProcess | AttributedChildProcess | OrphanProcess;

const ProcessEndSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exited"), t_us: MicrosSchema, status: z.int() }),
  z.strictObject({ kind: z.literal("killed"), t_us: MicrosSchema, signal: z.string().min(1) }),
  z.strictObject({ kind: z.literal("alive_at_teardown") }),
]) satisfies z.ZodType<ProcessEnd>;

const processCommonShape = {
  pid: PidSchema,
  threads: z.array(z.strictObject({ tid: PidSchema, born_us: MicrosSchema, event_id: EventIdSchema })),
  execs: z.array(
    z.strictObject({
      event_id: EventIdSchema,
      t_us: MicrosSchema,
      path: z.string(),
      argv: z.array(z.string()),
    }),
  ),
  end: ProcessEndSchema,
};

const RootProcessSchema = z.strictObject({ kind: z.literal("root"), ...processCommonShape });
const ChildProcessSchema = z.strictObject({
  kind: z.literal("child"),
  ...processCommonShape,
  parent_pid: PidSchema,
  born_us: MicrosSchema,
  spawn_event_id: EventIdSchema,
});
const OrphanProcessSchema = z.strictObject({
  kind: z.literal("orphan"),
  ...processCommonShape,
  first_seen_us: MicrosSchema,
});

const PidKeySchema = z.string().regex(/^[1-9][0-9]*$/);

export const ProcessRecordSchema = z.discriminatedUnion("kind", [
  RootProcessSchema,
  ChildProcessSchema,
  OrphanProcessSchema,
]) satisfies z.ZodType<ProcessRecord>;

export const ProcessesFileSchema = z.record(PidKeySchema, ProcessRecordSchema) satisfies z.ZodType<
  ProcessTable<ProcessRecord>
>;

const StartupRefSchema = z.strictObject({ kind: z.literal("startup") });
const CallRefSchema = z.strictObject({ kind: z.literal("call"), call_id: CallIdSchema });
const ShutdownRefSchema = z.strictObject({ kind: z.literal("shutdown") });
const ServerOwnerSchema = z.strictObject({ kind: z.literal("server") });

export const GapPredecessorSchema = z.discriminatedUnion("kind", [
  StartupRefSchema,
  CallRefSchema,
]) satisfies z.ZodType<GapPredecessor>;

export const ProcessOwnerSchema = z.discriminatedUnion("kind", [
  ServerOwnerSchema,
  CallRefSchema,
  ShutdownRefSchema,
  z.strictObject({ kind: z.literal("gap"), preceded_by: GapPredecessorSchema }),
]) satisfies z.ZodType<ProcessOwner>;

export const AttributedProcessSchema = z.discriminatedUnion("kind", [
  RootProcessSchema.extend({ owner: ServerOwnerSchema }),
  ChildProcessSchema.extend({ owner: ProcessOwnerSchema }),
  OrphanProcessSchema,
]) satisfies z.ZodType<AttributedProcess>;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The acting process is `ancestor_pid`, born inside this bundle's window, or one of its descendants. */
export interface OwnedLink {
  readonly kind: "owned";
  readonly ancestor_pid: Pid;
}
/** A server process acted inside a startup or shutdown window. */
export interface PhaseLink {
  readonly kind: "phase";
}
/** A server process acted inside a tool-call window. */
export interface OverlapLink {
  readonly kind: "overlap";
}
export type Link = OwnedLink | PhaseLink | OverlapLink;

export type LinkStrength = "strong" | "weak";

/** Strength is derived from the basis and never stored, so the two cannot disagree. */
export function linkStrength(link: Link): LinkStrength {
  switch (link.kind) {
    case "owned":
    case "phase":
      return "strong";
    case "overlap":
      return "weak";
    default:
      return assertNever(link);
  }
}

const OwnedLinkSchema = z.strictObject({ kind: z.literal("owned"), ancestor_pid: PidSchema });
const PhaseLinkSchema = z.strictObject({ kind: z.literal("phase") });
const OverlapLinkSchema = z.strictObject({ kind: z.literal("overlap") });

export const LinkSchema = z.discriminatedUnion("kind", [
  OwnedLinkSchema,
  PhaseLinkSchema,
  OverlapLinkSchema,
]) satisfies z.ZodType<Link>;

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/** A half-open interval `[start_us, end_us)`. */
export interface Window {
  readonly start_us: Micros;
  readonly end_us: Micros;
}

export interface StartupEntry {
  readonly event: Event;
  readonly link: PhaseLink;
}

export interface OwnedCallEntry {
  readonly event: Event;
  readonly link: OwnedLink;
  /** The event happened after the call's reply time. */
  readonly after_reply: boolean;
}
/** An overlap event lies inside the call window by definition, so it is never after the reply. */
export interface OverlapCallEntry {
  readonly event: Event;
  readonly link: OverlapLink;
  readonly after_reply: false;
}
export type ToolCallEntry = OwnedCallEntry | OverlapCallEntry;

export interface ShutdownEntry {
  readonly event: Event;
  readonly link: OwnedLink | PhaseLink;
}

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocol_version: string;
  readonly capabilities: JsonObject;
}

export interface StartupBundle {
  readonly kind: "startup";
  /** From the root's first `execve` to the driver's read of the last listing reply. */
  readonly window: Window;
  /** `initialize`, `notifications/initialized`, and every listing page. */
  readonly messages: readonly TimelineMessage[];
  readonly server_info: ServerInfo;
  readonly advertised_tools: readonly ToolDefinition[];
  readonly events: readonly StartupEntry[];
}

export interface AdvertisedDefinition {
  readonly kind: "advertised";
  readonly tool: ToolDefinition;
}
/** The scenario deliberately called a name the server did not list. */
export interface NotAdvertised {
  readonly kind: "not_advertised";
}
export type CallDefinition = AdvertisedDefinition | NotAdvertised;

export interface ScenarioSource {
  readonly kind: "scenario";
  readonly index: number;
}
export interface SchemaProbeSource {
  readonly kind: "schema_probe";
}
export type ArgumentSource = ScenarioSource | SchemaProbeSource;

export interface ReplyOutcome {
  readonly kind: "reply";
  readonly t_us: Micros;
  readonly content: readonly JsonValue[];
  /** The MCP `isError` flag. */
  readonly is_error: boolean;
}
export interface RpcErrorOutcome {
  readonly kind: "rpc_error";
  readonly t_us: Micros;
  readonly code: number;
  readonly message: string;
}
export interface NoReplyOutcome {
  readonly kind: "no_reply";
  readonly t_us: Micros;
  readonly reason: "timeout" | "server_exited";
}
/** The call window ends at the outcome's `t_us`. No other field holds an end time. */
export type CallOutcome = ReplyOutcome | RpcErrorOutcome | NoReplyOutcome;

export interface OwnedProcess {
  readonly pid: Pid;
  readonly end: ProcessEnd;
  /** Still running when the reply arrived. */
  readonly outlived_reply: boolean;
}

export interface ToolCallBundle {
  readonly kind: "tool_call";
  readonly call_id: CallId;
  /** Position in send order, from 0. */
  readonly seq: number;
  readonly tool: string;
  readonly definition: CallDefinition;
  readonly arguments: JsonObject;
  readonly argument_source: ArgumentSource;
  /** When the driver finished writing the request. The window opens here. */
  readonly sent_us: Micros;
  readonly outcome: CallOutcome;
  readonly events: readonly ToolCallEntry[];
  readonly owned_processes: readonly OwnedProcess[];
}

export interface StdinClosedTrigger {
  readonly kind: "stdin_closed";
  readonly t_us: Micros;
}
/** The server quit before the driver closed stdin. */
export interface ServerExitedTrigger {
  readonly kind: "server_exited";
  readonly t_us: Micros;
  readonly end: ExitEnd;
}
export type ShutdownTrigger = StdinClosedTrigger | ServerExitedTrigger;

export interface ShutdownBundle {
  readonly kind: "shutdown";
  readonly trigger: ShutdownTrigger;
  /** The last task exit or the teardown kill. */
  readonly end_us: Micros;
  readonly events: readonly ShutdownEntry[];
  readonly killed_at_teardown: readonly Pid[];
}

export type Bundle = StartupBundle | ToolCallBundle | ShutdownBundle;

export const WindowSchema = z
  .strictObject({ start_us: MicrosSchema, end_us: MicrosSchema })
  .refine((w) => w.end_us >= w.start_us, "window ends before it starts") satisfies z.ZodType<Window>;

export const StartupBundleSchema = z.strictObject({
  kind: z.literal("startup"),
  window: WindowSchema,
  messages: z.array(TimelineMessageSchema),
  server_info: z.strictObject({
    name: z.string(),
    version: z.string(),
    protocol_version: z.string(),
    capabilities: JsonObjectSchema,
  }),
  advertised_tools: z.array(ToolDefinitionSchema),
  events: z.array(z.strictObject({ event: EventSchema, link: PhaseLinkSchema })),
}) satisfies z.ZodType<StartupBundle>;

export const ToolCallEntrySchema = z.union([
  z.strictObject({ event: EventSchema, link: OwnedLinkSchema, after_reply: z.boolean() }),
  z.strictObject({ event: EventSchema, link: OverlapLinkSchema, after_reply: z.literal(false) }),
]) satisfies z.ZodType<ToolCallEntry>;

export const CallOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("reply"),
    t_us: MicrosSchema,
    content: z.array(JsonValueSchema),
    is_error: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("rpc_error"), t_us: MicrosSchema, code: z.int(), message: z.string() }),
  z.strictObject({
    kind: z.literal("no_reply"),
    t_us: MicrosSchema,
    reason: z.enum(["timeout", "server_exited"]),
  }),
]) satisfies z.ZodType<CallOutcome>;

export const ToolCallBundleSchema = z
  .strictObject({
    kind: z.literal("tool_call"),
    call_id: CallIdSchema,
    seq: z.int().nonnegative(),
    tool: z.string(),
    definition: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("advertised"), tool: ToolDefinitionSchema }),
      z.strictObject({ kind: z.literal("not_advertised") }),
    ]),
    arguments: JsonObjectSchema,
    argument_source: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("scenario"), index: z.int().nonnegative() }),
      z.strictObject({ kind: z.literal("schema_probe") }),
    ]),
    sent_us: MicrosSchema,
    outcome: CallOutcomeSchema,
    events: z.array(ToolCallEntrySchema),
    owned_processes: z.array(
      z.strictObject({ pid: PidSchema, end: ProcessEndSchema, outlived_reply: z.boolean() }),
    ),
  })
  .refine((b) => b.outcome.t_us >= b.sent_us, "outcome precedes sent_us") satisfies z.ZodType<ToolCallBundle>;

export const ShutdownBundleSchema = z.strictObject({
  kind: z.literal("shutdown"),
  trigger: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("stdin_closed"), t_us: MicrosSchema }),
    z.strictObject({ kind: z.literal("server_exited"), t_us: MicrosSchema, end: ExitEndSchema }),
  ]),
  end_us: MicrosSchema,
  events: z.array(
    z.strictObject({ event: EventSchema, link: z.discriminatedUnion("kind", [OwnedLinkSchema, PhaseLinkSchema]) }),
  ),
  killed_at_teardown: z.array(PidSchema),
}) satisfies z.ZodType<ShutdownBundle>;

// ---------------------------------------------------------------------------
// Unmatched events
// ---------------------------------------------------------------------------

/** A server process acted while no request was in flight. */
export interface BetweenWindows {
  readonly kind: "between_windows";
  readonly preceded_by: GapPredecessor;
}
/** The acting process descends from a process born in a gap. */
export interface BornBetweenWindows {
  readonly kind: "born_between_windows";
  readonly ancestor_pid: Pid;
  readonly preceded_by: GapPredecessor;
}
export interface OrphanProcessReason {
  readonly kind: "orphan_process";
}
export type UnmatchedReason = BetweenWindows | BornBetweenWindows | OrphanProcessReason;

/** An event plus a reason. It carries no link, so it cannot claim a cause. */
export interface UnmatchedEvent {
  readonly event: Event;
  readonly reason: UnmatchedReason;
}

export const UnmatchedEventSchema = z.strictObject({
  event: EventSchema,
  reason: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("between_windows"), preceded_by: GapPredecessorSchema }),
    z.strictObject({
      kind: z.literal("born_between_windows"),
      ancestor_pid: PidSchema,
      preceded_by: GapPredecessorSchema,
    }),
    z.strictObject({ kind: z.literal("orphan_process") }),
  ]),
}) satisfies z.ZodType<UnmatchedEvent>;

// ---------------------------------------------------------------------------
// Run (bundles.json)
// ---------------------------------------------------------------------------

export const CLOCK_TOLERANCE_US = 5_000;

export interface RunTarget {
  readonly name: string;
  readonly source: TargetSource;
  readonly image_id: string;
  readonly command: Argv;
}

export interface AllowNetwork {
  readonly kind: "allow";
  readonly flows: readonly ProxyFlow[];
}
/** A block run has no flows field, so it cannot hold proxy flows. */
export interface BlockNetwork {
  readonly kind: "block";
}
export type RunNetwork = AllowNetwork | BlockNetwork;

/**
 * Each response's traced stdout `write` must fall after the driver sent the
 * request and before the driver read the response.
 */
export interface ClockCheck {
  readonly max_violation_us: Micros;
  readonly responses_checked: number;
  /** `max_violation_us <= CLOCK_TOLERANCE_US`. */
  readonly passed: boolean;
}

export interface Run {
  readonly run_id: string;
  readonly target: RunTarget;
  readonly network: RunNetwork;
  readonly canaries: readonly Canary[];
  readonly timeline: readonly TimelineEntry[];
  readonly clock_check: ClockCheck;
  readonly processes: ProcessTable<AttributedProcess>;
  readonly startup: StartupBundle;
  /** In send order. */
  readonly tool_calls: readonly ToolCallBundle[];
  readonly shutdown: ShutdownBundle;
  readonly unmatched: readonly UnmatchedEvent[];
}

export const RunTargetSchema = z.strictObject({
  name: z.string().min(1),
  source: TargetSourceSchema,
  image_id: z.string().min(1),
  command: ArgvSchema,
}) satisfies z.ZodType<RunTarget>;

export const RunNetworkSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("allow"), flows: z.array(ProxyFlowSchema) }),
  z.strictObject({ kind: z.literal("block") }),
]) satisfies z.ZodType<RunNetwork>;

export const ClockCheckSchema = z
  .strictObject({
    max_violation_us: MicrosSchema,
    responses_checked: z.int().nonnegative(),
    passed: z.boolean(),
  })
  .refine(
    (c) => c.passed === c.max_violation_us <= CLOCK_TOLERANCE_US,
    "passed disagrees with max_violation_us",
  ) satisfies z.ZodType<ClockCheck>;

export const RunSchema = z
  .strictObject({
    run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    target: RunTargetSchema,
    network: RunNetworkSchema,
    canaries: CanariesFileSchema,
    timeline: z.array(TimelineEntrySchema),
    clock_check: ClockCheckSchema,
    processes: z.record(PidKeySchema, AttributedProcessSchema),
    startup: StartupBundleSchema,
    tool_calls: z.array(ToolCallBundleSchema),
    shutdown: ShutdownBundleSchema,
    unmatched: z.array(UnmatchedEventSchema),
  })
  .refine((r) => r.tool_calls.every((b, i) => b.seq === i), "tool_calls are not in seq order")
  .refine(
    (r) => new Set(r.tool_calls.map((b) => b.call_id)).size === r.tool_calls.length,
    "duplicate call_id",
  ) satisfies z.ZodType<Run>;

// ---------------------------------------------------------------------------
// Findings (findings.json)
// ---------------------------------------------------------------------------

export type RuleName =
  | "spawned_process"
  | "file_modified"
  | "credential_access"
  | "network_attempt"
  | "late_code_load"
  | "canary_exposed";

export const RuleNameSchema = z.enum([
  "spawned_process",
  "file_modified",
  "credential_access",
  "network_attempt",
  "late_code_load",
  "canary_exposed",
]) satisfies z.ZodType<RuleName>;

export interface PathSubject {
  readonly kind: "path";
  readonly path: string;
}
export interface PeerSubject {
  readonly kind: "peer";
  readonly peer: Peer;
}
export interface DnsNameSubject {
  readonly kind: "dns_name";
  readonly name: string;
}
export interface ArgvSubject {
  readonly kind: "argv";
  readonly argv: readonly string[];
}
/** Replaces the proxy's address as the subject when the evidence joins a proxy flow. */
export interface FlowSubject {
  readonly kind: "flow";
  readonly method: string;
  readonly url: string;
}
export type FindingSubject = PathSubject | PeerSubject | DnsNameSubject | ArgvSubject | FlowSubject;

export interface SourceHint {
  readonly file: string;
  readonly line: number;
}

export type ConflictingAnnotation = "readOnlyHint" | "openWorldHint";

export interface ClaimCheck {
  /** The rule keyword found in the tool's name, description, or schema property names. */
  readonly interface_mentions: string | null;
  readonly annotation_conflict: ConflictingAnnotation | null;
}

interface FindingCommon {
  readonly rule: RuleName;
  readonly evidence: NonEmpty<EventId>;
  readonly subject: FindingSubject;
  readonly source_hints: readonly SourceHint[];
}

// A finding's `kind` (plus `call_id` for calls) is its bundle reference.
export interface CallFinding extends FindingCommon {
  readonly kind: "call";
  readonly call_id: CallId;
  /** The strongest link among the evidence events. */
  readonly strength: LinkStrength;
  readonly claim_check: ClaimCheck;
}
export interface StartupFinding extends FindingCommon {
  readonly kind: "startup";
  readonly strength: LinkStrength;
}
export interface ShutdownFinding extends FindingCommon {
  readonly kind: "shutdown";
  readonly strength: LinkStrength;
}
export interface UnmatchedFinding extends FindingCommon {
  readonly kind: "unmatched";
}
export type Finding = CallFinding | StartupFinding | ShutdownFinding | UnmatchedFinding;

const LinkStrengthSchema = z.enum(["strong", "weak"]) satisfies z.ZodType<LinkStrength>;

const findingCommonShape = {
  rule: RuleNameSchema,
  evidence: z.tuple([EventIdSchema], EventIdSchema),
  subject: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("path"), path: z.string() }),
    z.strictObject({ kind: z.literal("peer"), peer: PeerSchema }),
    z.strictObject({ kind: z.literal("dns_name"), name: z.string().min(1) }),
    z.strictObject({ kind: z.literal("argv"), argv: z.array(z.string()) }),
    z.strictObject({ kind: z.literal("flow"), method: z.string().min(1), url: z.string() }),
  ]),
  source_hints: z.array(z.strictObject({ file: z.string().min(1), line: z.int().positive() })),
};

export const FindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("call"),
    call_id: CallIdSchema,
    ...findingCommonShape,
    strength: LinkStrengthSchema,
    claim_check: z.strictObject({
      interface_mentions: z.string().min(1).nullable(),
      annotation_conflict: z.enum(["readOnlyHint", "openWorldHint"]).nullable(),
    }),
  }),
  z.strictObject({ kind: z.literal("startup"), ...findingCommonShape, strength: LinkStrengthSchema }),
  z.strictObject({ kind: z.literal("shutdown"), ...findingCommonShape, strength: LinkStrengthSchema }),
  z.strictObject({ kind: z.literal("unmatched"), ...findingCommonShape }),
]) satisfies z.ZodType<Finding>;

export const FindingsFileSchema = z.array(FindingSchema) satisfies z.ZodType<readonly Finding[]>;

// ---------------------------------------------------------------------------
// Static profile (static_profile.json)
// ---------------------------------------------------------------------------

export interface PackageInfo {
  readonly name: string;
  readonly version: string | null;
  readonly ecosystem: Ecosystem;
  readonly manifest_path: string | null;
}

export interface Dependency {
  readonly name: string;
  readonly spec: string;
}

/** Ran at image build time, not observed. */
export interface InstallScript {
  readonly hook: "preinstall" | "install" | "postinstall";
  readonly command: string;
}

export type ApiHintCategory = "spawn" | "file" | "credential" | "network" | "code_load" | "platform";

export interface ApiHint {
  readonly category: ApiHintCategory;
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
  readonly snippet: string;
}

export interface SourceSite {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

export interface ToolSites {
  readonly tool: string;
  readonly sites: readonly SourceSite[];
}

export const DESCRIPTION_LENGTH_LIMIT = 1_000;

export interface TooLongFlag {
  readonly kind: "too_long";
}
export interface InstructionPhraseFlag {
  readonly kind: "instruction_phrase";
  readonly phrase: string;
}
export type DescriptionFlag = TooLongFlag | InstructionPhraseFlag;

export interface ToolText {
  readonly tool: string;
  /** Zero-width and other non-printing characters shown as escapes. */
  readonly escaped_description: string;
  readonly length: number;
  readonly flags: readonly DescriptionFlag[];
}

export interface StaticProfile {
  readonly package: PackageInfo;
  readonly dependencies: readonly Dependency[];
  readonly install_scripts: readonly InstallScript[];
  readonly api_hints: readonly ApiHint[];
  readonly tool_sites: readonly ToolSites[];
  readonly tool_texts: readonly ToolText[];
}

const SourceLineShape = { file: z.string().min(1), line: z.int().positive() };

export const StaticProfileSchema = z.strictObject({
  package: z.strictObject({
    name: z.string().min(1),
    version: z.string().nullable(),
    ecosystem: EcosystemSchema,
    manifest_path: z.string().nullable(),
  }),
  dependencies: z.array(z.strictObject({ name: z.string().min(1), spec: z.string() })),
  install_scripts: z.array(
    z.strictObject({ hook: z.enum(["preinstall", "install", "postinstall"]), command: z.string() }),
  ),
  api_hints: z.array(
    z.strictObject({
      category: z.enum(["spawn", "file", "credential", "network", "code_load", "platform"]),
      ...SourceLineShape,
      pattern: z.string(),
      snippet: z.string(),
    }),
  ),
  tool_sites: z.array(
    z.strictObject({
      tool: z.string(),
      sites: z.array(z.strictObject({ ...SourceLineShape, snippet: z.string() })),
    }),
  ),
  tool_texts: z.array(
    z.strictObject({
      tool: z.string(),
      escaped_description: z.string(),
      length: z.int().nonnegative(),
      flags: z.array(
        z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("too_long") }),
          z.strictObject({ kind: z.literal("instruction_phrase"), phrase: z.string().min(1) }),
        ]),
      ),
    }),
  ),
}) satisfies z.ZodType<StaticProfile>;

// ---------------------------------------------------------------------------
// Judge (the LLM's answer, and judgments.json)
// ---------------------------------------------------------------------------

export type JudgeOpinion = "matches" | "does_not_match" | "unclear";

export interface Mismatch {
  readonly event_ids: NonEmpty<EventId>;
  readonly explanation: string;
}

/** The one JSON object the judge must return per tool call. */
export interface JudgeAnswer {
  readonly opinion: JudgeOpinion;
  readonly mismatches: readonly Mismatch[];
  readonly summary: string;
}

export interface AnswerJudgment {
  readonly kind: "answer";
  readonly call_id: CallId;
  readonly model: string;
  readonly answered_at_us: Micros;
  readonly answer: JudgeAnswer;
}
/** The answer failed validation twice. The report shows it as invalid. */
export interface InvalidJudgment {
  readonly kind: "invalid";
  readonly call_id: CallId;
  readonly model: string;
  readonly answered_at_us: Micros;
  readonly raw_text: string;
  readonly error: string;
}
export type Judgment = AnswerJudgment | InvalidJudgment;

export const JudgeAnswerSchema = z.strictObject({
  opinion: z.enum(["matches", "does_not_match", "unclear"]),
  mismatches: z.array(
    z.strictObject({
      event_ids: z.tuple([EventIdSchema], EventIdSchema),
      explanation: z.string().min(1),
    }),
  ),
  summary: z.string().min(1),
}) satisfies z.ZodType<JudgeAnswer>;

export const JudgmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("answer"),
    call_id: CallIdSchema,
    model: z.string().min(1),
    answered_at_us: MicrosSchema,
    answer: JudgeAnswerSchema,
  }),
  z.strictObject({
    kind: z.literal("invalid"),
    call_id: CallIdSchema,
    model: z.string().min(1),
    answered_at_us: MicrosSchema,
    raw_text: z.string(),
    error: z.string(),
  }),
]) satisfies z.ZodType<Judgment>;

export const JudgmentsFileSchema = z.array(JudgmentSchema) satisfies z.ZodType<readonly Judgment[]>;

// ---------------------------------------------------------------------------
// Boundary parsing
// ---------------------------------------------------------------------------

/** Untyped text that failed to parse. `line` is 1-based for JSON Lines files. */
export class BoundaryError extends Error {
  constructor(
    readonly source: string,
    readonly line: number | null,
    readonly detail: string,
  ) {
    super(`${source}${line === null ? "" : `:${line}`}: ${detail}`);
    this.name = "BoundaryError";
  }
}

function validate<T>(schema: z.ZodType<T>, value: unknown, source: string, line: number | null): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BoundaryError(source, line, z.prettifyError(result.error));
  }
  return result.data;
}

function decodeJson(text: string, source: string, line: number | null): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BoundaryError(source, line, error instanceof Error ? error.message : String(error));
  }
}

/** Parses a whole JSON file, such as `bundles.json` with `RunSchema`. */
export function parseJsonFile<T>(schema: z.ZodType<T>, text: string, source: string): T {
  return validate(schema, decodeJson(text, source, null), source, null);
}

/** Parses a JSON Lines file, such as `transcript.jsonl` with `TimelineEntrySchema`. */
export function parseJsonLines<T>(schema: z.ZodType<T>, text: string, source: string): T[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line, index) => validate(schema, decodeJson(line, source, index + 1), source, index + 1));
}

export function parseTargetToml(text: string, source: string): Target {
  let value: unknown;
  try {
    value = parseToml(text);
  } catch (error) {
    throw new BoundaryError(source, null, error instanceof Error ? error.message : String(error));
  }
  return validate(TargetSchema, value, source, null);
}

/** Parses one judge answer and rejects any citation that is not an event in the judged bundle. */
export function parseJudgeAnswer(text: string, citable: ReadonlySet<EventId>, source: string): JudgeAnswer {
  const answer = parseJsonFile(JudgeAnswerSchema, text, source);
  const invented = answer.mismatches.flatMap((m) => m.event_ids).filter((id) => !citable.has(id));
  if (invented.length > 0) {
    throw new BoundaryError(source, null, `cites events outside the bundle: ${invented.join(", ")}`);
  }
  return answer;
}
