import { describe, expect, test } from "bun:test";
import {
	askAnswerReason,
	askQuestionsFromInput,
	deckPermissionModeForOmp,
	deckStateForOmpEvent,
	deckUsageForOmp,
	promptOptionsForAsk,
	promptOptionsForToolCall,
	toolGateTier,
} from "../src/mapping.js";

describe("ask tool mapping", () => {
	test("turns each ask question into a multi_select prompt with its option labels", () => {
		const questions = askQuestionsFromInput({
			questions: [
				{
					id: "db",
					question: "Which store?",
					options: [{ label: "SQLite" }, { label: "Postgres", description: "shared" }],
				},
				{ id: "auth", question: "Which auth?", options: [{ label: "JWT" }, { label: "Cookies" }] },
			],
		});
		expect(questions?.length).toBe(2);
		expect(promptOptionsForAsk(questions![0]!)).toEqual({
			promptType: "multi_select",
			question: "Which store?",
			options: [
				{ index: 0, label: "SQLite" },
				{ index: 1, label: "Postgres" },
			],
		});
	});

	test("rejects input that is not a well-formed ask call", () => {
		expect(askQuestionsFromInput({ command: "ls" })).toBeNull();
		expect(askQuestionsFromInput({ questions: [{ question: "q", options: [] }] })).toBeNull();
	});

	test("states every answer in the block reason so the model continues without asking again", () => {
		const reason = askAnswerReason([{ question: "Which store?", labels: ["SQLite", "Postgres"] }], [1]);
		expect(reason).toContain("Which store?");
		expect(reason).toContain("Postgres");
		expect(reason).not.toContain("SQLite");
	});
});

describe("deckPermissionModeForOmp", () => {
	test("maps OMP approval modes onto the deck's permission modes", () => {
		expect(deckPermissionModeForOmp("yolo")).toBe("bypassPermissions");
		expect(deckPermissionModeForOmp("write")).toBe("acceptEdits");
		expect(deckPermissionModeForOmp("always-ask")).toBe("default");
	});
});

describe("deckStateForOmpEvent", () => {
	test("maps agent lifecycle to deck states", () => {
		expect(deckStateForOmpEvent("session_start")).toBe("idle");
		expect(deckStateForOmpEvent("before_agent_start")).toBe("processing");
		expect(deckStateForOmpEvent("agent_start")).toBe("processing");
		expect(deckStateForOmpEvent("agent_end")).toBe("idle");
		expect(deckStateForOmpEvent("session_shutdown")).toBe("disconnected");
	});

	test("tool activity implies processing", () => {
		expect(deckStateForOmpEvent("tool_call")).toBe("processing");
		expect(deckStateForOmpEvent("tool_result")).toBe("processing");
	});
});

describe("toolGateTier", () => {
	test("classifies only known read-only tools as read tier", () => {
		expect(toolGateTier("read")).toBe("read");
		expect(toolGateTier("grep")).toBe("read");
		expect(toolGateTier("glob")).toBe("read");
		expect(toolGateTier("web_search")).toBe("approval");
		expect(toolGateTier("bash")).toBe("approval");
		expect(toolGateTier("write")).toBe("approval");
		expect(toolGateTier("edit")).toBe("approval");
		expect(toolGateTier("unknown-tool")).toBe("approval");
	});
});

describe("promptOptionsForToolCall", () => {
	test("builds structured Allow/Always/Deny options for a gated tool", () => {
		const prompt = promptOptionsForToolCall("bash", { command: "rm -rf /tmp/x" });
		expect(prompt.question).toContain("bash");
		expect(prompt.promptType).toBe("yes_no_always");
		expect(prompt.options).toEqual([
			{ index: 0, label: "Allow" },
			{ index: 1, label: "Always" },
			{ index: 2, label: "Deny" },
		]);
	});

	test("summarizes long input without dumping it", () => {
		const prompt = promptOptionsForToolCall("write", {
			path: "src/index.ts",
			content: "x".repeat(5000),
		});
		expect(prompt.question.length).toBeLessThan(300);
		expect(prompt.question).toContain("src/index.ts");
	});
});

describe("deckUsageForOmp", () => {
	test("maps usage stats to the usage_update event shape", () => {
		expect(
			deckUsageForOmp({ stats: { input: 1200, output: 300, cost: 0.042 }, toolCalls: 4, startedAtMs: 0, nowMs: 90500 }),
		).toEqual({
			type: "usage_update",
			sessionDurationSec: 90,
			inputTokens: 1200,
			outputTokens: 300,
			toolCalls: 4,
			estimatedCostUsd: 0.042,
		});
	});

	test("omits estimated cost when zero", () => {
		expect(
			deckUsageForOmp({ stats: { input: 10, output: 5, cost: 0 }, toolCalls: 1, startedAtMs: 0, nowMs: 1500 }),
		).toEqual({
			type: "usage_update",
			sessionDurationSec: 1,
			inputTokens: 10,
			outputTokens: 5,
			toolCalls: 1,
		});
	});
});
