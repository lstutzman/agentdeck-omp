import { strict as assert } from "node:assert";
import { resolve } from "node:path";

const port = Number(process.env.AGENTDECK_TEST_PORT ?? 9139);
const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
assert.equal(health.mode, "daemon");
assert.equal(health.sameSocketControl, true);
const deck = [];
const rpc = [];
let socket = new WebSocket(`ws://127.0.0.1:${port}`);
const registrySocket = socket;
socket.onmessage = (event) => deck.push(JSON.parse(String(event.data)));
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(50);
  }
}
await until(() => socket.readyState === WebSocket.OPEN, "daemon socket");
socket.send(JSON.stringify({ type: "client_register", clientType: "companion", clientLabel: "OMP live smoke" }));
const child = Bun.spawn([
  "omp", "--mode", "rpc", "--no-session", "--no-title", "--no-extensions",
  "--extension", resolve("src/index.ts"), "--no-skills", "--no-rules", "--no-lsp",
  "--tools", "read", "--approval-mode", "yolo", "--max-time", "2m",
  "--model", process.env.OMP_TEST_MODEL ?? "openai-codex/gpt-6-astra",
  "--system-prompt", "You are a read-only integration test. For each new user request, call read exactly once on the requested file, even if a previous request read it. Do not retry within a request if denied. Never modify files. Keep answers brief.",
], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTDECK_PORT_WINDOW: `${port}-${port}` } });
const decoder = new TextDecoder();
const output = (async () => {
  let pending = "";
  for await (const chunk of child.stdout) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("{")) continue; // Non-protocol startup diagnostics.
      rpc.push(JSON.parse(line));
    }
  }
  pending += decoder.decode();
  const trailing = pending.trim();
  if (!trailing) return;
  if (!trailing.startsWith("{")) return; // Trailing diagnostics.
  rpc.push(JSON.parse(pending));
})();
const stderrText = new Response(child.stderr).text();
let sessionId;
try {
  await until(() => rpc.some((x) => x.type === "ready"), "OMP ready");
  child.stdin.write(JSON.stringify({ type: "get_state", id: "identity" }) + "\n");
  await until(() => rpc.some((x) => x.id === "identity"), "OMP identity");
  sessionId = rpc.find((x) => x.id === "identity").data.sessionId;
  await until(() => deck.some((x) => x.type === "sessions_list" && x.sessions.some((s) => s.id === sessionId)), "real session registration");
  const registered = deck.findLast((x) => x.type === "sessions_list" && x.sessions.some((s) => s.id === sessionId));
  const sessionPort = registered.sessions.find((s) => s.id === sessionId).port;
  assert(Number.isInteger(sessionPort) && sessionPort > 0 && sessionPort !== port);
  assert.equal(typeof registered.sessions.find((s) => s.id === sessionId).modelName, "string", "registered modelName");
  registrySocket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "sessions_list") deck.push(frame);
  };
  const switchedAt = deck.length;
  socket = new WebSocket(`ws://127.0.0.1:${sessionPort}`);
  socket.onmessage = (event) => deck.push(JSON.parse(String(event.data)));
  await until(() => socket.readyState === WebSocket.OPEN, "advertised session endpoint");
  socket.send(JSON.stringify({ type: "client_register", clientType: "tui" }));
  await until(() => deck.slice(switchedAt).some((x) => x.type === "state_update" && x.sessionId === sessionId), "switched session snapshot");
  const send = (command) => socket.send(JSON.stringify({ ...command, sessionId }));
  console.log("PASS real OMP registration and advertised endpoint session switching");
  for (const [index, expectedError] of [[1, true], [0, false]]) {
    const startDeck = deck.length;
    const startRpc = rpc.length;
    send({ type: "send_prompt", text: `New independent ${expectedError ? "denial" : "allow"} scenario: read package.json exactly once with the read tool and report the package name. Do not reuse earlier results. If this call is denied, say DENIED and stop this turn.` });
    await until(() => deck.slice(startDeck).some((x) => x.type === "prompt_options" && x.question), "real read approval");
    const prompt = deck.slice(startDeck).find((x) => x.type === "prompt_options" && x.question);
    assert.equal(prompt.promptType, "yes_no");
    assert.deepEqual(prompt.options, [{ index: 0, label: "Allow" }, { index: 1, label: "Deny" }]);
    assert(deck.slice(startDeck).some((x) => x.type === "state_update" && x.state === "awaiting_permission" && x.currentTool === "read"));
    send({ type: "select_option", index, question: prompt.question });
    await until(() => rpc.slice(startRpc).some((x) => x.type === "tool_execution_end"), "tool result");
    const result = rpc.slice(startRpc).find((x) => x.type === "tool_execution_end");
    assert.equal(result.isError, expectedError);
    assert(JSON.stringify(result.result).includes(expectedError ? "denied" : "agentdeck-omp"));
    await until(() => rpc.slice(startRpc).some((x) => x.type === "agent_end" && x.isTerminal !== false), "turn completion");
    await until(() => deck.slice(startDeck).some((x) => x.type === "usage_update" && x.sessionId === sessionId && x.inputTokens > 0), "usage after turn");
    console.log(`PASS real idle prompt injection and ${expectedError ? "Deny blocks" : "Allow executes"}`);
  }
  {
    const gateStart = deck.length;
    const rpcStart = rpc.length;
    send({ type: "send_prompt", text: "New interruption scenario: use read exactly once on package.json. Do not reuse earlier results." });
    await until(() => deck.slice(gateStart).some((x) => x.type === "prompt_options" && x.question), "gate before interrupt");
    send({ type: "interrupt" });
    await until(() => rpc.slice(rpcStart).some((x) => x.type === "tool_execution_end"), "interrupted gate releases immediately", 5000);
    const interrupted = rpc.slice(rpcStart).find((x) => x.type === "tool_execution_end");
    assert.equal(interrupted.isError, true);
    await until(() => rpc.slice(rpcStart).some((x) => x.type === "agent_end" && x.isTerminal !== false), "interrupted turn ends");
    console.log("PASS real interrupt blocks and releases pending approval");
  }
  if (process.env.AGENTDECK_TEST_STREAMING === "1") {
    const rpcStart = rpc.length;
    send({ type: "send_prompt", text: "Streaming test: output integers 1 through 5000, one per line. Do not use tools." });
    await until(() => rpc.slice(rpcStart).some((x) => x.type === "message_update" && x.assistantMessageEvent?.type === "text_delta"), "actual streaming output");
    child.stdin.write(JSON.stringify({ type: "get_state", id: "streaming" }) + "\n");
    await until(() => rpc.some((x) => x.id === "streaming"), "streaming state");
    assert.equal(rpc.find((x) => x.id === "streaming").data.isStreaming, true);
    send({ type: "send_prompt", text: "Stop listing integers. Your next response must be exactly STEERING_CONFIRMED." });
    send({ type: "interrupt" });
    await until(() => rpc.slice(rpcStart).some((x) => x.type === "agent_end" && x.messages?.some((m) => m.steering === true)), "queued steering consumed");
    await until(() => rpc.slice(rpcStart).some((x) => x.type === "agent_end" && x.messages?.some((m) => m.role === "assistant" && m.content?.some((c) => c.type === "text" && c.text === "STEERING_CONFIRMED"))), "steering response");
    assert(rpc.slice(rpcStart).some((x) => x.type === "agent_end" && x.messages?.some((m) => m.stopReason === "aborted")));
    console.log("PASS real streaming steering and generation interruption");
  }
  if (process.env.AGENTDECK_TEST_RECONNECT === "1") {
    const gateStart = deck.length;
    const rpcStart = rpc.length;
    send({ type: "send_prompt", text: "New reconnect scenario: use read exactly once on package.json. Do not reuse earlier results." });
    await until(() => deck.slice(gateStart).some((x) => x.type === "prompt_options" && x.question), "gate before restart");
    console.log("WAIT restart isolated daemon now; approval is pending");
    await until(() => socket.readyState === WebSocket.CLOSED, "daemon restart begins", 60000);
    const deadline = Date.now() + 30000;
    while (true) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      assert(Date.now() < deadline, "daemon failed to restart");
      await Bun.sleep(100);
    }
    const reconnectStart = deck.length;
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.onmessage = (event) => deck.push(JSON.parse(String(event.data)));
    await until(() => socket.readyState === WebSocket.OPEN, "controller reconnect");
    send({ type: "client_register", clientType: "companion", clientLabel: "OMP live smoke" });
    await until(() => deck.slice(reconnectStart).some((x) => x.type === "sessions_list" && x.sessions.some((s) => s.id === sessionId)), "same OMP session re-registers");
    send({ type: "focus_session" });
    await until(() => deck.slice(reconnectStart).some((x) => x.type === "prompt_options" && x.question), "pending approval restored");
    const restored = deck.slice(reconnectStart).find((x) => x.type === "prompt_options" && x.question);
    send({ type: "select_option", index: 1, question: restored.question });
    await until(() => rpc.slice(rpcStart).some((x) => x.type === "tool_execution_end"), "post-reconnect denial");
    assert.equal(rpc.slice(rpcStart).find((x) => x.type === "tool_execution_end").isError, true);
    console.log("PASS real reconnect preserves session and pending approval");
  }
  assert(!rpc.some((x) => x.type === "extension_error"));
} finally {
  try {
    const cutoff = deck.length;
    try {
      child.stdin.end();
    } catch {
      // Stdin already closed; fall through to exit wait.
    }
    await child.exited;
    await output;
    await stderrText;
    if (sessionId) {
      await until(() => deck.slice(cutoff).some((x) => x.type === "sessions_list" && !x.sessions.some((s) => s.id === sessionId)), "session removed after shutdown", 15000);
      console.log("PASS real shutdown removes session");
    }
  } finally {
    socket.close();
    registrySocket.close();
  }
}
