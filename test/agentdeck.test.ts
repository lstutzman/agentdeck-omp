import { describe, expect, test } from "bun:test";
import { adaptSocket, ApprovalGate, BridgeClient, buildPushState, buildRegisterFrame, probeDaemons, selectDaemonTarget } from "../src/agentdeck.js";

describe("buildRegisterFrame", () => {
	test("sets remoteAttach only when daemon advertises same-socket control", () => {
		const base = {
			sessionId: "omp-123",
			port: 9131,
			projectName: "agentdeck-omp",
			host: "mbp",
			weight: 0,
		};
		expect(
			buildRegisterFrame({ ...base, sameSocketControl: true }).remoteAttach,
		).toBe(true);
		expect(
			buildRegisterFrame({ ...base, sameSocketControl: false }).remoteAttach,
		).toBe(undefined);
	});
});

describe("buildPushState", () => {
	test("emits session id, state, and model when known", () => {
		expect(
			buildPushState({ sessionId: "omp-123", state: "processing", modelName: "opus" }),
		).toEqual({
			type: "session_push_state",
			sessionId: "omp-123",
			state: "processing",
			modelName: "opus",
		});
	});
});

describe("selectDaemonTarget", () => {
	test("picks the first daemon with same-socket control", () => {
		expect(
			selectDaemonTarget([
				{ port: 9120, mode: "daemon", sameSocketControl: false },
				{ port: 9121, mode: "other", sameSocketControl: true },
				{ port: 9122, mode: "daemon", sameSocketControl: true },
			]),
		).toEqual({ host: "127.0.0.1", port: 9122 });
	});

	test("returns null when no capable daemon answers", () => {
		expect(selectDaemonTarget([{ port: 9120, mode: "daemon" }])).toBeNull();
	});
});

describe("BridgeClient", () => {
	test("sends register on open, connects on ack", () => {
		const sent: string[] = [];
		const socket = {
			readyState: 1,
			onopen: null as (() => void) | null,
			onclose: null as (() => void) | null,
			onmessage: null as ((data: string) => void) | null,
			send(data: string) {
				sent.push(data);
			},
			close() {},
		};
		const client = new BridgeClient(
			{ sessionId: "omp-123", port: 9131, projectName: "agentdeck-omp" },
			{ host: "127.0.0.1", port: 9120, sameSocketControl: true },
			() => socket,
		);
		expect(client.isConnected).toBe(false);
		client.connect();
		socket.onopen?.();
		expect(JSON.parse(sent[0])).toEqual({
			type: "session_push_register",
			sessionId: "omp-123",
			port: 9131,
			projectName: "agentdeck-omp",
			weight: 0,
			remoteAttach: true,
		});
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		expect(client.isConnected).toBe(true);
	});
	test("pushes state only while connected", () => {
		const sent: string[] = [];
		const socket = {
			readyState: 1,
			onopen: null as (() => void) | null,
			onclose: null as (() => void) | null,
			onmessage: null as ((data: string) => void) | null,
			send(data: string) {
				sent.push(data);
			},
			close() {},
		};
		const client = new BridgeClient(
			{ sessionId: "omp-123", port: 9131 },
			{ host: "127.0.0.1", port: 9120, sameSocketControl: true },
			() => socket,
		);
		client.connect();
		client.pushState("processing");
		expect(sent.length).toBe(0);
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		client.pushState("processing", "opus");
		expect(JSON.parse(sent[1])).toEqual({
			type: "session_push_state",
			sessionId: "omp-123",
			state: "processing",
			modelName: "opus",
		});
		socket.onclose?.();
		client.pushState("idle");
		expect(sent.length).toBe(2);
});
});

	test("forwards relayed events only while focused", () => {
		const sent: string[] = [];
		const socket = {
			readyState: 1,
			onopen: null as (() => void) | null,
			onclose: null as (() => void) | null,
			onmessage: null as ((data: string) => void) | null,
			send(data: string) {
				sent.push(data);
			},
			close() {},
		};
		const client = new BridgeClient(
			{ sessionId: "omp-123", port: 9131 },
			{ host: "127.0.0.1", port: 9120, sameSocketControl: true },
			() => socket,
		);
		client.connect();
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		client.setReverseControl(
			() => {},
			() => [{ type: "state_update", state: "processing" }],
		);
		client.forwardEvent({ type: "prompt_options", question: "Allow bash?" });
		expect(sent.length).toBe(1);
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "foreign" }));
		client.forwardEvent({ type: "prompt_options", question: "Allow bash?" });
		expect(sent.length).toBe(1);
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		expect(JSON.parse(sent[1])).toEqual({
			type: "session_event_up",
			sessionId: "omp-123",
			event: { type: "state_update", state: "processing" },
		});
		client.forwardEvent({ type: "prompt_options", question: "Allow bash?" });
		client.forwardEvent({ type: "user_prompt", text: "hi" });
		expect(sent.length).toBe(3);
		expect(JSON.parse(sent[2]).event.type).toBe("prompt_options");
		socket.onmessage?.(JSON.stringify({ type: "session_unfocus_down", sessionId: "omp-123" }));
		client.forwardEvent({ type: "prompt_options", question: "Allow bash?" });
		expect(sent.length).toBe(3);
	});

	test("reports focus state", () => {
		const socket = {
			readyState: 1,
			onopen: null as (() => void) | null,
			onclose: null as (() => void) | null,
			onmessage: null as ((data: string) => void) | null,
			send(_data: string) {},
			close() {},
		};
		const client = new BridgeClient(
			{ sessionId: "omp-123", port: 9131 },
			{ host: "127.0.0.1", port: 9120, sameSocketControl: true },
			() => socket,
		);
		client.connect();
		socket.onopen?.();
		expect(client.isFocused).toBe(false);
		socket.onmessage?.(JSON.stringify({ type: "session_focus_down", sessionId: "omp-123" }));
		expect(client.isFocused).toBe(true);
		socket.onmessage?.(JSON.stringify({ type: "session_unfocus_down", sessionId: "omp-123" }));
		expect(client.isFocused).toBe(false);
	});

	test("routes daemon commands to the handler, ignores foreign sessions", () => {
		const applied: unknown[] = [];
		const socket = {
			readyState: 1,
			onopen: null as (() => void) | null,
			onclose: null as (() => void) | null,
			onmessage: null as ((data: string) => void) | null,
			send(_data: string) {},
			close() {},
		};
		const client = new BridgeClient(
			{ sessionId: "omp-123", port: 9131 },
			{ host: "127.0.0.1", port: 9120, sameSocketControl: true },
			() => socket,
		);
		client.connect();
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		client.setReverseControl(
			(cmd) => {
				applied.push(cmd);
			},
			() => [],
		);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "foreign",
				command: { type: "interrupt" },
			}),
		);
		socket.onmessage?.(
			JSON.stringify({
				type: "session_command_down",
				sessionId: "omp-123",
				command: { type: "send_prompt", text: "fix it" },
			}),
		);
		expect(applied).toEqual([{ type: "send_prompt", text: "fix it" }]);
	});

	test("reconnects with backoff and re-registers", () => {
		const delays: number[] = [];
		const pending: { fn: (() => void) | null } = { fn: null };
		const sockets: {
			onopen: (() => void) | null;
			onclose: (() => void) | null;
			onmessage: ((data: string) => void) | null;
			sent: string[];
		}[] = [];
		const client = new BridgeClient(
			{ sessionId: "omp-123", port: 9131 },
			{ host: "127.0.0.1", port: 9120, sameSocketControl: true },
			() => {
				const socket = {
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
				sockets.push(socket);
				return socket;
			},
			(fn, ms) => {
				delays.push(ms);
				pending.fn = fn;
			},
		);
		client.connect();
		sockets[0].onopen?.();
		sockets[0].onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		expect(client.isConnected).toBe(true);
		sockets[0].onclose?.();
		expect(client.isConnected).toBe(false);
		expect(delays).toEqual([2000]);
		pending.fn?.();
		sockets[1].onopen?.();
		expect(JSON.parse(sockets[1].sent[0]).type).toBe("session_push_register");
	});

	test("notifies once per connection establishment", () => {
		let calls = 0;
		const socket = {
			readyState: 1,
			onopen: null as (() => void) | null,
			onclose: null as (() => void) | null,
			onmessage: null as ((data: string) => void) | null,
			send(_data: string) {},
			close() {},
		};
		const client = new BridgeClient(
			{ sessionId: "omp-123", port: 9131 },
			{ host: "127.0.0.1", port: 9120, sameSocketControl: true },
			() => socket,
		);
		client.setOnConnect(() => {
			calls += 1;
		});
		client.connect();
		socket.onopen?.();
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		socket.onmessage?.(JSON.stringify({ type: "session_push_ack", sessionId: "omp-123" }));
		expect(calls).toBe(1);
	});

describe("ApprovalGate", () => {
	test("resolves allow or deny for the open request", () => {
		const gate = new ApprovalGate();
		const opened = gate.open("Allow bash? rm -rf /tmp/x");
		expect(gate.decide(0, opened.requestId, "Allow bash? rm -rf /tmp/x")).toBe("allow");
		const reopened = gate.open("Allow bash? rm -rf /tmp/x");
		expect(gate.decide(1, reopened.requestId, "Allow bash? rm -rf /tmp/x")).toBe("deny");
	});
	test("rejects answers for superseded requests", () => {
		const gate = new ApprovalGate();
		const first = gate.open("Allow bash? one");
		const second = gate.open("Allow bash? two");
		expect(gate.decide(0, first.requestId, "Allow bash? one")).toBeNull();
		expect(gate.decide(0, second.requestId, "Allow bash? one")).toBeNull();
		expect(gate.decide(0, second.requestId, "Allow bash? two")).toBe("allow");
	});
	test("times out an unanswered request", () => {
		const pending: { fn: (() => void) | null } = { fn: null };
		const timedOut: string[] = [];
		const gate = new ApprovalGate((fn) => {
			pending.fn = fn;
		}, 25000);
		const opened = gate.open("Allow bash?", () => {
			timedOut.push(opened.requestId);
		});
		pending.fn?.();
		expect(timedOut).toEqual([opened.requestId]);
		expect(gate.decide(0, opened.requestId, "Allow bash?")).toBeNull();
	});
});

describe("probeDaemons", () => {
	test("sweeps ports in order and returns answering health payloads", async () => {
		const seen: number[] = [];
		const target = await probeDaemons([9120, 9121, 9122], async (port) => {
			seen.push(port);
			if (port === 9121) return { port, mode: "daemon", sameSocketControl: true };
			return null;
		});
		expect(seen).toEqual([9120, 9121, 9122]);
		expect(target).toEqual({ host: "127.0.0.1", port: 9121 });
	});

	test("returns null when nothing capable answers", async () => {
		const target = await probeDaemons([9120], async () => null);
		expect(target).toBeNull();
	});
});

describe("adaptSocket", () => {
	test("maps MessageEvents to string messages", () => {
		const sent: string[] = [];
		const real = {
			readyState: 1,
			onopen: null as (() => void) | null,
			onclose: null as (() => void) | null,
			onmessage: null as ((event: { data: unknown }) => void) | null,
			send(data: string) {
				sent.push(data);
			},
			close() {},
		};
		const socket = adaptSocket(real);
		const received: string[] = [];
		socket.onmessage = (data) => {
			received.push(data);
		};
		real.onmessage?.({ data: "hello" });
		socket.send("out");
		expect(received).toEqual(["hello"]);
		expect(sent).toEqual(["out"]);
		expect(socket.readyState).toBe(1);
	});
});