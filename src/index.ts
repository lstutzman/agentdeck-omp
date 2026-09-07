/**
 * OMP extension entry (`omp --extension <path>`, alias `--hook`).
 *
 * OMP imports this module with Bun and executes the default-export factory
 * once per session. All behavior lives in `registerBridge`; this file only
 * binds real I/O: loopback `/health`, daemon `/health` probes, and sockets.
 */
import { adaptSocket, type ClientTarget } from "./agentdeck.js";
import { registerBridge, type BridgePi } from "./extension.js";

declare const Bun:
	| {
			serve(options: {
				hostname: string;
				port: number;
				fetch(request: Request): Response | Promise<Response>;
			}): {
				port: number;
				stop(): void;
			};
	  }
	| undefined;

async function fetchHealth(port: number) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
		if (!response.ok) return null;
		const body = (await response.json()) as { mode?: unknown; sameSocketControl?: unknown };
		return {
			port,
			mode: typeof body.mode === "string" ? body.mode : undefined,
			sameSocketControl: body.sameSocketControl === true ? true : undefined,
		};
	} catch {
		return null;
	}
}

/** Loopback `/health` so daemon reachability probes see this session. */
function openHealthServer(): { port: number; stop(): void } | null {
	try {
		if (typeof Bun === "undefined") return null;
		return Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/health") return Response.json({ status: "ok", mode: "session-bridge" });
				return new Response("Not Found", { status: 404 });
			},
		});
	} catch {
		return null;
	}
}

export default function (pi: BridgePi): undefined {
	const healthServer = openHealthServer();
	registerBridge(pi, {
		bridgePort: healthServer?.port ?? 0,
		fetchHealth,
		createSocket: (target: ClientTarget) => adaptSocket(new WebSocket(`ws://127.0.0.1:${target.port}`)),
		onShutdown: () => healthServer?.stop(),
	});
	return undefined;
}
