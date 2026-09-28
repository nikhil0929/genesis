import { createHash, timingSafeEqual } from "node:crypto";

import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { runsRoutes } from "./routes/runs.js";
import type { RunsDeps } from "./routes/runs.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export async function buildServer(deps: RunsDeps): Promise<FastifyInstance> {
  const token = process.env["MCPDET_API_TOKEN"];
  if (token === undefined || token === "") throw new Error("MCPDET_API_TOKEN is not set");
  const expected = digest(token);

  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onRequest", async (request, reply) => {
    const given = /^bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (given === undefined || !timingSafeEqual(digest(given), expected)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
  await app.register(runsRoutes, deps);
  return app;
}
