## Project memory

- `README.md` — Short GitHub page: how to run a target, how a run works, and later ideas. The long design is in `docs/technical-design.md`.
- `notes.md` — Live checklist. Open items and finished items, with links to the design docs and GitHub.
- `archived.md` — Checklist items moved out of `notes.md` after they were done.
- `docs/technical-design.md` — Architecture plan. Every v1 choice is marked as a decision, with the reason, the data shape, the pipeline, and the report format.
- `docs/implementation-waves.md` — How the build was split across agents: who owns which files, why `src/model.ts` is frozen, and the order of the six proof steps.
- `docs/local-mcp-detonation-challenge.md` — Plain-language reading of the Forge brief. Each claim is tagged as coming from the brief, inferred, or background.
- `docs/existing-detonators.md` — How classic file detonators (FireEye, Cuckoo, and others) are built, and which of those ideas mcpdet keeps.
- `internal/brief-raw.txt` — The Forge brief text itself. Source for the challenge explainer. The OpenRouter key line is redacted.
- `internal/mcpdet-contract-arena.md` — Why `src/model.ts` follows candidate 3 from the contract bakeoff, and what was grafted in from the other candidate.
