import { describe, expect, test } from "bun:test";
import factory from "../src/index.js";
import type { BridgeCtx, BridgePi } from "../src/extension.js";
import { openSessionEndpoint } from "../src/session-relay.js";

const OUR_SESSION = "tui-relay-1";
const OTHER_SESSION = "other-session";

interface TestSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

declare const Bun: {
	serve(options: {
		hostname: string;
		port: number;
		fetch(request: Request, server: { upgrade(request: Request): boolean }): Response | undefined;
		websocket: {
			open(ws: TestSocket): void;
			message(ws: TestSocket, raw: string | Uint8Array | ArrayBuffer): void;
			close(ws: TestSocket): void;
		};
	}): { port: number; stop(closeActiveConnections?: boolean): void };
};

function textOf(raw: string | Uint8Array | ArrayBuffer): string {
	return typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
}

async function waitFor(label: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Minimal fake Node daemon: worker push channel plus dashboard client protocol. */
function serveFakeDaemon(): {
	port: number;
	stop(): void;
	received: { type: string; raw: string }[];
	focused: () => string | null;
	advertisedPort: () => number | null;
} {
	const received: { type: string; raw: string }[] = [];
	let worker: TestSocket | null = null;
	const dashboards = new Set<TestSocket>();
	let focused: string | null = OTHER_SESSION;
	let advertisedPort: number | null = null;
	for (let port = 9139; port >= 9131; port--) {
		try {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port,
				fetch(request, srv) {
					if (new URL(request.url).pathname === "/health") {
						return Response.json({ status: "ok", mode: "daemon", sameSocketControl: true });
					}
					if (srv.upgrade(request)) return undefined;
					return new Response("Not Found", { status: 404 });
				},
				websocket: {
					open(_ws) {},
					message(ws, raw) {
						const text = textOf(raw);
						const msg = JSON.parse(text) as { type: string; sessionId?: string; event?: { type: string } & Record<string, unknown> };
						received.push({ type: msg.type, raw: text });
						if (msg.type === "session_push_register") {
							worker = ws;
							advertisedPort = (msg as { port?: number }).port ?? null;
							ws.send(JSON.stringify({ type: "session_push_ack", sessionId: msg.sessionId }));
							ws.send(JSON.stringify({ type: "session_focus_down", sessionId: OTHER_SESSION }));
						} else if (msg.type === "client_register") {
							dashboards.add(ws);
							ws.send(
								JSON.stringify({
									type: "sessions_list",
									sessions: [
										{ id: OTHER_SESSION, port: 9999 },
										{ id: OUR_SESSION, port: advertisedPort },
									],
								}),
							);
							// Deterministic stand-in for the delayed initial state:
							// the real burst always lands after registration, so it
							// always reaches this client; pre-register frames may not.
							ws.send(JSON.stringify({ type: "state_update", sessionId: OUR_SESSION, state: "disconnected" }));
						} else if (msg.type === "focus_session" && typeof msg.sessionId === "string") {
							focused = msg.sessionId;
							worker?.send(JSON.stringify({ type: "session_focus_down", sessionId: msg.sessionId }));
						} else if (msg.type === "session_event_up" && typeof msg.sessionId === "string" && msg.event) {
							if (focused === msg.sessionId) {
								for (const d of dashboards) d.send(JSON.stringify({ ...msg.event, sessionId: msg.sessionId }));
							}
						}
					},
					close(ws) {
						dashboards.delete(ws);
						if (worker === ws) worker = null;
					},
				},
			});
			return {
				port: server.port,
				stop: () => server.stop(true),
				received,
				focused: () => focused,
				advertisedPort: () => advertisedPort,
			};
		} catch {
			// Port taken: try the next one down.
		}
	}
	throw new Error("no free port in 9131-9139 for the fake daemon");
}

describe("session loopback endpoint", () => {
	test("tui connecting to the advertised port receives this session's live state", async () => {
		const daemon = serveFakeDaemon();
		try {
			const handlers = new Map<string, (event: unknown, ctx: BridgeCtx) => unknown>();
			const pi: BridgePi = {
				on: (event, handler) => {
					handlers.set(event, handler);
				},
				sendUserMessage: () => {},
			};
			const ctx: BridgeCtx = { abort: () => {}, isIdle: () => true, ui: { notify: () => {} }, cwd: "/repo/agentdeck-omp" };
			(factory as (pi: BridgePi) => void)(pi);
			await handlers.get("session_start")?.({ sessionId: OUR_SESSION }, ctx);
			await waitFor(
				"worker registration at the fake daemon",
				() => daemon.received.some((m) => m.type === "session_push_register"),
			);
			const advertised = daemon.advertisedPort();
			expect(typeof advertised === "number" && advertised > 0).toBe(true);

			const health = await fetch(`http://127.0.0.1:${advertised}/health`).then((r) => r.json());
			expect(health).toEqual({ status: "ok", mode: "session-bridge" });

			await handlers.get("agent_start")?.({}, ctx);

			const seen: { type: string; sessionId?: string; state?: string; sessions?: { id: string }[] }[] = [];
			const tui = new WebSocket(`ws://127.0.0.1:${advertised}`);
			tui.onmessage = (event) => seen.push(JSON.parse(String(event.data)));
			await waitFor("tui upgrade on the advertised port", () => tui.readyState === 1, 2000);
			tui.send(JSON.stringify({ type: "client_register", clientType: "tui" }));
			await waitFor(
				"sessions_list through the advertised port",
				() => seen.some((m) => m.type === "sessions_list"),
			);
			expect(seen.find((m) => m.type === "sessions_list")?.sessions?.some((s) => s.id === OUR_SESSION)).toBe(true);
			await waitFor(
				"focused live state for this session",
				() => seen.some((m) => m.type === "state_update" && m.sessionId === OUR_SESSION && m.state === "processing"),
			);
			expect(daemon.focused()).toBe(OUR_SESSION);

			tui.close();
			await handlers.get("session_shutdown")?.({}, ctx);
		} finally {
			daemon.stop();
		}
	});
	test("closing either side of a relayed connection closes the other", async () => {
		const received: string[] = [];
		const upstreamSockets: TestSocket[] = [];
		let upstreamCloses = 0;
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(_request, srv) {
				if (srv.upgrade(_request)) return undefined;
				return new Response("Not Found", { status: 404 });
			},
			websocket: {
				open: (ws) => {
					upstreamSockets.push(ws);
				},
				message: (_ws, raw) => {
					received.push(textOf(raw));
				},
				close: (_ws) => {
					upstreamCloses += 1;
				},
			},
		});
		const endpoint = openSessionEndpoint(() => ({
			session: { sessionId: "close-1", port: 0 },
			target: { host: "127.0.0.1", port: upstream.port },
			snapshot: () => [],
		}));
		try {
			expect(endpoint !== null).toBe(true);
			const first = new WebSocket(`ws://127.0.0.1:${endpoint!.port}`);
			await waitFor("downstream upgrade", () => first.readyState === 1);
			await waitFor("upstream dial", () => upstreamSockets.length >= 1);
			await waitFor("relay-initiated focus", () =>
				received.some((raw) => JSON.parse(raw).type === "focus_session" && JSON.parse(raw).sessionId === "close-1"),
			);
			first.close();
			await waitFor("upstream follows downstream close", () => upstreamCloses >= 1);

			const second = new WebSocket(`ws://127.0.0.1:${endpoint!.port}`);
			await waitFor("second downstream upgrade", () => second.readyState === 1);
			await waitFor("second upstream dial", () => upstreamSockets.length >= 2);
			upstreamSockets.at(-1)!.close();
			await waitFor("downstream follows upstream close", () => second.readyState === 3);
		} finally {
			endpoint?.stop();
			upstream.stop(true);
		}
	});
	test("unrouted upgrades fail visibly while /health stays valid", async () => {
		const endpoint = openSessionEndpoint(() => null);
		try {
			expect(endpoint !== null).toBe(true);
			const health = await fetch(`http://127.0.0.1:${endpoint!.port}/health`).then((r) => r.json());
			expect(health).toEqual({ status: "ok", mode: "session-bridge" });
			const handshake = await fetch(`http://127.0.0.1:${endpoint!.port}/`, {
				headers: { Upgrade: "websocket", Connection: "Upgrade" },
			});
			expect(handshake.status).toBe(503);
			const ws = new WebSocket(`ws://127.0.0.1:${endpoint!.port}`);
			// No event fires for a refused upgrade; the fixed settle asserts the socket stays shut.
			await new Promise((r) => setTimeout(r, 300));
			expect(ws.readyState).toBe(3);
		} finally {
			endpoint?.stop();
		}
	});
	test("browser Origin upgrades are rejected", async () => {
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(_request, srv) {
				if (srv.upgrade(_request)) return undefined;
				return new Response("Not Found", { status: 404 });
			},
			websocket: {
				open: (_ws) => {},
				message: (_ws, _raw) => {},
				close: (_ws) => {},
			},
		});
		const endpoint = openSessionEndpoint(() => ({
			session: { sessionId: "origin-1", port: 0 },
			target: { host: "127.0.0.1", port: upstream.port },
			snapshot: () => [],
		}));
		try {
			expect(endpoint !== null).toBe(true);
			const forbidden = await fetch(`http://127.0.0.1:${endpoint!.port}/`, {
				headers: { Origin: "https://evil.test" },
			});
			expect(forbidden.status).toBe(403);
			// Bun sends `headers` at runtime; the DOM lib types lag behind, hence the cast.
			const evil = new WebSocket(`ws://127.0.0.1:${endpoint!.port}`, {
				headers: { Origin: "https://evil.test" },
			} as unknown as string);
			// No event fires for a refused upgrade; the fixed settle asserts the socket stays shut.
			await new Promise((r) => setTimeout(r, 300));
			expect(evil.readyState).toBe(3);
			const tui = new WebSocket(`ws://127.0.0.1:${endpoint!.port}`);
			await waitFor("clean upgrade without Origin", () => tui.readyState === 1);
			tui.close();
		} finally {
			endpoint?.stop();
			upstream.stop(true);
		}
	});
	test("delayed disconnected burst and duplicate focus keep live state", async () => {
		const workerRef: { current: TestSocket | null } = { current: null };
		const dashboards = new Set<TestSocket>();
		let focused: string | null = OTHER_SESSION;
		let advertised: number | null = null;
		let bursts = 0;
		const burst = () => {
			bursts += 1;
			for (const d of dashboards) d.send(JSON.stringify({ type: "state_update", sessionId: OUR_SESSION, state: "disconnected" }));
		};
		let daemon: { port: number; stop(): void } | null = null;
		for (let port = 9139; port >= 9131; port--) {
			try {
				const server = Bun.serve({
					hostname: "127.0.0.1",
					port,
					fetch(request, srv) {
						if (new URL(request.url).pathname === "/health") {
							return Response.json({ status: "ok", mode: "daemon", sameSocketControl: true });
						}
						if (srv.upgrade(request)) return undefined;
						return new Response("Not Found", { status: 404 });
					},
					websocket: {
						open: (_ws) => {},
						message: (ws, raw) => {
							const msg = JSON.parse(textOf(raw)) as {
								type: string;
								sessionId?: unknown;
								port?: unknown;
								event?: Record<string, unknown>;
							};
							if (msg.type === "session_push_register") {
								workerRef.current = ws;
								advertised = typeof msg.port === "number" ? msg.port : null;
								ws.send(JSON.stringify({ type: "session_push_ack", sessionId: msg.sessionId }));
								ws.send(JSON.stringify({ type: "session_focus_down", sessionId: OTHER_SESSION }));
							} else if (msg.type === "client_register") {
								dashboards.add(ws);
								ws.send(JSON.stringify({ type: "sessions_list", sessions: [{ id: OUR_SESSION }] }));
								burst();
							} else if (msg.type === "focus_session" && typeof msg.sessionId === "string") {
								// Same-session focus is a daemon no-op: no fresh snapshot.
								if (focused !== msg.sessionId) {
									focused = msg.sessionId;
									workerRef.current?.send(JSON.stringify({ type: "session_focus_down", sessionId: msg.sessionId }));
								}
								// Hostile repeat of the delayed initial state: substitution must hold regardless.
								burst();
							} else if (msg.type === "session_event_up" && typeof msg.sessionId === "string" && msg.event) {
								if (focused === msg.sessionId) {
									for (const d of dashboards) d.send(JSON.stringify({ ...msg.event, sessionId: msg.sessionId }));
								}
								burst();
							}
						},
						close: (ws) => {
							dashboards.delete(ws);
						},
					},
				});
				daemon = { port: server.port, stop: () => server.stop(true) };
				break;
			} catch {
				// Port taken: try the next one down.
			}
		}
		if (!daemon) throw new Error("no free port in 9131-9139 for the fake daemon");
		try {
			const handlers = new Map<string, (event: unknown, ctx: BridgeCtx) => unknown>();
			const pi: BridgePi = {
				on: (event, handler) => {
					handlers.set(event, handler);
				},
				sendUserMessage: () => {},
			};
			const ctx: BridgeCtx = { abort: () => {}, isIdle: () => true, ui: { notify: () => {} }, cwd: "/repo/agentdeck-omp" };
			(factory as (pi: BridgePi) => void)(pi);
			await handlers.get("session_start")?.({ sessionId: OUR_SESSION }, ctx);
			await waitFor("worker registration", () => advertised !== null);
			await handlers.get("agent_start")?.({}, ctx);
			const seen: { type: string; sessionId?: string; state?: string }[] = [];
			const tui = new WebSocket(`ws://127.0.0.1:${advertised}`);
			tui.onmessage = (event) => seen.push(JSON.parse(String(event.data)));
			await waitFor("tui upgrade", () => tui.readyState === 1, 2000);
			tui.send(JSON.stringify({ type: "client_register", clientType: "tui" }));
			await waitFor("sessions_list", () => seen.some((m) => m.type === "sessions_list"));
			await waitFor(
				"live state surviving the burst",
				() => seen.some((m) => m.type === "state_update" && m.sessionId === OUR_SESSION && m.state === "processing"),
			);
			const liveState = () => seen.filter((m) => m.type === "state_update").at(-1)?.state;
			expect(liveState()).toBe("processing");
			const burstsBefore = bursts;
			tui.send(JSON.stringify({ type: "focus_session", sessionId: OUR_SESSION }));
			await waitFor("repeat burst after duplicate focus", () => bursts > burstsBefore);
			// No event repairs a clobber; the fixed settle proves the live paint holds.
			await new Promise((r) => setTimeout(r, 200));
			expect(liveState()).toBe("processing");
			for (const d of [...dashboards]) {
				d.send(JSON.stringify({ type: "prompt_options", sessionId: OTHER_SESSION, question: "foreign" }));
				d.send(JSON.stringify({ type: "prompt_options", question: "unattributed" }));
				d.send(JSON.stringify({ type: "usage_update", sessionId: OTHER_SESSION, cost: 42 }));
				d.send(JSON.stringify({ type: "verification_barrier" }));
			}
			await waitFor("all foreign frames delivered", () => seen.some((m) => m.type === "verification_barrier"));
			expect(seen.some((m) => m.type === "prompt_options" || m.type === "usage_update")).toBe(false);
			tui.close();
			await handlers.get("session_shutdown")?.({}, ctx);
		} finally {
			daemon.stop();
		}
	});
});
