# Implementation agents

The six build steps in the [technical design](/cursor/stores/bc-ddd00a24-3754-4cee-ae7c-b90d3917c196/docs/technical-design.md) are a proof sequence. Slice 2's check detonates the slice 1 server. Slice 3 rebuilds that run. Slices 4 and 5 need a working harness. Slice 6 reads finished findings. Running one agent per slice at the same time makes them edit the same files, and none of the later checks can pass yet.

Parallel work is by file owner. Peak is three agents. The code home is [genesis](https://github.com/nikhil0929/genesis). This Cursor workspace is a different git remote, so every agent clones genesis into its own directory and leaves `/workspace` alone.

## Poteto mode on every implementation agent

This Project coordinator cannot pass `subagent_type: poteto-agent`. That call is rejected here. A general worker does not read poteto-mode on its own.

Every implementation kickoff from this chat starts with this instruction, before the task:

Read `/Users/nikhilaggarwal/.cursor/plugins/cache/cursor-public/pstack/ecc249f1e306fc64ddf83c7bed16cacf7c2239db/agents/poteto-agent.md` and `/Users/nikhilaggarwal/.cursor/plugins/cache/cursor-public/pstack/ecc249f1e306fc64ddf83c7bed16cacf7c2239db/skills/poteto-mode/SKILL.md` in full before any work. Follow that skill, including its playbooks and the leaf principle skills it names. On a machine where that plugin path is missing, stop and say so.

Attaching `/poteto-mode` on the parent message does not apply it to the worker.

## Contract

`src/model.ts` is written once, in full, before any other implementation branch. It holds every variant in the design (run, event, bundle, finding, static profile, proxy flow, judgment) as TypeScript discriminated unions, plus the zod schemas that parse the target file, the transcript, the flow log, and the judge output.

Later agents import that module. They do not edit it. Additive type changes go back to the runtime owner as a single follow-up, so the unions stay in one file.

`src/app/cli.ts` has one owner for the whole project, the runtime agent. Other agents export a function. The runtime agent is the only one who calls it.

## Agents

During the build, this ownership list used the old flat paths such as `src/sandbox.ts` and `src/cli.ts`, before those modules moved under `src/engine/` and `src/app/`.

### 1. Contract

Starts first. Stops when the draft PR is up.

Owns `package.json`, `tsconfig.json`, and `src/model.ts`. Node 24, `strict`, the `mcpdet` bin pointed at compiled output. No Docker, no detonation, no rules, no report.

Done when `tsc` succeeds and a second package can import the run type.

### 2. Runtime

Starts from the contract branch. Two phases, same owner, because the container lifecycle is one clock.

Phase A is build step 1. Owns `src/engine/sandbox.ts`, `src/engine/driver.ts`, `src/engine/sensors/`, `src/engine/attribution.ts`, `src/app/cli.ts`, `fixtures/detfix/` (`echo`, `spawn_and_linger`, `delayed_write`), `targets/detfix.toml`, and `checks/` for that step.

Phase B is build step 2's container work, after phase A is green. Owns decoy planting, the resolver file, DNS decoding, `proxy/mcpdet_addon.py`, flow join, and the `word_count` and `load_plugin` tools. Calls `rules` once that module exists.

Needs Docker. The design's host is macOS with Docker Desktop, or Linux with Docker Engine. The contract machine has no Docker, so this agent runs somewhere Docker can be installed and the slice checks can execute a real container.

### 3. Rules

Starts from the contract branch, in parallel with runtime phase A.

Owns `src/engine/rules.ts` only. Pure function from a parsed run to findings. The keyword lists, sensitive paths, and code extensions live in one table in that file. Its check feeds a synthetic `bundles.json` that matches the frozen types and asserts literal findings. It does not start a container.

The live `word_count` assertions stay in the runtime agent's slice 2 check.

### 4. Report

Starts from the contract branch, in parallel with rules and runtime phase A.

Owns `src/engine/static-profile.ts` and `src/engine/report.ts`. Pure functions from a run directory to `static_profile.json` and `report.md`. Its check uses a synthetic run directory and asserts section headers plus a byte-identical rebuild.

`report.ts` reads `judgments.json` when that file exists and prints `judge not run` when it does not. The judge agent never edits `report.ts`.

The live byte-identical check against a real `detfix` run is build step 3. The report agent runs that check after runtime phase B has produced a run directory.

### 5. Git target

Starts after build steps 1 through 3 are green. Parallel with the filesystem agent.

Owns `targets/mcp-server-git.toml`, that target's scenario, and `checks/` for build step 4. No edits under `src/`.

### 6. Filesystem target

Same start gate as the git agent.

Owns `targets/server-filesystem.toml`, that target's scenario, and `checks/` for build step 5. No edits under `src/`.

### 7. Judge

Starts once `findings.json` has been produced by a real run and `report.ts` already renders a missing judgment. Parallel with the two target agents, because those agents do not edit `src/`.

Owns `src/engine/judge.ts` and `checks/` for build step 6. Writes `judgments.json`. Skips cleanly when `ANTHROPIC_API_KEY` is absent.

## Schedule

| Wave | Agents | Start gate |
|---|---|---|
| 0 | Contract | Now |
| 1 | Runtime phase A, Rules, Report | Contract branch is pushed |
| 2 | Runtime phase B | Slice 1 check is green. Rules module is on the branch. |
| 3 | Report agent's live rebuild check | A real slice 2 run directory exists |
| 4 | Git target, Filesystem target, Judge | Slices 1 through 3 are green |

## Branches

Each agent pushes its own branch to `nikhil0929/genesis` and opens a draft PR. Wave 1 branches from the contract branch. Wave 4 branches from main after slices 1 through 3 have merged. No agent pushes to `main` directly.
