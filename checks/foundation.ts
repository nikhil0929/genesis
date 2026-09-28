import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseRun } from "../src/model.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcpdet-foundation-"));
const targetPath = join(dir, "mcp-server-git.toml");
writeFileSync(
  targetPath,
  `name = "mcp-server-git"
base_image = "python:3.12-slim"
install = [
  "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git",
  "python -m pip install --no-cache-dir .",
]
source_path = "/opt/mcp-server-git"
command = ["python", "-m", "mcp_server_git"]
network = "block"

[source]
kind = "registry"
ecosystem = "pypi"
package = "mcp-server-git"
version = "2026.8.18"

[[scenario]]
tool = "git_status"

[scenario.arguments]
repo_path = "/work/repo"
`,
);

function sourcePath(value: unknown): string {
  if (typeof value !== "object" || value === null || !("source_path" in value) || typeof value.source_path !== "string") {
    throw new Error("host.json has no source_path");
  }
  return value.source_path;
}

try {
  const result = spawnSync(process.execPath, ["dist/src/app/cli.js", "detonate", targetPath, "--no-judge"], {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const runDir = result.stdout.trim().split("\n").at(-1) ?? "";
  assert.equal(existsSync(join(runDir, "raw", "source", "pyproject.toml")), true);
  const host: unknown = JSON.parse(readFileSync(join(runDir, "raw", "host.json"), "utf8"));
  assert.equal(sourcePath(host), "registry/pypi/mcp-server-git/2026.8.18");
  const bundlesPath = join(runDir, "bundles.json");
  const run = parseRun(readFileSync(bundlesPath, "utf8"), bundlesPath);
  switch (run.target.source.kind) {
    case "registry":
      assert.equal(run.target.source.package, "mcp-server-git");
      break;
    case "local":
      assert.fail("target.source.kind is local");
      break;
    default: {
      const unreachable: never = run.target.source;
      throw new Error(String(unreachable));
    }
  }
  const reportPath = join(runDir, "report.md");
  const before = readFileSync(reportPath);
  assert.equal(before.toString("utf8").split("\n").includes("judge not run"), true);
  const again = spawnSync(process.execPath, ["dist/src/app/cli.js", "report", runDir], {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
  });
  assert.equal(again.status, 0, again.stderr || again.stdout || again.error?.message);
  assert.equal(again.stdout, "");
  const after = readFileSync(reportPath);
  assert.ok(before.equals(after), "report.md bytes changed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
