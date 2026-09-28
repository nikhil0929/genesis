import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema.js";

/** Drizzle opens a pg Pool from the URL. The caller ends it with `db.$client.end()`. */
export function openDb(url: string | undefined = process.env.DATABASE_URL) {
  if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");
  return drizzle({ connection: { connectionString: url }, schema });
}

export type Db = ReturnType<typeof openDb>;
