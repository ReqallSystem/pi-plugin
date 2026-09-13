import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Capabilities, originatingSession } from "./capabilities.js";
import { extractProjectHint, resolveProjectBinding } from "./project-policy.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

const VALID_KINDS = ["issue", "spec", "arch", "test", "todo", "info", "work"] as const;
const VALID_KINDS_WITH_ALL = [...VALID_KINDS, "all"] as const;
const VALID_STATUSES = ["open", "resolved", "archived", "active", "inactive"] as const;
const VALID_STATUSES_WITH_ALL = [...VALID_STATUSES, "all"] as const;
const VALID_RELATIONSHIPS = ["blocks", "implements", "tests", "parent", "related"] as const;
const VALID_ENTITY_TYPES = ["records", "projects"] as const;
const VALID_DIRECTIONS = ["outgoing", "incoming", "both"] as const;

interface McpContentPart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface McpToolResult {
	content?: McpContentPart[];
	isError?: boolean;
	[key: string]: unknown;
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: unknown;
	result?: McpToolResult;
	error?: { code?: number; message?: string; data?: unknown };
}

interface PiToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

interface ReqallConfig {
	apiKey?: string;
	url: string;
	contextLimit: number;
	openLimit: number;
	autoContext: "inject" | "reminder" | "off";
	autoPersist: "reminder" | "followup" | "off";
}

function getConfig(): ReqallConfig {
	const autoContextRaw = (process.env.REQALL_AUTO_CONTEXT ?? "inject").toLowerCase();
	const autoPersistRaw = (process.env.REQALL_AUTO_PERSIST ?? "reminder").toLowerCase();
	return {
		apiKey: process.env.REQALL_API_KEY || undefined,
		url: (process.env.REQALL_URL || process.env.REQALL_API_URL || "https://www.reqall.net").replace(/\/+$/, ""),
		contextLimit: parseInt(process.env.REQALL_CONTEXT_LIMIT || "", 10) || 5,
		openLimit: parseInt(process.env.REQALL_OPEN_LIMIT || "", 10) || 25,
		autoContext: autoContextRaw === "0" || autoContextRaw === "false" || autoContextRaw === "off"
			? "off"
			: autoContextRaw === "reminder"
				? "reminder"
				: "inject",
		autoPersist: autoPersistRaw === "0" || autoPersistRaw === "false" || autoPersistRaw === "off"
			? "off"
			: autoPersistRaw === "followup"
				? "followup"
				: "reminder",
	};
}

function contentToText(result: McpToolResult | undefined): string {
	if (!result?.content?.length) return "";
	return result.content
		.map((part) => {
			if (part.type === "text" && typeof part.text === "string") return part.text;
			return JSON.stringify(part);
		})
		.join("\n");
}

function parseSseResponse(text: string, id: number): JsonRpcResponse | undefined {
	const responses: JsonRpcResponse[] = [];
	let currentData: string[] = [];

	const flush = () => {
		if (currentData.length === 0) return;
		const payload = currentData.join("\n").trim();
		currentData = [];
		if (!payload || payload === "[DONE]") return;
		try {
			responses.push(JSON.parse(payload) as JsonRpcResponse);
		} catch {
			// Ignore non-JSON SSE messages.
		}
	};

	for (const line of text.split(/\r?\n/)) {
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith("data:")) currentData.push(line.slice(5).trimStart());
	}
	flush();

	return responses.find((response) => response.id === id);
}

function parseJsonRpcResponse(text: string, id: number): JsonRpcResponse {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Reqall MCP returned an empty response");

	if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
		const parsed = parseSseResponse(trimmed, id);
		if (parsed) return parsed;
		throw new Error("Reqall MCP returned an SSE response without a JSON-RPC payload");
	}

	const parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
	if (Array.isArray(parsed)) {
		const match = parsed.find((response) => response.id === id);
		if (!match) throw new Error("Reqall MCP returned an empty JSON-RPC batch");
		return match;
	}
	if (parsed.id !== id) throw new Error("Reqall MCP response id mismatch");
	return parsed;
}

export default function reqallPiPlugin(pi: ExtensionAPI) {
	// Invocation-local identity survives awaits without leaking between parallel calls.
	const originContext = new AsyncLocalStorage<string>();
	const withOrigin = <T>(ctx: ExtensionContext, fn: () => T): T =>
		originContext.run(originatingSession(ctx.sessionManager.getSessionId()), fn);
	const capabilities = new Capabilities(request);
	const capabilityIdentity = () => JSON.stringify([getConfig().url, getConfig().apiKey]);

async function callReqallMcp(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
	const origin = originContext.getStore();
	if (!origin) throw new Error("Reqall call has no originating Pi session");
	const attributed = await capabilities.arguments(capabilityIdentity(), toolName, args, origin, signal);
	return request("tools/call", { name: toolName, arguments: attributed }, signal);
}

async function request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
	const config = getConfig();
	if (!config.apiKey) {
		throw new Error("REQALL_API_KEY is required. Generate one from the Reqall dashboard and export it before launching pi.");
	}

	const id = Date.now() + Math.floor(Math.random() * 1000);
	const response = await fetch(`${config.url}/mcp`, {
		method: "POST",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
		redirect: "error",
		headers: {
			"Authorization": `Bearer ${config.apiKey}`,
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		let message = text || `${response.status} ${response.statusText}`;
		try {
			const payload = JSON.parse(text) as { message?: string; error?: string };
			message = payload.message ?? payload.error ?? message;
		} catch {
			// Keep the raw message.
		}
		throw new Error(`Reqall MCP HTTP ${response.status}: ${message}`);
	}

	const rpc = parseJsonRpcResponse(text, id);
	if (rpc.error) {
		throw new Error(`Reqall MCP error ${rpc.error.code ?? ""}: ${rpc.error.message ?? "unknown error"}`.trim());
	}
	if (!rpc.result) throw new Error("Reqall MCP response did not include a tool result");
	if (rpc.result.isError || structuredPayload(rpc.result)?.ok === false) {
		throw new Error(contentToText(rpc.result) || `Reqall ${method} failed`);
	}
	return rpc.result;
}

function structuredPayload(result: McpToolResult): Record<string, any> | undefined {
	if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Record<string, any>;
	try {
		const parsed = JSON.parse(contentToText(result));
		if (parsed && typeof parsed === "object") return parsed;
	} catch { /* Older servers return human-readable text. */ }
	return undefined;
}

function boundedText(full: string): string {
	let text = full;
	if (full.length > 12_000) {
		const path = join(mkdtempSync(join(tmpdir(), "reqall-output-")), "result.txt");
		writeFileSync(path, full, { mode: 0o600 });
		text = `${full.slice(0, 12_000)}\n[Reqall output truncated; full result: ${path}. Read it before verification.]`;
	}
	return text;
}

function toPiToolResult(toolName: string, result: McpToolResult): PiToolResult {
	const full = [contentToText(result), result.structuredContent ? JSON.stringify(result.structuredContent) : ""].filter(Boolean).join("\n\n") || "(Reqall returned no text output.)";
	return {
		content: [{ type: "text", text: boundedText(full) }],
		details: { reqallTool: toolName, structuredContent: result.structuredContent },
	};
}

async function executeReqallTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<PiToolResult> {
	return toPiToolResult(toolName, await callReqallMcp(toolName, args, signal));
}

function parseProjectId(text: string): number | undefined {
	const projectMatch = text.match(/(?:Project|project)\s+#(\d+)/);
	if (projectMatch?.[1]) return Number(projectMatch[1]);
	const firstHash = text.match(/^#(\d+)\s+/m);
	return firstHash?.[1] ? Number(firstHash[1]) : undefined;
}

function parseProjectIdFromList(text: string, projectName: string): number | undefined {
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^#(\d+)\s+(.+?)(?:\s+\(shared\))?$/);
		if (match?.[1] && match[2] === projectName) return Number(match[1]);
	}
	return undefined;
}

async function resolveProjectId(projectName: string, signal?: AbortSignal): Promise<{ projectId?: number; projectText: string }> {
	let projectText = "";
	try {
		const upsert = await callReqallMcp("upsert_project", { name: projectName }, signal);
		projectText = contentToText(upsert);
		const project = structuredPayload(upsert)?.data?.project;
		const projectId = Number.isSafeInteger(project?.id) && project.id > 0 ? project.id : parseProjectId(projectText);
		if (projectId !== undefined) return { projectId, projectText };
	} catch (error) {
		projectText = `Project upsert skipped/failed: ${error instanceof Error ? error.message : String(error)}`;
	}

	try {
		const projects = await callReqallMcp("list_projects", {}, signal);
		const listText = contentToText(projects);
		const projectsData = structuredPayload(projects)?.data?.projects;
		const project = Array.isArray(projectsData) ? projectsData.find(p => p.name === projectName && Number.isSafeInteger(p.id) && p.id > 0) : undefined;
		return { projectId: project?.id ?? parseProjectIdFromList(listText, projectName), projectText: `${projectText}\n${listText}`.trim() };
	} catch {
		return { projectText };
	}
}

async function gatherProjectContext(query: string, projectName: string, signal?: AbortSignal): Promise<string> {
	const config = getConfig();
	const sections: string[] = [`[reqall] Project: ${projectName}`];

	const { projectId, projectText } = await resolveProjectId(projectName, signal);
	if (projectText) sections.push(`## Project\n${projectText}`);

	try {
		const search = await callReqallMcp("search", {
			query,
			project_name: projectName,
			limit: config.contextLimit,
		}, signal);
		sections.push(`## Relevant Records\n${contentToText(search) || "No results found."}`);
	} catch (error) {
		sections.push(`## Relevant Records\nSearch failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (projectId !== undefined) {
		try {
			const open = await callReqallMcp("list_records", {
				project_id: projectId,
				status: "open",
				limit: config.openLimit,
			}, signal);
			sections.push(`## Open Records\n${contentToText(open) || "No open records found."}`);
		} catch (error) {
			sections.push(`## Open Records\nList failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		sections.push("## Open Records\nProject id unavailable; call reqall_list_projects or reqall_upsert_project if open-record enumeration is needed.");
	}

	return boundedText(sections.join("\n\n"));
}

function reqallSystemPrompt(projectName: string): string {
	return `
## Reqall Memory Autopilot

Reqall is available through Pi tools named \`reqall_*\`. Current project name: \`${projectName}\`.

For non-trivial coding, bug fixing, refactoring, migration, architecture/spec, or test work:
1. At task start, use injected Reqall context if present. If context was not injected, call \`reqall_project_context\` with the user's task and project_name=\`${projectName}\`.
2. For agreed non-trivial new behavior or architecture, follow the reqall-intend skill: search/reuse or create one spec/arch with acceptance criteria before implementation. Skip chores, questions and routine fixes. Before modifying a file or tracked behavior, call \`reqall_search\` with the file path, component, or behavior to find related specs/issues/architecture decisions.
3. Before your final response, persist meaningful completed work. Call \`reqall_upsert_project\` for \`${projectName}\`, then create/update one Reqall record per distinct work item with \`reqall_upsert_record\`; link related records with \`reqall_upsert_link\` when relationships are clear.
4. Persist verification evidence from tests/builds as kind=\`test\` when useful.
5. Prefer status transitions (resolved/archived) over deletion. Only call \`reqall_delete_record\` or \`reqall_delete_link\` when the user explicitly asks.

Call reqall_capabilities before using additive features. Prefer work/resolved for session outcomes and info for durable reference notes only when advertised; legacy outcomes use todo/resolved. Inline links require advertised support. Link fulfilled intent with implements, tests with tests, and open gaps with todo --blocks--> intent. Inspect every inline link result; repair partial saves using existing record IDs, never duplicate creates. Verify each record with reqall_get_record and all relevant reqall_list_links pages, then project-scoped reqall_list_records. Transport success alone is not verified persistence. Disclose failures; do not claim memory was saved when unavailable.

Session attribution is injected automatically by the transport only for schemas advertising session_id; do not supply your own. It is untrusted correlation metadata, not authorization or a subscription cursor.

Classification defaults: bug fix -> issue/resolved; new unfixed bug -> issue/open; follow-up -> todo/open; architecture decision -> arch/resolved; new/updated spec -> spec/open; test/build evidence -> test/active or test/resolved. Successful routine git add/commit/push bookkeeping alone does not merit another record; keep existing pending work.
`;
}

function buildPersistPrompt(projectName: string, summary?: string): string {
	return `[reqall] Mandatory persistence step for project_name="${projectName}".

Classify and persist all meaningful work completed in this Pi session:
1. Call reqall_upsert_project with name="${projectName}" and keep the returned project_id.
2. Identify distinct work items (files changed, bugs fixed/discovered, specs/architecture decisions, tests run/added, follow-up tasks).
3. For each non-trivial item, call reqall_upsert_record with the appropriate kind/status/title/body.
4. Search for related records and call reqall_upsert_link when a clear relationship exists.
5. Reconcile agreed intent: outcomes implement it, tests test it, and open todos block remaining gaps. Prefer advertised work/info kinds and inline links after reqall_capabilities; otherwise use legacy kinds and reqall_upsert_link. Inspect every link result, repair with existing IDs, read back each record and all relevant link pages, then call reqall_list_records with the project_id. Report partial persistence honestly.
6. Report what was persisted and any remaining open follow-ups.

${summary ? `User-provided summary:\n${summary}` : "Use the conversation and tool history as the source of truth."}`;
}

function looksNonTrivial(messages: unknown): boolean {
	const text = JSON.stringify(messages).toLowerCase();
	return [
		'"toolname":"write"',
		'"toolname":"edit"',
		'"toolname":"bash"',
		'"name":"write"',
		'"name":"edit"',
		'"name":"bash"',
		"reqall_upsert_record",
		"reqall_upsert_link",
	].some((needle) => text.includes(needle));
}

function registerMcpTool(
	pi: ExtensionAPI,
	name: string,
	mcpTool: string,
	label: string,
	description: string,
	parameters: ReturnType<typeof Type.Object>,
	promptSnippet?: string,
	promptGuidelines?: string[],
	defaultProject?: (cwd: string) => string,
) {
	pi.registerTool({
		name,
		label,
		description,
		promptSnippet,
		promptGuidelines,
		parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args = { ...params } as Record<string, unknown>;
			if (defaultProject && !args.project_name) args.project_name = defaultProject(ctx.cwd);
			return withOrigin(ctx, () => executeReqallTool(mcpTool, args, signal));
		},
	});
}

	let persistFollowupInProgress = false;
	let selectedProject = "";
	let pendingProject = "";
	let activeProject = "";
	const resolveProject = (cwd: string) => resolveProjectBinding(cwd, process.env, "", selectedProject).name;
	const effectiveProject = (cwd: string) => activeProject || resolveProject(cwd);

	// InputEvent.source distinguishes user input from extension-generated followups.
	pi.on("input", async (event) => {
		// Skill arguments describe one operation, not a session project switch.
		const skillOperation = /^\/skill:reqall-(?:context|intend|persist|document|review|triage|sleep)(?:\s|$)/.test(event.text);
		if (event.source !== "extension" && !skillOperation) {
			const hint = extractProjectHint(event.text);
			if (hint) pendingProject = hint;
		}
		return { action: "continue" };
	});

	registerMcpTool(
		pi,
		"reqall_search",
		"search",
		"Reqall Search",
		"Search Reqall records by semantic meaning. Use for relevant project context, related decisions, prior work, file-specific specs/issues, and duplicate detection. Returns summary lines only; call reqall_get_record for full details.",
		Type.Object({
			query: Type.String({ description: "Natural language query; describe what you need conceptually, or pass a file path/component name before modifying it." }),
			kind: Type.Optional(StringEnum(VALID_KINDS_WITH_ALL)),
			project_name: Type.Optional(Type.String({ description: "Project name (e.g. org/repo) to prefer in results; other projects can still appear." })),
			project_only: Type.Optional(Type.Boolean({ description: "Restrict results to project_name; requires advertised server support." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default 5)." })),
		}),
		"Search persistent Reqall memory for relevant records",
		["Use reqall_search before changing tracked behavior or files to surface related specs, issues, and architecture decisions."],
		effectiveProject,
	);

	registerMcpTool(
		pi,
		"reqall_upsert_project",
		"upsert_project",
		"Reqall Upsert Project",
		"Create, retrieve, or rename a Reqall project. Safe to call repeatedly. Returns a project id required by reqall_upsert_record and reqall_list_records.",
		Type.Object({
			id: Type.Optional(Type.Integer({ description: "Project ID to rename/update." })),
			name: Type.String({ description: "Exact effective project name supplied by Reqall context, or a deliberate operation-specific target." }),
		}),
		"Create or retrieve the current Reqall project",
	);

	registerMcpTool(
		pi,
		"reqall_upsert_record",
		"upsert_record",
		"Reqall Upsert Record",
		"Persist or update an issue, spec, architecture decision, test scenario, or todo. Use this before final response for meaningful completed work and follow-ups. Server embeds content and deduplicates similar records.",
		Type.Object({
			id: Type.Optional(Type.Integer({ description: "Record ID to update. If provided, all other fields are optional." })),
			project_id: Type.Optional(Type.Integer({ description: "Project ID; required for creating records." })),
			kind: Type.Optional(StringEnum(VALID_KINDS)),
			title: Type.Optional(Type.String({ maxLength: 500, description: "Short title with prefix like BUG:, TASK:, ARCH:, FEAT:, REFACTOR:, TEST:. Required for create." })),
			body: Type.Optional(Type.String({ maxLength: 32000, description: "Detailed context, rationale, file paths, commands, outcomes, and follow-ups." })),
			status: Type.Optional(StringEnum(VALID_STATUSES)),
			links: Type.Optional(Type.Array(Type.Object({
				target_id: Type.Integer(),
				target_table: Type.Optional(StringEnum(VALID_ENTITY_TYPES)),
				relationship: StringEnum(VALID_RELATIONSHIPS),
				direction: Type.Optional(StringEnum(["outgoing", "incoming"] as const)),
			}), { maxItems: 20, description: "Inline links, only when reqall_capabilities advertises support. Inspect each link result; partial errors require same-ID repair." })),
		}),
		"Persist completed work, decisions, specs, issues, todos, and tests",
		["Use reqall_upsert_record before the final response to persist meaningful non-trivial work completed in the session."],
	);

	registerMcpTool(
		pi,
		"reqall_get_record",
		"get_record",
		"Reqall Get Record",
		"Retrieve full details for one Reqall record by id, including body. Use after reqall_search or reqall_list_records when a summary may be relevant.",
		Type.Object({ id: Type.Integer({ description: "Record ID." }) }),
		"Read full details for a Reqall record",
	);

	registerMcpTool(
		pi,
		"reqall_list_records",
		"list_records",
		"Reqall List Records",
		"List Reqall records with structured filters by project, kind, and status. Prefer reqall_search for relevance; use this to enumerate open work or verify persistence.",
		Type.Object({
			kind: Type.Optional(StringEnum(VALID_KINDS_WITH_ALL)),
			status: Type.Optional(StringEnum(VALID_STATUSES_WITH_ALL)),
			project_id: Type.Optional(Type.Integer({ description: "Project ID to filter by." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max records (default 50)." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Pagination offset." })),
		}),
		"Enumerate Reqall records by project, kind, or status",
	);

	registerMcpTool(
		pi,
		"reqall_list_projects",
		"list_projects",
		"Reqall List Projects",
		"List projects visible to the authenticated Reqall user. Use when a project id is needed and the project name is unknown.",
		Type.Object({}),
		"List available Reqall projects",
	);

	registerMcpTool(
		pi,
		"reqall_upsert_link",
		"upsert_link",
		"Reqall Upsert Link",
		"Create or update a directed link between records or projects. Use links to connect specs to implementations, tests to decisions, blockers to dependents, parent/child records, or generally related items.",
		Type.Object({
			id: Type.Optional(Type.Integer({ description: "Link ID to update." })),
			source_id: Type.Integer({ description: "Source entity ID." }),
			source_table: StringEnum(VALID_ENTITY_TYPES),
			target_id: Type.Integer({ description: "Target entity ID." }),
			target_table: StringEnum(VALID_ENTITY_TYPES),
			relationship: StringEnum(VALID_RELATIONSHIPS),
		}),
		"Link related Reqall records or projects",
	);

	registerMcpTool(
		pi,
		"reqall_list_links",
		"list_links",
		"Reqall List Links",
		"Discover dependencies, implementations, parent/child relationships, and related records for one record or project. Direction is relative to the queried entity.",
		Type.Object({
			entity_id: Type.Integer({ description: "Record or project ID to inspect." }),
			entity_type: Type.Optional(StringEnum(VALID_ENTITY_TYPES)),
			direction: Type.Optional(StringEnum(VALID_DIRECTIONS)),
			relationship: Type.Optional(StringEnum(VALID_RELATIONSHIPS)),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		"List graph links for a Reqall record or project",
	);

	registerMcpTool(
		pi,
		"reqall_impact",
		"impact",
		"Reqall Impact",
		"Answer what would be affected if an entity changes. Traverses outgoing links from a starting record or project and returns downstream records/projects sorted by depth.",
		Type.Object({
			entity_id: Type.Integer({ description: "Starting record or project ID." }),
			entity_type: Type.Optional(StringEnum(VALID_ENTITY_TYPES)),
			max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Max link hops (default 5)." })),
			relationship: Type.Optional(StringEnum(VALID_RELATIONSHIPS)),
		}),
		"Traverse Reqall links to assess downstream impact",
	);

	registerMcpTool(
		pi,
		"reqall_delete_record",
		"delete_record",
		"Reqall Delete Record",
		"Permanently delete a Reqall record and all links referencing it. Destructive and irreversible: only use when the user explicitly asks. Prefer reqall_upsert_record with status resolved or archived.",
		Type.Object({ id: Type.Integer({ description: "Record ID to delete." }) }),
	);

	registerMcpTool(
		pi,
		"reqall_delete_link",
		"delete_link",
		"Reqall Delete Link",
		"Delete a Reqall link by id. Destructive: only use when the user explicitly asks. Connected records/projects remain unchanged.",
		Type.Object({ id: Type.Integer({ description: "Link ID to delete." }) }),
	);

	registerMcpTool(
		pi,
		"reqall_sleep_candidates",
		"sleep_candidates",
		"Reqall SLEEP Candidates",
		"Analyze a project for knowledge-graph maintenance candidates. May refresh density/link-diff audits; rate-limited, not strictly read-only. Inspect returned operations before reqall_sleep_apply.",
		Type.Object({ project_id: Type.Integer({ description: "Project ID to analyze." }) }),
		"Find Reqall knowledge-graph maintenance candidates",
	);

	registerMcpTool(
		pi,
		"reqall_sleep_apply",
		"sleep_apply",
		"Reqall SLEEP Apply",
		"Apply SLEEP knowledge-graph maintenance operations. Safety invariants are enforced server-side. Use only after inspecting reqall_sleep_candidates and reasoning about operations.",
		Type.Object({
			project_id: Type.Integer({ description: "Project ID." }),
			operations: Type.Array(Type.Any({ description: "Server-supported SLEEP operations from inspected candidates; may include promote/discard work logs and merge_projects. Never invent unsupported operation shapes." })),
		}),
		"Apply Reqall knowledge-graph maintenance operations",
	);

	registerMcpTool(
		pi, "reqall_merge_projects", "merge_projects", "Reqall Merge Projects",
		"Irreversibly merge owned source projects into target_id, deleting sources. Only after explicit user confirmation. Requires advertised server support.",
		Type.Object({ target_id: Type.Integer(), source_ids: Type.Array(Type.Integer(), { minItems: 1, maxItems: 20 }) }),
	);

	pi.registerTool({
		name: "reqall_capabilities",
		label: "Reqall Capabilities",
		description: "Discover server tool schemas before using work/info kinds, inline links or project_only. Attribution is injected automatically when advertised; never supply a session_id yourself.",
		parameters: Type.Object({ tool_name: Type.Optional(Type.String({ description: "MCP tool name (without reqall_) for its full advertised schema, e.g. sleep_apply." })) }),
		async execute(_id, params, signal) {
			const tools = await capabilities.discover(capabilityIdentity(), signal);
			const summary = params.tool_name
				? tools.get(params.tool_name) ?? { unavailable: params.tool_name }
				: [...tools.values()].map(t => ({ name: t.name, fields: Object.keys(t.inputSchema?.properties || {}), kinds: t.inputSchema?.properties?.kind?.enum }));
			return toPiToolResult("capabilities", { content: [{ type: "text", text: JSON.stringify(summary) }] });
		},
	});

	pi.registerCommand("reqall-intend", {
		description: "Record agreed behavior or architecture before implementation",
		handler: async (args, ctx) => {
			pi.sendUserMessage(`[reqall] Record agreed intent for project_name=${JSON.stringify(effectiveProject(ctx.cwd))}. ${args.trim()}\nRead the reqall-intend skill. Search first; reuse or create one spec/arch with acceptance criteria only for agreed non-trivial behavior/architecture, not chores or questions. Reconcile outcomes against it before final handoff.`);
		},
	});

	pi.registerTool({
		name: "reqall_project_context",
		label: "Reqall Project Context",
		description: "Pi-specific convenience tool: detect or accept a project name, upsert/list the project, semantically search for context, and list open records in one call. Use at task start for non-trivial work.",
		promptSnippet: "Gather current project context from Reqall in one call",
		promptGuidelines: ["Use reqall_project_context at the start of non-trivial tasks when injected Reqall context is absent or stale."],
		parameters: Type.Object({
			query: Type.String({ description: "The user's task or a concise query for relevant context." }),
			project_name: Type.Optional(Type.String({ description: "Override detected project name." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as { query: string; project_name?: string };
			const text = await withOrigin(ctx, () => gatherProjectContext(input.query, input.project_name?.trim() || effectiveProject(ctx.cwd), signal));
			return { content: [{ type: "text", text }], details: { reqallTool: "project_context" } };
		},
	});

	const restoreProjectSelection = (ctx: ExtensionContext, isNew = false) => {
		selectedProject = "";
		if (!isNew) {
			// Custom entries stay out of model context and follow the active branch.
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== "reqall-project-selection") continue;
				const data = entry.data as { projectName?: unknown } | undefined;
				if (typeof data?.projectName === "string" && data.projectName.trim()) selectedProject = data.projectName.trim();
			}
		}
		pendingProject = "";
		activeProject = "";
		persistFollowupInProgress = false;
	};

	// Pi emits session_tree only after navigation succeeds, in the same instance.
	pi.on("session_tree", async (_event, ctx) => {
		restoreProjectSelection(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		restoreProjectSelection(ctx, event.reason === "new");
		if (!ctx.hasUI) return;
		const config = getConfig();
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("reqall", config.apiKey ? theme.fg("success", "reqall") : theme.fg("warning", "reqall: no key"));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const config = getConfig();
		// Pi emits input before queuing streaming followups. Bind only at a new
		// context boundary, never mid-run or for generated persistence followups.
		if (!event.prompt.startsWith("[reqall]")) {
			if (pendingProject && pendingProject !== selectedProject) {
				selectedProject = pendingProject;
				pi.appendEntry("reqall-project-selection", { projectName: selectedProject });
			}
			pendingProject = "";
			activeProject = resolveProject(ctx.cwd);
		} else if (!activeProject) {
			activeProject = resolveProject(ctx.cwd);
		}
		const projectName = effectiveProject(ctx.cwd);
		const systemPrompt = `${event.systemPrompt}\n${reqallSystemPrompt(projectName)}`;

		if (config.autoContext === "off" || event.prompt.startsWith("[reqall]")) {
			return { systemPrompt };
		}

		if (config.autoContext === "reminder" || !config.apiKey) {
			const keyNote = config.apiKey ? "" : "\n\nREQALL_API_KEY is not set, so Reqall tools will fail until the key is exported before launching pi.";
			return {
				systemPrompt,
				message: {
					customType: "reqall-context",
					content: `[reqall] Project: ${projectName}\nUse reqall_project_context with query=${JSON.stringify(event.prompt)} before non-trivial work.${keyNote}`,
					display: true,
					details: { projectName, mode: "reminder" },
				},
			};
		}

		try {
			if (ctx.hasUI) ctx.ui.setStatus("reqall", ctx.ui.theme.fg("accent", "reqall: context"));
			const context = await withOrigin(ctx, () => gatherProjectContext(event.prompt, projectName, ctx.signal));
			if (ctx.hasUI) ctx.ui.setStatus("reqall", ctx.ui.theme.fg("success", "reqall"));
			return {
				systemPrompt,
				message: {
					customType: "reqall-context",
					content: context,
					display: true,
					details: { projectName, mode: "inject" },
				},
			};
		} catch (error) {
			if (ctx.hasUI) ctx.ui.setStatus("reqall", ctx.ui.theme.fg("warning", "reqall: context failed"));
			return {
				systemPrompt,
				message: {
					customType: "reqall-context",
					content: `[reqall] Automatic context retrieval failed: ${error instanceof Error ? error.message : String(error)}\nCall reqall_project_context manually if needed.`,
					display: true,
					details: { projectName, mode: "failed" },
				},
			};
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const config = getConfig();
		if (config.autoPersist === "off") return;
		if (persistFollowupInProgress) {
			persistFollowupInProgress = false;
			return;
		}
		if (!looksNonTrivial(event.messages)) return;

		const projectName = effectiveProject(ctx.cwd);
		if (config.autoPersist === "followup") {
			persistFollowupInProgress = true;
			pi.sendUserMessage(buildPersistPrompt(projectName), { deliverAs: "followUp" });
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify("Reqall: persist meaningful completed work before final handoff (or set REQALL_AUTO_PERSIST=followup).", "warning");
		}
	});

	pi.registerCommand("reqall-context", {
		description: "Fetch Reqall context for this project and query",
		handler: async (args, ctx) => {
			const query = args.trim() || (ctx.hasUI ? ctx.ui.getEditorText() : "") || "current project context";
			const context = await withOrigin(ctx, () => gatherProjectContext(query, effectiveProject(ctx.cwd), ctx.signal));
			pi.sendMessage({ customType: "reqall-context", content: context, display: true }, { triggerTurn: true });
		},
	});

	pi.registerCommand("reqall-persist", {
		description: "Ask the agent to classify and persist completed work to Reqall",
		handler: async (args, ctx) => {
			pi.sendUserMessage(buildPersistPrompt(effectiveProject(ctx.cwd), args.trim() || undefined));
		},
	});

	pi.registerCommand("reqall-review", {
		description: "Review and triage open Reqall records for this project",
		handler: async (args, ctx) => {
			const projectName = effectiveProject(ctx.cwd);
			pi.sendUserMessage(`[reqall] Review open records for project_name="${projectName}". Use reqall_upsert_project, reqall_list_records${args.trim() ? ` with filter/instructions: ${args.trim()}` : ""}, reqall_get_record, reqall_upsert_record, and reqall_upsert_link as needed. Do not delete records unless explicitly requested.`);
		},
	});

	pi.registerCommand("reqall-triage", {
		description: "Triage a new issue/request into Reqall",
		handler: async (args, ctx) => {
			const projectName = effectiveProject(ctx.cwd);
			pi.sendUserMessage(`[reqall] Triage this incoming issue/request for project_name="${projectName}". Description: ${args.trim() || "Ask the user for the issue/request details."}\n\nClassify it, gather missing structured details, search for duplicates, determine priority, create/update a Reqall record, and link related records.`);
		},
	});

	pi.registerCommand("reqall-sleep", {
		description: "Run Reqall SLEEP knowledge-graph maintenance workflow",
		handler: async (args, ctx) => {
			const argument = args.trim();
			const target = /^\d+$/.test(argument)
				? `project_id=${argument}`
				: `project_name=${JSON.stringify(argument || effectiveProject(ctx.cwd))}`;
			pi.sendUserMessage(`[reqall] Run SLEEP maintenance for ${target}. This is an operation-specific target; do not change the session project.\n\nUse the supplied project_id, or reqall_upsert_project or reqall_list_projects to resolve the exact project_name to project_id. Call reqall_sleep_candidates, reason through consolidation/compact/split/crosslink operations, then call reqall_sleep_apply with the safe operation batch. Summarize results.`);
		},
	});
}
