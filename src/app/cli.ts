import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { publishRun } from "../engine/report.js";
import { rawPath } from "../engine/run-dir.js";
import { traceTarget } from "../engine/sandbox.js";
import { parseTarget } from "../model.js";
import type { Target } from "../model.js";

type Command =
  | { readonly kind: "detonate"; readonly targetPath: string; readonly mode: "skip" | "if_absent" }
  | { readonly kind: "report"; readonly runDir: string; readonly mode: "if_absent" | "again" };

function withWorkingSource(target: Target, targetPath: string): Target {
  if (target.source.kind !== "local") return target;
  const absolute = resolve(dirname(resolve(targetPath)), target.source.path);
  return {
    ...target,
    source: { kind: "local", ecosystem: target.source.ecosystem, path: relative(process.cwd(), absolute) },
  };
}

export function parseCommand(argv: readonly string[]): Command {
  const [command, path, flag, extra] = argv;
  if (extra !== undefined || path === undefined) throw new Error("usage");
  switch (command) {
    case "detonate":
      if (flag === undefined) return { kind: "detonate", targetPath: path, mode: "if_absent" };
      if (flag === "--no-judge") return { kind: "detonate", targetPath: path, mode: "skip" };
      throw new Error("usage");
    case "report":
      if (flag === undefined) return { kind: "report", runDir: path, mode: "if_absent" };
      if (flag === "--rejudge") return { kind: "report", runDir: path, mode: "again" };
      throw new Error("usage");
    default:
      throw new Error("usage");
  }
}

export async function detonateCommand(targetPath: string, mode: "skip" | "if_absent"): Promise<string> {
  const absolute = resolve(targetPath);
  const text = readFileSync(absolute, "utf8");
  const target = withWorkingSource(parseTarget(text, absolute), absolute);
  const traced = await traceTarget(target);
  copyFileSync(absolute, rawPath(traced.runDir, "target.toml"));
  await publishRun(traced.runDir, mode);
  return traced.runDir;
}

export async function reportCommand(runDir: string, mode: "if_absent" | "again"): Promise<void> {
  await publishRun(resolve(runDir), mode);
}

function fail(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  let command: Command;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "usage: mcpdet detonate <target.toml> [--no-judge]\n       mcpdet report <run-dir> [--rejudge]\n",
    );
    process.exit(1);
  }
  switch (command.kind) {
    case "detonate":
      detonateCommand(command.targetPath, command.mode)
        .then((runDir) => {
          process.stdout.write(`${runDir}\n`);
        })
        .catch(fail);
      break;
    case "report":
      reportCommand(command.runDir, command.mode).catch(fail);
      break;
    default: {
      const unreachable: never = command;
      fail(unreachable);
    }
  }
}
