import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertExactPlacement, parseFindings, parseRun, parseTarget, parseTranscript } from "./model.js";
import type { Target } from "./model.js";
import { attribute } from "./attribution.js";
import { applyRules } from "./rules.js";
import { traceTarget } from "./sandbox.js";
import { readSensors } from "./sensors/index.js";
import { profileSources } from "./static-profile.js";

function withWorkingSource(target: Target, targetPath: string): Target {
  if (target.source.kind !== "local") return target;
  const absolute = resolve(dirname(resolve(targetPath)), target.source.path);
  return {
    ...target,
    source: { kind: "local", ecosystem: target.source.ecosystem, path: relative(process.cwd(), absolute) },
  };
}

export async function detonateCommand(targetPath: string): Promise<string> {
  const absolute = resolve(targetPath);
  const text = readFileSync(absolute, "utf8");
  const target = withWorkingSource(parseTarget(text, absolute), absolute);
  const traced = await traceTarget(target);
  copyFileSync(absolute, join(traced.runDir, "target.toml"));
  const sensed = readSensors(traced.runDir, traced.envelope.network);
  const timeline = parseTranscript(readFileSync(traced.transcriptPath, "utf8"), traced.transcriptPath);
  const run = attribute({
    events: sensed.events,
    processes: sensed.processes,
    timeline,
    envelope: traced.envelope,
  });
  writeFileSync(traced.bundlesPath, JSON.stringify(run));
  const parsed = parseRun(readFileSync(traced.bundlesPath, "utf8"), traced.bundlesPath);
  assertExactPlacement(sensed.events, parsed, traced.bundlesPath);
  const profile = profileSources(traced.runDir);
  const findings = applyRules(parsed, profile);
  const findingsPath = join(traced.runDir, "findings.json");
  const findingsText = JSON.stringify(findings);
  writeFileSync(findingsPath, findingsText);
  parseFindings(findingsText, findingsPath, parsed);
  return traced.runDir;
}

export function reportCommand(runDir: string): void {
  void runDir;
  throw new Error("not implemented");
}

function fail(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const [command, arg, extra] = process.argv.slice(2);
  if (extra !== undefined || arg === undefined || (command !== "detonate" && command !== "report")) {
    process.stderr.write("usage: mcpdet detonate <target.toml>\n       mcpdet report <run-dir>\n");
    process.exit(1);
  }
  if (command === "report") {
    try {
      reportCommand(arg);
    } catch (error) {
      fail(error);
    }
  } else {
    detonateCommand(arg)
      .then((runDir) => {
        process.stdout.write(`${runDir}\n`);
      })
      .catch(fail);
  }
}
