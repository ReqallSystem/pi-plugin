# Claude/Codex parity review

Scope: Reqall #5843 and the sibling `../claude-plugin` / `../codex-plugin`
working copies inspected for this change. Those working copies can contain
unreleased changes; this is not a claim about marketplace deployments.

## Delivered in this PR

| Area | Pi update |
|---|---|
| Originating writes (#5843) | Stable opaque Pi-session digest, invocation-local attribution, per-tool schema discovery, no unsupported session field on older servers. Covers every exposed write, including automatic project upsert, inline links, deletes, SLEEP and merge. |
| Session lifecycle | Host UUID survives reload/resume/compaction/project changes; new/fork sessions get distinct labels. No credentials, paths or raw host IDs in labels. |
| Schema parity | `work`/`info`, inline links (20 maximum), strict-project search, confirmed project merges and `reqall_capabilities`. Additive arguments require positive advertisement. |
| Response handling | Structured and JSON-text project identities and errors; structured partial link results remain visible; bounded output; matching RPC IDs; deadlines and refused redirects. |
| Intent | New Pi-native command/skill. Reuse one agreed spec/arch, skip chores/questions; preserve the effective binding. |
| Persistence | Guidance for outcome/intent reconciliation, exact record and paginated link readback, same-ID partial-save repair, legacy kind/link fallback, honest failure disclosure. |
| SLEEP | Modern work-log promotion/discard guidance; inspect advertised schemas/candidates; explicit project-merge confirmation. `sleep_candidates` is not described as strictly read-only. |
| Portable project identity | Preserved the pre-existing local implementation and tests in a separate baseline commit; intent skill arguments follow its one-operation routing rule. |

## Remaining gaps (not implemented or claimed)

1. **Automatic project subscriptions.** Claude/Codex subscribe/poll at turn
   boundaries and manage project-specific cursors. Pi has no subscription
   wrappers or background polling yet. Add schema-discovered tools, bounded
   event pages, durable acknowledgement/deduplication state, project rebind and
   shutdown cleanup. Keep subscriber/cursor identity separate from write origin.
   Only suppress `actor=self` AND exact non-null own `session_id`. Retain unknown,
   legacy, other-account and other-session edits even to a record we wrote.
   `isOwnEvent` is tested groundwork, not an active notification pipeline. Do not
   copy Claude's older own-record-ID heuristic, even as a legacy fallback.
2. **Enforced, branch-local persistence.** Codex tracks work revisions,
   commitments, partial saves and verified readbacks; Claude uses bounded Stop
   retries and intent tracking. Pi currently offers prompt guidance and the
   existing optional single follow-up, not proof of persistence or a mutation
   gate. Reqall #2337 already proposes `reqall_commit_persist_batch`, deterministic
   client keys, branch-local evidence and idempotent finalization. Implement that
   explicitly rather than pretending `agent_end` is a cancellable Stop hook.
3. **Durable intent/evidence tracking and compaction handoff.** The new intent
   skill records memory remotely, but Pi does not maintain a commitment ledger or
   automatically reconcile IDs after compaction. Preserve consulted-vs-agreed
   distinctions and same-ID partial recovery when adding the ledger.
4. **Activity/noise classification.** Guidance excludes routine successful
   git add/commit/push bookkeeping. The existing broad `looksNonTrivial` detector
   still nudges on any Bash activity. Replace it with structured successful tool
   evidence and a narrow read/bookkeeping classifier; failed/executed commands
   can still mutate, while blocked/no-op edits must not count as success.
5. **OAuth and auth diagnostics.** Pi tools still use only process
   `REQALL_API_KEY`. Claude/Codex host-owned MCP OAuth cannot be copied into Pi's
   provider `/login`. Reqall #2363 documents the distinction; #2366 tracks safe
   auth-source diagnostics. A dedicated PKCE/token-storage/refresh design is
   separate work. Never read another harness's credentials.
6. **Background documentation / pre-edit context.** Claude has throttled hooks
   and a documenter subagent; Codex has root/subagent evidence boundaries. Pi has
   advisory search-before-edit guidance and a document skill, not those hooks or
   subagent ownership guarantees.
7. **Broader MCP surface.** Native resource subscriptions, project sharing,
   connector OAuth and dynamic registration of every server tool are not in
   this wrapper. Discover schemas deliberately rather than blindly exposing
   every future/destructive tool.

## Verification and boundaries

- `npm test`: TypeScript, 12 routing/lifecycle/attribution tests on source and
  again on the extracted npm package, plus package assertions (13 top-level
  tests). All network tests use an asserted fixture-only endpoint.
- Real Pi SessionManager persistence is exercised for resume/reload and forks;
  compaction and new sessions preserve/renew origin as appropriate. Two sessions
  on one account write the same record concurrently with distinct labels.
- Tests cover all exposed writes, context/command upserts, inline links,
  capability pagination/cache isolation, legacy/discovery failures, denied writes,
  structured/JSON-text results, partial link visibility and cancellation.
- Installed pi 0.85.1: isolated offline RPC startup loaded all six commands with
  no extension errors and no Reqall/provider request. Existing 0.73-era dev
  dependencies remain; this smoke check is not a full multi-version SDK matrix.
- Read-only production `tools/list` confirmed advertised `session_id` on all
  seven write tools and `work`/`info` kinds. No destructive production smoke test,
  SLEEP run, merge, migration or subscription change was performed.
- The client tests demonstrate propagation, not server transaction/fan-out
  correctness, deployment acceptance, exactly-once delivery or OAuth support.
  Keep cross-plugin #5843 open until the other integrations and server acceptance
  are complete.
