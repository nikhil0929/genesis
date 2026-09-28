import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { ZodError } from "zod";

import { deleteLocalRun, uploadRun } from "../src/app/archive.js";

const bucket = "mcpdet-runs";
const runId = "01234567-89ab-cdef-0123-456789abcdef";
const otherId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type Stored = Map<string, Buffer>;

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function listXml(objects: Stored, prefix: string): string {
  const matches = [...objects.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right));
  const contents = matches
    .map(
      ([key, body]) =>
        `<Contents><Key>${xmlEscape(key)}</Key><Size>${body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${xmlEscape(bucket)}</Name>
  <Prefix>${xmlEscape(prefix)}</Prefix>
  <KeyCount>${matches.length}</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  ${contents}
</ListBucketResult>`;
}

function listen(objects: Stored, hits: { count: number }): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer();
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    hits.count += 1;
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter((part) => part.length > 0);
      const key = parts.slice(1).map(decodeURIComponent).join("/");
      if (req.method === "PUT" && key.length > 0) {
        const body = await readBody(req);
        objects.set(key, body);
        const etag = createHash("md5").update(body).digest("hex");
        res.writeHead(200, { ETag: `"${etag}"` });
        res.end();
        return;
      }
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(listXml(objects, prefix));
        return;
      }
      if (req.method === "GET" && key.length > 0) {
        const body = objects.get(key);
        if (body === undefined) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Length": body.length, ETag: `"${createHash("md5").update(body).digest("hex")}"` });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  };
  server.on("request", handle);
  server.on("checkContinue", (req, res) => {
    res.writeContinue();
    handle(req, res);
  });
  return new Promise((resolvePromise, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("s3 listen failed"));
        return;
      }
      resolvePromise({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}

function withEnv(values: Readonly<Record<string, string | undefined>>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

function reader(endpoint: string): S3Client {
  return new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

async function keysUnder(client: S3Client, id: string): Promise<string[]> {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${id}/` }));
  return (listed.Contents ?? []).flatMap((item) => (item.Key === undefined ? [] : [item.Key])).sort();
}

async function uploadCase(endpoint: string): Promise<void> {
  const runDir = mkdtempSync(join(tmpdir(), "mcpdet-archive-"));
  const files = {
    "report.md": "# report\n",
    "bundles.json": "{\"bundles\":[]}\n",
    "raw/host.json": "{\"image_id\":\"sha256:abc\"}\n",
    "raw/trace/t.4242": "exec\n",
  };
  writeTree(runDir, files);
  try {
    await withEnv(
      {
        MCPDET_S3_BUCKET: bucket,
        MCPDET_S3_ENDPOINT: endpoint,
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_EC2_METADATA_DISABLED: "true",
      },
      async () => {
        await uploadRun(runDir, runId);
      },
    );
    const client = reader(endpoint);
    try {
      const keys = await keysUnder(client, runId);
      assert.deepEqual(
        keys,
        Object.keys(files)
          .map((path) => `${runId}/${path}`)
          .sort(),
      );
      for (const [path, text] of Object.entries(files)) {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `${runId}/${path}` }));
        const body = object.Body;
        if (body === undefined) throw new Error(`missing body ${path}`);
        assert.equal(Buffer.from(await body.transformToByteArray()).toString("utf8"), text);
      }
    } finally {
      client.destroy();
    }
    deleteLocalRun(runDir);
    assert.equal(existsSync(runDir), false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

async function missingBucketCase(endpoint: string, hits: { count: number }): Promise<void> {
  const runDir = mkdtempSync(join(tmpdir(), "mcpdet-archive-"));
  writeTree(runDir, { "raw/host.json": "{}\n" });
  const before = hits.count;
  try {
    for (const unset of [undefined, ""] as const) {
      await withEnv(
        {
          MCPDET_S3_BUCKET: unset,
          MCPDET_S3_ENDPOINT: endpoint,
          AWS_ACCESS_KEY_ID: "test",
          AWS_SECRET_ACCESS_KEY: "test",
          AWS_EC2_METADATA_DISABLED: "true",
        },
        async () => {
          await assert.rejects(uploadRun(runDir, runId), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "MCPDET_S3_BUCKET is unset");
            return true;
          });
        },
      );
    }
    assert.equal(hits.count, before);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

async function prefixCase(endpoint: string, hits: { count: number }): Promise<void> {
  const bad = "01234567-89AB-cdef-0123-456789abcdef";
  const runDir = mkdtempSync(join(tmpdir(), "mcpdet-archive-"));
  writeTree(runDir, { "bundles.json": "{}\n", "raw/host.json": "{}\n", "raw/trace/t.7": "trace\n" });
  const before = hits.count;
  try {
    await withEnv(
      {
        MCPDET_S3_BUCKET: bucket,
        MCPDET_S3_ENDPOINT: endpoint,
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_EC2_METADATA_DISABLED: "true",
      },
      async () => {
        await assert.rejects(uploadRun(runDir, bad), (error: unknown) => {
          assert.ok(error instanceof ZodError);
          return true;
        });
        assert.equal(hits.count, before);
        await uploadRun(runDir, otherId);
      },
    );
    const client = reader(endpoint);
    try {
      const keys = await keysUnder(client, otherId);
      assert.deepEqual(keys, [`${otherId}/bundles.json`, `${otherId}/raw/host.json`, `${otherId}/raw/trace/t.7`]);
      const first = await keysUnder(client, runId);
      assert.deepEqual(first, [
        `${runId}/bundles.json`,
        `${runId}/raw/host.json`,
        `${runId}/raw/trace/t.4242`,
        `${runId}/report.md`,
      ]);
    } finally {
      client.destroy();
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

const objects: Stored = new Map();
const hits = { count: 0 };
const server = await listen(objects, hits);
try {
  await missingBucketCase(server.url, hits);
  await uploadCase(server.url);
  await prefixCase(server.url, hits);
} finally {
  await server.close();
}
