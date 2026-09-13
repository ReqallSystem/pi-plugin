---
name: reqall-context
description: Initialize a Reqall project and gather relevant semantic context before non-trivial Pi coding work.
---

# Gather Reqall Context

Use this skill before starting non-trivial coding, bug fixing, refactoring, migration, architecture/specification, or test work.

## Project binding (portable policy)

Use the exact effective project supplied by the Pi extension throughout recall,
work, persistence, and verification; do not independently rediscover a different
name. Deliberate operation arguments (including a SLEEP project ID/name or
`reqall_project_context.project_name`) affect only that operation. `.user` is an
intentional account-wide preferences target, not an automatic fallback.

Pi freezes the effective binding for each context-bound run. Labelled ordinary
user input becomes a pending selection and takes effect at the next non-generated
`before_agent_start`, never during active tools or their persistence followup.
Streaming followups/steering consumed inside the existing agent loop keep its
binding until that next context boundary. The latest pending label wins.
Applied selections are stored in Pi custom session entries and restored from the
active branch on startup/resume/reload/fork; a new session starts without one.
Unapplied pending input is not persisted. Arguments to any bundled
`/skill:reqall-*` invocation (for example `/skill:reqall-sleep project_name=.user`)
are operation-specific and never select the session project. Supply a label in
ordinary user input to change the session selection instead.

Without a supplied binding, use this ordered chain:
1. Nonempty trimmed `REQALL_PROJECT_NAME` (environment wins; Pi adds no project settings).
2. Actual network Git `origin`: HTTP(S), SSH, Git or SCP-style. Remove trailing
   slashes and terminal `.git`; retain the final two path segments, including for
   nested namespaces. Local paths and `file:` remotes fall through.
3. Explicit user `project_name` or `project` label using `:` or `=`, with unquoted,
   single-, double-, or backtick-quoted value, or the retained session selection.
   Strip sentence punctuation only from unquoted values. Never infer from arbitrary
   slash tokens, URLs, incidental paths, or synthetic reports/quoted examples.
4. Nearest valid ancestor `.reqall.yml`, then `.reqall.yaml` identity.
5. Nearest valid package identity: `package.json`, `go.mod`, then `Cargo.toml`
   at each directory before searching its parent.
6. Exact POSIX-style cwd-relative path within a known workspace root.
7. `.machine/<short-lower-hostname>/<os-user>` (OS account, not `USER`/`USERNAME`).
   `REQALL_MACHINE_NAME` replaces the whole host segment, sanitized/lowercased
   while retaining deliberate dots. Never use an unconstrained cwd basename.

Explicit manual names preserve historical identifiers apart from outer whitespace;
never migrate records during discovery. Automatic metadata uses ASCII letters,
digits, `_`, `-`, `.` in slash-separated segments. Reject absolute POSIX, drive,
UNC, backslash, tilde, empty, `.` and `..` segments before normalization; do not
strip leading separators. Intentional `src` and `work` names are valid.

Read only regular UTF-8 metadata files up to 64 KiB; skip unreadable, oversized,
malformed, unsupported, and non-string values. YAML supports top-level string
`project` (preferred) or `name`, matching single/double quotes and trailing
comments; reject ambiguous duplicate keys, malformed quotes, plain boolean/null/
numeric values, nested mappings, aliases and multiline scalars. `package.json`
requires a string `name`; remove one leading `@` only for a valid npm scoped name.
`go.mod` preserves the full declared module including domain/nested path/version;
leading comments and empty files are safe. Cargo reads a simple quoted `name`
inside `[package]`, not `[[bin]]` or dependencies; this is not full TOML parsing.

Search nearest valid ancestors up to the containing workspace root inclusive, or
filesystem root if none is known. `REQALL_WORKSPACE_ROOT` comes from process env
(relative to cwd; `~/` expands home), otherwise use the nearest regular ancestor
`.reqall-workspace` marker. Resolve real paths before containment checks so symlinks
cannot escape. An invalid/non-containing explicit root must not silently use a
marker. Cwd equal to root has no relative identity. Preserve every relative
segment, including `src`/`work`; a rootless plain directory uses machine memory.

## Steps

1. **Identify the project** — Use the supplied effective binding, or the portable policy below if unavailable.
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
