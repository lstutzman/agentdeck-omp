# AgentDeck–OMP Bridge — v1 Design (approved architecture)

Status: architecture approved by Lee (Node daemon + `tool_call` gate).
This spec must be approved in writing before the implementation plan.

## 1. Goal

Surface live OMP sessions on AgentDeck dashboards with bidirectional steering:
telemetry out, prompts / interrupt / approvals back. Local-only package in
`agentdeck-omp`. No AgentDeck fork, no OMP fork.

## 2. Why Node daemon is required (verified)

- Node `/health` advertises `sameSocketControl: true` (`daemon-server.ts`).
  Workers send `remoteAttach: true` only to such daemons
  (`daemon-ws-client.ts` `buildRegisterFrame`).
- Same-socket reverse is the only reverse path: daemon writes
  `session_focus_down` / `session_command_down` down the worker push socket;
  worker rides `session_event_up` back up while focused. No inbound dial.
- Routed commands: `respond`, `interrupt`, `escape`, `select_option`,
  `send_prompt`, `navigate_option`, `switch_mode` (`session-focus-relay.ts`
  `ROUTED_COMMANDS`).
- Relayed events up: `state_update`, `prompt_options`, `usage_update`
  (`RELAYED_EVENTS`, shared both ends so they cannot drift).
- Hook endpoint is `POST /hooks/:eventName` on the Node daemon
  (`daemon-server.ts`: `pathname.startsWith('/hooks/')`). Shell contract
  (`HookInstaller.swift` `buildHookCommand`): `PreToolUse` `--max-time 60`,
  `Stop` `--max-time 10`, rest fire-and-forget `--max-time 0.8`.
- Held `PreToolUse` resolves via `permission-resolver.ts`: timeout → `pass`
  (empty body, Claude normal flow); decision body is
  `{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision}}`.
- Observed steering (`observed-steering.ts`): soft STOP consumed at next
  `PreToolUse` (`STOP_DENY_REASON`); directive queue cap 3, TTL 1h, one per
  `Stop`; `takeDirectiveForStop` refuses `synthetic_stop`.
- Swift: held `PreToolUse` gate removed 2026-06-27 and stays removed
  (`DeviceApprovalGateTests.swift`); live gate is display-only Notification
  overlay. Swift advertises no `sameSocketControl`. Verdict: Swift cannot
  satisfy v1 steering. Refuse it at startup with a clear error.

## 3. Why `tool_call`, not approval events (verified)

OMP `wrapper.ts`: `tool_approval_requested` / `tool_approval_resolved` are
emitted observability-only; handlers take no result type. They cannot gate.
`tool_call` is pre-exec, blockable, input-revisable. v1 gates there:

- Deny → `{block:true, reason}`.
- Allow → return `undefined` (release extension gate; OMP native policy stays
  authoritative and may still prompt).
- Timeout and supersession return `undefined`, leaving native OMP policy in
  charge. This is not fail-closed denial. A stale answer is ignored; the
  pending gate remains open. Disconnect permits reconnect until the gate expires.
- Interrupt and escape block a pending gate before calling `ctx.abort()`.

## 4. Transport shape

Act as an AgentDeck session-bridge worker over WS (pattern:
`DaemonWsClient`), not as a Claude-hooks emulator. Do not claim
`agentType:'claude-code'` — Claude permission prediction is Claude-specific.

- Discovery: probe `127.0.0.1:9120–9139` `/health`. Accept only
  `mode:'daemon'`. Require `sameSocketControl:true`; otherwise refuse with
  “v1 requires the Node daemon”.
- Register: `session_push_register {sessionId, port, projectName,
  host, remoteAttach:true, weight:0}`. `sessionId` is the stable OMP session ID.
  `port` belongs to a loopback `/health` server used for reachability probes.
  The same-socket path does not require an inbound control connection.
  Registration omits `agentType`: upstream has no `omp` type, and the bridge
  must not impersonate another agent.
- Ack: expect `session_push_ack`; `isConnected` = open + acked.
- Telemetry: `session_push_state {sessionId, state, modelName?}` on OMP
  lifecycle changes via existing pure `deckStateForOmpEvent`. While focused,
  also send focused `state_update` and `prompt_options` through
  `session_event_up`. Usage telemetry is not implemented.
- Focus: on `session_focus_down`, emit a full state snapshot and the current
  structured approval options if a gate is open;
  on `session_unfocus_down` clear, stop forwarding. Ignore foreign
  `sessionId` frames. Drop `session_event_up` unless on registered sender
  socket (daemon enforces; mirror it client-side).
- Reconnect: base 2000ms, ×1.5, cap 30000ms (mirror `DaemonWsClient`).
  Re-register from current state; re-emit snapshot if focused. Refuse
  capability-less targets under remote intent; hold loop until a valid
  target resolves.
- Shutdown: resolve any pending gate to native policy, publish `disconnected`,
  close the socket, and stop the loopback health server. The daemon removes
  the remote registration when the socket closes.

## 5. OMP binding (`src/extension.ts`)

- `session_start` → `idle`; `before_agent_start`/`agent_start`/`tool_call`/
  `tool_result` → `processing`; `agent_end` → `idle`;
  `session_shutdown` → `disconnected` (existing mapping, tested).
- `send_prompt` command → `pi.sendUserMessage(text)`. Idle starts a turn;
  streaming steers per OMP semantics. One delivery seam (no dual
  `session_stop` + `sendMessage` for the same directive).
- `interrupt` and `escape` block and release a pending gate, clear its display,
  then call `ctx.abort()`.
- `tool_call` publishes `awaiting_permission` and `prompt_options` with
  `promptType:"yes_no"` and indexed `{index, label}` Allow/Deny objects.
  The question is capped at 280 characters and contains only an input summary.
  Any supplied `requestId` or question echo must match the current gate.
  Legacy commands may omit both; identical question text cannot distinguish
  successive requests without a request ID.
- Timeout is 25 seconds. `navigate_option` and `switch_mode` remain no-ops.
- Full display snapshots use `permissionMode:"default"`. This describes the
  bridge display, not OMP's native approval policy. Model telemetry is absent.

## 6. Files

- `src/mapping.ts` — pure, tested. No I/O.
- `src/agentdeck.ts` — discovery, WS client, reconnect, focus, frame
  encode/decode, correlation. No OMP imports.
- `src/extension.ts` — OMP event bindings, `tool_call` gate,
  `sendUserMessage`/`abort` delivery. Depends on the above.
- `test/agentdeck.test.ts` — transport behavior (register/ack, state push,
  focus/command routing, stale reject, timeout fallback, reconnect).
- `scripts/smoke.ts` — fake OMP host and daemon exercise transport behavior.
- `scripts/live-smoke.mjs` — real installed OMP and a separately running Node
  daemon exercise registration, approval, interruption, and shutdown.

## 7. Verification

Run `bun test && bun run check && bun run smoke`.
Run `bun scripts/live-smoke.mjs` against an isolated capable Node daemon on
port 9139. `AGENTDECK_TEST_PORT` and `OMP_TEST_MODEL` override those defaults.
This command uses the installed `omp` executable and its model credentials.
It runs read-only tool scenarios and prints only allow-listed evidence.

For real restart recovery, set `AGENTDECK_TEST_RECONNECT=1`. When the script
prints `WAIT restart isolated daemon`, restart only the disposable test daemon.
The script checks that the same OMP session and pending approval return.
Set `AGENTDECK_TEST_STREAMING=1` to also verify queued steering during real
generation and interrupt the streaming response.

Protocol commands in these checks do not prove physical Stream Deck+ controls.
Hardware and rendered approval controls remain separate acceptance checks.
