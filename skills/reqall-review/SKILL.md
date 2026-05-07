---
name: reqall-review
description: Interactively review and triage open Reqall records for the current project.
---

# Review Open Reqall Records

Use this for backlog grooming, issue review, or checking active specs/todos.

## Steps

1. Resolve project name and call `reqall_upsert_project` to get `project_id`.
2. Fetch records with `reqall_list_records`, usually `status: "open"` and optional `kind` filter from the user's request.
3. For each relevant record, show kind, title, and status. Call `reqall_get_record` when full detail is needed.
4. Inspect relationships with `reqall_list_links`; use `reqall_search` for duplicates or related records.
5. Ask the user whether each record is still relevant, should be resolved/archived, needs more detail, or should be linked.
6. Apply updates with `reqall_upsert_record` and links with `reqall_upsert_link`.
7. Delete only on explicit user request; otherwise prefer `status: "archived"`.
8. Summarize records updated, resolved, archived, linked, or left open.
