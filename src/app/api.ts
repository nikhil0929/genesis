import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { runsRoutes } from "./routes/runs.js";
import type { RunsDeps } from "./routes/runs.js";

export async function buildServer(deps: RunsDeps): Promise<FastifyInstance> {
  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(runsRoutes, deps);
  return app;
}
