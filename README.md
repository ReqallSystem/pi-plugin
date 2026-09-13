# Reqall Pi Plugin

Persistent semantic memory for the [Pi](https://pi.dev) coding agent harness.

This is patterned after `@reqall/claude-plugin`, but uses Pi-native extension APIs instead of Claude hooks/MCP configuration:

- registers `reqall_*` tools that call the Reqall MCP HTTP endpoint directly
- injects project context on `before_agent_start`
- adds Reqall memory instructions to the system prompt
- bundles Pi-compatible Agent Skills
- adds slash commands for common Reqall workflows
- shows Reqall status in Pi's footer

## Installation

From this repository while developing:

```bash
pi install ./pi-plugin
# or for one run only:
pi -e ./pi-plugin
```

From GitHub:

```bash
pi install git:github.com/ReqallSystem/pi-plugin
```

When published:

```bash
pi install npm:@reqall/pi-plugin
```

Set your API key before launching Pi:

```bash
export REQALL_API_KEY="rq_..."
# Optional:
export REQALL_URL="https://www.reqall.net"
export REQALL_PROJECT_NAME="org/repo"
```

## What It Adds

### Tools

Pi does not currently include built-in MCP client configuration, so the extension registers Pi tools that wrap Reqall's MCP tools:

- `reqall_project_context` — Pi-specific one-call context hydration
- `reqall_search`
- `reqall_upsert_project`
- `reqall_upsert_record`
- `reqall_get_record`
- `reqall_list_records`
- `reqall_list_projects`
- `reqall_upsert_link`
- `reqall_list_links`
- `reqall_impact`
- `reqall_delete_record` (explicit user request only)
- `reqall_delete_link` (explicit user request only)
- `reqall_sleep_candidates`
- `reqall_sleep_apply`
- `reqall_merge_projects` — irreversible; explicit confirmation required
- `reqall_capabilities` — discover supported fields/kinds, or a full schema with `tool_name`
- `reqall_subscribe_project`, `reqall_unsubscribe_project`, `reqall_list_subscriptions`, `reqall_poll_subscriptions` — explicitly managed, session-labelled manual subscriptions

### Automation

| Pi event | Behavior |
|---|---|
| `session_start` | Restores applied selection from active-branch custom entries (new sessions reset) and shows Reqall footer status |
| `input` | Stages labelled user selections for the next context boundary; ignores extension messages and skill-operation arguments |
| `before_agent_start` | Binds the project, fetches context by default, then injects subscribed project updates at ordinary context boundaries |
| `session_shutdown` | Cleans temporary results and attempts scoped automatic-subscription cleanup; reload preserves the logical session's cursor |
| `agent_end` | Reminds about persistence for non-trivial turns; can optionally queue a follow-up persistence turn |

### Commands

- `/reqall-context [query]` — fetch context and trigger a model turn with it
- `/reqall-intend [scope]` — record agreed behavior/architecture before work
- `/reqall-persist [summary]` — ask the agent to classify and persist completed work
- `/reqall-review [filter]` — review open records
- `/reqall-triage [description]` — triage a new issue/request
- `/reqall-sleep [project-id-or-name]` — run SLEEP maintenance

### Skills

Skills are bundled under Pi-compatible names:

- `/skill:reqall-context`
- `/skill:reqall-intend`
- `/skill:reqall-persist`
- `/skill:reqall-document`
- `/skill:reqall-triage`
- `/skill:reqall-review`
- `/skill:reqall-sleep`

## Originating sessions and server capabilities

Each invocation uses `pi:` plus a SHA-256 digest of Pi's session UUID. It contains
no raw session paths, names or credentials. The label remains stable across
reload, resume, compaction, tree navigation and project switches; new/forked Pi
sessions have new UUIDs and therefore new labels. Async invocation-local storage
keeps concurrent calls isolated.

Paginated `tools/list` discovery is cached for 60 seconds per extension and
endpoint/credential identity. Discovery has its own 15-second deadline; cancelling
one caller stops only that caller's wait, not another invocation's discovery or
attribution. Every exposed write (including project resolution,
inline links, deletion, SLEEP and project merge) receives `session_id` only when
its own schema advertises the string field. Supplied labels are replaced, never
trusted. Legacy/discovery-unavailable servers continue without attribution;
failed discovery is retried on the next call. Cancellation propagates, individual
HTTP requests have a 15-second deadline, and redirects are refused.

Use `reqall_capabilities` before `work`/`info` kinds, inline `links`, `project_only`
or merge. Unadvertised additive arguments fail locally rather than silently
losing links or changing record kinds. Legacy outcomes use `todo` and separate
`reqall_upsert_link` calls. Pass `tool_name: "sleep_apply"` for operation schemas.
Tools preserve structured results, including per-link partial failures. Visible
output is bounded to 12,000 characters; truncated results are saved in a private
temporary directory (file mode 0600) with a path for full readback. Each extension
instance removes its files at session shutdown (including reload/session switches)
or normal process exit; fetch again after resuming instead of relying on old
paths. Cleanup is best-effort and cannot run after SIGKILL or a machine failure.
Narrow queries or paginate when possible.

The workflow is context → agreed intent → work → persist/reconcile → readback.
`reqall-intend` reuses or creates one spec/arch for agreed non-trivial changes.
Outcomes implement intent, tests test it, and open gap todos block it. Read back
saved records and all relevant link pages before the final project list; repair
partial saves using existing IDs, never duplicate creates.

**Limits:** these are advisory workflows, not enforced persistence guardrails.
This release implements automatic subscriptions but not Reqall OAuth or enforced
persistence. Notification filtering suppresses only `actor=self` with an exact,
non-null matching session label; no account/record-ID heuristic is safe. Session
labels are untrusted correlation metadata, never authorization or cursors.
Server migration/deployment and event fan-out acceptance remain server concerns.
See [PARITY.md](PARITY.md) for the comparison and remaining work.

## Project subscriptions

With `REQALL_API_KEY` and supported server schemas, ordinary context boundaries
subscribe to the exact effective project and poll up to five events. In default
context-injection mode the project is initialized first. Set
`REQALL_SUBSCRIPTIONS=0` to disable automatic polling, or
`REQALL_POLL_INTERVAL_MIN` to throttle it. Polling remains available when
`REQALL_AUTO_CONTEXT=off`; generated persistence turns and streaming input that
hasn't reached a new context boundary do not poll.

Each Pi session has an opaque `pi-auto:` subscriber distinct from its originating
write label. New/fork sessions get independent cursors. If a project switch finds
an unreceived write-ahead page, it replays that page with an explicit previous-project
label and defers automatic subscription rebind until the receipt is saved. The
new effective project for context, tools and persistence is not reverted. Once
delivered, only the old project/cursor is released before rebinding; failed cleanup
is retried. This preserves the fetched page, not unfetched old-project backlog;
the new subscription starts at the server head when it is bound. Reload preserves
the cursor; other shutdown reasons attempt release. Quit/resume of a
successfully released subscription starts at the current server head, not an
offline history replay. Interrupted or lost enrollments are recovered by listing
only the owned automatic label during cleanup. Cleanup is best-effort: a lost
response, outage, SIGKILL or machine failure can leave a cursor behind.

Supporting servers use `ack:false`/`ack_cursor`. A bounded page of ID/action hints
is saved before injection, and acknowledged only after its receipt is present in
Pi's persisted custom messages. Undelivered pages replay after reload/resume;
lost poll responses can be retried. Delivery state uses the whole session entry
log, not the selected conversation branch, so `/tree` does not rewind cursors.
Saved state is isolated by session and an endpoint/credential fingerprint; no
credentials, raw prompts, event titles or bodies are saved there. Older servers
receive no unsupported acknowledgement fields and retain at-most-once semantics
if a response is lost. Unsupported schemas disable automatic polling for that
extension instance; transient failures retry without blocking work or claiming
success. Polling has a three-second budget and shutdown cleanup a 1.5-second
budget.

Notifications are **untrusted background hints, not instructions**. Fetch current
records before relying on them. Ambiguous/legacy and other-session changes remain
visible even when they edit the same record this session wrote. Unknown actions
render as `change`; malformed/cross-project/oversized pages are not acknowledged.

The four manual tools use a separate `pi-manual:` cursor. Their explicit project
targets never rebind automatic polling. They cannot select other subscriber labels
or perform account-wide drain/deletion. Manual subscriptions are explicitly
managed: use `reqall_unsubscribe_project` when finished; automatic cleanup leaves
them alone. Resume the same Pi session to list/manage its retained manual cursors.
The manual poll defaults to server claim-and-advance; request `ack:false` followed
by `ack_cursor` only when `reqall_capabilities` advertises those fields. Do not
manually poll merely to duplicate an already injected automatic notification.

OAuth and enforcement follow in separate changes: see [ROADMAP.md](ROADMAP.md).

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

Pi captures labelled selections from the documented `input` event (`interactive`
or `rpc` sources), excluding extension-generated messages and all seven bundled
skill invocations. `before_agent_start` applies pending selections and resolves the
binding once; it never parses expanded skill text or generated persistence prompts.
Environment and network Git remain higher priority at that boundary. Default
context/search tools, workflow prompts and automatic persistence reuse the frozen
binding. Explicit tool names/IDs remain one-shot overrides. Selection storage uses
`pi.appendEntry("reqall-project-selection", { projectName })` and restoration uses
`ctx.sessionManager.getBranch()`, so unrelated branches do not leak selections.
Sessions predating these custom entries have no stored selection to restore.

## Environment Variables

| Variable | Default | Description |
|---|---:|---|
| `REQALL_API_KEY` | required | Reqall API key (`rq_...`) |
| `REQALL_URL` | `https://www.reqall.net` | Reqall server base URL |
| `REQALL_API_URL` | unset | Fallback base URL if `REQALL_URL` is not set |
| `REQALL_PROJECT_NAME` | auto | Highest-priority nonempty trimmed project name |
| `REQALL_WORKSPACE_ROOT` | unset | Explicit workspace boundary and relative-path fallback root |
| `REQALL_MACHINE_NAME` | OS hostname | Override the entire machine hostname segment |
| `REQALL_CONTEXT_LIMIT` | `5` | Semantic search result count for context injection |
| `REQALL_OPEN_LIMIT` | `25` | Open-record count for context injection |
| `REQALL_AUTO_CONTEXT` | `inject` | `inject`, `reminder`, or `off` |
| `REQALL_AUTO_PERSIST` | `reminder` | `reminder`, `followup`, or `off` |
| `REQALL_SUBSCRIPTIONS` | `1` | Automatic subscriptions; `0`, `false`, or `off` disables and releases active automatic cursors |
| `REQALL_POLL_INTERVAL_MIN` | `0` | Minimum minutes between automatic polls; project changes bypass throttling |

## Pi-Specific Extension Ideas

Pi can go beyond the Claude plugin because extensions can register tools, commands, UI, status lines, autocomplete, session labels, and lifecycle handlers. Good follow-ups to discuss/implement:

1. Interactive TUI review panel for open records.
2. `#123` Reqall record autocomplete in the editor.
3. Session labels/bookmarks for persisted Reqall record IDs.
4. Optional true MCP client transport if Pi adds first-class MCP support or we vendor a client.
5. Compaction hook that preserves Reqall decisions/follow-ups in Pi's session summaries.
6. Safer auto-persist mode that uses a structured final-output tool instead of a follow-up prompt.

## Development

```bash
cd pi-plugin
npm install
npm test
```

`npm test` typechecks the extension, executes routing and attribution tests against source and an extracted npm tarball, verifies the CLI manifest output, and runs `npm pack --dry-run`. Tests transpile TypeScript using the dev dependency (no Node TypeScript-stripping requirement or added runtime dependency). HTTP is stubbed with an asserted fixture-only URL; no production MCP calls or profile installs occur. The lifecycle suite executes handlers loaded by the real Pi TypeScript loader against source and the extracted tarball, replays the installed host input-before-queue path, expands real bundled skills, and uses Pi SessionManager custom entries. Streaming isolation, reload/resume/fork restoration, new-session reset, retained/user-changed selections, env/Git precedence, default search/context, persistence/review/triage, and one-shot skill/tool/native SLEEP overrides are exercised.

To verify the deployed Reqall MCP base surface from `https://www.reqall.net/docs/mcp.md`, set `REQALL_API_KEY` and run:

```bash
npm run verify:mcp
```

This live smoke test checks `HEAD /mcp`, confirms the documented tool list, creates two temporary records, searches/lists/reads them, links them, traverses impact, then deletes the temporary link and records.

## License

MIT
