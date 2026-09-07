/**
 * AgentDeck push-channel transport (no OMP imports).
 *
 * Mirrors the worker side of the Node daemon protocol (`daemon-ws-client.ts`
 * + `session-focus-relay.ts`): register/state frames up, focus and command
 * frames down on the same socket, relayed events back up while focused.
 * `remoteAttach` is sent only when the daemon advertises `sameSocketControl`
 * (Node daemon); a capability-less daemon (Swift) gets a plain local-style
 * registration.
 */
import { decisionFromSelectOption, type DeckDecision } from "./mapping.js";

export interface RegisterArgs {
	sessionId: string;
	port: number;
	projectName?: string | undefined;
	host?: string | undefined;
	weight?: number | undefined;
	sameSocketControl?: boolean | undefined;
}

export interface SessionPushRegister {
	type: "session_push_register";
	sessionId: string;
	port: number;
	projectName?: string | undefined;
	host?: string | undefined;
	remoteAttach?: boolean | undefined;
	weight: number;
}

/** Build the `session_push_register` frame. Always sends a concrete weight. */
export function buildRegisterFrame(args: RegisterArgs): SessionPushRegister {
	return {
		type: "session_push_register",
		sessionId: args.sessionId,
		port: args.port,
		projectName: args.projectName,
		host: args.host,
		remoteAttach: args.sameSocketControl === true ? true : undefined,
		weight: args.weight ?? 0,
	};
}

export interface PushStateArgs {
	sessionId: string;
	state: string;
	modelName?: string | undefined;
}

export interface SessionPushState {
	type: "session_push_state";
	sessionId: string;
	state: string;
	modelName?: string | undefined;
}

/** Build the `session_push_state` frame. Omits `modelName` when unknown. */
export function buildPushState(args: PushStateArgs): SessionPushState {
	return args.modelName === undefined
		? { type: "session_push_state", sessionId: args.sessionId, state: args.state }
		: {
				type: "session_push_state",
				sessionId: args.sessionId,
				state: args.state,
				modelName: args.modelName,
			};
}

export interface DaemonHealth {
	port: number;
	mode?: string | undefined;
	sameSocketControl?: boolean | undefined;
}

export interface DaemonTarget {
	host: string;
	port: number;
}

/**
 * Pick the first reachable Node daemon. Accepts only `mode:'daemon'` with
 * `sameSocketControl:true`; v1 refuses the Swift daemon with a null (the
 * caller reports “v1 requires the Node daemon”).
 */
export function selectDaemonTarget(candidates: DaemonHealth[]): DaemonTarget | null {
	for (const c of candidates) {
		if (c.mode === "daemon" && c.sameSocketControl === true) {
			return { host: "127.0.0.1", port: c.port };
		}
	}
	return null;
}


/**
 * Sweep candidate ports for a capable daemon. `fetchHealth` returns the
 * `/health` payload or null when unreachable; all ports are probed so the
 * sweep observes the full window, then the first capable daemon wins.
 */
export async function probeDaemons(
	ports: number[],
	fetchHealth: (port: number) => Promise<DaemonHealth | null>,
): Promise<DaemonTarget | null> {
	const candidates: DaemonHealth[] = [];
	for (const port of ports) {
		try {
			const health = await fetchHealth(port);
			if (health) candidates.push({ ...health, port });
		} catch {
			// Unreachable port: skip.
		}
	}
	return selectDaemonTarget(candidates);
}
export interface ClientSession {
	sessionId: string;
	port: number;
	projectName?: string | undefined;
	host?: string | undefined;
	weight?: number | undefined;
}

export interface ClientTarget extends DaemonTarget {
	sameSocketControl?: boolean | undefined;
}


/**
 * DOM-style socket surface (real `WebSocket`). Handler slots are `unknown`
 * because DOM handler variance runs opposite to this adapter's needs; the
 * single cast in `adaptSocket` is the documented boundary.
 */
export interface WebSocketLike {
	readonly readyState: number;
	onopen: unknown;
	onclose: unknown;
	onmessage: unknown;
	send(data: string): void;
	close(): void;
}

/** Adapt a DOM-style WebSocket to the string-message surface the client drives. */
export function adaptSocket(ws: WebSocketLike): PushSocketLike {
	const socket: PushSocketLike = {
		get readyState() {
			return ws.readyState;
		},
		onopen: null,
		onclose: null,
		onmessage: null,
		send: (data) => ws.send(data),
		close: () => ws.close(),
	};
	const handlers = ws as unknown as {
		onopen: (() => void) | null;
		onclose: (() => void) | null;
		onmessage: ((event: { data: unknown }) => void) | null;
	};
	handlers.onopen = () => socket.onopen?.();
	handlers.onclose = () => socket.onclose?.();
	handlers.onmessage = (event) => socket.onmessage?.(typeof event.data === "string" ? event.data : String(event.data));
	return socket;
}
/** Minimal socket surface the client drives (real `WebSocket` satisfies it). */
export interface PushSocketLike {
	readonly readyState: number;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onmessage: ((data: string) => void) | null;
	send(data: string): void;
	close(): void;
}

/** Events the daemon relays from a focused session (shared set, both ends). */
const RELAYED_EVENT: Record<string, true> = {
	state_update: true,
	prompt_options: true,
	usage_update: true,
};

export interface BridgeEvent {
	type: string;
	[key: string]: unknown;
}

export interface PluginCommand {
	type: string;
	[key: string]: unknown;
}

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

/** Push-channel worker: registers, tracks ack, forwards while focused. */
export class BridgeClient {
	private socket: PushSocketLike | null = null;
	private registered = false;
	private focused = false;
	private closed = false;
	private applyCommand: ((cmd: PluginCommand) => void) | null = null;
	private focusSnapshot: (() => BridgeEvent[]) | null = null;
	private onConnect: (() => void) | null = null;
	private reconnectDelay = RECONNECT_BASE_MS;

	constructor(
		private readonly session: ClientSession,
		private readonly target: ClientTarget,
		private readonly createSocket: (target: ClientTarget) => PushSocketLike,
		private readonly schedule: (fn: () => void, ms: number) => void = setTimeout,
	) {}

	get isConnected(): boolean {
		return this.socket?.readyState === 1 && this.registered;
	}

	get isFocused(): boolean {
		return this.focused;
	}

	connect(): void {
		if (this.closed) return;
		const socket = this.createSocket(this.target);
		this.socket = socket;
		socket.onopen = () => {
			this.reconnectDelay = RECONNECT_BASE_MS;
			socket.send(
				JSON.stringify(
					buildRegisterFrame({ ...this.session, sameSocketControl: this.target.sameSocketControl }),
				),
			);
		};
		socket.onmessage = (data: string) => {
			let msg: { type?: unknown; sessionId?: unknown; command?: PluginCommand };
			try {
				msg = JSON.parse(data);
			} catch {
				return;
			}
			if (msg.sessionId !== this.session.sessionId) return;
			if (msg.type === "session_push_ack") {
				if (!this.registered) {
					this.registered = true;
					this.onConnect?.();
				}
			} else if (msg.type === "session_focus_down") {
				this.focused = true;
				for (const evt of this.focusSnapshot?.() ?? []) this.sendEventUp(evt);
			} else if (msg.type === "session_unfocus_down") {
				this.focused = false;
			} else if (msg.type === "session_command_down") {
				if (msg.command) this.applyCommand?.(msg.command);
			}
		};
		socket.onclose = () => {
			this.registered = false;
			this.focused = false;
			if (this.closed) return;
			const delay = this.reconnectDelay;
			this.reconnectDelay = Math.min(delay * 1.5, RECONNECT_MAX_MS);
			this.schedule(() => this.connect(), delay);
		};
	}

	/** Shut down: close the socket, never reconnect. */
	close(): void {
		this.closed = true;
		this.registered = false;
		this.focused = false;
		try {
			this.socket?.close();
		} catch {
			// Socket already gone.
		}
		this.socket = null;
	}

	/** Push a state update; dropped unless the socket is open and acked. */
	pushState(state: string, modelName?: string | undefined): void {
		if (!this.isConnected) return;
		this.socket?.send(
			JSON.stringify(buildPushState({ sessionId: this.session.sessionId, state, modelName })),
		);
	}

	/**
	 * Enable same-socket reverse control. `applyCommand` feeds daemon
	 * commands into the OMP binding; `focusSnapshot` yields the events to
	 * emit up when the daemon focuses this session.
	 */
	setReverseControl(
		applyCommand: (cmd: PluginCommand) => void,
		focusSnapshot: () => BridgeEvent[],
	): void {
		this.applyCommand = applyCommand;
		this.focusSnapshot = focusSnapshot;
	}

	/** Run `fn` once per connection establishment (first ack). */
	setOnConnect(fn: () => void): void {
		this.onConnect = fn;
	}

	/** Forward a relayed event up while focused; all else is dropped. */
	forwardEvent(evt: BridgeEvent): void {
		if (!this.focused) return;
		this.sendEventUp(evt);
	}

	private sendEventUp(evt: BridgeEvent): void {
		const socket = this.socket;
		if (!this.isConnected || !socket) return;
		if (!RELAYED_EVENT[evt.type]) return;
		socket.send(JSON.stringify({ type: "session_event_up", sessionId: this.session.sessionId, event: evt }));
	}
}

const GATE_TIMEOUT_MS = 25000;

/**
 * Correlates one open tool approval with its device answer. Fail closed:
 * stale request ids, changed questions, bad indexes, and timeouts resolve to
 * null (the caller falls back to local approval, never to allow).
 */
export class ApprovalGate {
	private openRequest: { requestId: string; question: string } | null = null;

	constructor(
		private readonly schedule: (fn: () => void, ms: number) => void = (fn, ms) => {
			const timer = setTimeout(fn, ms) as unknown as { unref?: () => void };
			timer.unref?.();
		},
		private readonly timeoutMs: number = GATE_TIMEOUT_MS,
	) {}

	open(question: string, onTimeout?: () => void): { requestId: string } {
		const requestId = crypto.randomUUID();
		this.openRequest = { requestId, question };
		this.schedule(() => {
			if (this.openRequest?.requestId !== requestId) return;
			this.openRequest = null;
			onTimeout?.();
		}, this.timeoutMs);
		return { requestId };
	}

	decide(index: number, requestId: string, askedQuestion: string): DeckDecision | null {
		const current = this.openRequest;
		if (!current || current.requestId !== requestId) return null;
		const decision = decisionFromSelectOption(index, askedQuestion, current.question);
		if (decision !== null) this.openRequest = null;
		return decision;
	}
}
