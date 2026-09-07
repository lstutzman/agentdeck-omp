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
	type ClientTarget,
	type DaemonHealth,
	type PluginCommand,
	type PushSocketLike,
} from "./agentdeck.js";
import {
	deckStateForOmpEvent,
	promptOptionsForToolCall,
	type DeckSessionState,
} from "./mapping.js";

/** Minimal OMP context surface this binding drives. */
export interface BridgeCtx {
	abort(): void;
	isIdle(): boolean;
	notify(message: string): void;
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
	let pending: { requestId: string; question: string; resolve: (result: ToolCallResult | undefined) => void } | null =
		null;

	const push = (state: DeckSessionState) => {
		deckState = state;
		client?.pushState(state);
	};

	const applyCommand = (cmd: PluginCommand) => {
		if (cmd.type === "select_option" && typeof cmd.index === "number") {
			if (!pending) return;
			const decision = gate.decide(cmd.index, typeof cmd.requestId === "string" ? cmd.requestId : pending.requestId, pending.question);
			if (decision === "allow") {
				const resolve = pending.resolve;
				pending = null;
				resolve(undefined);
			} else if (decision === "deny") {
				const resolve = pending.resolve;
				pending = null;
				resolve({ block: true, reason: "AgentDeck: denied from the connected dashboard." });
			}
		} else if (cmd.type === "respond" && typeof cmd.value === "string") {
			if (!pending) return;
			const allow = /^(y|a)/i.test(cmd.value.trim());
			const resolve = pending.resolve;
			pending = null;
			resolve(allow ? undefined : { block: true, reason: "AgentDeck: denied from the connected dashboard." });
		} else if (cmd.type === "send_prompt" && typeof cmd.text === "string") {
			pi.sendUserMessage(cmd.text);
		} else if (cmd.type === "interrupt" || cmd.type === "escape") {
			lastCtx?.abort();
		}
		// navigate_option / switch_mode: acknowledged no-ops in v1.
	};

	pi.on("tool_call", async (event, ctx) => {
		lastCtx = ctx;
		const call = event as { toolName?: unknown; input?: unknown };
		const toolName = typeof call.toolName === "string" ? call.toolName : "tool";
		const input = (call.input ?? {}) as Record<string, unknown>;
		push(deckStateForOmpEvent("tool_call"));
		if (!client?.isConnected || !client.isFocused) return undefined;
		const { question, options } = promptOptionsForToolCall(toolName, input);
		return new Promise<ToolCallResult | undefined>((resolve) => {
			const { requestId } = gate.open(question, () => {
				if (pending?.requestId !== requestId) return;
				pending = null;
				resolve(undefined);
			});
			pending = { requestId, question, resolve };
			client?.forwardEvent({ type: "prompt_options", question, options, requestId });
		});
	});

	for (const event of ["before_agent_start", "agent_start", "tool_result", "agent_end"] as const) {
		pi.on(event, (_event, ctx) => {
			lastCtx = ctx;
			push(deckStateForOmpEvent(event));
		});
	}
	pi.on("session_shutdown", () => {
		push("disconnected");
		client?.close();
		client = null;
	});

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		const target = await probeDaemons(deps.ports ?? DEFAULT_PORTS, deps.fetchHealth);
		if (!target) {
			ctx.notify("AgentDeck: v1 requires the Node daemon (sameSocketControl). Telemetry off.");
			return;
		}
		client = new BridgeClient(
			{
				sessionId: resolveSessionId(event, ctx, deps.sessionId),
				port: deps.bridgePort,
				projectName: deps.projectName ?? (ctx.cwd === undefined ? undefined : basename(ctx.cwd)),
				host: deps.host,
			},
			{ ...target, sameSocketControl: true },
			deps.createSocket,
		);
		client.setReverseControl(applyCommand, () => [
			{ type: "state_update", state: deckState },
			...(pending ? [{ type: "prompt_options", question: pending.question, options: ["Allow", "Deny"], requestId: pending.requestId }] : []),
		]);
		client.setOnConnect(() => {
			push("idle");
		});
		client.connect();
	});
}
