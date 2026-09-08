/**
 * End-to-end smoke: fake Node daemon (HTTP /health + WS push channel) drives
 * the REAL extension entry (`src/index.ts`) over real sockets.
 *
 * Flow: session_start → register/ack → idle → focus → agent_start →
 * tool_call held → select_option(deny) blocks → tool_call again →
 * select_option(allow) releases → superseded gate falls back to local →
 * stale deny ignored, fresh allow releases → send_prompt delivers →
 * interrupt aborts → daemon restart → re-register + live state re-push →
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
let connections = 0;

function serveFakeDaemon(preferred?: number): { port: number; stop(closeActiveConnections?: boolean): void } {
	// Bind inside the entry's probe window (9120-9139); AGENTDECK_PORT_WINDOW
	// then pins discovery here so a real daemon on 9120 is never selected.
	const ports = preferred === undefined ? [] : [preferred];
	for (let port = 9139; port >= 9131; port--) ports.push(port);
	for (const port of ports) {
		try {
			const server = Bun.serve({
				port,
				...{ hostname: "127.0.0.1" },
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
						connections += 1;
						daemonSocket = { send: (data: string) => ws.send(data) };
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

function sendDown(frame: unknown): void {
	if (!daemonSocket) throw new Error("smoke FAIL: no daemon socket for down-frame");
	daemonSocket.send(JSON.stringify(frame));
}

function promptOptions(): {
	promptType: string;
	question: string;
	options: { index: number; label: string }[];
	requestId: string;
}[] {
	return daemonReceived
		.map((m) => JSON.parse(m.raw))
		.filter((m) => m.type === "session_event_up" && m.event.type === "prompt_options")
		.map((m) => m.event);
}

function downCommand(command: unknown): unknown {
	return { type: "session_command_down", sessionId: "smoke-1", command };
}

let daemon = serveFakeDaemon();
const daemonPort = daemon.port;
process.env.AGENTDECK_PORT_WINDOW = `${daemonPort}-${daemonPort}`;
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
	ui: { notify: (message: string) => console.log(`smoke notify: ${message}`) },
	sessionManager: { getSessionId: () => "smoke-1" },
	cwd: "/Users/smoke/agentdeck-omp",
};

// The sweep probes 9120-9139 with the real fetch: Swift on 9120 answers
// without the capability and is skipped; closed ports refuse fast.

(factory as (pi: unknown) => void)(pi);
await handlers.get("session_start")?.({ sessionId: "smoke-1" }, ctx);
await waitFor("socket connected", () => connections >= 1);
await waitFor(
	"register acked",
	() =>
		daemonReceived.some((m) => m.type === "session_push_state" && JSON.parse(m.raw).state === "idle"),
);
const register = JSON.parse(daemonReceived.find((m) => m.type === "session_push_register")!.raw);
assert(register.sessionId === "smoke-1", "register carries the OMP session id");
assert(register.remoteAttach === true, "register sets remoteAttach to the capable daemon");
assert(register.projectName === "agentdeck-omp", "register carries the project basename");

await handlers.get("agent_start")?.({}, ctx);
await waitFor(
	"processing pushed",
	() =>
		daemonReceived.some((m) => m.type === "session_push_state" && JSON.parse(m.raw).state === "processing"),
);
assert(true, "agent_start pushes processing");

sendDown({ type: "session_focus_down", sessionId: "smoke-1" });
await new Promise((r) => setTimeout(r, 50));

const held = handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, ctx);
await waitFor("prompt_options emitted", () => promptOptions().length >= 1);
assert(true, "focused tool_call emits prompt_options");
const promptEvent = promptOptions()[0];
assert(
	promptEvent.question.includes("bash") &&
		promptEvent.promptType === "yes_no" &&
		JSON.stringify(promptEvent.options) ===
			JSON.stringify([
				{ index: 0, label: "Allow" },
				{ index: 1, label: "Deny" },
			]),
	"approval question uses the structured yes/no contract",
);

sendDown(downCommand({ type: "select_option", index: 1, requestId: promptEvent.requestId }));
const denied = (await held) as { block?: boolean; reason?: string };
assert(denied?.block === true && typeof denied?.reason === "string", "deny blocks with a reason");

const allowed = handlers.get("tool_call")?.({ toolName: "read", input: { path: "src/index.ts" } }, ctx);
await waitFor("second prompt emitted", () => promptOptions().length >= 2);
const prompt2 = promptOptions().at(-1)!;
sendDown(downCommand({ type: "select_option", index: 0, requestId: prompt2.requestId }));
assert((await allowed) === undefined, "allow releases the gate");

// Stale leg: a second gate supersedes the first; the replaced gate falls
// back to local, and a late answer to it never touches the current gate.
const staleBase = promptOptions().length;
const first = handlers.get("tool_call")?.({ toolName: "bash", input: { command: "id" } }, ctx);
const second = handlers.get("tool_call")?.({ toolName: "read", input: { path: "DESIGN.md" } }, ctx);
await waitFor("superseding prompt emitted", () => promptOptions().length >= staleBase + 2);
const [stalePrompt, livePrompt] = promptOptions().slice(-2);
assert((await first) === undefined, "superseded gate falls back to local");
sendDown(downCommand({ type: "select_option", index: 1, requestId: stalePrompt.requestId }));
sendDown(downCommand({ type: "select_option", index: 0, requestId: livePrompt.requestId }));
assert((await second) === undefined, "stale deny ignored, fresh allow releases");

sendDown(downCommand({ type: "send_prompt", text: "fix it" }));
sendDown(downCommand({ type: "interrupt" }));
await waitFor("prompt delivered", () => prompts.length === 1);
assert(prompts[0] === "fix it", "send_prompt reaches sendUserMessage");
await waitFor("interrupt delivered", () => aborts === 1);
assert(true, "interrupt reaches abort");

// Restart leg: kill the daemon and bring it back on the same port. The
// bridge must re-register and re-push the live state on its own.
const registersBefore = daemonReceived.filter((m) => m.type === "session_push_register").length;
daemon.stop(true);
daemon = serveFakeDaemon(daemonPort);
await waitFor("bridge reconnected", () => connections >= 2, 8000);
await waitFor(
	"re-registered",
	() => daemonReceived.filter((m) => m.type === "session_push_register").length >= registersBefore + 1,
	8000,
);
assert(true, "restart re-registers without a new session");
const secondRegisterAt = daemonReceived.findIndex(
	(m, i) =>
		m.type === "session_push_register" &&
		daemonReceived.findIndex((n) => n.type === "session_push_register") !== i,
);
await waitFor(
	"live state re-pushed",
	() =>
		daemonReceived.some(
			(m, i) =>
				i > secondRegisterAt &&
				m.type === "session_push_state" &&
				JSON.parse(m.raw).state === "processing",
		),
	8000,
);
assert(true, "restart re-pushes live processing state");

await handlers.get("session_shutdown")?.({}, ctx);
await waitFor(
	"disconnected pushed",
	() =>
		daemonReceived.some((m) => m.type === "session_push_state" && JSON.parse(m.raw).state === "disconnected"),
);
assert(true, "shutdown pushes disconnected");

daemon.stop();
console.log("smoke PASS");
process.exit(0);
