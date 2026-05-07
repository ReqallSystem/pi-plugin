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

### Automation

| Pi event | Behavior |
|---|---|
| `session_start` | Shows Reqall status in the footer |
| `before_agent_start` | Detects project, injects system prompt guidance, and (by default) fetches context via Reqall |
| `agent_end` | Reminds about persistence for non-trivial turns; can optionally queue a follow-up persistence turn |

### Commands

- `/reqall-context [query]` — fetch context and trigger a model turn with it
- `/reqall-persist [summary]` — ask the agent to classify and persist completed work
- `/reqall-review [filter]` — review open records
- `/reqall-triage [description]` — triage a new issue/request
- `/reqall-sleep [project-id-or-name]` — run SLEEP maintenance

### Skills

Skills are bundled under Pi-compatible names:

- `/skill:reqall-context`
- `/skill:reqall-persist`
- `/skill:reqall-document`
- `/skill:reqall-triage`
- `/skill:reqall-review`
- `/skill:reqall-sleep`

## Environment Variables

| Variable | Default | Description |
|---|---:|---|
| `REQALL_API_KEY` | required | Reqall API key (`rq_...`) |
| `REQALL_URL` | `https://www.reqall.net` | Reqall server base URL |
| `REQALL_API_URL` | unset | Fallback base URL if `REQALL_URL` is not set |
| `REQALL_PROJECT_NAME` | auto | Override project name |
| `REQALL_CONTEXT_LIMIT` | `5` | Semantic search result count for context injection |
| `REQALL_OPEN_LIMIT` | `25` | Open-record count for context injection |
| `REQALL_AUTO_CONTEXT` | `inject` | `inject`, `reminder`, or `off` |
| `REQALL_AUTO_PERSIST` | `reminder` | `reminder`, `followup`, or `off` |

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

`npm test` typechecks the extension, verifies the CLI manifest output, and runs `npm pack --dry-run`.

## License

MIT
