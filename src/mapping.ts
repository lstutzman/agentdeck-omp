/**
 * Pure mapping between OMP hook events and the AgentDeck session protocol.
 *
 * No I/O here — this module is the unit-tested core. The Deck daemon
 * consumes explicit push-channel states (`idle` / `processing` /
 * `disconnected`) and `prompt_options` / `select_option` round-trips for
 * approvals, so the mapping stays small on purpose.
 */

export type DeckSessionState = "idle" | "processing" | "awaiting_permission" | "disconnected";

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
/** OMP `ApprovalMode` (`tools/approval.ts`) → upstream `PermissionMode` enum values. */
export type OmpApprovalMode = "always-ask" | "write" | "yolo";
export type DeckPermissionMode = "default" | "acceptEdits" | "bypassPermissions";

/** OMP's default is `yolo`; the deck shows `bypassPermissions` in purple for it. */
export const DEFAULT_DECK_PERMISSION_MODE: DeckPermissionMode = "bypassPermissions";

export function deckPermissionModeForOmp(mode: OmpApprovalMode): DeckPermissionMode {
	switch (mode) {
		case "yolo":
			return "bypassPermissions";
		case "write":
			return "acceptEdits";
		case "always-ask":
			return "default";
	}
}

export interface DeckPromptOption {
	index: number;
	label: string;
}

export interface DeckPromptOptions {
	promptType: "yes_no" | "yes_no_always" | "multi_select";
	question: string;
	options: DeckPromptOption[];
}

export type ToolGateTier = "read" | "approval";

/** Unknown tools require approval; only known side-effect-free tools bypass the deck gate. */
export function toolGateTier(toolName: string): ToolGateTier {
	switch (toolName) {
		case "read":
		case "grep":
		case "glob":
			return "read";
		default:
			return "approval";
	}
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
	const headline = pick("command", "path", "paths", "file", "pattern", "url", "text", "prompt", "message") ?? toolName;
	return headline.length > 160 ? `${headline.slice(0, 157)}…` : headline;
}

/** Approval question for a gated tool call. Fixed Allow/Always/Deny option order. */
export function promptOptionsForToolCall(toolName: string, input: Record<string, unknown>): DeckPromptOptions {
	const question = `Allow ${toolName}? ${summarizeToolInput(toolName, input)}`;
	return {
		promptType: "yes_no_always",
		question: question.length > QUESTION_MAX_CHARS ? `${question.slice(0, QUESTION_MAX_CHARS - 1)}…` : question,
		options: [
			{ index: 0, label: "Allow" },
			{ index: 1, label: "Always" },
			{ index: 2, label: "Deny" },
		],
	};
}

/** One `ask` question reduced to what the deck can show: the text and its option labels. */
export interface AskQuestion {
	question: string;
	labels: string[];
}

/**
 * Parse an OMP `ask` tool input (`questions[].{question, options[].label}`).
 * Null when the shape is not a well-formed ask call; the caller then treats
 * it as an ordinary tool. Every question must carry at least one option.
 */
export function askQuestionsFromInput(input: Record<string, unknown>): AskQuestion[] | null {
	const raw = input.questions;
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const questions: AskQuestion[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || !("question" in item) || !("options" in item)) return null;
		const { question, options } = item;
		if (typeof question !== "string" || question === "" || !Array.isArray(options)) return null;
		const labels: string[] = [];
		for (const option of options) {
			if (!option || typeof option !== "object" || !("label" in option)) return null;
			if (typeof option.label !== "string" || option.label === "") return null;
			labels.push(option.label);
		}
		if (labels.length === 0) return null;
		questions.push({ question, labels });
	}
	return questions;
}

/** Deck prompt for one ask question; option index is the position in the ask's option list. */
export function promptOptionsForAsk(question: AskQuestion): DeckPromptOptions {
	return {
		promptType: "multi_select",
		question:
			question.question.length > QUESTION_MAX_CHARS
				? `${question.question.slice(0, QUESTION_MAX_CHARS - 1)}…`
				: question.question,
		options: question.labels.map((label, index) => ({ index, label })),
	};
}

/**
 * Block reason that carries the deck answers back to the model. OMP cannot
 * substitute a tool result, so the answer rides the block reason exactly as
 * the upstream ask-gate does for Claude Code.
 */
export function askAnswerReason(questions: AskQuestion[], answers: number[]): string {
	const lines = questions.map((q, i) => `${q.question} → ${q.labels[answers[i] ?? -1] ?? "(no answer)"}`);
	return `The user answered from AgentDeck; do not ask again.\n${lines.join("\n")}`;
}

export type DeckDecision = "allow" | "deny";

export interface OmpUsageStats {
	input: number;
	output: number;
	cost: number;
}

export interface DeckUsageEvent {
	type: "usage_update";
	sessionDurationSec: number;
	inputTokens: number;
	outputTokens: number;
	toolCalls: number;
	estimatedCostUsd?: number | undefined;
	[key: string]: unknown;
}
/** Map OMP usage statistics to the deck `usage_update` event. Cost rides only when positive. */
export function deckUsageForOmp(args: {
	stats: OmpUsageStats;
	toolCalls: number;
	startedAtMs: number;
	nowMs: number;
}): DeckUsageEvent {
	const cost = args.stats.cost > 0 ? { estimatedCostUsd: args.stats.cost } : {};
	return {
		type: "usage_update",
		sessionDurationSec: Math.floor((args.nowMs - args.startedAtMs) / 1000),
		inputTokens: args.stats.input,
		outputTokens: args.stats.output,
		toolCalls: args.toolCalls,
		...cost,
	};
}
