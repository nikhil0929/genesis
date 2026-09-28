import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    targetName: text("target_name").notNull(),
    mcpServerName: text("mcp_server_name"),
    serverKey: text("server_key").notNull(),
    sourceKind: text("source_kind", { enum: ["registry", "local"] }).notNull(),
    packageName: text("package_name"),
    packageVersion: text("package_version"),
    ecosystem: text("ecosystem", { enum: ["npm", "pypi"] }).notNull(),
    downloadUrl: text("download_url"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
    verdict: text("verdict", { enum: ["pass", "fail", "incomplete"] }),
  },
  (table) => [
    check("runs_source_kind_check", sql`${table.sourceKind} in ('registry', 'local')`),
    check("runs_ecosystem_check", sql`${table.ecosystem} in ('npm', 'pypi')`),
    check("runs_status_check", sql`${table.status} in ('running', 'succeeded', 'failed')`),
    check("runs_verdict_check", sql`${table.verdict} in ('pass', 'fail', 'incomplete')`),
    check(
      "runs_finish_check",
      sql`(${table.status} = 'running' and ${table.endedAt} is null and ${table.verdict} is null)
    or (${table.status} <> 'running' and ${table.endedAt} is not null and ${table.verdict} is not null)`,
    ),
    check(
      "runs_source_check",
      sql`(${table.sourceKind} = 'registry' and ${table.packageName} is not null and ${table.packageVersion} is not null)
    or (${table.sourceKind} = 'local' and ${table.packageName} is null and ${table.packageVersion} is null)`,
    ),
    index("runs_server_key").on(table.serverKey),
  ],
);

export type RunRow = typeof runs.$inferSelect;
