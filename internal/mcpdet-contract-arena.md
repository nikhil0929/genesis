---
cursor:
  subagentId: "bc-41d0e0e3-39d7-5a03-87f8-064cad1448dd"
---

# Contract arena synthesis

This note records how the second version of `src/model.ts` on [genesis #1](https://github.com/nikhil0929/genesis/pull/1) was chosen. The first version was written without poteto-mode. The operator asked for a redesign that follows its principles.

## Setup

- Brief: `/tmp/arena-mcpdet-model/brief.md`. Rubric: `/tmp/arena-mcpdet-model/rubric.md`. Both are on the contract agent's VM and are not durable.
- Runners wrote in separate git worktrees under `/tmp/arena-mcpdet-model/candidate-<n>`.
- Candidate 1 ran on `claude-opus-5-5-max` and was told to put schemas first. It produced no files after about 30 minutes. The operator asked to skip it, so the arena ran with two candidates.
- Candidate 2 ran on `gpt-5.6-sol-max` and was told to put hand-written types first, bound to their schemas in both directions.
- Candidate 3 ran on `grok-4.7-xhigh-fast` with an open direction. It chose one private schema per document, with exported types derived from it.
- The cross-judge ran on `gpt-5.6-sol-max`, read-only.

## Scores

| Criterion | Candidate 2 (judge) | Candidate 3 (judge) |
|---|---:|---:|
| Design fidelity | 4 | 2 |
| One source of truth | 3 | 4 |
| Type discipline | 5 | 3 |
| Boundary discipline | 4 | 3 |
| Reader load | 4 | 2 |
| Proof | 4 | 3 |

The judge recommended candidate 2. The contract agent picked candidate 3.

## Why candidate 3 is the base

Most of the gap came from the fidelity criterion. The judge docked candidate 3 for replacing the stored `after_reply`, `outlived_reply`, `seq`, `passed`, finding `strength`, and `too_long` fields with functions. The rubric's second criterion asked for exactly that, so the two criteria conflicted. The design itself calls `after_reply` "computed as event time later than the reply time" and finding strength "the strongest link among the evidence events". A value derived by a function is still representable, so the conflict resolves in candidate 3's favor.

Candidate 2 keeps a hand-written interface beside every schema. The `typescript-best-practices` skill rules this out: "Do not maintain a schema, a duplicate interface, and a guard that can drift apart." The judge also showed candidate 2's two-way shape check misses constraint drift. Changing `Pid` from positive to nonnegative compiled cleanly. Candidate 2 also stores the derived fields and then re-checks them in `parseRunJson`, which the rubric counts as a second source of truth.

The judge's reader-load point stands as a cost. Hover types for `Run` and `Event` expand into structural types because they come from `DeepReadonly<z.output<...>>`. The schemas in the source file stay readable, so a later agent reads `src/model.ts` instead of the hover.

## Grafts into candidate 3

- From candidate 2, the owned-link causal check. `parseRun` rejects an owned link, or an entry in `owned_processes`, whose process the bundle's own call or shutdown did not start. This closes the design row "a strong link with no causal process", which the judge marked open in candidate 3.
- From candidate 2, citation checks at the boundary. `parseFindings` and `parseJudgments` take the run and reject unknown calls, evidence outside the cited bundle, and duplicate judgments. `findingStrength` became total.
- From candidate 2's `Serialized<TimelineEntry>` idea, `DriverTimelineEntry`. It is derived as `DeepReadonly<z.input<typeof timelineEntrySchema>>`, so the driver writes plain numbers without casting brands.
- From the judge, `max_violation_us` became a `Duration` instead of an instant.
- From a consumer test, the `Bundle` union export. Candidate 3 did not export it, but the design names it.
- New in synthesis, the `wellFormed` gate. Removing a guard that looked dead made one field error report twice. zod 4 runs an object's `superRefine` after a field fails. The fix passes `when: payload.issues.length === 0` to both relational refinements, instead of putting the guard back.

## Rejected

- Candidate 2's teardown rule, which says every process alive at teardown must be in `killed_at_teardown`. The design never states it, and the fixture's orphan process would violate it.
- Candidate 2's `parseRunJson(text, source, events)`. Every reader of `bundles.json` would also have to load `events.jsonl`. The event-partition check stays in `assertExactPlacement`, which slice checks call.
- Candidate 2's `SchemaShape` and `schemaFor` type machinery. With one schema per document there is nothing to bind.

## Verification

- `npm run check` passed on both commits, `5699ea9` (the candidate 3 base) and `4eeb97a` (the grafts). It runs `tsc` and then `node dist/checks/contract.js` on Node 24.21.0.
- A separate package installed from the branch imports `Run`, `Bundle`, and `DriverPlan` from `mcpdet/model` and parses a real `bundles.json`.
