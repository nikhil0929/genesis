import assert from "node:assert/strict";

import { resolveRunId } from "../src/engine/sandbox.js";

const supplied = "01234567-89ab-cdef-0123-456789abcdef";
const accepted = resolveRunId("detfix", supplied);
assert.equal(accepted, supplied);
process.stdout.write(`${accepted}\n`);

const generated = resolveRunId("detfix");
assert.match(generated, /^detfix-[0-9a-f]{8}$/);

assert.throws(() => resolveRunId("detfix", "01234567-89AB-CDEF-0123-456789ABCDEF"));
assert.throws(() => resolveRunId("detfix", ""));
assert.throws(() => resolveRunId("detfix", "01234567-89ab-cdef/0123-456789abcdef"));
assert.throws(() => resolveRunId("detfix", "01234567-89ab-cdef 0123-456789abcdef"));
