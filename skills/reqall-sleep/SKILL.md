---
name: reqall-sleep
description: Run Reqall SLEEP maintenance to consolidate, compact, split, and cross-link project records.
---

# Reqall SLEEP Maintenance

SLEEP = Synthesis, Linking, Extraction, Enrichment Pipeline. It keeps a project's knowledge graph healthy. It is rate-limited server-side.

## Steps

1. Resolve project name from the user argument, injected context, `REQALL_PROJECT_NAME`, git remote, or directory basename.
2. Call `reqall_upsert_project` (or `reqall_list_projects`) to get `project_id`.
3. Call `reqall_sleep_candidates` with `project_id`.
4. If rate-limited, report the next eligible time and stop. If no candidates, say the graph is healthy.
5. For consolidation clusters, synthesize all input records into one durable replacement record. Preserve every important detail.
6. For rollups, compact lasting resolved knowledge and skip trivial/ephemeral items.
7. For split candidates, split only when a dense active record clearly contains separable topics.
8. For crosslinks, confirm only meaningful relationships; reject superficial matches.
9. Call `reqall_sleep_apply` with the safe operation batch.
10. Summarize consolidated, compacted, split, cross-linked, skipped, and errored items.

## Safety

Do not ask the user for confirmation on every individual candidate unless the user requested interactive review. Server-side invariants prevent unsafe destructive operations, but your reasoning should still be visible before applying.
