import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";

import { BoundaryError, parseCanaries, parseFlows, parseTarget } from "../model.js";
import type { Target, TargetSource } from "../model.js";
import { rawPath } from "./run-dir.js";
import type { RunEnvelope } from "./sandbox.js";

const hostSealSchema = z.strictObject({
  image_id: z.string().min(1),
  source_path: z.string().min(1).refine((path) => !path.startsWith("/"), "source_path is relative"),
});

export type HostSeal = {
  readonly image_id: string;
  readonly source_path: string;
};

export function sealSourcePath(source: TargetSource): string {
  switch (source.kind) {
    case "local":
      return source.path;
    case "registry":
      return ["registry", source.ecosystem, source.package, source.version].join("/");
    default: {
      const unreachable: never = source;
      throw new Error(String(unreachable));
    }
  }
}

function envelopeSource(target: Target, seal: HostSeal): TargetSource {
  switch (target.source.kind) {
    case "local":
      return {
        kind: "local",
        ecosystem: target.source.ecosystem,
        path: seal.source_path,
      };
    case "registry": {
      const expected = sealSourcePath(target.source);
      if (seal.source_path !== expected) {
        throw new Error(`host seal source_path ${seal.source_path} does not match ${expected}`);
      }
      return target.source;
    }
    default: {
      const unreachable: never = target.source;
      throw new Error(String(unreachable));
    }
  }
}

export function writeHostSeal(runDir: string, seal: HostSeal): void {
  const text = JSON.stringify({ image_id: seal.image_id, source_path: seal.source_path });
  const temporary = rawPath(runDir, `.host.json.${process.pid}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, rawPath(runDir, "host.json"));
}

function readHostSeal(runDir: string): HostSeal {
  const source = rawPath(runDir, "host.json");
  const text = readFileSync(source, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BoundaryError(source, null, detail);
  }
  const parsed = hostSealSchema.safeParse(value);
  if (!parsed.success) throw new BoundaryError(source, null, z.prettifyError(parsed.error));
  return { image_id: parsed.data.image_id, source_path: parsed.data.source_path };
}

export function readEnvelope(runDir: string): RunEnvelope {
  const directory = resolve(runDir);
  const seal = readHostSeal(directory);
  const targetPath = rawPath(directory, "target.toml");
  const target = parseTarget(readFileSync(targetPath, "utf8"), targetPath);
  const source = envelopeSource(target, seal);
  const canariesPath = rawPath(directory, "canaries.json");
  let network: RunEnvelope["network"];
  switch (target.network) {
    case "allow": {
      const flowsPath = rawPath(directory, "proxy", "flows.jsonl");
      network = { kind: "allow", flows: parseFlows(readFileSync(flowsPath, "utf8"), flowsPath) };
      break;
    }
    case "block":
      network = { kind: "block" };
      break;
    default: {
      const unreachable: never = target.network;
      throw new Error(String(unreachable));
    }
  }
  return {
    runId: basename(directory),
    target: {
      name: target.name,
      source,
      image_id: seal.image_id,
      command: target.command,
    },
    network,
    canaries: parseCanaries(readFileSync(canariesPath, "utf8"), canariesPath),
    scenario: target.scenario,
  };
}
