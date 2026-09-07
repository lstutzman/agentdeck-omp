/** Minimal ambient runtime surface for scripts (Bun serve + process exit). */
declare const Bun: {
	serve(options: {
		port: number;
		fetch(
			request: Request,
			server: { upgrade(request: Request): boolean; port: number },
		): Response | undefined;
		websocket: {
			open(ws: { send(data: string): void }): void;
			message(ws: { send(data: string): void }, raw: string | Uint8Array | ArrayBuffer): void;
			close?(ws: unknown): void;
		};
	}): { port: number; stop(): void };
};

declare const process: { exit(code: number): never };
