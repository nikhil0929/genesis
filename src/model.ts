// The data shape for one detonation.
// Each document has one zod schema. The exported type is that schema's output
// with every property readonly. A fact computed from other fields is a function,
// so the document cannot store a second copy that disagrees. Parse functions are
// the boundary. Schemas stay in this file.

import { parse as parseToml } from "smol-toml";
import { z } from "zod";

// --- Boundary ---------------------------------------------------------------

export class BoundaryError extends Error {
  readonly source: string;
  readonly line: number | null;
  readonly detail: string;

  constructor(source: string, line: number | null, detail: string) {
    super(line === null ? `${source}: ${detail}` : `${source}:${line}: ${detail}`);
    this.name = "BoundaryError";
    this.source = source;
    this.line = line;
    this.detail = detail;
  }
}

function decodeJson(text: string, source: string, line: number | null): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BoundaryError(source, line, detail);
  }
}

function parseWith<T extends z.ZodType>(
  schema: T,
  value: unknown,
  source: string,
  line: number | null,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BoundaryError(source, line, z.prettifyError(result.error));
  }
  return result.data;
}

function parseLines<T extends z.ZodType>(schema: T, text: string, source: string): z.output<T>[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => parseWith(schema, decodeJson(line, source, index + 1), source, index + 1));
}

// --- Types derived from schemas ---------------------------------------------

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

type DeepReadonly<T> = T extends Primitive
  ? T
  : T extends readonly [infer Head, ...infer Rest]
    ? readonly [DeepReadonly<Head>, ...DeepReadonlyRest<Rest>]
    : T extends readonly (infer Element)[]
      ? readonly DeepReadonly<Element>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

type DeepReadonlyRest<T> = T extends readonly []
  ? []
  : T extends readonly [infer Head, ...infer Rest]
    ? [DeepReadonly<Head>, ...DeepReadonlyRest<Rest>]
    : T extends readonly (infer Element)[]
      ? DeepReadonly<Element>[]
      : never;

type Out<T extends z.ZodType> = DeepReadonly<z.output<T>>;

// The schema has already accepted the value. The intersection is the nominal tag.
type Brand<T, Name extends string> = T & { readonly __brand: Name };

function brandedNumber<Name extends string>(schema: z.ZodNumber) {
  return schema.transform((value): Brand<number, Name> => value as Brand<number, Name>);
}

function brandedString<Name extends string>(schema: z.ZodString) {
  return schema.transform((value): Brand<string, Name> => value as Brand<string, Name>);
}

const microsSchema = brandedNumber<"Micros">(z.int().nonnegative());
const durationSchema = brandedNumber<"Duration">(z.int().nonnegative());
const pidSchema = brandedNumber<"Pid">(z.int().positive());
const tidSchema = brandedNumber<"Tid">(z.int().positive());
const callIdSchema = brandedNumber<"CallId">(z.int().nonnegative());
const eventIdSchema = brandedString<"EventId">(z.string().regex(/^e[0-9]+$/));

export type Micros = Out<typeof microsSchema>;
export type Duration = Out<typeof durationSchema>;
export type Pid = Out<typeof pidSchema>;
export type Tid = Out<typeof tidSchema>;
export type CallId = Out<typeof callIdSchema>;
export type EventId = Out<typeof eventIdSchema>;

// Addition of two branded numbers is a plain number. The range check puts the instant brand back.
function instant(value: number): Micros {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`microsecond instant is out of range: ${value}`);
  }
  return value as Micros;
}

const pidKeySchema = z.string().regex(/^[1-9][0-9]*$/);
const absolutePathSchema = z.string().startsWith("/");
const portSchema = z.int().min(0).max(65535);
const argvSchema = z.tuple([z.string().min(1)], z.string());
const nonemptyEventIdsSchema = z.tuple([eventIdSchema], eventIdSchema);

export type Argv = Out<typeof argvSchema>;

// --- JSON -------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

// --- Target file ------------------------------------------------------------

export const PROTOCOL_VERSION = "2025-11-25";
export const CLIENT_NAME = "mcpdet";
export const CALL_TIMEOUT_MS = 30_000;
export const SETTLE_MS = 1_000;
export const SHUTDOWN_WAIT_MS = 5_000;

const pinnedVersionSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/, "must be an exact version, not a range");

const ecosystemSchema = z.enum(["pypi", "npm"]);
export type Ecosystem = Out<typeof ecosystemSchema>;

const registrySourceSchema = z.strictObject({
  kind: z.literal("registry"),
  ecosystem: ecosystemSchema,
  package: z.string().min(1),
  version: pinnedVersionSchema,
});
const localSourceSchema = z.strictObject({
  kind: z.literal("local"),
  ecosystem: ecosystemSchema,
  path: z.string().min(1).refine((path) => !path.startsWith("/"), "local source is relative to the target file"),
});
const targetSourceSchema = z.discriminatedUnion("kind", [registrySourceSchema, localSourceSchema]);

export type RegistrySource = Out<typeof registrySourceSchema>;
export type LocalSource = Out<typeof localSourceSchema>;
export type TargetSource = Out<typeof targetSourceSchema>;

const networkModeSchema = z.enum(["allow", "block"]);
export type NetworkMode = Out<typeof networkModeSchema>;

const scenarioEntrySchema = z.strictObject({
  tool: z.string().min(1),
  arguments: jsonObjectSchema.default({}),
});
export type ScenarioEntry = Out<typeof scenarioEntrySchema>;

const targetSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  source: targetSourceSchema,
  base_image: z.string().min(1),
  install: z.array(z.string()).default([]),
  setup: z.array(z.string()).default([]),
  source_path: absolutePathSchema,
  command: argvSchema,
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  network: networkModeSchema.default("allow"),
  scenario: z.array(scenarioEntrySchema).default([]),
});
export type Target = Out<typeof targetSchema>;

export function parseTarget(text: string, source: string): Target {
  let value: unknown;
  try {
    value = parseToml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BoundaryError(source, null, detail);
  }
  return parseWith(targetSchema, value, source, null);
}

// --- Driver plan ------------------------------------------------------------

const driverPlanSchema = z.strictObject({
  server_command: argvSchema,
  server_env: z.record(z.string(), z.string()),
  scenario: z.array(scenarioEntrySchema),
  protocol_version: z.literal(PROTOCOL_VERSION),
  client_name: z.literal(CLIENT_NAME),
  call_timeout_ms: z.literal(CALL_TIMEOUT_MS),
  settle_ms: z.literal(SETTLE_MS),
  shutdown_wait_ms: z.literal(SHUTDOWN_WAIT_MS),
});

/** The in-container driver imports this type with `import type` and reads the JSON itself. */
export type DriverPlan = Out<typeof driverPlanSchema>;

export function parsePlan(text: string, source: string): DriverPlan {
  return parseWith(driverPlanSchema, decodeJson(text, source, null), source, null);
}

// --- Timeline ---------------------------------------------------------------

const jsonRpcIdSchema = z.union([z.string(), z.int()]);
export type JsonRpcId = Out<typeof jsonRpcIdSchema>;

const exitedEndSchema = z.strictObject({ kind: z.literal("exited"), status: z.int() });
const killedEndSchema = z.strictObject({
  kind: z.literal("killed"),
  signal: z.string().min(1),
});
const exitEndSchema = z.discriminatedUnion("kind", [exitedEndSchema, killedEndSchema]);
export type ExitedEnd = Out<typeof exitedEndSchema>;
export type KilledEnd = Out<typeof killedEndSchema>;
export type ExitEnd = Out<typeof exitEndSchema>;

const rpcRequestSchema = z.strictObject({
  kind: z.literal("request"),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
});
const rpcNotificationSchema = z.strictObject({
  kind: z.literal("notification"),
  method: z.string().min(1),
});
const rpcResultSchema = z.strictObject({
  kind: z.literal("result"),
  id: jsonRpcIdSchema,
});
const rpcErrorSchema = z.strictObject({
  kind: z.literal("error"),
  id: jsonRpcIdSchema.nullable(),
  code: z.int(),
  message: z.string(),
});
const rpcSummarySchema = z.discriminatedUnion("kind", [
  rpcRequestSchema,
  rpcNotificationSchema,
  rpcResultSchema,
  rpcErrorSchema,
]);
export type RpcRequest = Out<typeof rpcRequestSchema>;
export type RpcNotification = Out<typeof rpcNotificationSchema>;
export type RpcResult = Out<typeof rpcResultSchema>;
export type RpcError = Out<typeof rpcErrorSchema>;
export type RpcSummary = Out<typeof rpcSummarySchema>;

const directionSchema = z.enum(["to_server", "from_server"]);
export type Direction = Out<typeof directionSchema>;

const timelineMessageSchema = z.strictObject({
  kind: z.literal("message"),
  direction: directionSchema,
  t_us: microsSchema,
  raw: z.string(),
  rpc: rpcSummarySchema,
});
const invalidLineSchema = z.strictObject({
  kind: z.literal("invalid_line"),
  t_us: microsSchema,
  raw: z.string(),
  reason: z.enum(["not_json", "not_jsonrpc"]),
});
const callTimeoutSchema = z.strictObject({
  kind: z.literal("call_timeout"),
  t_us: microsSchema,
  call_id: callIdSchema,
});
const stdinClosedSchema = z.strictObject({
  kind: z.literal("stdin_closed"),
  t_us: microsSchema,
});
const serverExitedSchema = z.strictObject({
  kind: z.literal("server_exited"),
  t_us: microsSchema,
  end: exitEndSchema,
});
const timelineEntrySchema = z.discriminatedUnion("kind", [
  timelineMessageSchema,
  invalidLineSchema,
  callTimeoutSchema,
  stdinClosedSchema,
  serverExitedSchema,
]);

export type TimelineMessage = Out<typeof timelineMessageSchema>;
export type InvalidLine = Out<typeof invalidLineSchema>;
export type CallTimeout = Out<typeof callTimeoutSchema>;
export type StdinClosed = Out<typeof stdinClosedSchema>;
export type ServerExited = Out<typeof serverExitedSchema>;
export type TimelineEntry = Out<typeof timelineEntrySchema>;

/** The line the in-container driver writes. It carries plain numbers because the driver cannot import zod to brand them. */
export type DriverTimelineEntry = DeepReadonly<z.input<typeof timelineEntrySchema>>;

export function parseTranscript(text: string, source: string): readonly TimelineEntry[] {
  return parseLines(timelineEntrySchema, text, source);
}

// --- MCP payloads -----------------------------------------------------------

const toolAnnotationsSchema = z.strictObject({
  title: z.string().nullable(),
  read_only_hint: z.boolean().nullable(),
  destructive_hint: z.boolean().nullable(),
  idempotent_hint: z.boolean().nullable(),
  open_world_hint: z.boolean().nullable(),
});
export type ToolAnnotations = Out<typeof toolAnnotationsSchema>;

const toolDefinitionSchema = z.strictObject({
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  input_schema: jsonObjectSchema,
  annotations: toolAnnotationsSchema,
  raw: jsonObjectSchema,
});
export type ToolDefinition = Out<typeof toolDefinitionSchema>;

const serverInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  protocol_version: z.string(),
  capabilities: jsonObjectSchema,
});
export type ServerInfo = Out<typeof serverInfoSchema>;

const toolsPageSchema = z.strictObject({
  tools: z.array(toolDefinitionSchema),
  next_cursor: z.string().nullable(),
});
export type ToolsPage = Out<typeof toolsPageSchema>;

const callToolResultSchema = z.strictObject({
  content: z.array(jsonValueSchema),
  is_error: z.boolean(),
});
export type CallToolResult = Out<typeof callToolResultSchema>;

const rpcResultEnvelopeSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcIdSchema,
  result: z.unknown(),
});

const wireToolSchema = z.looseObject({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: jsonObjectSchema,
  annotations: z.record(z.string(), jsonValueSchema).optional(),
});

const initializeResultWireSchema = z.looseObject({
  protocolVersion: z.string(),
  capabilities: jsonObjectSchema,
  serverInfo: z.looseObject({
    name: z.string(),
    version: z.string(),
  }),
});

const toolsPageWireSchema = z.looseObject({
  tools: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

const callToolResultWireSchema = z.looseObject({
  content: z.array(jsonValueSchema),
  isError: z.boolean().optional(),
});

function rpcResult(rawLine: string, source: string): unknown {
  return parseWith(rpcResultEnvelopeSchema, decodeJson(rawLine, source, null), source, null).result;
}

function booleanHint(annotations: JsonObject, key: string): boolean | null {
  const value = annotations[key];
  return typeof value === "boolean" ? value : null;
}

function toolDefinitionFromWire(value: unknown, source: string): ToolDefinition {
  const raw = parseWith(jsonObjectSchema, value, source, null);
  const tool = parseWith(wireToolSchema, value, source, null);
  const annotations: JsonObject = tool.annotations ?? {};
  const annotationTitle = annotations["title"];
  return parseWith(
    toolDefinitionSchema,
    {
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      input_schema: tool.inputSchema,
      annotations: {
        title: typeof annotationTitle === "string" ? annotationTitle : null,
        read_only_hint: booleanHint(annotations, "readOnlyHint"),
        destructive_hint: booleanHint(annotations, "destructiveHint"),
        idempotent_hint: booleanHint(annotations, "idempotentHint"),
        open_world_hint: booleanHint(annotations, "openWorldHint"),
      },
      raw,
    },
    source,
    null,
  );
}

export function parseInitializeResult(rawLine: string, source: string): ServerInfo {
  const result = parseWith(initializeResultWireSchema, rpcResult(rawLine, source), source, null);
  return parseWith(
    serverInfoSchema,
    {
      name: result.serverInfo.name,
      version: result.serverInfo.version,
      protocol_version: result.protocolVersion,
      capabilities: result.capabilities,
    },
    source,
    null,
  );
}

export function parseToolsPage(rawLine: string, source: string): ToolsPage {
  const result = parseWith(toolsPageWireSchema, rpcResult(rawLine, source), source, null);
  return parseWith(
    toolsPageSchema,
    {
      tools: result.tools.map((tool) => toolDefinitionFromWire(tool, source)),
      next_cursor: result.nextCursor ?? null,
    },
    source,
    null,
  );
}

export function parseCallToolResult(rawLine: string, source: string): CallToolResult {
  const result = parseWith(callToolResultWireSchema, rpcResult(rawLine, source), source, null);
  return parseWith(
    callToolResultSchema,
    {
      content: result.content,
      is_error: result.isError ?? false,
    },
    source,
    null,
  );
}

// --- Canaries ---------------------------------------------------------------

const envPlacementSchema = z.strictObject({ kind: z.literal("env"), variable: z.string().min(1) });
const filePlacementSchema = z.strictObject({ kind: z.literal("file"), path: absolutePathSchema });
const canaryPlacementSchema = z.discriminatedUnion("kind", [envPlacementSchema, filePlacementSchema]);
const canarySchema = z.strictObject({
  name: z.string().min(1),
  placement: canaryPlacementSchema,
  value: z.string().min(1),
});
const canariesSchema = z.array(canarySchema);

export type EnvPlacement = Out<typeof envPlacementSchema>;
export type FilePlacement = Out<typeof filePlacementSchema>;
export type CanaryPlacement = Out<typeof canaryPlacementSchema>;
export type Canary = Out<typeof canarySchema>;

export function parseCanaries(text: string, source: string): readonly Canary[] {
  return parseWith(canariesSchema, decodeJson(text, source, null), source, null);
}

// --- Proxy flows ------------------------------------------------------------

export const PROXY_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

const textBodySchema = z.strictObject({
  kind: z.literal("text"),
  text: z.string(),
  byte_count: z.int().nonnegative(),
  truncated: z.boolean(),
});
const binaryBodySchema = z.strictObject({
  kind: z.literal("base64"),
  base64: z.base64(),
  byte_count: z.int().nonnegative(),
  truncated: z.boolean(),
});
const httpBodySchema = z.discriminatedUnion("kind", [textBodySchema, binaryBodySchema]);
const httpHeadersSchema = z.array(z.tuple([z.string(), z.string()]));

export type TextBody = Out<typeof textBodySchema>;
export type BinaryBody = Out<typeof binaryBodySchema>;
export type HttpBody = Out<typeof httpBodySchema>;
export type HttpHeaders = Out<typeof httpHeadersSchema>;

const httpRequestSchema = z.strictObject({
  method: z.string().min(1),
  url: z.string(),
  host: z.string(),
  headers: httpHeadersSchema,
  body: httpBodySchema,
});
const httpResponseSchema = z.strictObject({
  status: z.int(),
  headers: httpHeadersSchema,
  body: httpBodySchema,
});
const flowResponseSchema = z.strictObject({ kind: z.literal("response"), response: httpResponseSchema });
const flowErrorSchema = z.strictObject({ kind: z.literal("error"), message: z.string() });
const flowResultSchema = z.discriminatedUnion("kind", [flowResponseSchema, flowErrorSchema]);

// A flow's end is flowEnd. duration_us cannot be negative, so the end cannot precede the start.
const proxyFlowSchema = z.strictObject({
  flow_id: z.string().min(1),
  client: z.strictObject({ address: z.string().min(1), port: portSchema }),
  start_us: microsSchema,
  duration_us: durationSchema,
  request: httpRequestSchema,
  result: flowResultSchema,
});

export type HttpRequest = Out<typeof httpRequestSchema>;
export type HttpResponse = Out<typeof httpResponseSchema>;
export type FlowResponse = Out<typeof flowResponseSchema>;
export type FlowError = Out<typeof flowErrorSchema>;
export type FlowResult = Out<typeof flowResultSchema>;
export type ProxyFlow = Out<typeof proxyFlowSchema>;

export function flowEnd(flow: ProxyFlow): Micros {
  return instant(flow.start_us + flow.duration_us);
}

export function parseFlows(text: string, source: string): readonly ProxyFlow[] {
  return parseLines(proxyFlowSchema, text, source);
}

// --- Events -----------------------------------------------------------------

export const PREVIEW_LIMIT_BYTES = 4096;

const okResultSchema = z.strictObject({ kind: z.literal("ok"), value: z.int() });
const errorResultSchema = z.strictObject({
  kind: z.literal("error"),
  errno: z.string().regex(/^E[A-Z0-9]+$/),
});
const noReturnResultSchema = z.strictObject({ kind: z.literal("no_return") });
const syscallResultSchema = z.discriminatedUnion("kind", [
  okResultSchema,
  errorResultSchema,
  noReturnResultSchema,
]);
export type OkResult = Out<typeof okResultSchema>;
export type ErrorResult = Out<typeof errorResultSchema>;
export type NoReturnResult = Out<typeof noReturnResultSchema>;
export type SyscallResult = Out<typeof syscallResultSchema>;

const rawRefSchema = z.strictObject({ file: z.string().min(1), line: z.int().positive() });
export type RawRef = Out<typeof rawRefSchema>;

const spawnActionSchema = z.strictObject({
  kind: z.literal("spawn"),
  child_pid: pidSchema,
  untraced: z.boolean(),
});
const threadActionSchema = z.strictObject({ kind: z.literal("thread"), tid: tidSchema });
const execActionSchema = z.strictObject({
  kind: z.literal("exec"),
  path: z.string(),
  argv: z.array(z.string()),
  env_names: z.array(z.string()),
});
const exitActionSchema = z.strictObject({ kind: z.literal("exit"), end: exitEndSchema });
const processActionSchema = z.discriminatedUnion("kind", [
  spawnActionSchema,
  threadActionSchema,
  execActionSchema,
  exitActionSchema,
]);
export type SpawnAction = Out<typeof spawnActionSchema>;
export type ThreadAction = Out<typeof threadActionSchema>;
export type ExecAction = Out<typeof execActionSchema>;
export type ExitAction = Out<typeof exitActionSchema>;
export type ProcessAction = Out<typeof processActionSchema>;

const openActionSchema = z.strictObject({
  kind: z.literal("open"),
  path: absolutePathSchema,
  access: z.enum(["read", "write", "read_write"]),
  created: z.boolean(),
});
const twoPathActionSchema = z.strictObject({
  kind: z.enum(["rename", "link", "symlink"]),
  path: absolutePathSchema,
  second_path: z.string(),
});
const pathActionSchema = z.strictObject({
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
  path: absolutePathSchema,
});
const fileActionSchema = z.discriminatedUnion("kind", [openActionSchema, twoPathActionSchema, pathActionSchema]);
export type OpenAction = Out<typeof openActionSchema>;
export type FileAccess = OpenAction["access"];
export type TwoPathAction = Out<typeof twoPathActionSchema>;
export type PathAction = Out<typeof pathActionSchema>;
export type FileAction = Out<typeof fileActionSchema>;

const ipPeerSchema = z.strictObject({
  kind: z.literal("ip"),
  address: z.string().min(1),
  port: portSchema,
});
const unixPeerSchema = z.strictObject({ kind: z.literal("unix"), path: z.string() });
const noPeerSchema = z.strictObject({ kind: z.literal("none") });
const peerSchema = z.discriminatedUnion("kind", [ipPeerSchema, unixPeerSchema, noPeerSchema]);
export type IpPeer = Out<typeof ipPeerSchema>;
export type UnixPeer = Out<typeof unixPeerSchema>;
export type NoPeer = Out<typeof noPeerSchema>;
export type Peer = Out<typeof peerSchema>;

const fileTargetSchema = z.strictObject({ kind: z.literal("file"), path: absolutePathSchema });
const socketTargetSchema = z.strictObject({ kind: z.literal("socket"), peer: peerSchema });
const pipeTargetSchema = z.strictObject({ kind: z.literal("pipe"), inode: z.string().min(1) });
const stdoutTargetSchema = z.strictObject({ kind: z.literal("stdout") });
const stderrTargetSchema = z.strictObject({ kind: z.literal("stderr") });
const writeTargetSchema = z.discriminatedUnion("kind", [
  fileTargetSchema,
  socketTargetSchema,
  pipeTargetSchema,
  stdoutTargetSchema,
  stderrTargetSchema,
]);
export type FileTarget = Out<typeof fileTargetSchema>;
export type SocketTarget = Out<typeof socketTargetSchema>;
export type PipeTarget = Out<typeof pipeTargetSchema>;
export type StdoutTarget = Out<typeof stdoutTargetSchema>;
export type StderrTarget = Out<typeof stderrTargetSchema>;
export type WriteTarget = Out<typeof writeTargetSchema>;

const processBodySchema = z.strictObject({ kind: z.literal("process"), action: processActionSchema });
const fileBodySchema = z.strictObject({ kind: z.literal("file"), action: fileActionSchema });
const netBodySchema = z.strictObject({
  kind: z.literal("net"),
  op: z.enum(["socket", "connect", "bind", "listen", "accept", "send"]),
  family: z.enum(["inet", "inet6", "unix", "netlink", "other"]),
  protocol: z.enum(["tcp", "udp", "unix_stream", "unix_dgram", "other"]),
  local: peerSchema,
  peer: peerSchema,
  dns_name: z.string().min(1).nullable(),
  proxy_flow_id: z.string().min(1).nullable(),
});
const dataBodySchema = z.strictObject({
  kind: z.literal("data"),
  target: writeTargetSchema,
  byte_count: z.int().nonnegative(),
  preview: z.string(),
  truncated: z.boolean(),
});
const otherBodySchema = z.strictObject({
  kind: z.literal("other"),
  unparsed: z.string().nullable(),
});
const eventBodySchema = z.discriminatedUnion("kind", [
  processBodySchema,
  fileBodySchema,
  netBodySchema,
  dataBodySchema,
  otherBodySchema,
]);
export type ProcessBody = Out<typeof processBodySchema>;
export type FileBody = Out<typeof fileBodySchema>;
export type NetBody = Out<typeof netBodySchema>;
export type DataBody = Out<typeof dataBodySchema>;
export type OtherBody = Out<typeof otherBodySchema>;
export type EventBody = Out<typeof eventBodySchema>;

const eventSchema = z.strictObject({
  event_id: eventIdSchema,
  t_us: microsSchema,
  pid: pidSchema,
  tid: tidSchema,
  syscall: z.string().min(1),
  result: syscallResultSchema,
  raw_ref: rawRefSchema,
  body: eventBodySchema,
});
export type Event = Out<typeof eventSchema>;

export function parseEvents(text: string, source: string): readonly Event[] {
  const events = parseLines(eventSchema, text, source);
  const seen = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (seen.has(event.event_id)) {
      throw new BoundaryError(source, index + 1, `event ${event.event_id} appears twice in the trace`);
    }
    seen.add(event.event_id);
  }
  return events;
}

// --- Bundle references ------------------------------------------------------

const startupRefSchema = z.strictObject({ kind: z.literal("startup") });
const callRefSchema = z.strictObject({ kind: z.literal("call"), call_id: callIdSchema });
const shutdownRefSchema = z.strictObject({ kind: z.literal("shutdown") });
const gapPredecessorSchema = z.discriminatedUnion("kind", [startupRefSchema, callRefSchema]);

export type StartupRef = Out<typeof startupRefSchema>;
export type CallRef = Out<typeof callRefSchema>;
export type ShutdownRef = Out<typeof shutdownRefSchema>;
export type GapPredecessor = Out<typeof gapPredecessorSchema>;

// --- Processes --------------------------------------------------------------

const threadRecordSchema = z.strictObject({
  tid: tidSchema,
  born_us: microsSchema,
  event_id: eventIdSchema,
});
const execRecordSchema = z.strictObject({
  event_id: eventIdSchema,
  t_us: microsSchema,
  path: z.string(),
  argv: z.array(z.string()),
});
const exitedProcessEndSchema = z.strictObject({
  kind: z.literal("exited"),
  t_us: microsSchema,
  status: z.int(),
});
const killedProcessEndSchema = z.strictObject({
  kind: z.literal("killed"),
  t_us: microsSchema,
  signal: z.string().min(1),
});
const aliveAtTeardownSchema = z.strictObject({ kind: z.literal("alive_at_teardown") });
const processEndSchema = z.discriminatedUnion("kind", [
  exitedProcessEndSchema,
  killedProcessEndSchema,
  aliveAtTeardownSchema,
]);

export type ThreadRecord = Out<typeof threadRecordSchema>;
export type ExecRecord = Out<typeof execRecordSchema>;
export type ExitedProcessEnd = Out<typeof exitedProcessEndSchema>;
export type KilledProcessEnd = Out<typeof killedProcessEndSchema>;
export type AliveAtTeardown = Out<typeof aliveAtTeardownSchema>;
export type ProcessEnd = Out<typeof processEndSchema>;

const processCommonShape = {
  pid: pidSchema,
  threads: z.array(threadRecordSchema),
  execs: z.array(execRecordSchema),
  end: processEndSchema,
};

const rootProcessSchema = z.strictObject({ kind: z.literal("root"), ...processCommonShape });
const childProcessSchema = z.strictObject({
  kind: z.literal("child"),
  ...processCommonShape,
  parent_pid: pidSchema,
  born_us: microsSchema,
  spawn_event_id: eventIdSchema,
});
const orphanProcessSchema = z.strictObject({
  kind: z.literal("orphan"),
  ...processCommonShape,
  first_seen_us: microsSchema,
});
const processRecordSchema = z.discriminatedUnion("kind", [
  rootProcessSchema,
  childProcessSchema,
  orphanProcessSchema,
]);

export type RootProcess = Out<typeof rootProcessSchema>;
export type ChildProcess = Out<typeof childProcessSchema>;
export type OrphanProcess = Out<typeof orphanProcessSchema>;
export type ProcessRecord = Out<typeof processRecordSchema>;

const serverOwnerSchema = z.strictObject({ kind: z.literal("server") });
const gapOwnerSchema = z.strictObject({ kind: z.literal("gap"), preceded_by: gapPredecessorSchema });
const processOwnerSchema = z.discriminatedUnion("kind", [
  serverOwnerSchema,
  callRefSchema,
  shutdownRefSchema,
  gapOwnerSchema,
]);
export type ServerOwner = Out<typeof serverOwnerSchema>;
export type GapOwner = Out<typeof gapOwnerSchema>;
export type ProcessOwner = Out<typeof processOwnerSchema>;

const attributedRootSchema = rootProcessSchema.extend({ owner: serverOwnerSchema });
const attributedChildSchema = childProcessSchema.extend({ owner: processOwnerSchema });
const attributedProcessSchema = z.discriminatedUnion("kind", [
  attributedRootSchema,
  attributedChildSchema,
  orphanProcessSchema,
]);
export type AttributedRootProcess = Out<typeof attributedRootSchema>;
export type AttributedChildProcess = Out<typeof attributedChildSchema>;
export type AttributedProcess = Out<typeof attributedProcessSchema>;

// A cross-field check reads fields that may have failed their own schema, so it runs only on an issue-free value.
const wellFormed = { when: (payload: { readonly issues: readonly unknown[] }) => payload.issues.length === 0 };

function keyedProcesses<T extends z.ZodType<{ readonly pid: number; readonly kind: string }>>(record: T) {
  return z.record(pidKeySchema, record).superRefine((table, ctx) => {
    let roots = 0;
    for (const [key, process] of Object.entries<{ readonly pid: number; readonly kind: string }>(table)) {
      if (key !== String(process.pid)) {
        ctx.addIssue({ code: "custom", message: `process key ${key} does not match pid ${String(process.pid)}` });
      }
      if (process.kind === "root") roots += 1;
    }
    if (roots !== 1) {
      ctx.addIssue({ code: "custom", message: "expected exactly one root process" });
    }
  }, wellFormed);
}

const sensorProcessesSchema = keyedProcesses(processRecordSchema);
const attributedProcessesSchema = keyedProcesses(attributedProcessSchema);
export type SensorProcesses = Out<typeof sensorProcessesSchema>;
export type AttributedProcesses = Out<typeof attributedProcessesSchema>;

export function parseProcesses(text: string, source: string): SensorProcesses {
  return parseWith(sensorProcessesSchema, decodeJson(text, source, null), source, null);
}

// --- Links ------------------------------------------------------------------

const ownedLinkSchema = z.strictObject({ kind: z.literal("owned"), ancestor_pid: pidSchema });
const phaseLinkSchema = z.strictObject({ kind: z.literal("phase") });
const overlapLinkSchema = z.strictObject({ kind: z.literal("overlap") });
const linkSchema = z.discriminatedUnion("kind", [ownedLinkSchema, phaseLinkSchema, overlapLinkSchema]);

export type OwnedLink = Out<typeof ownedLinkSchema>;
export type PhaseLink = Out<typeof phaseLinkSchema>;
export type OverlapLink = Out<typeof overlapLinkSchema>;
export type Link = Out<typeof linkSchema>;
export type LinkStrength = "strong" | "weak";

export function linkStrength(link: Link): LinkStrength {
  switch (link.kind) {
    case "owned":
    case "phase":
      return "strong";
    case "overlap":
      return "weak";
    default: {
      const _exhaustive: never = link;
      return _exhaustive;
    }
  }
}

// --- Bundles ----------------------------------------------------------------

// The end of a window is windowEnd. A negative span cannot be written.
const windowSchema = z.strictObject({
  start_us: microsSchema,
  duration_us: durationSchema,
});
export type Window = Out<typeof windowSchema>;

export function windowEnd(window: Window): Micros {
  return instant(window.start_us + window.duration_us);
}

const startupEntrySchema = z.strictObject({ event: eventSchema, link: phaseLinkSchema });
const ownedCallEntrySchema = z.strictObject({ event: eventSchema, link: ownedLinkSchema });
const overlapCallEntrySchema = z.strictObject({ event: eventSchema, link: overlapLinkSchema });
const toolCallLinkSchema = z.discriminatedUnion("kind", [ownedLinkSchema, overlapLinkSchema]);
const shutdownLinkSchema = z.discriminatedUnion("kind", [ownedLinkSchema, phaseLinkSchema]);
const toolCallEntrySchema = z.strictObject({ event: eventSchema, link: toolCallLinkSchema });
const shutdownEntrySchema = z.strictObject({ event: eventSchema, link: shutdownLinkSchema });

export type StartupEntry = Out<typeof startupEntrySchema>;
export type OwnedCallEntry = Out<typeof ownedCallEntrySchema>;
export type OverlapCallEntry = Out<typeof overlapCallEntrySchema>;
export type ToolCallEntry = Out<typeof toolCallEntrySchema>;
export type ShutdownEntry = Out<typeof shutdownEntrySchema>;

const startupBundleSchema = z.strictObject({
  kind: z.literal("startup"),
  window: windowSchema,
  messages: z.array(timelineMessageSchema),
  server_info: serverInfoSchema,
  advertised_tools: z.array(toolDefinitionSchema),
  events: z.array(startupEntrySchema),
});
export type StartupBundle = Out<typeof startupBundleSchema>;

const advertisedDefinitionSchema = z.strictObject({
  kind: z.literal("advertised"),
  tool: toolDefinitionSchema,
});
const notAdvertisedSchema = z.strictObject({ kind: z.literal("not_advertised") });
const callDefinitionSchema = z.discriminatedUnion("kind", [advertisedDefinitionSchema, notAdvertisedSchema]);
export type AdvertisedDefinition = Out<typeof advertisedDefinitionSchema>;
export type NotAdvertised = Out<typeof notAdvertisedSchema>;
export type CallDefinition = Out<typeof callDefinitionSchema>;

const scenarioSourceSchema = z.strictObject({ kind: z.literal("scenario"), index: z.int().nonnegative() });
const schemaProbeSourceSchema = z.strictObject({ kind: z.literal("schema_probe") });
const argumentSourceSchema = z.discriminatedUnion("kind", [scenarioSourceSchema, schemaProbeSourceSchema]);
export type ScenarioSource = Out<typeof scenarioSourceSchema>;
export type SchemaProbeSource = Out<typeof schemaProbeSourceSchema>;
export type ArgumentSource = Out<typeof argumentSourceSchema>;

// The outcome time is outcomeTime. duration_us is nonnegative, so the outcome cannot precede sent_us.
// no_reply has a span and a reason. It has no reply body and no separate timestamp field.
const replyOutcomeSchema = z.strictObject({
  kind: z.literal("reply"),
  duration_us: durationSchema,
  content: z.array(jsonValueSchema),
  is_error: z.boolean(),
});
const rpcErrorOutcomeSchema = z.strictObject({
  kind: z.literal("rpc_error"),
  duration_us: durationSchema,
  code: z.int(),
  message: z.string(),
});
const noReplyOutcomeSchema = z.strictObject({
  kind: z.literal("no_reply"),
  duration_us: durationSchema,
  reason: z.enum(["timeout", "server_exited"]),
});
const callOutcomeSchema = z.discriminatedUnion("kind", [
  replyOutcomeSchema,
  rpcErrorOutcomeSchema,
  noReplyOutcomeSchema,
]);
export type ReplyOutcome = Out<typeof replyOutcomeSchema>;
export type RpcErrorOutcome = Out<typeof rpcErrorOutcomeSchema>;
export type NoReplyOutcome = Out<typeof noReplyOutcomeSchema>;
export type CallOutcome = Out<typeof callOutcomeSchema>;

const ownedProcessSchema = z.strictObject({
  pid: pidSchema,
  end: processEndSchema,
});
export type OwnedProcess = Out<typeof ownedProcessSchema>;

const toolCallBundleSchema = z.strictObject({
  kind: z.literal("tool_call"),
  call_id: callIdSchema,
  tool: z.string().min(1),
  definition: callDefinitionSchema,
  arguments: jsonObjectSchema,
  argument_source: argumentSourceSchema,
  sent_us: microsSchema,
  outcome: callOutcomeSchema,
  events: z.array(toolCallEntrySchema),
  owned_processes: z.array(ownedProcessSchema),
});
export type ToolCallBundle = Out<typeof toolCallBundleSchema>;

const stdinClosedTriggerSchema = z.strictObject({ kind: z.literal("stdin_closed"), t_us: microsSchema });
const serverExitedTriggerSchema = z.strictObject({
  kind: z.literal("server_exited"),
  t_us: microsSchema,
  end: exitEndSchema,
});
const shutdownTriggerSchema = z.discriminatedUnion("kind", [stdinClosedTriggerSchema, serverExitedTriggerSchema]);
export type StdinClosedTrigger = Out<typeof stdinClosedTriggerSchema>;
export type ServerExitedTrigger = Out<typeof serverExitedTriggerSchema>;
export type ShutdownTrigger = Out<typeof shutdownTriggerSchema>;

const shutdownBundleSchema = z.strictObject({
  kind: z.literal("shutdown"),
  trigger: shutdownTriggerSchema,
  duration_us: durationSchema,
  events: z.array(shutdownEntrySchema),
  killed_at_teardown: z.array(pidSchema),
});
export type ShutdownBundle = Out<typeof shutdownBundleSchema>;
export type Bundle = StartupBundle | ToolCallBundle | ShutdownBundle;

export function outcomeTime(call: ToolCallBundle): Micros {
  return instant(call.sent_us + call.outcome.duration_us);
}

export function shutdownEnd(bundle: ShutdownBundle): Micros {
  return instant(bundle.trigger.t_us + bundle.duration_us);
}

/** True only for an owned event whose timestamp is later than the outcome. Overlap is inside the window, so it is never after the reply. */
export function afterReply(call: ToolCallBundle, entry: ToolCallEntry): boolean {
  switch (entry.link.kind) {
    case "owned":
      return entry.event.t_us > outcomeTime(call);
    case "overlap":
      return false;
    default: {
      const _exhaustive: never = entry.link;
      return _exhaustive;
    }
  }
}

/** Still running when the outcome time arrived. Derived from the end record and the outcome time. */
export function outlivedReply(call: ToolCallBundle, owned: OwnedProcess): boolean {
  switch (owned.end.kind) {
    case "alive_at_teardown":
      return true;
    case "exited":
    case "killed":
      return owned.end.t_us > outcomeTime(call);
    default: {
      const _exhaustive: never = owned.end;
      return _exhaustive;
    }
  }
}

// --- Unmatched --------------------------------------------------------------

const betweenWindowsSchema = z.strictObject({
  kind: z.literal("between_windows"),
  preceded_by: gapPredecessorSchema,
});
const bornBetweenWindowsSchema = z.strictObject({
  kind: z.literal("born_between_windows"),
  ancestor_pid: pidSchema,
  preceded_by: gapPredecessorSchema,
});
const orphanProcessReasonSchema = z.strictObject({ kind: z.literal("orphan_process") });
const unmatchedReasonSchema = z.discriminatedUnion("kind", [
  betweenWindowsSchema,
  bornBetweenWindowsSchema,
  orphanProcessReasonSchema,
]);
const unmatchedEventSchema = z.strictObject({
  event: eventSchema,
  reason: unmatchedReasonSchema,
});

export type BetweenWindows = Out<typeof betweenWindowsSchema>;
export type BornBetweenWindows = Out<typeof bornBetweenWindowsSchema>;
export type OrphanProcessReason = Out<typeof orphanProcessReasonSchema>;
export type UnmatchedReason = Out<typeof unmatchedReasonSchema>;
export type UnmatchedEvent = Out<typeof unmatchedEventSchema>;

// --- Run --------------------------------------------------------------------

export const CLOCK_TOLERANCE_US = 5_000;

const runTargetSchema = z.strictObject({
  name: z.string().min(1),
  source: targetSourceSchema,
  image_id: z.string().min(1),
  command: argvSchema,
});
const allowNetworkSchema = z.strictObject({ kind: z.literal("allow"), flows: z.array(proxyFlowSchema) });
const blockNetworkSchema = z.strictObject({ kind: z.literal("block") });
const runNetworkSchema = z.discriminatedUnion("kind", [allowNetworkSchema, blockNetworkSchema]);

// Whether the check passed is clockPassed. The boolean is max_violation_us <= 5ms.
const clockCheckSchema = z.strictObject({
  max_violation_us: durationSchema,
  responses_checked: z.int().nonnegative(),
});

export type RunTarget = Out<typeof runTargetSchema>;
export type AllowNetwork = Out<typeof allowNetworkSchema>;
export type BlockNetwork = Out<typeof blockNetworkSchema>;
export type RunNetwork = Out<typeof runNetworkSchema>;
export type ClockCheck = Out<typeof clockCheckSchema>;

export function clockPassed(check: ClockCheck): boolean {
  return check.max_violation_us <= CLOCK_TOLERANCE_US;
}

const runSchema = z
  .strictObject({
    run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    target: runTargetSchema,
    network: runNetworkSchema,
    canaries: z.array(canarySchema),
    timeline: z.array(timelineEntrySchema),
    clock_check: clockCheckSchema,
    processes: attributedProcessesSchema,
    startup: startupBundleSchema,
    tool_calls: z.array(toolCallBundleSchema),
    shutdown: shutdownBundleSchema,
    unmatched: z.array(unmatchedEventSchema),
  })
  .superRefine((run, ctx) => {
    const seenCalls = new Set<number>();
    for (const call of run.tool_calls) {
      if (seenCalls.has(call.call_id)) {
        ctx.addIssue({ code: "custom", message: `duplicate call_id ${String(call.call_id)}` });
      }
      seenCalls.add(call.call_id);
    }
    const outside = (tUs: number, startUs: number, durationUs: number): boolean =>
      tUs < startUs || tUs >= startUs + durationUs;
    const childOwner = (pid: number): ProcessOwner | null => {
      const process = run.processes[String(pid)];
      return process?.kind === "child" ? process.owner : null;
    };
    for (const call of run.tool_calls) {
      const startedByCall = (pid: number): boolean => {
        const owner = childOwner(pid);
        return owner?.kind === "call" && owner.call_id === call.call_id;
      };
      for (const entry of call.events) {
        if (entry.link.kind === "overlap") {
          if (outside(entry.event.t_us, call.sent_us, call.outcome.duration_us)) {
            ctx.addIssue({
              code: "custom",
              message: `event ${entry.event.event_id} is overlap but falls outside the call window`,
            });
          }
        } else if (!startedByCall(entry.link.ancestor_pid)) {
          ctx.addIssue({
            code: "custom",
            message: `event ${entry.event.event_id} is owned by pid ${String(entry.link.ancestor_pid)}, which call ${String(call.call_id)} did not start`,
          });
        }
      }
      for (const owned of call.owned_processes) {
        if (!startedByCall(owned.pid)) {
          ctx.addIssue({
            code: "custom",
            message: `owned process ${String(owned.pid)} was not started by call ${String(call.call_id)}`,
          });
        }
      }
    }
    for (const entry of run.startup.events) {
      if (outside(entry.event.t_us, run.startup.window.start_us, run.startup.window.duration_us)) {
        ctx.addIssue({
          code: "custom",
          message: `event ${entry.event.event_id} is outside the startup window`,
        });
      }
    }
    for (const entry of run.shutdown.events) {
      if (entry.link.kind === "phase") {
        if (outside(entry.event.t_us, run.shutdown.trigger.t_us, run.shutdown.duration_us)) {
          ctx.addIssue({
            code: "custom",
            message: `event ${entry.event.event_id} is phase but falls outside the shutdown window`,
          });
        }
      } else if (childOwner(entry.link.ancestor_pid)?.kind !== "shutdown") {
        ctx.addIssue({
          code: "custom",
          message: `event ${entry.event.event_id} is owned by pid ${String(entry.link.ancestor_pid)}, which shutdown did not start`,
        });
      }
    }
    const seenEvents = new Set<string>();
    const visit = (event: { event_id: string; pid: number }): void => {
      if (seenEvents.has(event.event_id)) {
        ctx.addIssue({ code: "custom", message: `event ${event.event_id} is in two bundles` });
      }
      seenEvents.add(event.event_id);
      if (!Object.hasOwn(run.processes, String(event.pid))) {
        ctx.addIssue({
          code: "custom",
          message: `event ${event.event_id} names pid ${String(event.pid)} which has no process`,
        });
      }
    };
    for (const entry of run.startup.events) visit(entry.event);
    for (const call of run.tool_calls) {
      for (const entry of call.events) visit(entry.event);
    }
    for (const entry of run.shutdown.events) visit(entry.event);
    for (const entry of run.unmatched) visit(entry.event);
  }, wellFormed);

export type Run = Out<typeof runSchema>;

/** Send-order position. It is the index in `run.tool_calls`, so a stored seq cannot disagree with it. */
export function toolCallSeq(run: Run, callId: CallId): number | null {
  const index = run.tool_calls.findIndex((call) => call.call_id === callId);
  return index === -1 ? null : index;
}

export function parseRun(text: string, source: string): Run {
  return parseWith(runSchema, decodeJson(text, source, null), source, null);
}

export function assertExactPlacement(events: readonly Event[], run: Run, source: string): number {
  const placed = new Set<string>();
  const visit = (event: Event): void => {
    if (placed.has(event.event_id)) {
      throw new BoundaryError(source, null, `event ${event.event_id} is in two bundles`);
    }
    placed.add(event.event_id);
  };
  for (const entry of run.startup.events) visit(entry.event);
  for (const call of run.tool_calls) {
    for (const entry of call.events) visit(entry.event);
  }
  for (const entry of run.shutdown.events) visit(entry.event);
  for (const entry of run.unmatched) visit(entry.event);

  const traced = new Set<string>();
  for (const event of events) {
    if (traced.has(event.event_id)) {
      throw new BoundaryError(source, null, `event ${event.event_id} appears twice in the trace`);
    }
    traced.add(event.event_id);
    if (!placed.has(event.event_id)) {
      throw new BoundaryError(source, null, `event ${event.event_id} is in none of the bundles`);
    }
  }
  for (const id of placed) {
    if (!traced.has(id)) {
      throw new BoundaryError(source, null, `event ${id} is not in the trace`);
    }
  }
  return placed.size;
}

// --- Findings ---------------------------------------------------------------

export const RULE_NAMES = [
  "spawned_process",
  "file_modified",
  "credential_access",
  "network_attempt",
  "late_code_load",
  "canary_exposed",
] as const;

const ruleNameSchema = z.enum(RULE_NAMES);
export type RuleName = Out<typeof ruleNameSchema>;

const pathSubjectSchema = z.strictObject({ kind: z.literal("path"), path: z.string() });
const peerSubjectSchema = z.strictObject({ kind: z.literal("peer"), peer: peerSchema });
const dnsNameSubjectSchema = z.strictObject({ kind: z.literal("dns_name"), name: z.string().min(1) });
const argvSubjectSchema = z.strictObject({ kind: z.literal("argv"), argv: z.array(z.string()) });
const flowSubjectSchema = z.strictObject({
  kind: z.literal("flow"),
  method: z.string().min(1),
  url: z.string(),
});
const findingSubjectSchema = z.discriminatedUnion("kind", [
  pathSubjectSchema,
  peerSubjectSchema,
  dnsNameSubjectSchema,
  argvSubjectSchema,
  flowSubjectSchema,
]);
const sourceHintSchema = z.strictObject({ file: z.string().min(1), line: z.int().positive() });
const claimCheckSchema = z.strictObject({
  interface_mentions: z.string().min(1).nullable(),
  annotation_conflict: z.enum(["readOnlyHint", "openWorldHint"]).nullable(),
});

export type PathSubject = Out<typeof pathSubjectSchema>;
export type PeerSubject = Out<typeof peerSubjectSchema>;
export type DnsNameSubject = Out<typeof dnsNameSubjectSchema>;
export type ArgvSubject = Out<typeof argvSubjectSchema>;
export type FlowSubject = Out<typeof flowSubjectSchema>;
export type FindingSubject = Out<typeof findingSubjectSchema>;
export type SourceHint = Out<typeof sourceHintSchema>;
export type ClaimCheck = Out<typeof claimCheckSchema>;
export type ConflictingAnnotation = NonNullable<ClaimCheck["annotation_conflict"]>;

const findingCommonShape = {
  rule: ruleNameSchema,
  evidence: nonemptyEventIdsSchema,
  subject: findingSubjectSchema,
  source_hints: z.array(sourceHintSchema),
};

const callFindingSchema = z.strictObject({
  kind: z.literal("call"),
  call_id: callIdSchema,
  ...findingCommonShape,
  claim_check: claimCheckSchema,
});
const startupFindingSchema = z.strictObject({ kind: z.literal("startup"), ...findingCommonShape });
const shutdownFindingSchema = z.strictObject({ kind: z.literal("shutdown"), ...findingCommonShape });
const unmatchedFindingSchema = z.strictObject({ kind: z.literal("unmatched"), ...findingCommonShape });
const findingSchema = z.discriminatedUnion("kind", [
  callFindingSchema,
  startupFindingSchema,
  shutdownFindingSchema,
  unmatchedFindingSchema,
]);
const findingsSchema = z.array(findingSchema);

export type CallFinding = Out<typeof callFindingSchema>;
export type StartupFinding = Out<typeof startupFindingSchema>;
export type ShutdownFinding = Out<typeof shutdownFindingSchema>;
export type UnmatchedFinding = Out<typeof unmatchedFindingSchema>;
export type Finding = Out<typeof findingSchema>;

type CitableLinks = ReadonlyMap<string, Link | null>;

function linksOf(entries: readonly { readonly event: Event; readonly link: Link }[]): CitableLinks {
  return new Map(entries.map((entry) => [entry.event.event_id, entry.link]));
}

function callLinks(run: Run, callId: CallId): CitableLinks | null {
  const call = run.tool_calls.find((item) => item.call_id === callId);
  return call === undefined ? null : linksOf(call.events);
}

function citableLinks(run: Run, finding: Finding): CitableLinks | null {
  switch (finding.kind) {
    case "startup":
      return linksOf(run.startup.events);
    case "call":
      return callLinks(run, finding.call_id);
    case "shutdown":
      return linksOf(run.shutdown.events);
    case "unmatched":
      return new Map(run.unmatched.map((entry) => [entry.event.event_id, null]));
    default: {
      const _exhaustive: never = finding;
      return _exhaustive;
    }
  }
}

function uncited(ids: readonly EventId[], citable: { has(id: string): boolean }): EventId[] {
  return ids.filter((id) => !citable.has(id));
}

/** Rejects a finding whose call is not in the run or whose evidence is outside its bundle. */
export function parseFindings(text: string, source: string, run: Run): readonly Finding[] {
  const findings = parseWith(findingsSchema, decodeJson(text, source, null), source, null);
  for (const [index, finding] of findings.entries()) {
    const citable = citableLinks(run, finding);
    if (citable === null) {
      throw new BoundaryError(source, null, `finding ${index} names a call that is not in the run`);
    }
    const outside = uncited(finding.evidence, citable);
    if (outside.length > 0) {
      throw new BoundaryError(source, null, `finding ${index} cites events outside its bundle: ${outside.join(", ")}`);
    }
  }
  return findings;
}

/** The strongest link among the finding's evidence. Unmatched events have no link, so the result is null. */
export function findingStrength(run: Run, finding: Finding): LinkStrength | null {
  if (finding.kind === "unmatched") return null;
  const citable = citableLinks(run, finding);
  const strong = finding.evidence.some((id) => {
    const link = citable?.get(id);
    return link != null && linkStrength(link) === "strong";
  });
  return strong ? "strong" : "weak";
}

// --- Static profile ---------------------------------------------------------

export const DESCRIPTION_LENGTH_LIMIT = 1_000;

const apiHintCategorySchema = z.enum([...RULE_NAMES, "platform"]);
const packageInfoSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().nullable(),
  ecosystem: ecosystemSchema,
  manifest_path: z.string().nullable(),
});
const dependencySchema = z.strictObject({ name: z.string().min(1), spec: z.string() });
const installScriptSchema = z.strictObject({
  hook: z.enum(["preinstall", "install", "postinstall"]),
  command: z.string(),
});
const apiHintSchema = z.strictObject({
  category: apiHintCategorySchema,
  file: z.string().min(1),
  line: z.int().positive(),
  pattern: z.string(),
  snippet: z.string(),
});
const sourceSiteSchema = z.strictObject({
  file: z.string().min(1),
  line: z.int().positive(),
  snippet: z.string(),
});
const toolSitesSchema = z.strictObject({
  tool: z.string(),
  sites: z.array(sourceSiteSchema),
});
const instructionPhraseFlagSchema = z.strictObject({
  kind: z.literal("instruction_phrase"),
  phrase: z.string().min(1),
});
const toolTextSchema = z.strictObject({
  tool: z.string(),
  escaped_description: z.string(),
  length: z.int().nonnegative(),
  flags: z.array(instructionPhraseFlagSchema),
});
const staticProfileSchema = z.strictObject({
  package: packageInfoSchema,
  dependencies: z.array(dependencySchema),
  install_scripts: z.array(installScriptSchema),
  api_hints: z.array(apiHintSchema),
  tool_sites: z.array(toolSitesSchema),
  tool_texts: z.array(toolTextSchema),
});

export type ApiHintCategory = Out<typeof apiHintCategorySchema>;
export type PackageInfo = Out<typeof packageInfoSchema>;
export type Dependency = Out<typeof dependencySchema>;
export type InstallScript = Out<typeof installScriptSchema>;
export type ApiHint = Out<typeof apiHintSchema>;
export type SourceSite = Out<typeof sourceSiteSchema>;
export type ToolSites = Out<typeof toolSitesSchema>;
export type InstructionPhraseFlag = Out<typeof instructionPhraseFlagSchema>;
export type ToolText = Out<typeof toolTextSchema>;
export type StaticProfile = Out<typeof staticProfileSchema>;

export function descriptionTooLong(text: ToolText): boolean {
  return text.length > DESCRIPTION_LENGTH_LIMIT;
}

export function parseStaticProfile(text: string, source: string): StaticProfile {
  return parseWith(staticProfileSchema, decodeJson(text, source, null), source, null);
}

// --- Judge ------------------------------------------------------------------

const judgeOpinionSchema = z.enum(["matches", "does_not_match", "unclear"]);
const mismatchSchema = z.strictObject({
  event_ids: nonemptyEventIdsSchema,
  explanation: z.string().min(1),
});
const judgeAnswerSchema = z.strictObject({
  opinion: judgeOpinionSchema,
  mismatches: z.array(mismatchSchema),
  summary: z.string().min(1),
});
const answerJudgmentSchema = z.strictObject({
  kind: z.literal("answer"),
  call_id: callIdSchema,
  model: z.string().min(1),
  answered_at_us: microsSchema,
  answer: judgeAnswerSchema,
});
const invalidJudgmentSchema = z.strictObject({
  kind: z.literal("invalid"),
  call_id: callIdSchema,
  model: z.string().min(1),
  answered_at_us: microsSchema,
  raw_text: z.string(),
  error: z.string(),
});
const judgmentSchema = z.discriminatedUnion("kind", [answerJudgmentSchema, invalidJudgmentSchema]);
const judgmentsSchema = z.array(judgmentSchema);

export type JudgeOpinion = Out<typeof judgeOpinionSchema>;
export type Mismatch = Out<typeof mismatchSchema>;
export type JudgeAnswer = Out<typeof judgeAnswerSchema>;
export type AnswerJudgment = Out<typeof answerJudgmentSchema>;
export type InvalidJudgment = Out<typeof invalidJudgmentSchema>;
export type Judgment = Out<typeof judgmentSchema>;

function answerCitations(answer: JudgeAnswer): EventId[] {
  return answer.mismatches.flatMap((mismatch) => [...mismatch.event_ids]);
}

/** Rejects a judgment for a call that is not in the run, a second judgment for one call, and an invented citation. */
export function parseJudgments(text: string, source: string, run: Run): readonly Judgment[] {
  const judgments = parseWith(judgmentsSchema, decodeJson(text, source, null), source, null);
  const judged = new Set<number>();
  for (const judgment of judgments) {
    const citable = callLinks(run, judgment.call_id);
    if (citable === null) {
      throw new BoundaryError(source, null, `judgment names call ${String(judgment.call_id)}, which is not in the run`);
    }
    if (judged.has(judgment.call_id)) {
      throw new BoundaryError(source, null, `call ${String(judgment.call_id)} has two judgments`);
    }
    judged.add(judgment.call_id);
    if (judgment.kind === "answer") {
      const invented = uncited(answerCitations(judgment.answer), citable);
      if (invented.length > 0) {
        throw new BoundaryError(
          source,
          null,
          `judgment for call ${String(judgment.call_id)} cites events outside the bundle: ${invented.join(", ")}`,
        );
      }
    }
  }
  return judgments;
}

export function parseJudgeAnswer(text: string, source: string, citable: ReadonlySet<EventId>): JudgeAnswer {
  const answer = parseWith(judgeAnswerSchema, decodeJson(text, source, null), source, null);
  const invented = uncited(answerCitations(answer), citable);
  if (invented.length > 0) {
    throw new BoundaryError(source, null, `cites events outside the bundle: ${invented.join(", ")}`);
  }
  return answer;
}
