/**
 * End-to-end smoke: fake Node daemon (HTTP /health + WS push channel) drives
 * the REAL extension entry (`src/index.ts`) over real sockets.
 *
 * Flow: session_start → register/ack → idle → focus → agent_start →
 * tool_call held → select_option(deny) blocks → tool_call again →
 * select_option(allow) releases → send_prompt delivers → interrupt aborts →
 * shutdown disconnects. Any mismatch throws; exit code is the verdict.
 */
import factory from "../src/index.js";

function assert(cond: unknown, label: string): void {
	if (!cond) throw new Error(`smoke FAIL: ${label}`);
	console.log(`smoke ok: ${label}`);
}

async function waitFor(label: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (cond()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`smoke TIMEOUT: ${label}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

const daemonReceived: { type: string; raw: string }[] = [];
let daemonSocket: { send(data: string): void } | null = null;
let resolveSocket: ((s: { send(data: string): void }) => void) | null = null;
const socketReady = new Promise<{ send(data: string): void }>((resolve) => {
	resolveSocket = resolve;
});

function serveFakeDaemon(): { port: number; stop(): void } {
	// Bind inside the entry's probe window (9120-9139) so the normal sweep
	// finds this daemon; the real Swift daemon on 9120 answers without the
	// capability and must be skipped by selection, not by fetch patching.
	for (let port = 9139; port >= 9131; port--) {
		try {
			const server = Bun.serve({
				port,
				fetch(request, server) {
					const url = new URL(request.url);
					if (url.pathname === "/health") {
						return Response.json({ status: "ok", mode: "daemon", sameSocketControl: true });
					}
					if (server.upgrade(request)) return undefined as unknown as Response;
					return new Response("Not Found", { status: 404 });
				},
				websocket: {
					open(ws) {
						daemonSocket = { send: (data: string) => ws.send(data) };
						resolveSocket?.(daemonSocket);
					},
					message(ws, raw: string | Uint8Array | ArrayBuffer) {
						const text = typeof raw === "string" ? raw : String(raw);
						const msg = JSON.parse(text) as { type: string; sessionId?: string };
						daemonReceived.push({ type: msg.type, raw: text });
						if (msg.type === "session_push_register") {
							ws.send(JSON.stringify({ type: "session_push_ack", sessionId: msg.sessionId }));
						}
					},
				},
			});
			return server;
		} catch {
			// Port taken: try the next one down.
		}
	}
	throw new Error("smoke FAIL: no free port in 9131-9139 for the fake daemon");
}

const daemon = serveFakeDaemon();
const daemonPort = daemon.port;
console.log(`smoke: fake daemon on ${daemonPort}`);

// Fake OMP host: capture handlers, prompts, aborts.
const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const prompts: string[] = [];
let aborts = 0;
const pi = {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
		handlers.set(event, handler);
	},
	sendUserMessage: (content: string) => {
		prompts.push(content);
	},
};
const ctx = {
	abort: () => {
		aborts += 1;
	},
	isIdle: () => true,
	notify: (message: string) => console.log(`smoke notify: ${message}`),
	sessionManager: { getSessionId: () => "smoke-1" },
	cwd: "/Users/smoke/agentdeck-omp",
};

// The sweep probes 9120-9139 with the real fetch: Swift on 9120 answers
// without the capability and is skipped; closed ports refuse fast.

(factory as (pi: unknown) => void)(pi);
await handlers.get("session_start")?.({ sessionId: "smoke-1" }, ctx);
const sock = await socketReady;
await waitFor("register acked", () =>
	daemonReceived.some((m) => m.type === "session_push_state" && JSON.parse(m.raw).state === "idle"),
);
const register = JSON.parse(daemonReceived.find((m) => m.type === "session_push_register")!.raw);
assert(register.sessionId === "smoke-1", "register carries the OMP session id");
assert(register.remoteAttach === true, "register sets remoteAttach to the capable daemon");
assert(register.projectName === "agentdeck-omp", "register carries the project basename");

await handlers.get("agent_start")?.({}, ctx);
await waitFor("processing pushed", () =>
	daemonReceived.some((m) => m.type === "session_push_state" && JSON.parse(m.raw).state === "processing"),
);
assert(true, "agent_start pushes processing");

sock.send(JSON.stringify({ type: "session_focus_down", sessionId: "smoke-1" }));
await new Promise((r) => setTimeout(r, 50));

const held = handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, ctx);
await waitFor("prompt_options emitted", () =>
	daemonReceived.some((m) => {
		try {
			const parsed = JSON.parse(m.raw);
			return parsed.type === "session_event_up" && parsed.event.type === "prompt_options";
		} catch {
			return false;
		}
	}),
);
assert(true, "focused tool_call emits prompt_options");
const promptEvent = daemonReceived
	.map((m) => JSON.parse(m.raw))
	.find((m) => m.type === "session_event_up" && m.event.type === "prompt_options").event;
assert(promptEvent.question.includes("bash"), "approval question names the tool");

sock.send(
	JSON.stringify({
		type: "session_command_down",
		sessionId: "smoke-1",
		command: { type: "select_option", index: 1, requestId: promptEvent.requestId },
	}),
);
const denied = (await held) as { block?: boolean; reason?: string };
assert(denied?.block === true && typeof denied?.reason === "string", "deny blocks with a reason");

const allowed = handlers.get("tool_call")?.({ toolName: "read", input: { path: "src/index.ts" } }, ctx);
await waitFor("second prompt emitted", () => daemonReceived.filter((m) => {
	try {
		const parsed = JSON.parse(m.raw);
		return parsed.type === "session_event_up" && parsed.event.type === "prompt_options";
	} catch {
		return false;
	}
}).length >= 2);
const prompt2 = daemonReceived
	.map((m) => JSON.parse(m.raw))
	.filter((m) => m.type === "session_event_up" && m.event.type === "prompt_options")
	.at(-1).event;
sock.send(
	JSON.stringify({
		type: "session_command_down",
		sessionId: "smoke-1",
		command: { type: "select_option", index: 0, requestId: prompt2.requestId },
	}),
);
assert((await allowed) === undefined, "allow releases the gate");

sock.send(
	JSON.stringify({
		type: "session_command_down",
		sessionId: "smoke-1",
		command: { type: "send_prompt", text: "fix it" },
	}),
);
sock.send(
	JSON.stringify({ type: "session_command_down", sessionId: "smoke-1", command: { type: "interrupt" } }),
);
await waitFor("prompt delivered", () => prompts.length === 1);
assert(prompts[0] === "fix it", "send_prompt reaches sendUserMessage");
await waitFor("interrupt delivered", () => aborts === 1);
assert(true, "interrupt reaches abort");

await handlers.get("session_shutdown")?.({}, ctx);
await waitFor("disconnected pushed", () =>
	daemonReceived.some((m) => m.type === "session_push_state" && JSON.parse(m.raw).state === "disconnected"),
);
assert(true, "shutdown pushes disconnected");

daemon.stop();
console.log("smoke PASS");
process.exit(0);
