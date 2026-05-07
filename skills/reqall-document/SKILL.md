---
name: reqall-document
description: Document one meaningful work item by upserting a Reqall record and related links.
---

# Document One Work Item

Use this to incrementally record a single meaningful action or outcome. It is lighter than the full `reqall-persist` session review.

## When to Skip

Do not create a record for read-only exploration, trivial commands (`ls`, `pwd`), failed/no-op edits, formatting-only changes with no semantic impact, or test runs with no new finding.

## Steps

1. **Project** — Resolve the project name and call `reqall_upsert_project`; keep `project_id`.
2. **Evaluate significance** — Decide whether the action is worth long-term memory.
3. **Classify** — Use the same defaults as `reqall-persist`: bug fix -> `issue/resolved`, completed task -> `todo/resolved`, decision -> `arch/resolved`, spec -> `spec/open`, test evidence -> `test/active` or `test/resolved`, follow-up -> `todo/open`.
4. **Search for related records** — Call `reqall_search` with a concise description of the work.
5. **Upsert** — Call `reqall_upsert_record`; update a known duplicate by `id` rather than creating one.
6. **Link** — Call `reqall_upsert_link` for clear relationships.
7. **Summarize** — Output one line describing what was documented, or "Nothing to document."
