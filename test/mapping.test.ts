import { describe, expect, test } from "bun:test";
import {
	decisionFromSelectOption,
	deckStateForOmpEvent,
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
