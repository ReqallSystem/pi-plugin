import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

const VALID_KINDS = ["issue", "spec", "arch", "test", "todo"] as const;
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

function detectProject(cwd: string): string {
	if (process.env.REQALL_PROJECT_NAME) return process.env.REQALL_PROJECT_NAME;

	try {
		const remote = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
		const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
		if (match?.[1]) return match[1];
	} catch {
		// Not a git repository, no remote, or git unavailable.
	}

	return basename(cwd);
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

	return responses.find((response) => response.id === id) ?? responses.find((response) => response.result || response.error);
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
		const match = parsed.find((response) => response.id === id) ?? parsed[0];
		if (!match) throw new Error("Reqall MCP returned an empty JSON-RPC batch");
		return match;
	}
	return parsed;
}

async function callReqallMcp(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
	const config = getConfig();
	if (!config.apiKey) {
		throw new Error("REQALL_API_KEY is required. Generate one from the Reqall dashboard and export it before launching pi.");
	}

	const id = Date.now() + Math.floor(Math.random() * 1000);
	const response = await fetch(`${config.url}/mcp`, {
		method: "POST",
		signal,
		headers: {
			"Authorization": `Bearer ${config.apiKey}`,
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: toolName, arguments: args },
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
	if (rpc.result.isError) throw new Error(contentToText(rpc.result) || `Reqall tool ${toolName} failed`);
	return rpc.result;
}

function toPiToolResult(toolName: string, result: McpToolResult): PiToolResult {
	const text = contentToText(result) || "(Reqall returned no text output.)";
	return {
		content: [{ type: "text", text }],
		details: { reqallTool: toolName },
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
		return { projectId: parseProjectId(projectText), projectText };
	} catch (error) {
		projectText = `Project upsert skipped/failed: ${error instanceof Error ? error.message : String(error)}`;
	}

	try {
		const projects = await callReqallMcp("list_projects", {}, signal);
		const listText = contentToText(projects);
		return { projectId: parseProjectIdFromList(listText, projectName), projectText: `${projectText}\n${listText}`.trim() };
	} catch {
		return { projectText };
	}
}

async function gatherProjectContext(query: string, cwd: string, signal?: AbortSignal, projectNameOverride?: string): Promise<string> {
	const config = getConfig();
	const projectName = projectNameOverride || detectProject(cwd);
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

	return sections.join("\n\n");
}

function reqallSystemPrompt(projectName: string): string {
	return `
## Reqall Memory Autopilot

Reqall is available through Pi tools named \`reqall_*\`. Current project name: \`${projectName}\`.

For non-trivial coding, bug fixing, refactoring, migration, architecture/spec, or test work:
1. At task start, use injected Reqall context if present. If context was not injected, call \`reqall_project_context\` with the user's task and project_name=\`${projectName}\`.
2. Before modifying a file or tracked behavior, call \`reqall_search\` with the file path, component, or behavior to find related specs/issues/architecture decisions.
3. Before your final response, persist meaningful completed work. Call \`reqall_upsert_project\` for \`${projectName}\`, then create/update one Reqall record per distinct work item with \`reqall_upsert_record\`; link related records with \`reqall_upsert_link\` when relationships are clear.
4. Persist verification evidence from tests/builds as kind=\`test\` when useful.
5. Prefer status transitions (resolved/archived) over deletion. Only call \`reqall_delete_record\` or \`reqall_delete_link\` when the user explicitly asks.

Classification defaults: bug fix -> issue/resolved; new unfixed bug -> issue/open; completed implementation -> todo/resolved; follow-up -> todo/open; architecture decision -> arch/resolved; new/updated spec -> spec/open; test/build evidence -> test/active or test/resolved.
`;
}

function buildPersistPrompt(projectName: string, summary?: string): string {
	return `[reqall] Mandatory persistence step for project_name="${projectName}".

Classify and persist all meaningful work completed in this Pi session:
1. Call reqall_upsert_project with name="${projectName}" and keep the returned project_id.
2. Identify distinct work items (files changed, bugs fixed/discovered, specs/architecture decisions, tests run/added, follow-up tasks).
3. For each non-trivial item, call reqall_upsert_record with the appropriate kind/status/title/body.
4. Search for related records and call reqall_upsert_link when a clear relationship exists.
5. Call reqall_list_records with the project_id to verify the records were persisted.
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
) {
	pi.registerTool({
		name,
		label,
		description,
		promptSnippet,
		promptGuidelines,
		parameters,
		async execute(_toolCallId, params, signal) {
			return executeReqallTool(mcpTool, params as Record<string, unknown>, signal);
		},
	});
}

export default function reqallPiPlugin(pi: ExtensionAPI) {
	let persistFollowupInProgress = false;

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
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default 5)." })),
		}),
		"Search persistent Reqall memory for relevant records",
		["Use reqall_search before changing tracked behavior or files to surface related specs, issues, and architecture decisions."],
	);

	registerMcpTool(
		pi,
		"reqall_upsert_project",
		"upsert_project",
		"Reqall Upsert Project",
		"Create, retrieve, or rename a Reqall project. Safe to call repeatedly. Returns a project id required by reqall_upsert_record and reqall_list_records.",
		Type.Object({
			id: Type.Optional(Type.Integer({ description: "Project ID to rename/update." })),
			name: Type.String({ description: "Project name, preferably org/repo from git remote or REQALL_PROJECT_NAME." }),
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
		"Analyze a project for knowledge-graph maintenance candidates: consolidation, rollups, splits, and cross-project links. Read-only and rate-limited; use reqall_sleep_apply to apply accepted operations.",
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
			operations: Type.Array(Type.Any({ description: "Operations from the SLEEP workflow: consolidate, compact, skip, split, or crosslink." })),
		}),
		"Apply Reqall knowledge-graph maintenance operations",
	);

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
			const text = await gatherProjectContext(input.query, ctx.cwd, signal, input.project_name);
			return { content: [{ type: "text", text }], details: { reqallTool: "project_context" } };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const config = getConfig();
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("reqall", config.apiKey ? theme.fg("success", "reqall") : theme.fg("warning", "reqall: no key"));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const config = getConfig();
		const projectName = detectProject(ctx.cwd);
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
			const context = await gatherProjectContext(event.prompt, ctx.cwd, ctx.signal, projectName);
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

		const projectName = detectProject(ctx.cwd);
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
			const context = await gatherProjectContext(query, ctx.cwd, ctx.signal);
			pi.sendMessage({ customType: "reqall-context", content: context, display: true }, { triggerTurn: true });
		},
	});

	pi.registerCommand("reqall-persist", {
		description: "Ask the agent to classify and persist completed work to Reqall",
		handler: async (args, ctx) => {
			pi.sendUserMessage(buildPersistPrompt(detectProject(ctx.cwd), args.trim() || undefined));
		},
	});

	pi.registerCommand("reqall-review", {
		description: "Review and triage open Reqall records for this project",
		handler: async (args, ctx) => {
			const projectName = detectProject(ctx.cwd);
			pi.sendUserMessage(`[reqall] Review open records for project_name="${projectName}". Use reqall_upsert_project, reqall_list_records${args.trim() ? ` with filter/instructions: ${args.trim()}` : ""}, reqall_get_record, reqall_upsert_record, and reqall_upsert_link as needed. Do not delete records unless explicitly requested.`);
		},
	});

	pi.registerCommand("reqall-triage", {
		description: "Triage a new issue/request into Reqall",
		handler: async (args, ctx) => {
			const projectName = detectProject(ctx.cwd);
			pi.sendUserMessage(`[reqall] Triage this incoming issue/request for project_name="${projectName}". Description: ${args.trim() || "Ask the user for the issue/request details."}\n\nClassify it, gather missing structured details, search for duplicates, determine priority, create/update a Reqall record, and link related records.`);
		},
	});

	pi.registerCommand("reqall-sleep", {
		description: "Run Reqall SLEEP knowledge-graph maintenance workflow",
		handler: async (args, ctx) => {
			const projectName = detectProject(ctx.cwd);
			pi.sendUserMessage(`[reqall] Run SLEEP maintenance for project_name="${projectName}". ${args.trim() ? `User argument: ${args.trim()}.` : "Resolve the project id first."}\n\nUse reqall_upsert_project or reqall_list_projects to get project_id, call reqall_sleep_candidates, reason through consolidation/compact/split/crosslink operations, then call reqall_sleep_apply with the safe operation batch. Summarize results.`);
		},
	});
}
