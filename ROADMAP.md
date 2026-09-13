# Remaining parity work

PR #1 is squash-merged as `acf3582`. The next changes are intentionally separate
so credential handling and persistence enforcement can receive focused review.

## 1. Project subscriptions (this branch)

- Schema-discovered automatic polling at the effective project boundary.
- Independent automatic/manual subscribers; originating write IDs are separate.
- Write-ahead pages with persisted-message receipts before acknowledgement.
- Reload/resume/fork and credential isolation; bounded polling and owned cleanup.
- Legacy compatibility without unsafe account/record-ID suppression.

See README for delivery/lifetime limits. There is no daemon or native SSE stream.

## 2. Dedicated Reqall OAuth (next PR)

Pi's provider `/login` is not an MCP OAuth login (Reqall #2363). Do not borrow
Claude/Codex tokens or introduce a fake model provider to get credential storage.

Implementation plan:

- Introduce a shared Reqall auth resolver used by tools, context, subscriptions
  and cleanup. Explicit `REQALL_API_KEY` takes precedence; diagnostics disclose
  the source without displaying credentials (#2366).
- Add explicit `/reqall-login` and `/reqall-logout` commands using discovered
  OAuth metadata and authorization-code PKCE (S256), state validation and a
  bounded loopback callback. Review the actual Reqall authorization server's
  discovery, registration, scopes and resource-binding contract first.
- Store only Reqall credentials in a dedicated private, atomic credential file
  under the Pi agent directory. Validate endpoints, bind issuer/resource, refuse
  credential-bearing redirects, and never log authorization codes/tokens.
- Serialize refresh, handle cancellation and expired/revoked grants, and preserve
  a stable grant identity across access-token rotation. The subscription state
  connection identity must not reset on every successful refresh. Login to a
  different grant/account must never inherit another grant's pending pages.
- Logout performs bounded owned subscription cleanup before forgetting/revoking
  the grant. An API-key override remains an environment credential and must be
  reported separately, not falsely described as logged out.

Acceptance tests: fake authorization/token/resource servers only; PKCE/state and
wrong callback attacks; resource/issuer mismatch; insecure redirects; concurrent
refresh and cancellation; private atomic storage; failed refresh/logout; API-key
precedence; subscription continuity and account switches. An interactive live
login is a separate user-driven acceptance step, not part of automated tests.

## 3. Enforced persistence (after shared auth)

Build on the existing proposal in Reqall #2337, not on a claim that Pi has Codex's
cancellable Stop hook. `agent_end` happens after model output and cannot retract
already-visible text.

Implementation plan:

- Track branch/project-local work revisions and trusted tool results. Distinguish
  successful mutations, executed failed commands, blocked/no-op edits, read-only
  inspection, Git bookkeeping, consulted records and agreed commitments.
- Record evidence inside the shared transport for automatic context calls as
  well as exposed tools; free-form model assertions are not proof.
- Add a structured `reqall_commit_persist_batch` protocol with stable client keys,
  outcome IDs, intended directed links, partial-save state and exact readback.
  Verify current-revision records and complete link pages before marking a batch
  complete. Existing record IDs must survive partial failures and compaction.
- Define uncertain-create recovery explicitly. Do not promise exactly-once writes
  or blindly retry a create unless the server actually supports an idempotency
  contract; search/read back and reconcile uncertain IDs instead.
- Use Pi-supported mutation gating and a bounded follow-up continuation. Keep
  root/subagent ownership clear; another session/project or an old revision must
  not satisfy the current contract. Surface pending/degraded status honestly.
- Provide explicit opt-out/degraded-outage behavior without silently marking
  persistence complete. Final-response visibility limitations must remain
  documented even when mutation and batch gates are enabled.

Acceptance tests: branching/reload/compaction/resume, streaming steering,
late/parallel tool results, no-op/failed shell classification, partial record/link
writes, readback mismatch and pagination, idempotent same-ID recovery, new work
after verification, outage recovery, opt-out and bounded non-looping follow-up.
