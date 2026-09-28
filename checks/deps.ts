import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { runIdSchema, targetSchema } from "../src/model.js";

const require = createRequire(import.meta.url);

const packages = [
  "@aws-sdk/client-s3",
  "@aws-sdk/lib-storage",
  "@fastify/type-provider-zod",
  "drizzle-kit",
  "drizzle-orm",
  "fastify",
  "pg",
] as const;

for (const name of packages) {
  const resolved = require.resolve(name);
  assert.equal(resolved.includes(`/node_modules/${name}/`), true, name);
}

const id = "01234567-89ab-cdef-0123-456789abcdef";
assert.equal(runIdSchema.parse(id), id);
assert.equal(runIdSchema.safeParse("").success, false);
assert.equal(runIdSchema.safeParse("01234567-89AB-CDEF-0123-456789ABCDEF").success, false);
assert.deepEqual(Object.keys(targetSchema.shape).sort(), [
  "base_image",
  "command",
  "env",
  "install",
  "name",
  "network",
  "scenario",
  "setup",
  "source",
  "source_path",
]);
