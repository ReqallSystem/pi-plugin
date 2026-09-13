---
name: reqall-triage
description: Classify an incoming issue or request, gather structured details, de-duplicate, prioritize, and create a Reqall record.
---

# Triage Incoming Issue or Request

## Category Table

| Category | kind | prefix | priority hint |
|---|---|---|---|
| Bug report | issue | BUG: | P0-P2 by impact |
| Feature request | spec or todo | FEAT: | P2-P4 |
| Account/billing | issue | ACCOUNT: | P1-P2 |
| Docs/how-to gap | todo | DOCS: | P3-P4 |
| Integration question | issue | INTEG: | P2-P3 |

Priority scale: P0 critical/security/data loss; P1 high; P2 medium; P3 low; P4 wishlist.

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

1. Resolve project name and call `reqall_upsert_project`.
2. Use the user's description if provided; otherwise ask for it.
3. Classify category and confirm/correct with the user when ambiguous.
4. Gather missing details only:
   - Bug: reproduction, expected/actual, environment, frequency, errors, workaround/severity.
   - Feature: user story, beneficiaries, workaround, desired behavior, acceptance criteria.
   - Account/billing: account context, plan, charge/access issue, urgency.
   - Docs/how-to: goal, what was tried, docs consulted, confusing gap.
   - Integration: service/API, versions, errors, code/config snippets.
5. Search duplicates with `reqall_search`; list open records with `reqall_list_records` filtered by project/kind/status.
6. If duplicate, update the existing record via `reqall_upsert_record` and stop. If related, create a new record and link it.
7. Propose priority and let the user confirm/override when practical.
8. Create the record with `reqall_upsert_record` using title format `{PREFIX} {PRIORITY}: {concise title}` and a structured body.
9. Create related links with `reqall_upsert_link`.
10. Summarize record, priority, links, and suggested next steps.
