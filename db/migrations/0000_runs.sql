CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"target_name" text NOT NULL,
	"mcp_server_name" text,
	"server_key" text NOT NULL,
	"source_kind" text NOT NULL,
	"package_name" text,
	"package_version" text,
	"ecosystem" text NOT NULL,
	"download_url" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"status" text NOT NULL,
	"verdict" text,
	CONSTRAINT "runs_source_kind_check" CHECK ("runs"."source_kind" in ('registry', 'local')),
	CONSTRAINT "runs_ecosystem_check" CHECK ("runs"."ecosystem" in ('npm', 'pypi')),
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "runs_verdict_check" CHECK ("runs"."verdict" in ('pass', 'fail', 'incomplete')),
	CONSTRAINT "runs_finish_check" CHECK (("runs"."status" = 'running' and "runs"."ended_at" is null and "runs"."verdict" is null)
    or ("runs"."status" <> 'running' and "runs"."ended_at" is not null and "runs"."verdict" is not null)),
	CONSTRAINT "runs_source_check" CHECK (("runs"."source_kind" = 'registry' and "runs"."package_name" is not null and "runs"."package_version" is not null)
    or ("runs"."source_kind" = 'local' and "runs"."package_name" is null and "runs"."package_version" is null))
);
--> statement-breakpoint
CREATE INDEX "runs_server_key" ON "runs" USING btree ("server_key");