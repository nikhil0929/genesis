import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

const usage = spawnSync(process.execPath, ["dist/src/app/cli.js"], { cwd: root, encoding: "utf8" });
assert.equal(usage.status, 1);
assert.equal(
  usage.stderr,
  "usage: mcpdet detonate <target.toml> [--no-judge]\n       mcpdet report <run-dir> [--rejudge]\n",
);
