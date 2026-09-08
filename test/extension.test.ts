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
		ui: { notify(_message: string) {} },
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
			permissionMode: "bypassPermissions",
		});
	});
	test("notifies through ctx.ui and stays offline without a capable daemon", async () => {
		const { pi, ctx } = fakePi();
		const uiNotices: string[] = [];
		const directNotices: string[] = [];
		const loud = {
			...ctx,
			notify: (message: string) => directNotices.push(message),
			ui: { notify: (message: string) => uiNotices.push(message) },
		};
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
		expect(uiNotices.length).toBe(1);
		expect(directNotices).toEqual([]);
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
		const states = () =>
			tracked.sent
				.map((raw) => JSON.parse(raw))
				.filter((msg) => msg.type === "session_push_state")
				.map((msg) => msg.state);
		await pi.handlers.get("agent_start")?.({}, ctx);
		await pi.handlers.get("tool_call")?.({ toolName: "bash" }, ctx);
		await pi.handlers.get("agent_end")?.({}, ctx);
		expect(states()).toEqual(["idle", "processing", "processing", "idle"]);
		await pi.handlers.get("session_shutdown")?.({}, ctx);
		expect(states().at(-1)).toBe("disconnected");
		expect(closed).toBe(true);
	});
	test("names the running tool on state_update until its result arrives", async () => {
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
		// Unfocused: no gate opens, the tool simply runs.
		await pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "pwd" } }, ctx);
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		const updates = () =>
			socket.sent
				.map((raw) => JSON.parse(raw))
				.filter((msg) => msg.type === "session_event_up" && msg.event.type === "state_update")
				.map((msg) => msg.event);
		expect(updates().at(-1)).toEqual({
			type: "state_update",
			state: "processing",
			permissionMode: "bypassPermissions",
			currentTool: "bash",
		});
		await pi.handlers.get("tool_result")?.({ toolName: "bash" }, ctx);
		expect(updates().at(-1)).toEqual({
			type: "state_update",
			state: "processing",
			permissionMode: "bypassPermissions",
		});
	});
	test("offers Approved as the quick-send prompt only while idle", async () => {
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
		const updates = () =>
			socket.sent
				.map((raw) => JSON.parse(raw))
				.filter((msg) => msg.type === "session_event_up" && msg.event.type === "state_update")
				.map((msg) => msg.event);
		expect(updates().at(-1).suggestedPrompt).toBe("Approved");
		await pi.handlers.get("agent_start")?.({}, ctx);
		expect(updates().at(-1).suggestedPrompt).toBe(undefined);
		await pi.handlers.get("agent_end")?.({}, ctx);
		expect(updates().at(-1).suggestedPrompt).toBe("Approved");
	});
	test("reports bypassPermissions until OMP asks for approval, then the reported mode", async () => {
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
		const frames = () => socket.sent.map((raw) => JSON.parse(raw));
		const pushed = () =>
			frames()
				.filter((msg) => msg.type === "session_push_state")
				.at(-1);
		const updates = () =>
			frames()
				.filter((msg) => msg.type === "session_event_up" && msg.event.type === "state_update")
				.map((msg) => msg.event);
		expect(pushed().permissionMode).toBe("bypassPermissions");
		expect(updates().at(-1).permissionMode).toBe("bypassPermissions");
		await pi.handlers.get("tool_approval_requested")?.({ toolName: "bash", approvalMode: "always-ask" }, ctx);
		await pi.handlers.get("agent_start")?.({}, ctx);
		expect(pushed().permissionMode).toBe("default");
		expect(updates().at(-1)).toEqual({ type: "state_update", state: "processing", permissionMode: "default" });
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
		const result = pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, ctx);
		const prompt = socket.sent
			.map((raw) => JSON.parse(raw))
			.find((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options");
		expect(prompt.event.question).toContain("bash");
		expect(prompt.event.promptType).toBe("yes_no_always");
		expect(prompt.event.options).toEqual([
			{ index: 0, label: "Allow" },
			{ index: 1, label: "Always" },
			{ index: 2, label: "Deny" },
		]);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 0, requestId: prompt.event.requestId },
			}),
		);
		expect(await result).toBe(undefined);
	});
	test("Always applies only to one tool in one OMP session", async () => {
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
		const prompts = () =>
			socket.sent
				.map((raw) => JSON.parse(raw))
				.filter((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options")
				.map((msg) => msg.event);

		const first = pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "pwd" } }, ctx);
		const bashPrompt = prompts().at(-1);
		expect(bashPrompt.promptType).toBe("yes_no_always");
		expect(bashPrompt.options).toEqual([
			{ index: 0, label: "Allow" },
			{ index: 1, label: "Always" },
			{ index: 2, label: "Deny" },
		]);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 1, requestId: bashPrompt.requestId },
			}),
		);
		expect(await first).toBe(undefined);

		const promptCount = prompts().length;
		expect(await pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "pwd" } }, ctx)).toBe(undefined);
		expect(prompts().length).toBe(promptCount);

		const write = pi.handlers.get("tool_call")?.({ toolName: "write", input: { path: "out" } }, ctx);
		const writePrompt = prompts().at(-1);
		expect(prompts().length).toBe(promptCount + 1);
		expect(writePrompt.question).toContain("write");
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 0, requestId: writePrompt.requestId },
			}),
		);
		expect(await write).toBe(undefined);

		const fresh = fakePi();
		const freshSocket = fakeSocket();
		registerBridge(fresh.pi, {
			sessionId: "omp-456",
			bridgePort: 9132,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => freshSocket,
		});
		await fresh.pi.handlers.get("session_start")?.({}, fresh.ctx);
		freshSocket.onopen?.();
		freshSocket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-456" }));
		freshSocket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-456" }));
		void fresh.pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "pwd" } }, fresh.ctx);
		const freshPrompts = freshSocket.sent
			.map((raw) => JSON.parse(raw))
			.filter((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options");
		expect(freshPrompts.length).toBe(1);
	});
	test("focused read-tier tools bypass device approval", async () => {
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

		const result = pi.handlers.get("tool_call")?.({ toolName: "read", input: { path: "package.json" } }, ctx);

		const events = socket.sent
			.map((raw) => JSON.parse(raw))
			.filter((msg) => msg.type === "session_event_up")
			.map((msg) => msg.event);
		expect(events.filter((event) => event.type === "prompt_options")).toEqual([]);
		expect(events.filter((event) => event.type === "state_update").at(-1)).toEqual({
			type: "state_update",
			state: "processing",
			permissionMode: "bypassPermissions",
			currentTool: "read",
		});
		expect(await result).toBe(undefined);
	});
	test("answers a focused ask call from the deck through the block reason", async () => {
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
			{
				toolName: "ask",
				input: {
					questions: [{ id: "db", question: "Which store?", options: [{ label: "SQLite" }, { label: "Postgres" }] }],
				},
			},
			ctx,
		);
		const events = () =>
			socket.sent
				.map((raw) => JSON.parse(raw))
				.filter((msg) => msg.type === "session_event_up")
				.map((msg) => msg.event);
		const prompt = events().find((event) => event.type === "prompt_options");
		expect(prompt.promptType).toBe("multi_select");
		expect(prompt.question).toBe("Which store?");
		expect(prompt.options).toEqual([
			{ index: 0, label: "SQLite" },
			{ index: 1, label: "Postgres" },
		]);
		expect(
			events()
				.filter((event) => event.type === "state_update")
				.at(-1).state,
		).toBe("awaiting_permission");
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 1, requestId: prompt.requestId, question: "Which store?" },
			}),
		);
		const answer = (await result) as { block?: boolean; reason?: string };
		expect(answer.block).toBe(true);
		expect(answer.reason).toContain("Postgres");
		expect(
			events()
				.filter((event) => event.type === "state_update")
				.at(-1),
		).toEqual({
			type: "state_update",
			state: "processing",
			permissionMode: "bypassPermissions",
		});
	});
	test("holds a multi-question ask one question at a time and reports every answer", async () => {
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
			{
				toolName: "ask",
				input: {
					questions: [
						{ id: "db", question: "Which store?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
						{ id: "auth", question: "Which auth?", options: [{ label: "JWT" }, { label: "Cookies" }] },
					],
				},
			},
			ctx,
		);
		const prompts = () =>
			socket.sent
				.map((raw) => JSON.parse(raw))
				.filter((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options")
				.map((msg) => msg.event);
		const answer = (prompt: { requestId: string; question: string }, index: number) =>
			socket.onmessage?.(
				JSON.stringify({
					type: "session_command_down",
					sessionId: "omp-123",
					command: { type: "select_option", index, requestId: prompt.requestId, question: prompt.question },
				}),
			);
		answer(prompts()[0], 0);
		expect(prompts().length).toBe(2);
		expect(prompts()[1].question).toBe("Which auth?");
		expect(prompts()[1].requestId).not.toBe(prompts()[0].requestId);
		answer(prompts()[1], 1);
		const outcome = (await result) as { block?: boolean; reason?: string };
		expect(outcome.block).toBe(true);
		expect(outcome.reason).toContain("SQLite");
		expect(outcome.reason).toContain("Cookies");
	});
	test("publishes complete permission snapshots while a gate is held and after resolution", async () => {
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
		const result = pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "pwd" } }, ctx);
		const events = () =>
			socket.sent
				.map((raw) => JSON.parse(raw))
				.filter((msg) => msg.type === "session_event_up")
				.map((msg) => msg.event);
		const prompt = events().find((event) => event.type === "prompt_options");
		expect(
			events()
				.filter((event) => event.type === "state_update")
				.at(-1),
		).toEqual({
			type: "state_update",
			state: "awaiting_permission",
			permissionMode: "bypassPermissions",
			currentTool: "bash",
			question: prompt.question,
			options: prompt.options,
		});
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: {
					type: "select_option",
					index: 0,
					requestId: prompt.requestId,
					question: prompt.question,
				},
			}),
		);
		expect(await result).toBe(undefined);
		expect(
			events()
				.filter((event) => event.type === "state_update")
				.at(-1),
		).toEqual({
			type: "state_update",
			state: "processing",
			permissionMode: "bypassPermissions",
			currentTool: "bash",
		});
	});

	test("releases a pending gate to local policy on shutdown", async () => {
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
		const result = pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx);
		let settled = false;
		void Promise.resolve(result).then(() => {
			settled = true;
		});
		await pi.handlers.get("session_shutdown")?.({}, ctx);
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(true);
	});
	test("runs bridge resource cleanup on shutdown", async () => {
		const { pi, ctx } = fakePi();
		let cleanedUp = false;
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [],
			fetchHealth: async () => null,
			createSocket: () => fakeSocket(),
			onShutdown: () => {
				cleanedUp = true;
			},
		});
		await pi.handlers.get("session_shutdown")?.({}, ctx);
		expect(cleanedUp).toBe(true);
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
		const result = pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, ctx);
		const prompt = socket.sent
			.map((raw) => JSON.parse(raw))
			.find((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options");
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 2, requestId: prompt.event.requestId },
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
		const result = await pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "ls" } }, ctx);
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
		const result = pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "ls" } }, ctx);
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

	test("rejects respond with a mismatched supplied requestId", async () => {
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
		const result = pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx);
		const prompt = socket.sent
			.map((raw) => JSON.parse(raw))
			.find((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options").event;
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "respond", value: "n", requestId: "wrong" },
			}),
		);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "respond", value: "y", requestId: prompt.requestId },
			}),
		);
		expect(await result).toBe(undefined);
	});
	test("rejects respond with a mismatched question echo", async () => {
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
		const result = pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx);
		const prompt = socket.sent
			.map((raw) => JSON.parse(raw))
			.find((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options").event;
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: {
					type: "respond",
					value: "n",
					requestId: prompt.requestId,
					question: "different question",
				},
			}),
		);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: {
					type: "respond",
					value: "y",
					requestId: prompt.requestId,
					question: prompt.question,
				},
			}),
		);
		expect(await result).toBe(undefined);
	});

	test("interrupt blocks and releases a pending tool gate before aborting", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		let aborts = 0;
		const live: BridgeCtx = {
			...ctx,
			abort: () => {
				aborts += 1;
			},
		};
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		await pi.handlers.get("session_start")?.({}, live);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		const result = pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, live);
		let resolution: unknown = "pending";
		void Promise.resolve(result).then((value) => {
			resolution = value;
		});
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "interrupt" },
			}),
		);
		for (let turn = 0; turn < 5 && resolution === "pending"; turn += 1) {
			await Promise.resolve();
		}
		expect(resolution).toEqual({
			block: true,
			reason: "AgentDeck: interrupted from the connected dashboard.",
		});
		expect(aborts).toBe(1);
		const state = socket.sent
			.map((raw) => JSON.parse(raw))
			.filter((msg) => msg.type === "session_event_up" && msg.event.type === "state_update")
			.at(-1).event;
		expect(state).toEqual({
			type: "state_update",
			state: "processing",
			permissionMode: "bypassPermissions",
		});
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
			fetchHealth: async (port) => (port === 9121 ? { port, mode: "daemon", sameSocketControl: true } : null),
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
		const second = pi.handlers.get("tool_call")?.({ toolName: "write", input: {} }, ctx);
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
		const second = pi.handlers.get("tool_call")?.({ toolName: "write", input: {} }, ctx);
		const prompts = socket.sent
			.map((raw) => JSON.parse(raw))
			.filter((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options");
		// Stale deny for the replaced gate: ignored, current gate still holds.
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "select_option", index: 2, requestId: prompts[0].event.requestId },
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
	test("rejects a select_option with a mismatched question echo", async () => {
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
		const result = pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx);
		const prompt = socket.sent
			.map((raw) => JSON.parse(raw))
			.find((msg) => msg.type === "session_event_up" && msg.event.type === "prompt_options").event;
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: {
					type: "select_option",
					index: 1,
					requestId: prompt.requestId,
					question: "different question",
				},
			}),
		);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: {
					type: "select_option",
					index: 0,
					requestId: prompt.requestId,
					question: prompt.question,
				},
			}),
		);
		expect(await result).toBe(undefined);
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
	test("notifies once when the daemon never acknowledges registration", async () => {
		const { pi, ctx } = fakePi();
		const uiNotices: string[] = [];
		const loud = { ...ctx, ui: { notify: (message: string) => uiNotices.push(message) } };
		const socket = fakeSocket();
		const timers: (() => void)[] = [];
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
			clientSchedule: (fn) => {
				timers.push(fn);
			},
		});
		await pi.handlers.get("session_start")?.({}, loud);
		socket.onopen?.();
		expect(uiNotices).toEqual([]);
		for (const fn of timers.splice(0)) fn();
		expect(uiNotices.length).toBe(1);
		expect(uiNotices[0]).toContain("acknowledge");
		await pi.handlers.get("agent_start")?.({}, loud);
		expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual(["session_push_register"]);
		socket.onclose?.();
		for (const fn of timers.splice(0)) fn();
		socket.onopen?.();
		for (const fn of timers.splice(0)) fn();
		expect(uiNotices.length).toBe(1);
	});
	test("carries modelName in pushed state and snapshot when ctx.model is present", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		const modeled = { ...ctx, model: { id: "openai/gpt-5", name: "gpt-5" } };
		await pi.handlers.get("session_start")?.({}, modeled);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		const states = () => socket.sent.map((raw) => JSON.parse(raw));
		expect(states().find((msg) => msg.type === "session_push_state")?.modelName).toBe("gpt-5");
		const ups = states().filter((msg) => msg.type === "session_event_up");
		expect(ups.at(-1)?.event?.modelName).toBe("gpt-5");
	});
	test("reports usage on agent_end and in the focus snapshot when stats are available", async () => {
		const { pi, ctx } = fakePi();
		const socket = fakeSocket();
		registerBridge(pi, {
			sessionId: "omp-123",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => socket,
		});
		const rich = {
			...ctx,
			sessionManager: {
				getSessionId: () => "omp-123",
				getUsageStatistics: () => ({ input: 100, output: 50, cost: 0.01 }),
			},
		};
		await pi.handlers.get("session_start")?.({}, rich);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		// Gated calls stay open until a device answers; count only, never await.
		void pi.handlers.get("tool_call")?.({ toolName: "read", input: {} }, rich);
		void pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, rich);
		await pi.handlers.get("agent_end")?.({}, rich);
		const ups = socket.sent
			.map((raw) => JSON.parse(raw))
			.filter((msg) => msg.type === "session_event_up" && msg.event?.type === "usage_update")
			.map((msg) => msg.event);
		expect(ups.length).toEqual(2);
		expect(ups.at(-1)).toEqual({
			type: "usage_update",
			sessionDurationSec: ups.at(-1)?.sessionDurationSec,
			inputTokens: 100,
			outputTokens: 50,
			toolCalls: 2,
			estimatedCostUsd: 0.01,
		});
		expect(typeof ups.at(-1)?.sessionDurationSec).toBe("number");
		const order = socket.sent
			.map((raw) => JSON.parse(raw))
			.filter((msg) => msg.type === "session_event_up")
			.map((msg) => msg.event?.type);
		expect(order.slice(0, 2)).toEqual(["state_update", "usage_update"]);

		const spare = fakePi();
		const plainSocket = fakeSocket();
		registerBridge(spare.pi, {
			sessionId: "omp-456",
			bridgePort: 9131,
			ports: [9120],
			fetchHealth: async () => ({ port: 9120, mode: "daemon", sameSocketControl: true }),
			createSocket: () => plainSocket,
		});
		await spare.pi.handlers.get("session_start")?.({}, spare.ctx);
		plainSocket.onopen?.();
		plainSocket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-456" }));
		plainSocket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-456" }));
		await spare.pi.handlers.get("agent_end")?.({}, spare.ctx);
		expect(
			plainSocket.sent
				.map((raw) => JSON.parse(raw))
				.filter((msg) => msg.type === "session_event_up" && msg.event?.type === "usage_update"),
		).toEqual([]);
	});
});
