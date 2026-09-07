import { describe, expect, test } from "bun:test";
import { registerBridge, type BridgeCtx, type BridgePi } from "../src/extension.js";

function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: BridgeCtx) => unknown>();
	const pi = {
		handlers,
		on(event: string, handler: (event: unknown, ctx: BridgeCtx) => unknown) {
			handlers.set(event, handler);
		},
		sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
	} as BridgePi & { handlers: Map<string, (event: unknown, ctx: BridgeCtx) => unknown> };
	const ctx: BridgeCtx = {
		abort() {},
		isIdle() {
			return true;
		},
		notify(_message: string) {},
	};
	return { pi, ctx };
}

interface FakeSocket {
	readyState: number;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onmessage: ((data: string) => void) | null;
	sent: string[];
	send(data: string): void;
	close(): void;
}

function fakeSocket(): FakeSocket {
	return {
		readyState: 1,
		onopen: null as (() => void) | null,
		onclose: null as (() => void) | null,
		onmessage: null as ((data: string) => void) | null,
		sent: [] as string[],
		send(data: string) {
			this.sent.push(data);
		},
		close() {},
	};
}

describe("registerBridge", () => {
	test("connects to the Node daemon and pushes idle on session start", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			projectName: "agentdeck-omp",
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		expect(JSON.parse(socket.sent[0]).type).toBe("session_push_register");
		expect(JSON.parse(socket.sent[1])).toEqual({
			type: "session_push_state",
			sessionId: "omp-123",
			state: "idle",
		});
	});
	test("notifies and stays offline without a capable daemon", async () => {
		const { pi, ctx } = fakePi();
		const notices: string[] = [];
		const loud: BridgeCtx = { ...ctx, notify: (message: string) => notices.push(message) };
		let sockets = 0;
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => null,
			createSocket: () => {
				sockets += 1;
				return fakeSocket();
			},
		});
		await pi.handlers.get("session_start")?.({}, loud);
		expect(sockets).toBe(0);
		expect(notices.length).toBe(1);
	});
	test("mirrors lifecycle events to deck states", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		let closed = false;
		const tracked = { ...socket, close: () => (closed = true) };
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => tracked,
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		tracked.onopen?.();
		tracked.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		const states = () => tracked.sent.map((raw) => JSON.parse(raw)).filter((msg) => msg.type === "session_push_state").map((msg) => msg.state);
		await pi.handlers.get("agent_start")?.({}, ctx);
		await pi.handlers.get("tool_call")?.({ toolName: "bash" }, ctx);
		await pi.handlers.get("agent_end")?.({}, ctx);
		expect(states()).toEqual(["idle", "processing", "processing", "idle"]);
		await pi.handlers.get("session_shutdown")?.({}, ctx);
		expect(states().at(-1)).toBe("disconnected");
		expect(closed).toBe(true);
	});
	test("holds a focused tool call for device approval, allow releases", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		const result = pi.handlers.get("tool_call")?.(
			{ toolName: "bash", input: { command: "rm -rf /tmp/x" } },
			ctx,
		);
		const prompt = socket.sent
			.map((raw) => JSON.parse(raw))
			.find((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options");
		expect(prompt.event.question).toContain("bash");
		expect(prompt.event.options).toEqual(["Allow", "Deny"]);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 0, requestId: prompt.event.requestId },
			}),
		);
		expect(await result).toBe(undefined);
	});

	test("deny blocks the tool call with a reason", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		const result = pi.handlers.get("tool_call")?.(
			{ toolName: "bash", input: { command: "rm -rf /tmp/x" } },
			ctx,
		);
		const prompt = socket.sent
			.map((raw) => JSON.parse(raw))
			.find((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options");
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 1, requestId: prompt.event.requestId },
			}),
		);
		const decided = (await result) as { block?: boolean; reason?: string };
		expect(decided?.block).toBe(true);
		expect(typeof decided?.reason).toBe("string");
	});

	test("unfocused tool calls fall through to the local flow", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		const result = await pi.handlers.get("tool_call")?.(
			{ toolName: "bash", input: { command: "ls" } },
			ctx,
		);
		expect(result).toBe(undefined);
		const prompts = socket.sent
			.map((raw) => JSON.parse(raw))
			.filter((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options");
		expect(prompts).toEqual([]);
	});

	test("gate timeout releases to the local flow", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		const pending: { fn: (() => void) | null } = { fn: null };
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
			gateSchedule: (fn) => {
				pending.fn = fn;
			},
			gateTimeoutMs: 25000,
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		const result = pi.handlers.get("tool_call")?.(
			{ toolName: "bash", input: { command: "ls" } },
			ctx,
		);
		pending.fn?.();
		expect(await result).toBe(undefined);
	});

	test("respond answers the open gate by value", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		const first = pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "respond", value: "n" },
			}),
		);
		const denied = (await first) as { block?: boolean };
		expect(denied?.block).toBe(true);
		const second = pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "respond", value: "y" },
			}),
		);
		expect(await second).toBe(undefined);
	});

	test("routes prompts and interrupts into the session", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		const prompts: string[] = [];
		let aborts = 0;
		const live: BridgeCtx = {
			...ctx,
			abort: () => {
				aborts += 1;
			},
		};
		const sending = {
			...pi,
			sendUserMessage: (content: string) => {
				prompts.push(content);
			},
		};
		registerBridge(sending, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await sending.handlers.get("session_start")?.({}, live);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "send_prompt", text: "fix it" },
			}),
		);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "interrupt" },
			}),
		);
		expect(prompts).toEqual(["fix it"]);
		expect(aborts).toBe(1);
	});

	test("derives the session id from the start event when unconfigured", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({ sessionId: "live-1" }, ctx);
		socket.onopen?.();
		const register = JSON.parse(socket.sent[0]);
		expect(register.type).toBe("session_push_register");
		expect(register.sessionId).toBe("live-1");
	});

	test("falls back to the session manager id", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		const managed: BridgeCtx = {
			...ctx,
			sessionManager: { getSessionId: () => "mgr-7" },
		};
		registerBridge(pi, {
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({}, managed);
		socket.onopen?.();
		const register = JSON.parse(socket.sent[0]);
		expect(register.sessionId).toBe("mgr-7");
	});

	test("dials the probed daemon port", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		let dialed: { host: string; port: number } | null = null;
		registerBridge(pi, {
			bridgePort: 9131,
			ports: [9120, 9121],
			fetchHealth: async (port) =>
				port === 9121 ? { port, mode: "daemon", sameSocketControl: true } : null,
			createSocket: (target) => {
				dialed = { host: target.host, port: target.port };
				return socket;
			},
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		expect(dialed).toEqual({ host: "127.0.0.1", port: 9121 });
	});
	test("a superseded gate resolves to the local flow", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		const first = pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx);
		const second = pi.handlers.get("tool_call")?.({ toolName: "read", input: {} }, ctx);
		// The replaced gate must fall back to local instead of hanging.
		expect(await first).toBe(undefined);
		const prompts = socket.sent
			.map((raw) => JSON.parse(raw))
			.filter((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options");
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 0, requestId: prompts.at(-1).event.requestId },
			}),
		);
		expect(await second).toBe(undefined);
	});
	test("a stale device answer does not resolve the current gate", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		const first = pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx);
		const second = pi.handlers.get("tool_call")?.({ toolName: "read", input: {} }, ctx);
		const prompts = socket.sent
			.map((raw) => JSON.parse(raw))
			.filter((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options");
		// Stale deny for the replaced gate: ignored, current gate still holds.
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 1, requestId: prompts[0].event.requestId },
			}),
		);
		// Fresh allow for the current gate: releases it.
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 0, requestId: prompts.at(-1).event.requestId },
			}),
		);
		expect(await first).toBe(undefined);
		expect(await second).toBe(undefined);
	});
	test("reconnect re-registers and re-pushes the current state", async () => {
		const { pi, ctx } = fakePi();
		const created: FakeSocket[] = [];
		const holder: { fn: (() => void) | null } = { fn: null };
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => {
				const socket = fakeSocket();
				created.push(socket);
				return socket;
			},
			clientSchedule: (fn) => {
				holder.fn = fn;
			},
		});
		await pi.handlers.get("session_start")?.({}, ctx);
		created[0].onopen?.();
		created[0].onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		await pi.handlers.get("agent_start")?.({}, ctx);
		created[0].onclose?.();
		holder.fn?.();
		created[1].onopen?.();
		created[1].onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		const frames = created[1].sent.map((raw) => JSON.parse(raw));
		expect(frames[0].type).toBe("session_push_register");
		const states = frames.filter((msg) => msg.type === "session_push_state").map((msg) => msg.state);
		expect(states.at(-1)).toBe("processing");
	});
});
