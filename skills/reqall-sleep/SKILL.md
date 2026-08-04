---
name: reqall-sleep
description: Compress project memory — consolidate, split, compact, skip, and crosslink Reqall records
---

# SLEEP — compress project memory

**Goal:** Preserve **knowledge** in a **minimal number of short, non-redundant records**.
User invoked sleep → rewrite and delete are expected. Compression is the point.
Knowledge = decisions, outcomes, constraints, IDs, contracts — not session prose.

Ops (fixed names): `consolidate` · `split` · `compact` · `skip` · `crosslink`

Rate-limited server-side (~once per 24h per project). **Modest progress is success** — do not boil the ocean.

## Decision table

| Signal | Action |
|--------|--------|
| Server cluster of highly similar resolved/archived | **consolidate** → one terse record; **sources deleted** |
| Isolated resolved/archived; durable but verbose/redundant | **compact** |
| Isolated resolved/archived; pure noise (ack, empty, no durable fact) | **skip** |
| Active/open; 2+ clearly separable topics | **split** (original deleted by apply) |
| Active/open; single topic, already clear | leave (no op) |
| Cross-project pair; same concept, discovery-useful | **crosslink** |
| Cross-project pair; superficial token overlap | omit |
| Candidate unclear / not obvious | **omit this pass** (not a full-run refuse) |

Prefer clear, concise records and useful links over perfect coverage. A long but appropriate record can wait for a later sleep.

## Steps

1. Resolve project name — user arg → injected context → `REQALL_PROJECT_NAME` → git remote → dir basename.
2. `reqall_upsert_project` (or `reqall_list_projects`) → `project_id`.
3. `reqall_sleep_candidates` with `project_id`. Rate-limited → report next time and stop. Empty → graph healthy.
4. Select ops from the decision table. Prefer obvious wins; small batch is fine. Bodies: terse, non-redundant.
   - **consolidate** — `kind: "arch"`, `status: "resolved"`; best title; knowledge from all members; wording disposable.
   - **compact** — same id; leaner form.
   - **split** — focused sub-records; kind/status fit each topic.
   - **crosslink** — only when useful for discovery.
5. `reqall_sleep_apply` once with the batch. No per-op confirmation.
6. Report consolidated / compacted / split / crosslinked / skipped / errors. Note caps if truncated.

## Rules

- Knowledge ≠ wording. Prose is disposable; durable facts are not.
- **consolidate always deletes sources** (server). Do not keep originals.
- Do not ask whether rewrite/delete is OK — user ran sleep.
- Unclear candidate → omit; do not invent merges or splits.
- Safety is enforced by `reqall_sleep_apply` — do not re-check ownership/dependents.
