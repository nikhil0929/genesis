import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";

import { parseCommand, scratchDir } from "../src/app/cli.js";
import { openDb } from "../src/app/db/client.js";
import { runs } from "../src/app/db/schema.js";
import { runIdSchema } from "../src/model.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const bucket = process.env.MCPDET_S3_BUCKET;
if (bucket === undefined || bucket.length === 0) throw new Error("MCPDET_S3_BUCKET is not set; the wire check needs S3");

assert.deepEqual(parseCommand(["serve"]), { kind: "serve" });
assert.throws(() => parseCommand(["serve", "extra"]), /usage/);

function localRuns(): readonly string[] {
  const dir = join(root, "runs");
  return existsSync(dir) ? readdirSync(dir) : [];
}

const before = new Set(localRuns());
const result = spawnSync(process.execPath, ["dist/src/app/cli.js", "detonate", "targets/detfix.toml", "--no-judge"], {
  cwd: root,
  encoding: "utf8",
  timeout: 900_000,
});
assert.equal(result.status, 0, result.stderr || result.stdout);
const id = result.stdout.trimEnd();
assert.equal(result.stdout, `${id}\n`, "detonate printed more than the run id");
runIdSchema.parse(id);

assert.equal(existsSync(scratchDir(id)), false, `scratch dir ${scratchDir(id)} is still on disk`);
assert.deepEqual(
  localRuns().filter((name) => !before.has(name)),
  [],
  "detonate left a new directory under runs/",
);

const endpoint = process.env.MCPDET_S3_ENDPOINT;
const client = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
  ...(endpoint === undefined || endpoint.length === 0 ? {} : { endpoint, forcePathStyle: true }),
});
try {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${id}/` }));
  const keys = (listed.Contents ?? []).map((object) => object.Key);
  assert.ok(keys.includes(`${id}/report.md`), `bucket ${bucket} has no ${id}/report.md: ${JSON.stringify(keys)}`);
  assert.ok(keys.includes(`${id}/bundles.json`), `bucket ${bucket} has no ${id}/bundles.json`);
} finally {
  client.destroy();
}

const handle = openDb();
try {
  const [row] = await handle.db.select().from(runs).where(eq(runs.id, id));
  assert.ok(row, `no runs row for ${id}`);
  assert.equal(row.status, "succeeded");
  assert.notEqual(row.endedAt, null);
} finally {
  await handle.close();
}

process.stdout.write("wire ok\n");
