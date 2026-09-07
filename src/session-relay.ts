/** Loopback session endpoint: `/health` plus a per-client TUI relay to the daemon. */
import type { SessionRoute } from "./agentdeck.js";

interface RelayConn {
	upstream: WebSocket | null;
	buffered: string[];
	bufferedChars: number;
}
interface RelaySocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	readonly data: RelayConn;
}

declare const Bun:
	| {
			serve(options: {
				hostname: string;
				port: number;
				fetch(
					request: Request,
					server: { upgrade(request: Request, options?: { data?: RelayConn }): boolean },
				): Response | undefined;
				websocket: {
					open(ws: RelaySocket): void;
					message(ws: RelaySocket, message: string | Uint8Array | ArrayBuffer): void;
					close(ws: RelaySocket): void;
				};
			}): { port: number; stop(closeActiveConnections?: boolean): void };
	  }
	| undefined;

const MAX_BUFFERED_MESSAGES = 100;
const MAX_BUFFERED_CHARS = 65536;
const textDecoder = new TextDecoder();

export function openSessionEndpoint(getRoute: () => SessionRoute | null): { port: number; stop(): void } | null {
	if (typeof Bun === "undefined") return null;
	const live = new Set<RelaySocket>();
	let server: { port: number; stop(closeActiveConnections?: boolean): void };
	try {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, srv) {
				if (new URL(request.url).pathname === "/health") {
					return Response.json({ status: "ok", mode: "session-bridge" });
				}
				const origin = request.headers.get("origin");
				if (origin !== null && origin !== "") return new Response("Forbidden", { status: 403 });
				if (!getRoute()) return new Response("Service Unavailable", { status: 503 });
				const conn: RelayConn = { upstream: null, buffered: [], bufferedChars: 0 };
				if (srv.upgrade(request, { data: conn })) return undefined;
				return new Response("Not Found", { status: 404 });
			},
			websocket: {
				open(ws) {
					live.add(ws);
					const route = getRoute();
					if (!route) {
						ws.close(1011, "relay unavailable");
						return;
					}
					const upstream = new WebSocket(`ws://${route.target.host}:${route.target.port}`);
					ws.data.upstream = upstream;
					const sendDown = (text: string) => {
						try {
							ws.send(text);
						} catch {
							upstream.close();
						}
					};
					upstream.onopen = () => {
						try {
							for (const text of ws.data.buffered) upstream.send(text);
							ws.data.buffered = [];
							ws.data.bufferedChars = 0;
							upstream.send(JSON.stringify({ type: "focus_session", sessionId: route.session.sessionId }));
						} catch {
							ws.close(1011, "relay unavailable");
						}
					};
					upstream.onmessage = (event) => {
						if (typeof event.data !== "string") return;
						let frame: unknown;
						try {
							frame = JSON.parse(event.data);
						} catch {
							sendDown(event.data);
							return;
						}
						if (typeof frame === "object" && frame !== null && "type" in frame) {
							// Authoritative local paint: the daemon burst and other
							// global focus states must not overwrite this endpoint.
							if (frame.type === "state_update") {
								for (const snap of route.snapshot()) {
									const stamped =
										snap.type === "state_update"
											? { ...snap, sessionId: route.session.sessionId, projectName: route.session.projectName }
											: { ...snap, sessionId: route.session.sessionId };
									sendDown(JSON.stringify(stamped));
								}
								return;
							}
							// Only identified events from this session belong on its endpoint.
							if (
								(frame.type === "prompt_options" || frame.type === "usage_update") &&
								(!("sessionId" in frame) || frame.sessionId !== route.session.sessionId)
							) {
								return;
							}
						}
						sendDown(event.data);
					};
					const drop = () => ws.close(1011, "relay upstream closed");
					upstream.onclose = drop;
					upstream.onerror = drop;
				},
				message(ws, raw) {
					const conn = ws.data;
					const text = typeof raw === "string" ? raw : textDecoder.decode(raw);
					const upstream = conn.upstream;
					if (upstream?.readyState === WebSocket.OPEN) {
						try {
							upstream.send(text);
						} catch {
							ws.close(1011, "relay unavailable");
						}
						return;
					}
					if (upstream && upstream.readyState >= WebSocket.CLOSING) {
						ws.close(1011, "relay upstream closed");
						return;
					}
					if (conn.buffered.length >= MAX_BUFFERED_MESSAGES || conn.bufferedChars + text.length > MAX_BUFFERED_CHARS) {
						ws.close(1009, "relay buffer full");
						conn.upstream?.close();
						return;
					}
					conn.buffered.push(text);
					conn.bufferedChars += text.length;
				},
				close(ws) {
					live.delete(ws);
					ws.data.upstream?.close();
					ws.data.upstream = null;
				},
			},
		});
	} catch {
		return null;
	}
	return {
		port: server.port,
		stop() {
			for (const ws of [...live]) ws.close(1001, "shutting down");
			server.stop(true);
		},
	};
}
