---
name: reqall-intend
description: Record agreed new behavior or architecture before implementation, then reconcile outcomes against its acceptance criteria.
---

# Record Agreed Intent

Only for agreed non-trivial behavior, contracts or structural decisions. Skip
questions, exploratory plans, chores and routine fixes. A specific user request
already authorizes its scope; do not ask again merely to record intent.

1. Complete Reqall project context. Search for the intended behavior; read the
   best matching spec/arch. Reuse it rather than creating a duplicate.
2. If needed, create one open spec/arch with rationale, agreed scope, acceptance
   criteria and non-goals. Update an existing record by ID only when scope changes.
3. Call `reqall_capabilities` before additive features. Use advertised inline
   `links` (at most 20), otherwise `reqall_upsert_link`. Inspect every result;
   missing/error edges mean partial persistence. Repair with existing record IDs.
4. Read the saved record and relevant link pages. Keep the agreed intent ID for
   final reconciliation. A consulted record is not automatically a commitment.
5. Proceed with work. At persistence, an outcome `implements` fulfilled intent,
   tests use `tests`, and an open gap todo `blocks` unfulfilled intent. Intent
   alone is not an outcome or proof that implementation succeeded.

Pi injects originating session attribution automatically when the server schema
supports it. Never manufacture `session_id`. The current plugin's intent and
verification guidance is advisory, not a Codex-style enforced Stop guardrail.

## Project binding (portable policy)

The supplied effective project is authoritative. Preserve deliberate operation
targets without changing the session project. Without a supplied binding, use
trimmed `REQALL_PROJECT_NAME`, network Git `origin`, explicitly labelled
`project_name`/`project`, nearest valid `.reqall.yml`/`.reqall.yaml`, then nearest
package identity (`package.json`, `go.mod`, `Cargo.toml`), workspace-relative
path within `REQALL_WORKSPACE_ROOT` or `.reqall-workspace`, then
`.machine/<short-lower-hostname>/<os-user>`. `.user` is an intentional account
preferences target, not an automatic fallback. Never use an arbitrary basename.
Read regular UTF-8 metadata at most 64 KiB, rejecting malformed values, absolute,
UNC, drive, tilde and dot-segment identities; resolve symlinks before workspace
containment. Follow the full [context policy](../reqall-context/SKILL.md).

Ordinary labelled input is a pending selection applied at the next context
boundary, not during active tools or generated persistence. Applied selections
are custom session entries restored from the active branch on
startup/resume/reload/fork; new sessions reset. Arguments to skills, including
`/skill:reqall-sleep project_name=.user`, are operation-specific and never select
the session project. `/skill:reqall-intend` follows the same rule.
