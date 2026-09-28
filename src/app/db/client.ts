import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export type DbHandle = {
  readonly db: Db;
  readonly close: () => Promise<void>;
};

export function openDb(url: string | undefined = process.env.DATABASE_URL): DbHandle {
  if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");
  const db = drizzle({ connection: { connectionString: url }, schema });
  return { db, close: () => db.$client.end() };
}
