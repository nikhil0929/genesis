import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseTarget } from "./model.js";
import type { Target } from "./model.js";
import { publishRun } from "./report.js";
import { traceTarget } from "./sandbox.js";

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
  publishRun(traced.runDir);
  return traced.runDir;
}

export function reportCommand(runDir: string): void {
  publishRun(resolve(runDir));
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
