import { createHash } from "node:crypto";

export interface ToolSchema {
	name: string;
	inputSchema?: { properties?: Record<string, { type?: string; enum?: unknown[] }> };
}
export type RpcRequest = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;

/** Correlation only: never expose a session path, user name, credential or raw host ID. */
export function originatingSession(hostSessionId: string): string {
	if (!hostSessionId) throw new Error("Pi session identity unavailable");
	return `pi:${createHash("sha256").update(hostSessionId).digest("hex")}`;
}

/** Do not use actor alone, remembered record IDs, or the subscription cursor as ownership. */
export function isOwnEvent(event: { actor?: unknown; session_id?: unknown }, origin: string): boolean {
	return !!origin && event.actor === "self" && typeof event.session_id === "string" && event.session_id === origin;
}

/** Cancel only this waiter, not the shared discovery or other invocations. */
function waitForDiscovery<T>(value: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return value;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => { cleanup(); reject(signal.reason); };
		signal.addEventListener("abort", onAbort, { once: true });
		value.then(
			result => { cleanup(); resolve(result); },
			error => { cleanup(); reject(error); },
		);
	});
}

export class Capabilities {
	private cached?: { identity: string; expires: number; value: Promise<Map<string, ToolSchema>> };
	constructor(private request: RpcRequest) {}

	async discover(identity: string, signal?: AbortSignal): Promise<Map<string, ToolSchema>> {
		signal?.throwIfAborted();
		if (this.cached?.identity === identity && this.cached.expires > Date.now()) {
			return waitForDiscovery(this.cached.value, signal);
		}
		// Discovery owns its deadline; no invocation may cancel the shared request.
		const value = this.load(AbortSignal.timeout(15_000));
		const entry = { identity, expires: Date.now() + 60_000, value };
		this.cached = entry;
		void value.catch(() => {
			if (this.cached === entry) this.cached = undefined;
		});
		return waitForDiscovery(value, signal);
	}

	private async load(signal?: AbortSignal): Promise<Map<string, ToolSchema>> {
		const tools = new Map<string, ToolSchema>();
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 20; page++) {
			const result = await this.request("tools/list", cursor ? { cursor } : {}, signal);
			if (!Array.isArray(result.tools)) throw new Error("Invalid Reqall tools/list response");
			for (const tool of result.tools) {
				if (tool && typeof tool.name === "string") tools.set(tool.name, tool);
			}
			if (result.nextCursor === undefined) return tools;
			if (typeof result.nextCursor !== "string" || seen.has(result.nextCursor)) throw new Error("Invalid Reqall tools/list cursor");
			cursor = result.nextCursor;
			seen.add(cursor);
		}
		throw new Error("Reqall tools/list pagination limit exceeded");
	}

	async arguments(identity: string, name: string, input: Record<string, unknown>, origin: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const args = { ...input };
		// The extension owns attribution; model-supplied values must never impersonate another session.
		delete args.session_id;
		let tools: Map<string, ToolSchema> | undefined;
		try { tools = await this.discover(identity, signal); }
		catch (error) { if (signal?.aborted) throw error; /* Legacy servers may not support discovery. */ }
		if (name === "merge_projects" && !tools?.has(name)) throw new Error("Reqall merge_projects is not advertised by this server");
		const properties = tools?.get(name)?.inputSchema?.properties;
		// Additive features must be positively discovered, never silently discarded or downgraded.
		for (const field of ["links", "project_only", "ack", "ack_cursor"]) {
			if (args[field] !== undefined && !properties?.[field]) throw new Error(`Reqall ${name}.${field} is not advertised; use legacy tools or retry reqall_capabilities.`);
		}
		if ((args.kind === "work" || args.kind === "info") && !properties?.kind?.enum?.includes(args.kind)) {
			throw new Error(`Reqall ${name} does not advertise kind=${args.kind}; choose a supported legacy kind.`);
		}
		if (properties?.session_id?.type === "string") args.session_id = origin;
		return args;
	}
}
