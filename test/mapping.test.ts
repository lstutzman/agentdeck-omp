import { describe, expect, test } from "bun:test";
import {
	decisionFromSelectOption,
	deckStateForOmpEvent,
	deckUsageForOmp,
	promptOptionsForToolCall,
} from "../src/mapping.js";

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

describe("promptOptionsForToolCall", () => {
	test("builds structured yes/no options for a gated tool", () => {
		const prompt = promptOptionsForToolCall("bash", { command: "rm -rf /tmp/x" });
		expect(prompt.question).toContain("bash");
		expect(prompt.promptType).toBe("yes_no");
		expect(prompt.options).toEqual([
			{ index: 0, label: "Allow" },
			{ index: 1, label: "Deny" },
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

describe("decisionFromSelectOption", () => {
	test("index 0 allows, index 1 denies", () => {
		expect(decisionFromSelectOption(0, "q")).toBe("allow");
		expect(decisionFromSelectOption(1, "q")).toBe("deny");
	});

	test("stale question echo is rejected", () => {
		expect(decisionFromSelectOption(0, "old question", "new question")).toBeNull();
	});

	test("out-of-range index is rejected", () => {
		expect(decisionFromSelectOption(7, "q")).toBeNull();
	});
});

describe("deckUsageForOmp", () => {
	test("maps usage stats to the usage_update event shape", () => {
		expect(deckUsageForOmp({ stats: { input: 1200, output: 300, cost: 0.042 }, toolCalls: 4, startedAtMs: 0, nowMs: 90500 })).toEqual({
			type: "usage_update",
			sessionDurationSec: 90,
			inputTokens: 1200,
			outputTokens: 300,
			toolCalls: 4,
			estimatedCostUsd: 0.042,
		});
	});

	test("omits estimated cost when zero", () => {
		expect(deckUsageForOmp({ stats: { input: 10, output: 5, cost: 0 }, toolCalls: 1, startedAtMs: 0, nowMs: 1500 })).toEqual({
			type: "usage_update",
			sessionDurationSec: 1,
			inputTokens: 10,
			outputTokens: 5,
			toolCalls: 1,
		});
	});
});
