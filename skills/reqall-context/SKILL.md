---
name: reqall-context
description: Initialize a Reqall project and gather relevant semantic context before non-trivial Pi coding work.
---

# Gather Reqall Context

Use this skill before starting non-trivial coding, bug fixing, refactoring, migration, architecture/specification, or test work.

## Steps

1. **Identify the project** — Prefer the project name injected by the Pi extension. If unavailable, check `REQALL_PROJECT_NAME`, then derive `org/repo` from `git remote get-url origin`, falling back to the current directory basename.
2. **Fast path** — If the `reqall_project_context` tool is available, call it with the user's task as `query` and the resolved project name as `project_name`. Use the returned project, relevant records, and open records as context.
3. **Manual path** — If needed, call:
   - `reqall_upsert_project` with the exact project name and keep `project_id`.
   - `reqall_search` with a natural-language query from the task and `project_name`.
   - `reqall_list_records` with `project_id` and `status: "open"`.
4. **Drill down** — Call `reqall_get_record` for full details on highly relevant search/list results.
5. **Impact check** — If changing existing tracked behavior, call `reqall_list_links` and/or `reqall_impact` for relevant records.
6. **Summarize** — Briefly state what context matters for the task and proceed.

## Skip/Minimize

For greetings, one-line Q&A, or formatting-only tasks, a quick `reqall_search` is enough or can be skipped if clearly unnecessary.
