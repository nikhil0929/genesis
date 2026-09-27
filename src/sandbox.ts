import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CALL_TIMEOUT_MS,
  CLIENT_NAME,
  PROTOCOL_VERSION,
  SETTLE_MS,
  SHUTDOWN_WAIT_MS,
  parsePlan,
} from "./model.js";
import type { Canary, RunNetwork, RunTarget, ScenarioEntry, Target } from "./model.js";

export type RunEnvelope = {
  readonly runId: string;
  readonly target: RunTarget;
  readonly network: RunNetwork;
  readonly canaries: readonly Canary[];
  readonly scenario: readonly ScenarioEntry[];
};

export type TracedRun = {
  readonly runDir: string;
  readonly transcriptPath: string;
  readonly bundlesPath: string;
  readonly envelope: RunEnvelope;
};

const BUILD_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 180_000;

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

async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "-f", name], 30_000).catch(() => undefined);
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

function dockerfile(target: Target): string {
  const installs = target.install.map((command) => `RUN ${command}`).join("\n");
  const setups = target.setup.map((command) => `RUN ${command}`).join("\n");
  return `FROM ${target.base_image}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends strace \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd --create-home --shell /bin/bash detonee \\
 && mkdir -p /trace /work /opt/mcpdet \\
 && chmod 700 /trace && chmod 755 /work
COPY source/ ${target.source_path}/
WORKDIR ${target.source_path}
${installs}
RUN chmod -R a+rX ${target.source_path}
${setups}
COPY driver.js /opt/mcpdet/driver.js
WORKDIR /work
ENTRYPOINT ["node", "/opt/mcpdet/driver.js", "/plan.json"]
`;
}

function serverEnv(target: Target): Record<string, string> {
  const env: Record<string, string> = { ...target.env };
  if (target.source.ecosystem === "npm" && env.UV_USE_IO_URING === undefined) env.UV_USE_IO_URING = "0";
  return env;
}

export async function traceTarget(target: Target): Promise<TracedRun> {
  switch (target.network) {
    case "block":
      break;
    case "allow":
      throw new Error("allow mode is not available");
    default: {
      const unreachable: never = target.network;
      throw new Error(unreachable);
    }
  }
  if (target.source.kind !== "local") throw new Error(`registry source is not supported for ${target.name}`);

  const runId = `${target.name}-${randomBytes(4).toString("hex")}`;
  const runDir = resolve(process.cwd(), "runs", runId);
  const sourceOnHost = resolve(process.cwd(), target.source.path);
  if (!existsSync(sourceOnHost)) throw new Error(`local source not found: ${sourceOnHost}`);
  const driverJs = fileURLToPath(new URL("./driver.js", import.meta.url));
  if (!existsSync(driverJs)) throw new Error(`compiled driver is missing: ${driverJs}`);

  mkdirSync(runDir, { recursive: true });
  const envelope: RunEnvelope = {
    runId,
    target: {
      name: target.name,
      source: target.source,
      image_id: "pending",
      command: target.command,
    },
    network: { kind: "block" },
    canaries: [],
    scenario: target.scenario,
  };
  const plan = {
    server_command: target.command,
    server_env: serverEnv(target),
    scenario: target.scenario,
    protocol_version: PROTOCOL_VERSION,
    client_name: CLIENT_NAME,
    call_timeout_ms: CALL_TIMEOUT_MS,
    settle_ms: SETTLE_MS,
    shutdown_wait_ms: SHUTDOWN_WAIT_MS,
  };
  const planPath = join(runDir, "plan.json");
  const planText = JSON.stringify(plan);
  parsePlan(planText, planPath);
  writeFileSync(planPath, planText);
  writeFileSync(join(runDir, "canaries.json"), "[]\n");

  const context = mkdtempSync(join(tmpdir(), "mcpdet-"));
  const image = `mcpdet-${runId}`;
  const container = `mcpdet-${runId}`;
  const sourceContainer = `${container}-source`;
  try {
    copyTree(sourceOnHost, join(context, "source"));
    copyFileSync(driverJs, join(context, "driver.js"));
    writeFileSync(join(context, "Dockerfile"), dockerfile(target));
    const iidPath = join(context, "image-id");
    await docker(["build", "--iidfile", iidPath, "-t", image, context], BUILD_TIMEOUT_MS);
    const imageId = readFileSync(iidPath, "utf8").trim();
    const built: RunEnvelope = { ...envelope, target: { ...envelope.target, image_id: imageId } };

    mkdirSync(join(runDir, "source"), { recursive: true });
    await docker(["create", "--name", sourceContainer, image], 60_000);
    try {
      await docker(["cp", `${sourceContainer}:${target.source_path}/.`, join(runDir, "source")], 60_000);
    } finally {
      await removeContainer(sourceContainer);
    }

    await docker(
      [
        "create",
        "--name",
        container,
        "--network",
        "none",
        "--cap-add",
        "SYS_PTRACE",
        "--cpus",
        "2",
        "--memory",
        "2g",
        "--pids-limit",
        "512",
        image,
      ],
      60_000,
    );
    let runError: Error | null = null;
    try {
      await docker(["cp", planPath, `${container}:/plan.json`], 30_000);
      try {
        await docker(["start", "-a", container], RUN_TIMEOUT_MS, container);
      } catch (error) {
        runError = error instanceof Error ? error : new Error(String(error));
      }
      mkdirSync(join(runDir, "trace"), { recursive: true });
      await docker(["cp", `${container}:/trace/.`, join(runDir, "trace")], 60_000);
      await docker(["cp", `${container}:/transcript.jsonl`, join(runDir, "transcript.jsonl")], 30_000);
      await docker(["cp", `${container}:/stderr.log`, join(runDir, "stderr.log")], 30_000);
    } finally {
      await removeContainer(container);
    }
    if (runError !== null) throw runError;
    return {
      runDir,
      transcriptPath: join(runDir, "transcript.jsonl"),
      bundlesPath: join(runDir, "bundles.json"),
      envelope: built,
    };
  } finally {
    rmSync(context, { recursive: true, force: true });
    await docker(["rmi", "-f", image], 60_000).catch(() => undefined);
  }
}
