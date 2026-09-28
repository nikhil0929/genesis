import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  CALL_TIMEOUT_MS,
  CLIENT_NAME,
  PROTOCOL_VERSION,
  SETTLE_MS,
  SHUTDOWN_WAIT_MS,
  parseCanaries,
  parseFlows,
  parsePlan,
} from "../model.js";
import type { Canary, ProxyFlow, RegistrySource, RunNetwork, RunTarget, ScenarioEntry, Target } from "../model.js";
import { sealSourcePath, writeHostSeal } from "./host-seal.js";
import { rawPath } from "./run-dir.js";
import { pruneUnscanned } from "./static-profile.js";

export type RunEnvelope = {
  readonly runId: string;
  readonly target: RunTarget;
  readonly network: RunNetwork;
  readonly canaries: readonly Canary[];
  readonly scenario: readonly ScenarioEntry[];
};

export type TracedRun = {
  readonly runDir: string;
  readonly envelope: RunEnvelope;
};

type ProxyCa = {
  readonly dir: string;
  readonly certPem: string;
};

type AllowProxy = {
  readonly url: string;
  readonly certInContainer: "/opt/mcpdet/ca.pem";
};

type Attachment = { readonly kind: "block" } | { readonly kind: "allow"; readonly internalName: string };

const BUILD_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 180_000;
const PROXY_IMAGE = "mitmproxy/mitmproxy";
const PROXY_LOG = "/tmp/mcpdet-flows.jsonl";
const CERT_IN_CONTAINER = "/opt/mcpdet/ca.pem" as const;
const RESOLVER_TEXT = "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n";

const DECOY_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

const DECOY_FILES = [
  { name: "aws_credentials", path: "/home/detonee/.aws/credentials" },
  { name: "ssh_key", path: "/home/detonee/.ssh/id_ed25519" },
  { name: "gh_hosts", path: "/home/detonee/.config/gh/hosts.yml" },
  { name: "npmrc", path: "/home/detonee/.npmrc" },
  { name: "netrc", path: "/home/detonee/.netrc" },
  { name: "docker_config", path: "/home/detonee/.docker/config.json" },
  { name: "kube_config", path: "/home/detonee/.kube/config" },
  { name: "work_env", path: "/work/.env" },
] as const;

const PROXY_URL_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;
const PROXY_CA_KEYS = ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"] as const;

function docker(args: readonly string[], timeoutMs: number, killName?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (killName !== undefined) spawn("docker", ["kill", killName]);
      child.kill("SIGKILL");
      reject(new Error(`docker ${args[0] ?? "command"} timed out after ${String(timeoutMs)}ms\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`docker ${args.join(" ")} exited ${String(code)}\n${stderr || stdout}`));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "-f", name], 30_000).catch(() => undefined);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.isSymbolicLink()) continue;
    const source = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, dest);
    else if (entry.isFile()) copyFileSync(source, dest);
  }
}

function certificateBlock(pem: string): string | null {
  const match = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem);
  return match?.[0] ?? null;
}

function mintCaPem(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpdet-ca-"));
  try {
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "3650",
        "-subj",
        "/CN=mcpdet",
        "-addext",
        "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`openssl CA generation failed\n${result.stderr}`);
    return `${readFileSync(certPath, "utf8").trim()}\n${readFileSync(keyPath, "utf8").trim()}\n`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ensureProxyCa(): ProxyCa {
  const root = join(homedir(), ".mcpdet");
  const dir = join(root, "ca");
  mkdirSync(dir, { recursive: true });
  chmodSync(root, 0o755);
  chmodSync(dir, 0o755);
  const pemPath = join(dir, "mitmproxy-ca.pem");
  if (!existsSync(pemPath)) {
    const combined = mintCaPem();
    try {
      const fd = openSync(pemPath, "wx", 0o644);
      try {
        writeSync(fd, combined);
      } catch (error) {
        closeSync(fd);
        rmSync(pemPath, { force: true });
        throw error;
      }
      closeSync(fd);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  chmodSync(pemPath, 0o644);
  const certPem = certificateBlock(readFileSync(pemPath, "utf8"));
  if (certPem === null) throw new Error(`proxy CA has no certificate block: ${pemPath}`);
  return { dir, certPem };
}

function sealCanaries(runDir: string): readonly Canary[] {
  const canaries: Canary[] = [];
  for (const variable of DECOY_ENV) {
    canaries.push({
      name: variable.toLowerCase(),
      placement: { kind: "env", variable },
      value: randomBytes(16).toString("hex"),
    });
  }
  for (const file of DECOY_FILES) {
    canaries.push({
      name: file.name,
      placement: { kind: "file", path: file.path },
      value: randomBytes(16).toString("hex"),
    });
  }
  const path = rawPath(runDir, "canaries.json");
  const text = `${JSON.stringify(canaries)}\n`;
  writeFileSync(path, text, { mode: 0o644 });
  chmodSync(path, 0o644);
  return parseCanaries(text, path);
}

function stageDecoys(canaries: readonly Canary[]): string {
  const root = mkdtempSync(join(tmpdir(), "mcpdet-decoy-"));
  for (const canary of canaries) {
    switch (canary.placement.kind) {
      case "env":
        break;
      case "file": {
        const dest = join(root, canary.placement.path.slice(1));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, `${canary.value}\n`, { mode: 0o644 });
        chmodSync(dest, 0o644);
        break;
      }
      default: {
        const unreachable: never = canary.placement;
        throw new Error(String(unreachable));
      }
    }
  }
  return root;
}

function serverEnv(target: Target, canaries: readonly Canary[], proxy: AllowProxy | null): Record<string, string> {
  const env: Record<string, string> = { ...target.env };
  if (target.source.ecosystem === "npm") env.UV_USE_IO_URING = "0";
  for (const canary of canaries) {
    if (canary.placement.kind === "env") env[canary.placement.variable] = canary.value;
  }
  if (proxy === null) {
    for (const key of PROXY_URL_KEYS) delete env[key];
    for (const key of PROXY_CA_KEYS) delete env[key];
  } else {
    for (const key of PROXY_URL_KEYS) env[key] = proxy.url;
    for (const key of PROXY_CA_KEYS) env[key] = proxy.certInContainer;
    if (target.source.ecosystem === "npm") env.NODE_USE_ENV_PROXY = "1";
  }
  for (const canary of canaries) {
    if (canary.placement.kind === "env" && env[canary.placement.variable] !== canary.value) {
      throw new Error(`canary ${canary.placement.variable} was overwritten`);
    }
  }
  return env;
}

type ArchiveDigest =
  | { readonly algorithm: "sha256"; readonly hex: string }
  | { readonly algorithm: "sha512"; readonly base64: string };

type Archive = {
  readonly bytes: Buffer;
  readonly digest: ArchiveDigest;
};

type ArchiveEntry = {
  readonly name: string;
  readonly link: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero === -1 ? slice.length : zero).toString("utf8");
}

function parseOctal(buffer: Buffer, start: number, length: number): number {
  const text = readCString(buffer, start, length).trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error("tar octal field is out of range");
  return value;
}

function isZeroBlock(header: Buffer): boolean {
  for (const byte of header) {
    if (byte !== 0) return false;
  }
  return true;
}

function assertChecksum(header: Buffer): void {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    const byte = header[index] ?? 0;
    sum += index >= 148 && index < 156 ? 0x20 : byte;
  }
  const stored = parseOctal(header, 148, 8);
  if (sum !== stored) throw new Error(`tar checksum mismatch: ${String(sum)} !== ${String(stored)}`);
}

function readTarSize(header: Buffer): number {
  const first = header[124] ?? 0;
  if ((first & 0x80) === 0) return parseOctal(header, 124, 12);
  let value = first & 0x7f;
  for (let index = 125; index < 136; index += 1) value = value * 256 + (header[index] ?? 0);
  if (!Number.isSafeInteger(value)) throw new Error("tar entry is too large");
  return value;
}

function headerPath(header: Buffer): string {
  const name = readCString(header, 0, 100);
  const magic = header.subarray(257, 262).toString("utf8");
  const prefix = magic === "ustar" ? readCString(header, 345, 155) : "";
  return prefix.length === 0 ? name : `${prefix}/${name}`;
}

function parsePax(body: Buffer): ReadonlyMap<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    if (body[offset] === 0) break;
    const space = body.indexOf(0x20, offset);
    if (space === -1) throw new Error("pax header is missing a length");
    const length = Number(body.subarray(offset, space).toString("utf8"));
    if (!Number.isInteger(length) || length <= 0 || offset + length > body.length) {
      throw new Error("pax header length is invalid");
    }
    const record = body.subarray(offset, offset + length);
    const equals = record.indexOf(0x3d);
    if (equals === -1 || record[record.length - 1] !== 0x0a) throw new Error("pax record is malformed");
    const key = record.subarray(space - offset + 1, equals).toString("utf8");
    const value = record.subarray(equals + 1, record.length - 1).toString("utf8");
    records.set(key, value);
    offset += length;
  }
  return records;
}

function listArchiveEntries(bytes: Buffer): readonly ArchiveEntry[] {
  const raw = gunzipSync(bytes);
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let pendingName: string | null = null;
  let pendingLink: string | null = null;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    offset += 512;
    if (isZeroBlock(header)) break;
    assertChecksum(header);
    const size = readTarSize(header);
    const dataEnd = offset + size;
    const padded = offset + Math.ceil(size / 512) * 512;
    if (padded > raw.length) throw new Error("tar entry extends past the archive");
    const body = raw.subarray(offset, dataEnd);
    offset = padded;
    const typeByte = header[156] ?? 0;
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    if (type === "g") continue;
    if (type === "x") {
      const records = parsePax(body);
      pendingName = records.get("path") ?? pendingName;
      pendingLink = records.get("linkpath") ?? pendingLink;
      continue;
    }
    if (type === "L") {
      pendingName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "K") {
      pendingLink = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    const name = pendingName ?? headerPath(header);
    const link = type === "1" || type === "2" ? (pendingLink ?? readCString(header, 157, 100)) : null;
    pendingName = null;
    pendingLink = null;
    entries.push({ name, link });
  }
  return entries;
}

function entryEscapes(name: string): boolean {
  if (name.length === 0 || name.includes("\0") || name.includes("\n")) return true;
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[/\\]/).some((part) => part === "..");
}

function refuseArchiveEntries(entries: readonly ArchiveEntry[]): void {
  for (const entry of entries) {
    if (entryEscapes(entry.name) || (entry.link !== null && entryEscapes(entry.link))) {
      throw new Error(`archive entry escapes the destination: ${entry.name}`);
    }
  }
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned ${String(response.status)}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned ${String(response.status)}`);
  const body: unknown = await response.json();
  return body;
}

function pypiSdist(document: unknown, pkg: string, version: string): { url: string; sha256: string } {
  if (!isRecord(document) || !Array.isArray(document.urls)) {
    throw new Error(`pypi ${pkg} ${version} has no urls`);
  }
  const sdists: { url: string; sha256: string }[] = [];
  for (const entry of document.urls) {
    if (!isRecord(entry) || entry.packagetype !== "sdist") continue;
    if (typeof entry.url !== "string" || !isRecord(entry.digests) || typeof entry.digests.sha256 !== "string") {
      throw new Error(`pypi ${pkg} ${version} sdist is missing a url or sha256`);
    }
    sdists.push({ url: entry.url, sha256: entry.digests.sha256 });
  }
  const only = sdists.length === 1 ? sdists[0] : undefined;
  if (only === undefined) throw new Error(`pypi ${pkg} ${version} has ${String(sdists.length)} sdists`);
  return only;
}

function npmDist(document: unknown, pkg: string, version: string): { url: string; integrity: string } {
  if (!isRecord(document) || !isRecord(document.dist)) throw new Error(`npm ${pkg} ${version} has no dist`);
  const tarball = document.dist.tarball;
  const integrity = document.dist.integrity;
  if (typeof tarball !== "string" || typeof integrity !== "string") {
    throw new Error(`npm ${pkg} ${version} dist is missing tarball or integrity`);
  }
  return { url: tarball, integrity };
}

function requireDigest(bytes: Buffer, digest: ArchiveDigest): void {
  switch (digest.algorithm) {
    case "sha256": {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== digest.hex) throw new Error(`sha256 mismatch: expected ${digest.hex}, got ${actual}`);
      return;
    }
    case "sha512": {
      const actual = createHash("sha512").update(bytes).digest();
      const expected = Buffer.from(digest.base64, "base64");
      if (expected.length !== actual.length || !actual.equals(expected)) throw new Error("sha512 mismatch");
      return;
    }
    default: {
      const unreachable: never = digest;
      throw new Error(String(unreachable));
    }
  }
}

async function fetchArchive(source: RegistrySource): Promise<Archive> {
  switch (source.ecosystem) {
    case "pypi": {
      const url = `https://pypi.org/pypi/${encodeURIComponent(source.package)}/${encodeURIComponent(source.version)}/json`;
      const pinned = pypiSdist(await fetchJson(url), source.package, source.version);
      const bytes = await download(pinned.url);
      const digest: ArchiveDigest = { algorithm: "sha256", hex: pinned.sha256 };
      requireDigest(bytes, digest);
      return { bytes, digest };
    }
    case "npm": {
      const url = `https://registry.npmjs.org/${encodeURIComponent(source.package)}/${encodeURIComponent(source.version)}`;
      const pinned = npmDist(await fetchJson(url), source.package, source.version);
      const prefix = "sha512-";
      if (!pinned.integrity.startsWith(prefix)) throw new Error(`npm integrity is not sha512 for ${source.package}`);
      const bytes = await download(pinned.url);
      const digest: ArchiveDigest = { algorithm: "sha512", base64: pinned.integrity.slice(prefix.length) };
      requireDigest(bytes, digest);
      return { bytes, digest };
    }
    default: {
      const unreachable: never = source.ecosystem;
      throw new Error(String(unreachable));
    }
  }
}

function extractArchive(archive: Archive, destination: string): void {
  const entries = listArchiveEntries(archive.bytes);
  refuseArchiveEntries(entries);
  mkdirSync(destination, { recursive: true });
  const packed = join(dirname(destination), "archive.tgz");
  writeFileSync(packed, archive.bytes);
  try {
    const listed = spawnSync("tar", ["-tzf", packed], { encoding: "utf8" });
    if (listed.status !== 0) throw new Error(`tar list failed\n${listed.stderr}`);
    refuseArchiveEntries(
      listed.stdout
        .split("\n")
        .filter((name) => name.length > 0)
        .map((name) => ({ name, link: null })),
    );
    const extracted = spawnSync("tar", ["-xzf", packed, "-C", destination, "--strip-components", "1"], {
      encoding: "utf8",
    });
    if (extracted.status !== 0) throw new Error(`tar extract failed\n${extracted.stderr}`);
  } finally {
    rmSync(packed, { force: true });
  }
  if (!existsSync(join(destination, "package.json")) && !existsSync(join(destination, "pyproject.toml"))) {
    throw new Error("archive root has neither package.json nor pyproject.toml");
  }
}

async function stageSource(target: Target, destination: string): Promise<void> {
  switch (target.source.kind) {
    case "local": {
      const sourceOnHost = resolve(process.cwd(), target.source.path);
      if (!existsSync(sourceOnHost)) throw new Error(`local source not found: ${sourceOnHost}`);
      copyTree(sourceOnHost, destination);
      return;
    }
    case "registry": {
      extractArchive(await fetchArchive(target.source), destination);
      return;
    }
    default: {
      const unreachable: never = target.source;
      throw new Error(String(unreachable));
    }
  }
}

// python:3.12-slim started the bookworm node binary, so this copy adds no apt package for node.
// Trixie's strace 6.13 exits on the driver's --seccomp-bpf -u pair, so strace comes from bookworm.
// Bookworm's strace is dynamically linked against libraries slim images lack, so every library ldd names travels with it.
// A library the target already has stays, because bookworm's libc over a newer target libc breaks every binary in the image.
function driverRuntime(): string {
  return `COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=mcpdet-bins /usr/bin/strace /usr/bin/strace
COPY --from=mcpdet-bins /mcpdet-strace-libs/ /opt/mcpdet/strace-libs/
RUN cd /opt/mcpdet/strace-libs && find . -type f | while read -r lib; do \\
      dest="$(printf %s "$lib" | cut -c2-)"; \\
      [ -e "$dest" ] || { mkdir -p "$(dirname "$dest")" && cp "$lib" "$dest"; }; \\
    done \\
 && rm -rf /opt/mcpdet/strace-libs`;
}

function dockerfile(target: Target): string {
  const installs = target.install.map((command) => `RUN ${command}`).join("\n");
  const setups = target.setup.map((command) => `RUN ${command}`).join("\n");
  return `FROM node:24-bookworm-slim AS mcpdet-bins
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends strace \\
 && rm -rf /var/lib/apt/lists/* \\
 && for lib in $(ldd /usr/bin/strace | grep -o '/[^ ]*'); do \\
      dir="$(readlink -f "$(dirname "$lib")")"; \\
      mkdir -p "/mcpdet-strace-libs$dir" && cp -L "$lib" "/mcpdet-strace-libs$dir/$(basename "$lib")"; \\
    done
FROM ${target.base_image}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd --create-home --shell /bin/bash detonee \\
 && mkdir -p /trace /work /opt/mcpdet \\
    /home/detonee/.aws /home/detonee/.ssh /home/detonee/.config/gh \\
    /home/detonee/.docker /home/detonee/.kube \\
 && chown -R detonee:detonee /home/detonee \\
 && chmod 700 /trace && chmod 755 /work /opt/mcpdet
${driverRuntime()}
COPY source/ ${target.source_path}/
COPY ca.pem /opt/mcpdet/ca.pem
WORKDIR ${target.source_path}
${installs}
RUN chmod -R a+rX ${target.source_path} /opt/mcpdet/ca.pem \\
 && cp /opt/mcpdet/ca.pem /usr/local/share/ca-certificates/mcpdet.crt \\
 && update-ca-certificates
${setups}
RUN chown -R detonee:detonee /work
COPY driver.js /opt/mcpdet/driver.js
WORKDIR /work
ENTRYPOINT ["node", "/opt/mcpdet/driver.js", "/plan.json"]
`;
}

function writePlan(context: string, target: Target, canaries: readonly Canary[], proxy: AllowProxy | null): string {
  const plan = {
    server_command: target.command,
    server_env: serverEnv(target, canaries, proxy),
    scenario: target.scenario,
    protocol_version: PROTOCOL_VERSION,
    client_name: CLIENT_NAME,
    call_timeout_ms: CALL_TIMEOUT_MS,
    settle_ms: SETTLE_MS,
    shutdown_wait_ms: SHUTDOWN_WAIT_MS,
  };
  const planPath = join(context, "plan.json");
  const planText = JSON.stringify(plan);
  parsePlan(planText, planPath);
  writeFileSync(planPath, planText);
  return planPath;
}

function proxyContainerName(runId: string): string {
  return `mcpdet-${runId}-proxy`;
}

function internalNetworkName(runId: string): string {
  return `mcpdet-${runId}-net`;
}

async function createTarget(image: string, container: string, resolvPath: string, attachment: Attachment): Promise<void> {
  const args = [
    "create",
    "--name",
    container,
    "--cap-add",
    "SYS_PTRACE",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--pids-limit",
    "512",
    "--mount",
    `type=bind,src=${resolvPath},dst=/etc/resolv.conf,readonly`,
  ];
  switch (attachment.kind) {
    case "block":
      args.push("--network", "none");
      break;
    case "allow":
      args.push("--network", attachment.internalName);
      break;
    default: {
      const unreachable: never = attachment;
      throw new Error(String(unreachable));
    }
  }
  args.push(image);
  await docker(args, 60_000);
}

async function copyDecoys(container: string, staging: string, canaries: readonly Canary[]): Promise<void> {
  for (const canary of canaries) {
    if (canary.placement.kind !== "file") continue;
    await docker(
      ["cp", join(staging, canary.placement.path.slice(1)), `${container}:${canary.placement.path}`],
      30_000,
    );
  }
}

async function installInto(container: string, planPath: string, staging: string, canaries: readonly Canary[]): Promise<void> {
  await docker(["cp", planPath, `${container}:/plan.json`], 30_000);
  await copyDecoys(container, staging, canaries);
}

async function runAndCopy(container: string, runDir: string): Promise<void> {
  let runError: Error | null = null;
  try {
    await docker(["start", "-a", container], RUN_TIMEOUT_MS, container);
  } catch (error) {
    runError = error instanceof Error ? error : new Error(String(error));
  }
  mkdirSync(rawPath(runDir, "trace"), { recursive: true });
  await docker(["cp", `${container}:/trace/.`, rawPath(runDir, "trace")], 60_000);
  await docker(["cp", `${container}:/transcript.jsonl`, rawPath(runDir, "transcript.jsonl")], 30_000);
  await docker(["cp", `${container}:/stderr.log`, rawPath(runDir, "stderr.log")], 30_000);
  if (runError !== null) throw runError;
}

async function waitForProxyLog(container: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let detail = "";
  while (Date.now() < deadline) {
    try {
      await docker(["exec", container, "test", "-f", PROXY_LOG], 10_000);
      return;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      await delay(500);
    }
  }
  const logs = await docker(["logs", container], 15_000).catch(() => ({ stdout: "", stderr: detail }));
  throw new Error(`proxy log was not created\n${logs.stderr}\n${logs.stdout}`);
}

async function startProxy(runId: string, ca: ProxyCa): Promise<{ readonly internalName: string; readonly proxy: AllowProxy }> {
  const internalName = internalNetworkName(runId);
  const container = proxyContainerName(runId);
  const addon = resolve(process.cwd(), "proxy/mcpdet_addon.py");
  if (!existsSync(addon)) throw new Error(`proxy addon is missing: ${addon}`);
  await docker(["network", "create", "--internal", internalName], 60_000);
  // The first network owns the default route. Bridge has to be first or example.com has no path out.
  await docker(
    [
      "create",
      "--name",
      container,
      "--network",
      "bridge",
      "--user",
      "root",
      "--mount",
      `type=bind,src=${ca.dir},dst=/home/mitmproxy/.mitmproxy`,
      "--mount",
      `type=bind,src=${addon},dst=/addon/mcpdet_addon.py,readonly`,
      PROXY_IMAGE,
      "mitmdump",
      "--listen-host",
      "0.0.0.0",
      "--listen-port",
      "8080",
      "--set",
      "confdir=/home/mitmproxy/.mitmproxy",
      // Eager CONNECT fails before the POST exists when the upstream name does not resolve.
      "--set",
      "connection_strategy=lazy",
      "-s",
      "/addon/mcpdet_addon.py",
    ],
    BUILD_TIMEOUT_MS,
  );
  await docker(["network", "connect", internalName, container], 30_000);
  await docker(["start", container], 60_000);
  await waitForProxyLog(container);
  const inspected = await docker(["inspect", "-f", "{{json .NetworkSettings.Networks}}", container], 30_000);
  const networks = JSON.parse(inspected.stdout) as Record<string, { IPAddress?: string }>;
  const address = networks[internalName]?.IPAddress;
  if (address === undefined || address.length === 0) throw new Error(`proxy has no address on ${internalName}`);
  return { internalName, proxy: { url: `http://${address}:8080`, certInContainer: CERT_IN_CONTAINER } };
}

async function sealFlows(runDir: string, proxyContainer: string): Promise<readonly ProxyFlow[]> {
  await docker(["stop", "-t", "10", proxyContainer], 30_000).catch(() => undefined);
  const destDir = rawPath(runDir, "proxy");
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "flows.jsonl");
  await docker(["cp", `${proxyContainer}:${PROXY_LOG}`, dest], 30_000);
  const flows = parseFlows(readFileSync(dest, "utf8"), dest);
  await removeContainer(proxyContainer);
  const suffix = "-proxy";
  if (proxyContainer.endsWith(suffix)) {
    await docker(["network", "rm", `${proxyContainer.slice(0, -suffix.length)}-net`], 30_000).catch(() => undefined);
  }
  return flows;
}

export async function traceTarget(target: Target): Promise<TracedRun> {
  if (target.source.kind === "local") {
    const sourceOnHost = resolve(process.cwd(), target.source.path);
    if (!existsSync(sourceOnHost)) throw new Error(`local source not found: ${sourceOnHost}`);
  }
  const runId = `${target.name}-${randomBytes(4).toString("hex")}`;
  const runDir = resolve(process.cwd(), "runs", runId);
  const driverJs = fileURLToPath(new URL("./driver.js", import.meta.url));
  if (!existsSync(driverJs)) throw new Error(`compiled driver is missing: ${driverJs}`);

  mkdirSync(rawPath(runDir), { recursive: true });
  const ca = ensureProxyCa();
  const canaries = sealCanaries(runDir);
  const staging = stageDecoys(canaries);

  const context = mkdtempSync(join(tmpdir(), "mcpdet-"));
  const image = `mcpdet-${runId}`;
  const container = `mcpdet-${runId}`;
  const sourceContainer = `${container}-source`;
  const proxyContainer = proxyContainerName(runId);
  let allowNetwork: string | null = null;
  try {
    await stageSource(target, join(context, "source"));
    copyFileSync(driverJs, join(context, "driver.js"));
    writeFileSync(join(context, "ca.pem"), `${ca.certPem}\n`);
    writeFileSync(join(context, "Dockerfile"), dockerfile(target));
    const iidPath = join(context, "image-id");
    await docker(["build", "--iidfile", iidPath, "-t", image, context], BUILD_TIMEOUT_MS);
    const imageId = readFileSync(iidPath, "utf8").trim();
    const resolvPath = join(context, "resolv.conf");
    writeFileSync(resolvPath, RESOLVER_TEXT);
    const sourceDir = rawPath(runDir, "source");
    mkdirSync(sourceDir, { recursive: true });
    await docker(["create", "--name", sourceContainer, image], 60_000);
    try {
      await docker(["cp", `${sourceContainer}:${target.source_path}/.`, sourceDir], 60_000);
    } finally {
      await removeContainer(sourceContainer);
    }
    pruneUnscanned(sourceDir);

    let network: RunNetwork;
    switch (target.network) {
      case "block": {
        const planPath = writePlan(context, target, canaries, null);
        await createTarget(image, container, resolvPath, { kind: "block" });
        await installInto(container, planPath, staging, canaries);
        await runAndCopy(container, runDir);
        network = { kind: "block" };
        break;
      }
      case "allow": {
        allowNetwork = internalNetworkName(runId);
        const started = await startProxy(runId, ca);
        const planPath = writePlan(context, target, canaries, started.proxy);
        await createTarget(image, container, resolvPath, { kind: "allow", internalName: started.internalName });
        await installInto(container, planPath, staging, canaries);
        await runAndCopy(container, runDir);
        network = { kind: "allow", flows: await sealFlows(runDir, proxyContainer) };
        break;
      }
      default: {
        const unreachable: never = target.network;
        throw new Error(String(unreachable));
      }
    }
    writeHostSeal(runDir, { image_id: imageId, source_path: sealSourcePath(target.source) });
    return {
      runDir,
      envelope: {
        runId,
        target: {
          name: target.name,
          source: target.source,
          image_id: imageId,
          command: target.command,
        },
        network,
        canaries,
        scenario: target.scenario,
      },
    };
  } finally {
    rmSync(context, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
    await removeContainer(container);
    await removeContainer(sourceContainer);
    await removeContainer(proxyContainer);
    if (allowNetwork !== null) await docker(["network", "rm", allowNetwork], 30_000).catch(() => undefined);
    await docker(["rmi", "-f", image], 60_000).catch(() => undefined);
  }
}
