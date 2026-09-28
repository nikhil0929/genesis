import { createReadStream, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import { runIdSchema } from "../model.js";

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function objectKey(runDir: string, file: string, id: string): string {
  return `${id}/${relative(runDir, file).split(sep).join("/")}`;
}

function s3Client(): S3Client {
  const endpoint = process.env.MCPDET_S3_ENDPOINT;
  const region = process.env.AWS_REGION ?? "us-east-1";
  if (endpoint === undefined || endpoint.length === 0) return new S3Client({ region });
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export async function uploadRun(runDir: string, id: string): Promise<void> {
  runIdSchema.parse(id);
  const bucket = process.env.MCPDET_S3_BUCKET;
  if (bucket === undefined || bucket.length === 0) throw new Error("MCPDET_S3_BUCKET is unset");
  const root = resolve(runDir);
  const client = s3Client();
  try {
    for (const file of filesUnder(root).sort()) {
      await new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: objectKey(root, file, id),
          Body: createReadStream(file),
        },
      }).done();
    }
  } finally {
    client.destroy();
  }
}

export function deleteLocalRun(runDir: string): void {
  rmSync(runDir, { recursive: true });
}
