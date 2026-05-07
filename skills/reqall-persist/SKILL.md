---
name: reqall-persist
description: Classify and persist all meaningful work completed in a Pi session to Reqall.
---

# Persist Work to Reqall

Run this before the final user-facing response for non-trivial work. Create one record per distinct work item.

## Classification Defaults

| Work type | kind | status |
|---|---|---|
| Bug fixed | issue | resolved |
| New unfixed bug | issue | open |
| Completed implementation/task | todo | resolved |
| Follow-up task | todo | open |
| Architecture decision/change | arch | resolved |
| New or updated specification | spec | open |
| Test/build evidence | test | active or resolved |
| Trivial/Q&A/no-op | -- | skip |

## Title Prefixes

Use scannable prefixes: `BUG:`, `TASK:`, `BLOCKER:`, `QUESTION:`, `ARCH:`, `API:`, `AUTH:`, `DATA:`, `UI:`, `FEAT:`, `REFACTOR:`, `TEST:`.

## Steps

1. **Identify project** — Use the extension-injected project name if present; otherwise check `REQALL_PROJECT_NAME`, git remote, then directory basename.
2. **Ensure project exists** — Call `reqall_upsert_project` with the exact project name and keep `project_id`.
3. **Analyze the session** — Enumerate files changed, commands/tests run, bugs fixed/discovered, decisions made, specs changed, and follow-ups.
4. **Search/link context** — Use `reqall_search` to find related existing records. Use `reqall_get_record` if summaries are insufficient.
5. **Upsert records** — For every meaningful item, call `reqall_upsert_record` with `project_id`, `kind`, `status`, `title`, and a detailed `body` including paths and outcomes.
6. **Create links** — Use `reqall_upsert_link` for clear relationships: `implements`, `tests`, `blocks`, `parent`, or `related`.
7. **Verify** — Call `reqall_list_records` with `project_id` to sanity-check the created/updated records.
8. **Report** — Tell the user what was persisted and any open follow-ups.

## Safety

Prefer status changes (`resolved`/`archived`) over deletion. Only call delete tools if the user explicitly requested deletion.
