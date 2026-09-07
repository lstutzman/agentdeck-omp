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
- Timeout / disconnect / stale → fail closed to local: return `undefined`,
  never remote-allow. An AgentDeck allow never overrides a stricter OMP
  policy; a Deck deny always blocks.

## 4. Transport shape

Act as an AgentDeck session-bridge worker over WS (pattern:
`DaemonWsClient`), not as a Claude-hooks emulator. Do not claim
`agentType:'claude-code'` — Claude permission prediction is Claude-specific.

- Discovery: probe `127.0.0.1:9120–9139` `/health`. Accept only
  `mode:'daemon'`. Require `sameSocketControl:true`; otherwise refuse with
  “v1 requires the Node daemon”.
- Register: `session_push_register {sessionId, port, agentType, projectName,
  host, remoteAttach:true, weight:0}`. `sessionId` = stable OMP session id.
  `port` = tiny loopback `/health` server this package opens (satisfies
  reachability probes; daemon never dials back on same-socket path).
  `agentType` = honest generic (e.g. `monitor`); document the compromise —
  upstream has no `omp` type and we will not invent one in v1.
- Ack: expect `session_push_ack`; `isConnected` = open + acked.
- Telemetry: `session_push_state {sessionId, state, modelName?}` on OMP
  lifecycle changes via existing pure `deckStateForOmpEvent`. While focused,
  also ride `session_event_up {sessionId, event}` for `state_update`,
  `prompt_options`, `usage_update` only.
- Focus: on `session_focus_down` set focused, emit snapshot
  (`state_update` + current `prompt_options` if a gate is open + usage);
  on `session_unfocus_down` clear, stop forwarding. Ignore foreign
  `sessionId` frames. Drop `session_event_up` unless on registered sender
  socket (daemon enforces; mirror it client-side).
- Reconnect: base 2000ms, ×1.5, cap 30000ms (mirror `DaemonWsClient`).
  Re-register from current state; re-emit snapshot if focused. Refuse
  capability-less targets under remote intent; hold loop until a valid
  target resolves.
- Shutdown: push `disconnected` state, then close (daemon prunes remote
  registration on socket close).

## 5. OMP binding (`src/extension.ts`)

- `session_start` → `idle`; `before_agent_start`/`agent_start`/`tool_call`/
  `tool_result` → `processing`; `agent_end` → `idle`;
  `session_shutdown` → `disconnected` (existing mapping, tested).
- `send_prompt` command → `pi.sendUserMessage(text)`. Idle starts a turn;
  streaming steers per OMP semantics. One delivery seam (no dual
  `session_stop` + `sendMessage` for the same directive).
- `interrupt` / `escape` → `ctx.abort()`. Immediate in-process abort.
  Document honestly: this is stronger than observed-Claude soft STOP.
- `tool_call` gate: build `promptOptionsForToolCall` (fixed
  `["Allow","Deny"]`, 280-char cap, input summary only), emit as
  `prompt_options` while focused, await `select_option`/`respond` correlated
  by `requestId` + question echo. `decisionFromSelectOption` returns `null`
  on stale echo or bad index → timeout path. Timeout 25s (under the 60s
  hook analogy; in-process gate, bounded). `navigate_option` /
  `switch_mode` acknowledged, no-op in v1 (log).
- Never invent `permissionMode` unless semantically compatible; send
  `modelName` when known.

## 6. Files

- `src/mapping.ts` — pure, tested. No I/O.
- `src/agentdeck.ts` — discovery, WS client, reconnect, focus, frame
  encode/decode, correlation. No OMP imports.
- `src/extension.ts` — OMP event bindings, `tool_call` gate,
  `sendUserMessage`/`abort` delivery. Depends on the above.
- `test/agentdeck.test.ts` — transport behavior (register/ack, state push,
  focus/command routing, stale reject, timeout fallback, reconnect).
- `scripts/smoke.ts` — real OMP session: registration, idle/processing,
  prompt idle + streaming, abort, allow, deny, stale, disconnect, restart.

## 7. Verification

Unit (`bun test`), typecheck (`bunx tsc --noEmit`), then smoke against a
real OMP session covering §6 list. After implementation: simplify + review
passes, then atomic commit. No commit until all green.
