/**
 * OMP extension entry (`omp --extension <path>`, alias `--hook`).
 *
 * OMP imports this module with Bun and executes the default-export factory
 * once per session. All behavior lives in `registerBridge`; this file only
 * binds real I/O: the loopback session endpoint (`/health` plus the TUI
 * relay), daemon `/health` probes, and sockets.
 */
import { adaptSocket, type ClientTarget, type SessionRoute } from "./agentdeck.js";
import { registerBridge, type BridgePi } from "./extension.js";
import { openSessionEndpoint } from "./session-relay.js";

declare const Bun: {
	spawn(
		command: string[],
		options: { stdin: "ignore"; stdout: "ignore"; stderr: "ignore" },
	): { exited: Promise<number> };
};

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

/** Upstream's throwaway-daemon override: restrict discovery to `lo-hi`. */
function portWindow(): number[] | undefined {
	const match = /^(\d+)-(\d+)$/.exec(process.env.AGENTDECK_PORT_WINDOW ?? "");
	if (!match) return undefined;
	const lo = Number(match[1]);
	const hi = Number(match[2]);
	if (lo > hi) return undefined;
	return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

function herdrFocusTerminal(): (() => Promise<void>) | undefined {
	if (process.env.HERDR_ENV !== "1") return undefined;
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) return undefined;
	return async () => {
		const child = Bun.spawn(["herdr", "agent", "focus", paneId], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await child.exited;
		if (exitCode !== 0) throw new Error(`herdr agent focus exited with code ${exitCode}`);
	};
}

export default function (pi: BridgePi): undefined {
	// Bound before the worker connects so the advertised port is live by
	// `session_start`; the route resolves via the lifecycle hook below.
	let route: SessionRoute | null = null;
	const endpoint = openSessionEndpoint(() => route);
	registerBridge(pi, {
		bridgePort: endpoint?.port ?? 0,
		ports: portWindow(),
		fetchHealth,
		createSocket: (target: ClientTarget) => adaptSocket(new WebSocket(`ws://127.0.0.1:${target.port}`)),
		focusTerminal: herdrFocusTerminal(),
		onSessionRoute: (resolved) => {
			route = resolved;
		},
		onShutdown: () => endpoint?.stop(),
	});
	return undefined;
}
