import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

const engine = [
  "sandbox.ts",
  "driver.ts",
  "host-seal.ts",
  "run-dir.ts",
  "attribution.ts",
  "rules.ts",
  "static-profile.ts",
  "judge.ts",
  "report.ts",
  "sensors/index.ts",
];

for (const file of engine) {
  assert.equal(existsSync(join(root, "src", "engine", file)), true, `src/engine/${file} is missing`);
  assert.equal(existsSync(join(root, "src", file)), false, `src/${file} still exists`);
}
assert.equal(existsSync(join(root, "src", "app", "cli.ts")), true, "src/app/cli.ts is missing");
assert.equal(existsSync(join(root, "src", "cli.ts")), false, "src/cli.ts still exists");
assert.equal(existsSync(join(root, "src", "model.ts")), true, "src/model.ts moved");
assert.equal(existsSync(join(root, "dist", "src", "engine", "driver.js")), true, "driver.js is not beside sandbox.js");

const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.ok(typeof pkg === "object" && pkg !== null && "bin" in pkg && "exports" in pkg, "package.json lacks bin or exports");
assert.deepEqual(pkg.bin, { mcpdet: "dist/src/app/cli.js" });
assert.deepEqual(pkg.exports, { "./model": { types: "./dist/src/model.d.ts", default: "./dist/src/model.js" } });

const usageText = "usage: mcpdet detonate <target.toml> [--no-judge]\n       mcpdet report <run-dir> [--rejudge]\n";
const direct = spawnSync(process.execPath, ["dist/src/app/cli.js"], { cwd: root, encoding: "utf8" });
assert.equal(direct.status, 1);
assert.equal(direct.stderr, usageText);
const binDir = mkdtempSync(join(tmpdir(), "mcpdet-layout-"));
try {
  const link = join(binDir, "mcpdet");
  symlinkSync(join(root, "dist", "src", "app", "cli.js"), link);
  const linked = spawnSync(process.execPath, [link], { cwd: root, encoding: "utf8" });
  assert.equal(linked.status, 1, "CLI run through a bin symlink skipped its entry guard");
  assert.equal(linked.stderr, usageText);
} finally {
  rmSync(binDir, { recursive: true, force: true });
}

const cliUrl = pathToFileURL(join(root, "dist", "src", "app", "cli.js")).href;
const imported = spawnSync(
  process.execPath,
  ["--input-type=module", "-e", `await import(${JSON.stringify(cliUrl)});`, "not-a-path"],
  { cwd: root, encoding: "utf8" },
);
assert.equal(imported.status, 0, imported.stderr);
assert.equal(imported.stderr, "");
