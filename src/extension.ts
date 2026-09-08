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
	askAnswerReason,
	askQuestionsFromInput,
	DEFAULT_DECK_PERMISSION_MODE,
	deckPermissionModeForOmp,
	deckStateForOmpEvent,
	deckUsageForOmp,
	promptOptionsForAsk,
	promptOptionsForToolCall,
	TOOL_GATE_OPTION_INDEX,
	toolGateTier,
	type AskQuestion,
	type DeckPermissionMode,
	type DeckPromptOptions,
	type DeckSessionState,
	type OmpApprovalMode,
} from "./mapping.js";

/** Minimal OMP context surface this binding drives. */
export interface BridgeCtx {
	abort(): void;
	isIdle(): boolean;
	ui: { notify(message: string): void };
	cwd?: string | undefined;
	model?: { id: string; name: string } | undefined;
	sessionManager?:
		| {
				getSessionId(): string;
				getUsageStatistics?(): { input: number; output: number; cost: number };
		  }
		| undefined;
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
	focusNowMs?: (() => number) | undefined;
	focusTerminal?: (() => Promise<void>) | undefined;
	onSessionRoute?: ((route: SessionRoute) => void) | undefined;
	onShutdown?: (() => void) | undefined;
}

export interface ToolCallResult {
	block?: boolean | undefined;
	reason?: string | undefined;
}

const DEFAULT_PORTS: number[] = [
	9120, 9121, 9122, 9123, 9124, 9125, 9126, 9127, 9128, 9129, 9130, 9131, 9132, 9133, 9134, 9135, 9136, 9137, 9138,
	9139,
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
	let toolCalls = 0;
	let startedAtMs = 0;
	let lastCtx: BridgeCtx | null = null;
	/** Tool OMP is executing right now (`tool_call` → `tool_result`/`agent_end`). */
	let runningTool: string | null = null;
	/**
	 * OMP exposes no approval-mode getter; `tool_approval_requested` carries
	 * it and fires only when a prompt is needed, so a yolo session keeps the default.
	 */
	let permissionMode: DeckPermissionMode = DEFAULT_DECK_PERMISSION_MODE;
	const gate = new ApprovalGate(
		deps.gateSchedule ??
			((fn, ms) => {
				const timer = setTimeout(fn, ms) as unknown as { unref?: () => void };
				timer.unref?.();
			}),
		deps.gateTimeoutMs ?? 25000,
	);
	const alwaysAllowedTools = new Set<string>();
	/** An `ask` call held open: the deck answers its questions one at a time. */
	interface AskHold {
		questions: AskQuestion[];
		answers: number[];
	}
	let pending: {
		requestId: string;
		tool: string;
		prompt: DeckPromptOptions;
		resolve: (result: ToolCallResult | undefined) => void;
		ask?: AskHold | undefined;
	} | null = null;

	/**
	 * Hold `toolName` behind a deck prompt. An unanswered hold releases to
	 * local handling (`undefined`): the tool runs, OMP's own UI takes over.
	 */
	const hold = (
		toolName: string,
		prompt: DeckPromptOptions,
		resolve: (result: ToolCallResult | undefined) => void,
		ask?: AskHold | undefined,
	) => {
		const { requestId } = gate.open(prompt.question, () => {
			if (pending?.requestId !== requestId) return;
			pending = null;
			push("processing");
			resolve(undefined);
		});
		// A replaced gate falls back to local instead of hanging.
		pending?.resolve(undefined);
		pending = { requestId, tool: toolName, prompt, resolve, ask };
		push(ask === undefined ? "awaiting_permission" : "awaiting_option");
		client?.forwardEvent({ type: "prompt_options", ...prompt, requestId });
	};

	/**
	 * The deck's one quick-send slot (`suggestedPrompt`, rendered only while
	 * idle). "Approved" is the reply the model asks for most; a press sends it
	 * as `send_prompt`.
	 */
	const IDLE_SUGGESTED_PROMPT = "Approved";

	const stateUpdate = (): PluginCommand => {
		const modelName = lastCtx?.model?.name;
		const tagged = {
			...(modelName === undefined ? {} : { modelName }),
			...(runningTool === null ? {} : { currentTool: runningTool }),
		};
		if (pending === null) {
			return {
				type: "state_update",
				state: deckState,
				permissionMode,
				...tagged,
				...(deckState === "idle" ? { suggestedPrompt: IDLE_SUGGESTED_PROMPT } : {}),
			};
		}
		return {
			type: "state_update",
			state: deckState,
			permissionMode,
			question: pending.prompt.question,
			options: pending.prompt.options,
			...tagged,
			currentTool: pending.tool,
		};
	};

	const push = (state: DeckSessionState) => {
		deckState = state;
		client?.pushState(state, permissionMode, lastCtx?.model?.name);
		client?.forwardEvent(stateUpdate());
	};

	const usageUpdate = (): BridgeEvent | null => {
		const stats = lastCtx?.sessionManager?.getUsageStatistics?.();
		if (stats === undefined) return null;
		return deckUsageForOmp({ stats, toolCalls, startedAtMs, nowMs: Date.now() });
	};

	const DENIED: ToolCallResult = { block: true, reason: "AgentDeck: denied from the connected dashboard." };
	const INTERRUPTED: ToolCallResult = { block: true, reason: "AgentDeck: interrupted from the connected dashboard." };

	/** Release the held gate. A blocked call never runs, so it stops being the current tool. */
	const settle = (result: ToolCallResult | undefined) => {
		if (!pending) return;
		const resolve = pending.resolve;
		pending = null;
		if (result?.block) runningTool = null;
		push("processing");
		resolve(result);
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
			const chosen = gate.answer(cmd.index, pending.requestId, pending.prompt.question, pending.prompt.options.length);
			if (chosen === null) return;
			if (pending.ask) {
				const { questions, answers } = pending.ask;
				answers.push(chosen);
				const next = questions[answers.length];
				if (next === undefined) {
					settle({ block: true, reason: askAnswerReason(questions, answers) });
				} else {
					const { tool, resolve } = pending;
					pending = null;
					hold(tool, promptOptionsForAsk(next), resolve, { questions, answers });
				}
				return;
			}
			if (chosen === TOOL_GATE_OPTION_INDEX.always) alwaysAllowedTools.add(pending.tool);
			if (chosen === TOOL_GATE_OPTION_INDEX.allow || chosen === TOOL_GATE_OPTION_INDEX.always) settle(undefined);
			else if (chosen === TOOL_GATE_OPTION_INDEX.deny) settle(DENIED);
		} else if (cmd.type === "respond" && typeof cmd.value === "string") {
			// A yes/no reply has no meaning for an ask question.
			if (pending?.ask) return;
			settle(/^(y|a)/i.test(cmd.value.trim()) ? undefined : DENIED);
		} else if (cmd.type === "send_prompt" && typeof cmd.text === "string") {
			pi.sendUserMessage(cmd.text);
		} else if (cmd.type === "interrupt" || cmd.type === "escape") {
			settle(INTERRUPTED);
			lastCtx?.abort();
		}
	};

	pi.on("tool_call", async (event, ctx) => {
		lastCtx = ctx;
		toolCalls += 1;
		const call = event as { toolName?: unknown; input?: unknown };
		const toolName = typeof call.toolName === "string" ? call.toolName : "tool";
		const input = (call.input ?? {}) as Record<string, unknown>;
		runningTool = toolName;
		push(deckStateForOmpEvent("tool_call"));
		if (!client?.isConnected || !client.isFocused) return undefined;
		const questions = toolName === "ask" ? askQuestionsFromInput(input) : null;
		if (toolName !== "ask" && (toolGateTier(toolName) === "read" || alwaysAllowedTools.has(toolName))) return undefined;
		return new Promise<ToolCallResult | undefined>((resolve) => {
			if (questions) hold(toolName, promptOptionsForAsk(questions[0]!), resolve, { questions, answers: [] });
			else hold(toolName, promptOptionsForToolCall(toolName, input), resolve);
		});
	});

	for (const event of ["before_agent_start", "agent_start"] as const) {
		pi.on(event, (_event, ctx) => {
			lastCtx = ctx;
			push(deckStateForOmpEvent(event));
		});
	}
	pi.on("tool_approval_requested", (event, ctx) => {
		lastCtx = ctx;
		if (event && typeof event === "object" && "approvalMode" in event) {
			const mode = event.approvalMode;
			if (mode === "always-ask" || mode === "write" || mode === "yolo") {
				permissionMode = deckPermissionModeForOmp(mode);
			}
		}
	});
	pi.on("tool_result", (_event, ctx) => {
		lastCtx = ctx;
		runningTool = null;
		push(deckStateForOmpEvent("tool_result"));
	});
	pi.on("agent_end", (_event, ctx) => {
		lastCtx = ctx;
		runningTool = null;
		push(deckStateForOmpEvent("agent_end"));
		const usage = usageUpdate();
		if (usage) client?.forwardEvent(usage);
	});
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
		startedAtMs = Date.now();
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
		const snapshot = (): BridgeEvent[] => {
			const usage = usageUpdate();
			return [
				stateUpdate(),
				...(usage ? [usage] : []),
				...(pending ? [{ type: "prompt_options", ...pending.prompt, requestId: pending.requestId }] : []),
			];
		};
		deps.onSessionRoute?.({ session, target, snapshot });
		client = new BridgeClient(
			session,
			{ ...target, sameSocketControl: true },
			deps.createSocket,
			deps.clientSchedule,
			deps.focusNowMs,
		);
		client.setReverseControl(applyCommand, snapshot);
		const focusTerminal = deps.focusTerminal;
		if (focusTerminal) {
			client.setOnFocus(() => {
				void focusTerminal().catch(() => {
					ctx.ui.notify("AgentDeck: failed to focus the Herdr pane.");
				});
			});
		}
		let warnedUnacked = false;
		client.setOnAckTimeout(() => {
			if (warnedUnacked) return;
			warnedUnacked = true;
			ctx.ui.notify("AgentDeck: daemon did not acknowledge registration (worker route unsupported?). Telemetry off.");
		});
		client.setOnConnect(() => {
			// Re-push the live state: first connect sends idle, a
			// reconnect resends whatever the session is doing now.
			push(deckState);
		});
		client.connect();
	});
}
