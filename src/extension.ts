/**
 * OMP extension binding (depends on transport + pure mapping, never the reverse).
 *
 * v1 steering model: the tool_call gate is independent — an AgentDeck allow
 * releases the extension gate while OMP native policy stays authoritative; a
 * Deck deny blocks. Timeout, disconnect, and stale answers fail closed to the
 * local OMP flow, never to remote allow.
 */
import {
	ApprovalGate,
	BridgeClient,
	probeDaemons,
	type BridgeEvent,
	type ClientSession,
	type ClientTarget,
	type DaemonHealth,
	type PluginCommand,
	type PushSocketLike,
	type SessionRoute,
} from "./agentdeck.js";
import {
	deckStateForOmpEvent,
	promptOptionsForToolCall,
	type DeckPromptOptions,
	type DeckSessionState,
} from "./mapping.js";

/** Minimal OMP context surface this binding drives. */
export interface BridgeCtx {
	abort(): void;
	isIdle(): boolean;
	ui: { notify(message: string): void };
	cwd?: string | undefined;
	sessionManager?: { getSessionId(): string } | undefined;
}

/** Minimal OMP extension API surface this binding uses. */
export interface BridgePi {
	on(event: string, handler: (event: unknown, ctx: BridgeCtx) => unknown): void;
	sendUserMessage(content: string, options?: { deliverAs?: string }): void;
}
export interface BridgeDeps {
	sessionId?: string | undefined;
	bridgePort: number;
	projectName?: string | undefined;
	host?: string | undefined;
	ports?: number[] | undefined;
	fetchHealth: (port: number) => Promise<DaemonHealth | null>;
	createSocket: (target: ClientTarget) => PushSocketLike;
	gateSchedule?: ((fn: () => void, ms: number) => void) | undefined;
	gateTimeoutMs?: number | undefined;
	clientSchedule?: ((fn: () => void, ms: number) => void) | undefined;
	onSessionRoute?: ((route: SessionRoute) => void) | undefined;
	onShutdown?: (() => void) | undefined;
}

export interface ToolCallResult {
	block?: boolean | undefined;
	reason?: string | undefined;
}

const DEFAULT_PORTS: number[] = [
	9120, 9121, 9122, 9123, 9124, 9125, 9126, 9127, 9128, 9129,
	9130, 9131, 9132, 9133, 9134, 9135, 9136, 9137, 9138, 9139,
];

/** Last path segment; mirrors the daemon's own project-name fallback. */
function basename(path: string): string | undefined {
	const segment = path.split("/").filter(Boolean).pop();
	return segment === undefined || segment === "" ? undefined : segment;
}

/** Resolve the stable session id: explicit config, start event, manager, uuid. */
function resolveSessionId(event: unknown, ctx: BridgeCtx, explicit?: string | undefined): string {
	if (explicit) return explicit;
	const fromEvent = (event as { sessionId?: unknown } | null)?.sessionId;
	if (typeof fromEvent === "string" && fromEvent !== "") return fromEvent;
	const fromManager = ctx.sessionManager?.getSessionId();
	if (typeof fromManager === "string" && fromManager !== "") return fromManager;
	return `omp-${crypto.randomUUID()}`;
}

/** Register OMP lifecycle handlers that mirror this session to AgentDeck. */
export function registerBridge(pi: BridgePi, deps: BridgeDeps): void {
	let client: BridgeClient | null = null;
	let deckState: DeckSessionState = "idle";
	let lastCtx: BridgeCtx | null = null;
	const gate = new ApprovalGate(deps.gateSchedule ?? ((fn, ms) => {
		const timer = setTimeout(fn, ms) as unknown as { unref?: () => void };
		timer.unref?.();
	}), deps.gateTimeoutMs ?? 25000);
	let pending: {
		requestId: string;
		tool: string;
		prompt: DeckPromptOptions;
		resolve: (result: ToolCallResult | undefined) => void;
	} | null = null;

	const stateUpdate = (): PluginCommand =>
		pending === null
			? { type: "state_update", state: deckState, permissionMode: "default" }
			: {
					type: "state_update",
					state: "awaiting_permission",
					permissionMode: "default",
					tool: pending.tool,
					question: pending.prompt.question,
					options: pending.prompt.options,
				};

	const push = (state: DeckSessionState) => {
		deckState = state;
		client?.pushState(state);
		client?.forwardEvent(stateUpdate());
	};

	const applyCommand = (cmd: PluginCommand) => {
		if ((cmd.type === "select_option" || cmd.type === "respond") && pending !== null) {
			// Legacy daemon commands omit correlation echoes. Because this
			// bridge holds one gate, omission is accepted; any supplied mismatch is not.
			if (cmd.requestId !== undefined && cmd.requestId !== pending.requestId) return;
			if (cmd.question !== undefined && cmd.question !== pending.prompt.question) return;
		}
		if (cmd.type === "select_option" && typeof cmd.index === "number") {
			if (!pending) return;
			const decision = gate.decide(cmd.index, pending.requestId, pending.prompt.question);
			if (decision === "allow") {
				const resolve = pending.resolve;
				pending = null;
				push("processing");
				resolve(undefined);
			} else if (decision === "deny") {
				const resolve = pending.resolve;
				pending = null;
				push("processing");
				resolve({ block: true, reason: "AgentDeck: denied from the connected dashboard." });
			}
		} else if (cmd.type === "respond" && typeof cmd.value === "string") {
			if (!pending) return;
			const allow = /^(y|a)/i.test(cmd.value.trim());
			const resolve = pending.resolve;
			pending = null;
			push("processing");
			resolve(allow ? undefined : { block: true, reason: "AgentDeck: denied from the connected dashboard." });
		} else if (cmd.type === "send_prompt" && typeof cmd.text === "string") {
			pi.sendUserMessage(cmd.text);
		} else if (cmd.type === "interrupt" || cmd.type === "escape") {
			const resolve = pending?.resolve;
			pending = null;
			if (resolve) {
				push("processing");
				resolve({
					block: true,
					reason: "AgentDeck: interrupted from the connected dashboard.",
				});
			}
			lastCtx?.abort();
		}
	};

	pi.on("tool_call", async (event, ctx) => {
		lastCtx = ctx;
		const call = event as { toolName?: unknown; input?: unknown };
		const toolName = typeof call.toolName === "string" ? call.toolName : "tool";
		const input = (call.input ?? {}) as Record<string, unknown>;
		push(deckStateForOmpEvent("tool_call"));
		if (!client?.isConnected || !client.isFocused) return undefined;
		const prompt = promptOptionsForToolCall(toolName, input);
		return new Promise<ToolCallResult | undefined>((resolve) => {
			const { requestId } = gate.open(prompt.question, () => {
				if (pending?.requestId !== requestId) return;
				pending = null;
				push("processing");
				resolve(undefined);
			});
			// A replaced gate falls back to local instead of hanging.
			pending?.resolve(undefined);
			pending = { requestId, tool: toolName, prompt, resolve };
			push("awaiting_permission");
			client?.forwardEvent({ type: "prompt_options", ...prompt, requestId });
		});
	});

	for (const event of ["before_agent_start", "agent_start", "tool_result", "agent_end"] as const) {
		pi.on(event, (_event, ctx) => {
			lastCtx = ctx;
			push(deckStateForOmpEvent(event));
		});
	}
	pi.on("session_shutdown", () => {
		const resolve = pending?.resolve;
		pending = null;
		push("disconnected");
		resolve?.(undefined);
		client?.close();
		client = null;
		deps.onShutdown?.();
	});

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		const target = await probeDaemons(deps.ports ?? DEFAULT_PORTS, deps.fetchHealth);
		if (!target) {
			ctx.ui.notify("AgentDeck: v1 requires the Node daemon (sameSocketControl). Telemetry off.");
			return;
		}
		const session: ClientSession = {
			sessionId: resolveSessionId(event, ctx, deps.sessionId),
			port: deps.bridgePort,
			projectName: deps.projectName ?? (ctx.cwd === undefined ? undefined : basename(ctx.cwd)),
			host: deps.host,
		};
		// Live snapshot: the same frames the worker emits on focus_down. Shared
		// with the loopback relay so this endpoint paints authoritative local
		// state; the closure reads live gate state, never a cached copy.
		const snapshot = (): BridgeEvent[] => [
			stateUpdate(),
			...(pending ? [{ type: "prompt_options", ...pending.prompt, requestId: pending.requestId }] : []),
		];
		deps.onSessionRoute?.({ session, target, snapshot });
		client = new BridgeClient(
			session,
			{ ...target, sameSocketControl: true },
			deps.createSocket,
			deps.clientSchedule,
		);
		client.setReverseControl(applyCommand, snapshot);
		client.setOnConnect(() => {
			// Re-push the live state: first connect sends idle, a
			// reconnect resends whatever the session is doing now.
			push(deckState);
		});
		client.connect();
	});
}
