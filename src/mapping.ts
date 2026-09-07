/**
 * Pure mapping between OMP hook events and the AgentDeck session protocol.
 *
 * No I/O here — this module is the unit-tested core. The Deck daemon
 * consumes explicit push-channel states (`idle` / `processing` /
 * `disconnected`) and `prompt_options` / `select_option` round-trips for
 * approvals, so the mapping stays small on purpose.
 */

export type DeckSessionState = "idle" | "processing" | "disconnected";

export type OmpLifecycleEvent =
	| "session_start"
	| "before_agent_start"
	| "agent_start"
	| "agent_end"
	| "tool_call"
	| "tool_result"
	| "session_shutdown";

/** Deck state for an OMP lifecycle event. Tool activity recovers a dropped prompt-submit. */
export function deckStateForOmpEvent(event: OmpLifecycleEvent): DeckSessionState {
	switch (event) {
		case "session_shutdown":
			return "disconnected";
		case "session_start":
		case "agent_end":
			return "idle";
		case "before_agent_start":
		case "agent_start":
		case "tool_call":
		case "tool_result":
			return "processing";
	}
}

export interface DeckPromptOptions {
	question: string;
	options: [string, string];
}

const QUESTION_MAX_CHARS = 280;

/** One-line human summary of a tool call for the deck question. Never dumps full input. */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = input[key];
			if (typeof value === "string" && value.length > 0) return value;
			if (Array.isArray(value) && typeof value[0] === "string") return value[0];
		}
		return undefined;
	};
	const headline =
		pick("command", "path", "paths", "file", "pattern", "url", "text", "prompt", "message") ?? toolName;
	return headline.length > 160 ? `${headline.slice(0, 157)}…` : headline;
}

/** Approval question for a gated tool call. Fixed Allow/Deny order — index 0 always allows. */
export function promptOptionsForToolCall(
	toolName: string,
	input: Record<string, unknown>,
): DeckPromptOptions {
	const question = `Allow ${toolName}? ${summarizeToolInput(toolName, input)}`;
	return {
		question:
			question.length > QUESTION_MAX_CHARS ? `${question.slice(0, QUESTION_MAX_CHARS - 1)}…` : question,
		options: ["Allow", "Deny"],
	};
}

export type DeckDecision = "allow" | "deny";

/**
 * Resolve a deck `select_option` answer to a gate decision.
 * Returns null when the answer must not apply: stale question echo (the
 * session moved on) or an out-of-range index. Fail closed — null means the
 * caller falls back to the timeout path, never to allow.
 */
export function decisionFromSelectOption(
	index: number,
	askedQuestion: string,
	currentQuestion?: string,
): DeckDecision | null {
	if (currentQuestion !== undefined && currentQuestion !== askedQuestion) return null;
	if (index === 0) return "allow";
	if (index === 1) return "deny";
	return null;
}
