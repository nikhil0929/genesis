# mcpdet

## Quickstart

Fill in a `.env` file with the variables listed under [What you have to configure](#what-you-have-to-configure), then run:

```bash
npm install
npx drizzle-kit migrate   # create the runs table
node dist/src/app/cli.js serve
```

The server listens on `127.0.0.1:8787`. Both endpoints need an `Authorization: Bearer $MCPDET_API_TOKEN` header.

- `POST /runs` takes a target as JSON (the same fields as a file in `targets/`) and starts a run. It returns `{ "id", "status": "running" }`.
- `GET /runs/:id` returns the run's status, its verdict, and the judge results once the run is done.

## The architecture

It's the same detonator engine as `main`, with a small REST server in front and two places to keep results:

```
POST /runs  ──►  Fastify API  ──►  engine runs the MCP server in a container
                    │                        │
                    │                        ▼
                    │               writes a local run folder
                    │                        │
                    ▼                        ▼
               Postgres               S3 bucket (the whole folder)
          (one row per run:          e.g. <run-id>/bundles.json,
           status, verdict)               <run-id>/judgments.json
                                             │
GET /runs/:id ◄── reads the row + fetches judgments.json from S3
```

- **Code layout:** `src/engine/` is the original detonation logic, just moved into its own folder. `src/app/` is the new backend layer.
- **The API (`src/app/api.ts`, `src/app/routes/runs.ts`)** has two endpoints, and every request needs a bearer token.
  - `POST /runs` takes a target, returns a run ID straight away, and runs the detonation in the background. It allows one run at a time; a second request while one is going gets a `409` error.
  - `GET /runs/:id` returns the run's status and verdict, plus the judge results once the run is done.
- **Postgres (`src/app/db/`)** holds one `runs` table: ID, target and package names, start and end times, status (`running`, `succeeded`, `failed`) and verdict (`pass`, `fail`, `incomplete`). It's only the small facts you look up.
- **S3 (`src/app/archive.ts`)** holds the full evidence. When a run finishes, the whole run folder is uploaded under `<run-id>/...` and then the local copy is deleted. If the upload fails, the local folder is kept.
- **CLI (`src/app/cli.ts`):** `mcpdet serve` starts the API. `mcpdet detonate` now also writes the row to Postgres and uploads to S3.

## What you have to configure

The CLI reads a `.env` file from the repository root if there is one. It needs:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `MCPDET_API_TOKEN` | the bearer token API callers must send (required for `serve`) |
| `MCPDET_S3_BUCKET` | bucket name (required) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | normal AWS credentials |
| `AWS_REGION` | optional, defaults to `us-east-1` |
| `MCPDET_S3_ENDPOINT` | optional; set this to use a non-AWS S3 server |
| `MCPDET_LISTEN` | optional, defaults to `127.0.0.1:8787` |

The code builds a standard AWS client, so credentials come from wherever AWS tools normally find them: environment variables, `~/.aws/credentials`, or a cloud machine's attached role. The code never reads a key by name itself.

For local development, set `MCPDET_S3_ENDPOINT` to something like `http://localhost:9000` for MinIO. That server still needs a key pair, but it can be a throwaway one like `minioadmin`, not a real AWS account.

The tests do something similar. `checks/run-archive.ts` starts a tiny fake S3 server inside the test and passes dummy keys (`test` / `test`), which is why they pass without any AWS account. That fake exists only in the tests, not in the product.

## Things worth knowing

- The server doesn't create the bucket. It has to exist already.
- Postgres needs its table created first. There are migrations in `db/migrations/` with a `drizzle.config.ts`.
- The `download_url` column is always left empty for now. `GET /runs/:id` reads files through the server rather than handing out S3 links.
