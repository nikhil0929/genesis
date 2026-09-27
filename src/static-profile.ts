import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { parse as parseToml, TomlError } from "smol-toml";

import { BoundaryError, parseStaticProfile, parseToolsPage, parseTranscript } from "./model.js";
import type { ApiHintCategory, StaticProfile, ToolDefinition } from "./model.js";
import { rawPath } from "./run-dir.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Dependency = { name: string; spec: string };

type InstallHook = "preinstall" | "install" | "postinstall";

type Manifest = {
  name: string;
  version: string | null;
  ecosystem: "npm" | "pypi";
  manifest_path: string;
  dependencies: Dependency[];
  install_scripts: { hook: InstallHook; command: string }[];
};

type SourceLanguage = "python" | "node";

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;

const INSTRUCTION_PHRASES = ["ignore previous", "do not tell the user", "<IMPORTANT>"] as const;

const SKIP_DIRECTORIES = new Set(["node_modules", "site-packages", "__pycache__", ".git", ".venv", "venv"]);

const HINT_PATTERNS: readonly {
  category: ApiHintCategory;
  language: SourceLanguage | "any";
  pattern: RegExp;
}[] = [
  { category: "spawned_process", language: "python", pattern: /\bsubprocess\b/ },
  { category: "spawned_process", language: "python", pattern: /\bos\.system\b/ },
  { category: "spawned_process", language: "node", pattern: /\bchild_process\b/ },
  { category: "network_attempt", language: "python", pattern: /\brequests\b/ },
  { category: "network_attempt", language: "python", pattern: /\bhttpx\b/ },
  { category: "network_attempt", language: "python", pattern: /\burllib\b/ },
  { category: "network_attempt", language: "python", pattern: /\bsocket\b/ },
  { category: "network_attempt", language: "node", pattern: /\bfetch\(/ },
  { category: "network_attempt", language: "node", pattern: /\bhttp\.request\b/ },
  { category: "platform", language: "any", pattern: /\bsys\.platform\b/ },
  { category: "platform", language: "any", pattern: /\bprocess\.platform\b/ },
  { category: "platform", language: "any", pattern: /\bdarwin\b/ },
  { category: "platform", language: "any", pattern: /\bwin32\b/ },
];

function canonicalJson(value: Json): string {
  return `${encodeJson(value, 0)}\n`;
}

function encodeJson(value: Json, depth: number): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  const pad = " ".repeat((depth + 1) * 2);
  const close = " ".repeat(depth * 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${pad}${encodeJson(item, depth + 1)}`);
    return `[\n${items.join(",\n")}\n${close}]`;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  const items = keys.map((key) => {
    const field = value[key];
    if (field === undefined) throw new Error(`missing ${key}`);
    return `${pad}${JSON.stringify(key)}: ${encodeJson(field, depth + 1)}`;
  });
  return `{\n${items.join(",\n")}\n${close}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const child = value[key];
  return isRecord(child) ? child : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  if (value === null) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function parseJsonFile(path: string, source: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid json";
    throw new BoundaryError(source, null, detail);
  }
}

function dependenciesFrom(value: unknown): Dependency[] {
  if (value === undefined) return [];
  const specs = asRecord(value, "dependencies");
  const dependencies: Dependency[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    if (name.length === 0) continue;
    if (typeof spec === "string") dependencies.push({ name, spec });
    else if (typeof spec === "object" && spec !== null) dependencies.push({ name, spec: JSON.stringify(spec) });
  }
  return dependencies;
}

function installScriptsFrom(value: unknown): { hook: InstallHook; command: string }[] {
  if (value === undefined) return [];
  const scripts = asRecord(value, "scripts");
  const hooks: { hook: InstallHook; command: string }[] = [];
  for (const hook of INSTALL_HOOKS) {
    const command = scripts[hook];
    if (typeof command === "string") hooks.push({ hook, command });
  }
  return hooks;
}

function readPackageJson(path: string): Manifest {
  const manifest = asRecord(parseJsonFile(path, "raw/source/package.json"), "package.json");
  const name = stringField(manifest, "name");
  if (name === null || name.length === 0) throw new Error("package.json has no name");
  return {
    name,
    version: stringField(manifest, "version"),
    ecosystem: "npm",
    manifest_path: "raw/source/package.json",
    dependencies: dependenciesFrom(manifest.dependencies),
    install_scripts: installScriptsFrom(manifest.scripts),
  };
}

function parseTomlFile(path: string): unknown {
  try {
    return parseToml(readFileSync(path, "utf8"));
  } catch (error) {
    const line = error instanceof TomlError ? error.line : null;
    const detail = error instanceof Error ? error.message : "invalid toml";
    throw new BoundaryError("raw/source/pyproject.toml", line, detail);
  }
}

function pep508(requirement: string): Dependency {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$/.exec(requirement.trim());
  const name = match?.[1] ?? "";
  const spec = (match?.[2] ?? "").trim();
  if (name.length === 0) return { name: requirement.trim(), spec: "" };
  return { name, spec };
}

function pepDependencies(value: unknown): Dependency[] {
  if (!Array.isArray(value)) throw new Error("project.dependencies is not an array");
  const dependencies: Dependency[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) continue;
    const dependency = pep508(entry);
    if (dependency.name.length > 0) dependencies.push(dependency);
  }
  return dependencies;
}

function poetryDependencies(value: unknown): Dependency[] {
  if (value === undefined) return [];
  const specs = asRecord(value, "tool.poetry.dependencies");
  const dependencies: Dependency[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    if (name.length === 0) continue;
    if (typeof spec === "string") {
      dependencies.push({ name, spec });
      continue;
    }
    if (isRecord(spec)) {
      const version = spec.version;
      dependencies.push({ name, spec: typeof version === "string" ? version : JSON.stringify(spec) });
    }
  }
  return dependencies;
}

function readPyproject(path: string): Manifest {
  const doc = asRecord(parseTomlFile(path), "pyproject.toml");
  const project = objectField(doc, "project");
  const tool = objectField(doc, "tool");
  const poetry = tool === null ? null : objectField(tool, "poetry");
  const name = stringField(project, "name") ?? stringField(poetry, "name");
  if (name === null || name.length === 0) throw new Error("pyproject.toml has no package name");
  const dependencies =
    project !== null && project.dependencies !== undefined
      ? pepDependencies(project.dependencies)
      : poetryDependencies(poetry === null ? undefined : poetry.dependencies);
  return {
    name,
    version: stringField(project, "version") ?? stringField(poetry, "version"),
    ecosystem: "pypi",
    manifest_path: "raw/source/pyproject.toml",
    dependencies,
    install_scripts: [],
  };
}

// An npm package can vendor a pyproject.toml. Install scripts live only in package.json.
function readManifest(sourceRoot: string): Manifest {
  const packageJson = join(sourceRoot, "package.json");
  const pyproject = join(sourceRoot, "pyproject.toml");
  if (existsSync(packageJson)) return readPackageJson(packageJson);
  if (existsSync(pyproject)) return readPyproject(pyproject);
  throw new Error("raw/source/ has no package.json or pyproject.toml");
}

function idKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function advertisedTools(runDir: string): readonly ToolDefinition[] {
  const source = rawPath(runDir, "transcript.jsonl");
  const timeline = parseTranscript(readFileSync(source, "utf8"), source);
  const listIds = new Set<string>();
  for (const entry of timeline) {
    if (entry.kind !== "message" || entry.rpc.kind !== "request" || entry.rpc.method !== "tools/list") continue;
    listIds.add(idKey(entry.rpc.id));
  }
  const tools: ToolDefinition[] = [];
  for (const entry of timeline) {
    if (entry.kind !== "message" || entry.direction !== "from_server" || entry.rpc.kind !== "result") continue;
    if (!listIds.has(idKey(entry.rpc.id))) continue;
    tools.push(...parseToolsPage(entry.raw, source).tools);
  }
  return tools;
}

function collectFiles(directory: string, files: string[]): void {
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

export function pruneUnscanned(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (SKIP_DIRECTORIES.has(entry.name)) rmSync(path, { recursive: true, force: true });
    else pruneUnscanned(path);
  }
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function sourceFiles(sourceRoot: string): string[] {
  const files: string[] = [];
  collectFiles(sourceRoot, files);
  files.sort((left, right) => {
    const a = posixRelative(sourceRoot, left);
    const b = posixRelative(sourceRoot, right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  return files;
}

function languageOf(path: string): SourceLanguage | null {
  switch (extname(path)) {
    case ".py":
      return "python";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".mts":
    case ".cts":
    case ".jsx":
    case ".tsx":
      return "node";
    default:
      return null;
  }
}

function sourceLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").map((line) => line.replace(/\r$/, ""));
}

function hasStringLiteral(line: string, name: string): boolean {
  return line.includes(`"${name}"`) || line.includes(`'${name}'`) || line.includes("`" + name + "`");
}

// Length counts UTF-16 code units. A surrogate pair is two \u escapes.
function escapeDescription(raw: string): string {
  let escaped = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const char = raw[index] ?? "";
    if (code === 0x5c) escaped += "\\\\";
    else if (code >= 0x20 && code <= 0x7e) escaped += char;
    else escaped += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return escaped;
}

function instructionFlags(description: string): { kind: "instruction_phrase"; phrase: string }[] {
  const haystack = description.toLowerCase();
  return INSTRUCTION_PHRASES.filter((phrase) => haystack.includes(phrase.toLowerCase())).map((phrase) => ({
    kind: "instruction_phrase",
    phrase,
  }));
}

function scanSource(
  sourceRoot: string,
  tools: readonly ToolDefinition[],
): { api_hints: Json[]; tool_sites: Json[] } {
  const files = sourceFiles(sourceRoot);
  const apiHints: Json[] = [];
  const sites = tools.map((tool) => ({ tool: tool.name, sites: [] as Json[] }));
  for (const path of files) {
    const language = languageOf(path);
    if (language === null) continue;
    const file = posixRelative(sourceRoot, path);
    const lines = sourceLines(path);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const lineNumber = index + 1;
      for (const hint of HINT_PATTERNS) {
        if (hint.language !== "any" && hint.language !== language) continue;
        if (!hint.pattern.test(line)) continue;
        apiHints.push({
          category: hint.category,
          file,
          line: lineNumber,
          pattern: hint.pattern.source,
          snippet: line,
        });
      }
      for (const entry of sites) {
        if (!hasStringLiteral(line, entry.tool)) continue;
        entry.sites.push({ file, line: lineNumber, snippet: line });
      }
    }
  }
  return { api_hints: apiHints, tool_sites: sites };
}

export function profileSources(runDir: string): StaticProfile {
  const sourceRoot = rawPath(runDir, "source");
  if (!existsSync(sourceRoot)) throw new Error("raw/source/ is missing");
  const manifest = readManifest(sourceRoot);
  const tools = advertisedTools(runDir);
  const scanned = scanSource(sourceRoot, tools);
  const toolTexts: Json[] = tools.map((tool) => {
    const description = tool.description ?? "";
    const escaped = escapeDescription(description);
    return {
      tool: tool.name,
      escaped_description: escaped,
      length: escaped.length,
      flags: instructionFlags(description),
    };
  });
  const profile: Json = {
    package: {
      name: manifest.name,
      version: manifest.version,
      ecosystem: manifest.ecosystem,
      manifest_path: manifest.manifest_path,
    },
    dependencies: manifest.dependencies,
    install_scripts: manifest.install_scripts,
    api_hints: scanned.api_hints,
    tool_sites: scanned.tool_sites,
    tool_texts: toolTexts,
  };
  return parseStaticProfile(canonicalJson(profile), "static profile");
}
