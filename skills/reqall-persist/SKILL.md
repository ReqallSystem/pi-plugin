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
| Session outcome/implementation | work if advertised, otherwise todo | resolved |
| Durable reference note | info if advertised, otherwise suitable legacy kind | active |
| Follow-up task | todo | open |
| Architecture decision/change | arch | resolved |
| New or updated specification | spec | open |
| Test/build evidence | test | active or resolved |
| Trivial/Q&A/no-op | -- | skip |

## Title Prefixes

Use scannable prefixes: `BUG:`, `TASK:`, `BLOCKER:`, `QUESTION:`, `ARCH:`, `API:`, `AUTH:`, `DATA:`, `UI:`, `FEAT:`, `REFACTOR:`, `TEST:`.

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

1. **Identify project** — Use the supplied effective binding, or the portable policy below if unavailable.
2. **Ensure project exists** — Call `reqall_upsert_project` with the exact project name and keep `project_id`.
3. **Analyze the session** — Enumerate files changed, commands/tests run, bugs fixed/discovered, decisions made, specs changed, and follow-ups.
4. **Search/link context** — Use `reqall_search` to find related existing records. Use `reqall_get_record` if summaries are insufficient.
5. **Upsert records** — For every meaningful item, call `reqall_upsert_record` with `project_id`, `kind`, `status`, `title`, and a detailed `body` including paths and outcomes.
6. **Reconcile intent** — Outcomes `implements` agreed spec/arch, tests use `tests`, and open gap todos `blocks` unfulfilled intent. Call `reqall_capabilities` before using work/info or inline links. Prefer advertised inline `links` (max 20); otherwise use `reqall_upsert_link`. Inspect every created/existing/error link result. Missing results or errors are partial persistence: repair missing edges using the existing record ID, never recreate the record.
7. **Verify** — Read each saved ID with `reqall_get_record`, checking project, body, kind and status. Enumerate outgoing `reqall_list_links` through all pages and verify endpoint IDs/tables and relationships; also verify any requested incoming edges. After repairs, repeat readbacks. Finish with project-scoped `reqall_list_records`. A transport success or summary list alone is not proof.
8. **Report** — Tell the user what was persisted and any open follow-ups.

## Safety

Attribution is automatic when the server advertises `session_id`; never supply an invented label. If Reqall is unavailable or a save remains partial, report that honestly. These verification steps are advisory; Pi does not enforce Codex's Stop contract.

Successful routine git add/commit/push bookkeeping alone does not warrant another record; keep and reconcile any already-pending substantive work.

Prefer status changes (`resolved`/`archived`) over deletion. Only call delete tools if the user explicitly requested deletion.
