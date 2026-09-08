# AgentDeck integration for OMP

## Goal and scope

Build an independent OMP extension that approaches AgentDeck's Claude Code integration in observable behavior: session discovery and focus, lifecycle and tool activity, prompts and approvals, prompt injection, interrupt, model and usage telemetry, and session cleanup. A passing fake-daemon smoke run does not establish feature parity or working hardware.

Keep integration changes in this repository. The upstream repositories below are reference implementations, not places to install this project's files. Do not change the parent container's instruction files.

## Upstream references

Reviewed on 2026-09-07. Branches move; recheck relevant source before changing a contract. Revisions observed during this review:

- AgentDeck: https://github.com/puritysb/AgentDeck, default branch `master`, HEAD `0c84109396c7e0bd32886554765e7a84a0f064d2`.
- Oh My Pi: https://github.com/can1357/oh-my-pi, HEAD `daf07999c2fee9b22edc7bf8fea1fb6272e0df5e`.

### AgentDeck

Read these files when changing transport, display payloads, approvals, or the parity baseline:

- [`bridge/src/session-push-channel.ts`](https://github.com/puritysb/AgentDeck/blob/master/bridge/src/session-push-channel.ts): outbound worker registration, state ingestion, same-socket focus and command delivery. Registration requires `sessionId` and `port`; `remoteAttach: true` enables the worker reverse-control route. The daemon acknowledges registration with `session_push_ack`.
- [`bridge/src/session-focus-relay.ts`](https://github.com/puritysb/AgentDeck/blob/master/bridge/src/session-focus-relay.ts): focus/unfocus messages, `session_command_down`, `session_event_up`, and the relayed event allowlist: `state_update`, `prompt_options`, `usage_update`.
- [`shared/src/protocol.ts`](https://github.com/puritysb/AgentDeck/blob/master/shared/src/protocol.ts): authoritative event and command shapes. `StateUpdateEvent` requires `state` and `permissionMode`. `PromptOptionsEvent` requires `promptType` and structured options. `select_option` carries an optional `question` echo, not a guaranteed gate request ID. `permission_decision` is a separate request-ID-based command.
- [`shared/src/states.ts`](https://github.com/puritysb/AgentDeck/blob/master/shared/src/states.ts): states include `awaiting_permission`, `awaiting_option`, and `awaiting_diff`. `PromptOption` requires `{ index: number, label: string }`; a string array is not valid.
- [`bridge/src/adapters/claude-code.ts`](https://github.com/puritysb/AgentDeck/blob/master/bridge/src/adapters/claude-code.ts): Claude lifecycle comes from hooks. Its terminal observer supplies additional UI information such as options, diff prompts, cursor, mode, model, and usage. The OMP integration should use supported extension APIs rather than duplicate terminal scraping.
- [`bridge/src/permission-resolver.ts`](https://github.com/puritysb/AgentDeck/blob/master/bridge/src/permission-resolver.ts): Node observed-Claude approval path holds a PreToolUse HTTP response, correlates `permission_decision` by request ID, and returns Claude's hook decision. Timeout passes control back to Claude's own policy. This is different from managed-session option selection.
- [`plugin/src/actions/option-dial.ts`](https://github.com/puritysb/AgentDeck/blob/master/plugin/src/actions/option-dial.ts): despite its historical name, this Stream Deck+ dial currently shows Claude usage. Approval interaction lives in the keypad detail view. Do not infer hardware roles from old filenames.

The local bridge currently requires a daemon advertising `mode: "daemon"` and `sameSocketControl: true`. Do not infer the capability from the product name or claim installing a daemon alone fixes protocol errors. Health responses can contain pairing credentials; print only an explicit allowlist of diagnostic fields. `/health` carries no package version, only `build` (a content hash of the running JavaScript); a version pin is not available over HTTP. The bridge instead warns once when registration is never acknowledged, which is how a daemon that dropped the internal worker route presents.

Since 2026-09-08 the daily 9120 service on this machine is the Node daemon (`@agentdeck/bridge` 1.2.1, LaunchAgent `dev.agentdeck.daemon`, installed with `agentdeck daemon install`, which also installed Claude Code hooks and the OpenCode plugin). AgentDeck.app runs in client mode beside it. Set `AGENTDECK_PORT_WINDOW=lo-hi` to restrict the extension's discovery to a throwaway daemon; the fake-daemon tests and both smoke scripts do this so they never register with the daily daemon.

#### Public API boundary

[`docs/surface-protocol.md`](https://github.com/puritysb/AgentDeck/blob/master/docs/surface-protocol.md) explicitly limits the stable external API to allow-listed Surface Protocol v1 profiles. The complete internal WebSocket protocol is not a public compatibility promise. Our `session_push_register` / `session_push_state` transport uses that internal worker protocol, associated with the legacy managed-session remote-attach route.

The published profiles serve dashboards, control clients, portable readers, and displays. They do not declare an agent-session producer registration capability. This extension produces OMP sessions; switching it to `companion-control/v1` is therefore not an established replacement. Before promising durable compatibility, establish a supported agent-ingestion contract with upstream, or explicitly pin and verify the internal worker route against named daemon releases. AgentDeck's supported-agent table does not list OMP.

### Oh My Pi

Read these files when changing extension loading, lifecycle hooks, steering, or telemetry:

- [`packages/coding-agent/src/extensibility/extensions/types.ts`](https://github.com/can1357/oh-my-pi/blob/HEAD/packages/coding-agent/src/extensibility/extensions/types.ts): actual `ExtensionAPI` and `ExtensionContext` contracts. Notifications use `ctx.ui.notify`, not `ctx.notify`. Context exposes `abort`, `isIdle`, session/model information, and context-usage access. Prefer authoritative types over permissive local substitutes.
- [`packages/coding-agent/src/extensibility/extensions/runner.ts`](https://github.com/can1357/oh-my-pi/blob/HEAD/packages/coding-agent/src/extensibility/extensions/runner.ts): handler dispatch and timeout behavior. `tool_call` is a pre-execution gate whose result may block a tool. Native handler failures/timeouts have their own policy; do not describe bridge timeout fallthrough as a universal deny.
- [`packages/coding-agent/src/extensibility/shared-events.ts`](https://github.com/can1357/oh-my-pi/blob/HEAD/packages/coding-agent/src/extensibility/shared-events.ts): lifecycle, tool, message, model, and observability events.
- [`packages/coding-agent/src/session/agent-session.ts`](https://github.com/can1357/oh-my-pi/blob/HEAD/packages/coding-agent/src/session/agent-session.ts): `sendUserMessage` implementation. At the reviewed upstream revision, omitted `deliverAs` starts a turn when idle and queues steering while streaming. Explicit `steer`/`followUp` queues without starting an idle turn. Verify the installed OMP version before assuming identical behavior.

The extension gate is independent of native OMP approval. Deck Allow releases this gate; native policy still applies. Deny returns a blocking result. Timeout and supersession currently return `undefined`, leaving native policy in charge. Never label that unconditional safety or native approval parity.

## Review and repair evidence

The 2026-09-07 review found incompatible notifications and approval payloads,
missing permission state, stale-answer acceptance, and an unclosed health server.
These are repaired with behavioral regression tests. Interrupt and escape also
block and release a pending tool gate before aborting the OMP turn.

Verified against installed OMP **18.1.11** and AgentDeck Node bridge **1.2.1**,
revision `0c84109396c7e0bd32886554765e7a84a0f064d2`:

- `bun test && bun run check && bun run smoke`: 51 tests pass, TypeScript passes,
  and all 15 fake-daemon smoke assertions pass.
- `bun scripts/live-smoke.mjs`: a fresh real OMP process registers with the
  isolated daemon on 9139, and its controller switches to the advertised OMP
  endpoint before exercising controls. Idle prompts reach OMP. Deny blocks an actual read;
  Allow returns the real package data. Interrupt releases a pending approval
  within the five-second check. EOF shutdown removes the remote session.
- `AGENTDECK_TEST_RECONNECT=1 bun scripts/live-smoke.mjs`: after restarting
  the disposable real daemon during approval, the same OMP session re-registers.
- `AGENTDECK_TEST_STREAMING=1 bun scripts/live-smoke.mjs`: the final source
  produces streaming output, accepts a queued steering prompt, aborts the
  current generation, and answers `STEERING_CONFIRMED`. The final live run
  enabled both streaming and reconnect checks and passed every scenario.

The automated controls above use AgentDeck's real WebSocket, not physical
buttons. Separate live verification on 2026-09-07 established:

- The installed Stream Deck plugin connects to isolated Node daemon 9139 when
  Stream Deck launches with `AGENTDECK_DATA_DIR` pointing to the isolated data.
  The editor renders the OMP session. An MCP Session Slot press opens its detail
  view. MCP approval selection was not verified.
- Lee opened the fresh session on the physical Stream Deck+. Deny blocked the
  real read with `AgentDeck: denied from the connected dashboard.` Allow
  released a subsequent read about 7.5 seconds after the approval appeared,
  before the 25-second timeout, and returned the real package data.
- The repaired loopback endpoint supports the real dashboard TUI. With two
  real OMP sessions, numeric `1 → 2 → 1` selects distinct session IDs and
  renders `agentdeck-omp · IDLE`. Twenty rendered-screen samples over 22 seconds
  remain connected, beyond the TUI's 20-second stale timeout. Reopening the TUI
  on the already-focused session's port also renders live IDLE.
  The endpoint uses OMP's current snapshot instead of the daemon's delayed
  initial disconnected state. The TUI remains a monitor, not an approval widget.
- After verification, Stream Deck was relaunched without the override.
  Plugin logs confirm daemon 9120 and 9 buttons with 4 encoders. The installed
  plugin file matches its original bytes, and service 9120 remains healthy.

These results establish physical Allow and Deny, not full hardware parity.

Remaining boundaries:

- The Swift daemon lacks `sameSocketControl:true`; the daily service is now
  the Node daemon (see the deployment note above).
- Model name, session usage (input/output tokens, cost, tool calls,
  duration), `currentTool`, `agentType:"omp"`, `permissionMode`, and the
  ask-gate are live; verified 2026-09-08 by `bun scripts/live-smoke.mjs`
  against the daily daemon on 9120: the session list carried `modelName`,
  `agentType:"omp"`, and `permissionMode:"bypassPermissions"`; the gate's
  `state_update` carried `currentTool:"read"`; a `usage_update` with
  `inputTokens > 0` followed each real turn; a real `ask` call surfaced as a
  `multi_select` prompt, the deck's pick came back to the model, and the
  model's reply named it. `currentTool` names the executing tool from
  `tool_call` until `tool_result`/`agent_end`; a blocked call clears it.
- `agentType:"omp"` is not an upstream `AgentType` member: the deck renders
  the neutral accent and its fallback glyph. Omitting it is worse — the slot
  renderer defaults a missing type to `claude-code`. An OMP glyph needs an
  upstream `AgentType` member.
- `permissionMode` starts at `bypassPermissions` (OMP's default `yolo`) and
  follows `tool_approval_requested.approvalMode` when that fires (`write` →
  `acceptEdits`, `always-ask` → `default`). OMP has no approval-mode getter.
- Parity with Claude Code observed sessions still stops at upstream limits,
  each checked against source: `user_prompt`/`goal` (daemon `RELAYED_EVENTS`
  relays only `state_update`, `prompt_options`, `usage_update`; the push
  route accepts no `goal`); context percent (`SessionInfo.contextPercent`
  exists but the push route and remote projection never fill it, and the
  Stream Deck plugin does not render it); subagent census, timeline, and
  APME (hook-only ingest). `navigate_option` and `switch_mode` remain no-ops:
  OMP exposes no extension API for approval-mode changes or native prompt
  navigation, and the ask-gate makes cursor navigation unnecessary.
- Supplied question or request-ID mismatches are rejected. Legacy commands
  may omit both. Identical question text does not identify a unique request.
- The worker route is internal upstream protocol. No upstream source changes
  were necessary for the verified control loop; no upstream PR was opened.
- Daemon command focus remains global. A session endpoint is a display adapter,
  not a per-session authorization boundary or isolated control channel.
- `session_command_down` is applied by session ID only. `select_option` and
  `respond` are correlated to the open gate, but `send_prompt`, `interrupt`,
  and `escape` carry no correlation: a command sent while this session was
  focused but delivered after focus moved still executes here. Fencing needs
  a focus generation in upstream command frames.

## Verification standard

For protocol changes, exercise actual upstream consumer shapes, not only a fake that accepts arbitrary JSON. Prove startup without a daemon, capability rejection, structured prompt rendering, stale question rejection, idle and streaming prompt injection, interrupt, gate resolution, reconnect, and shutdown at the appropriate runtime boundary. Treat registration, rendered controls, and successful device actions as separate acceptance checks.

Run fake-daemon tests and real-daemon smoke sequentially. They share the
9120–9139 discovery range; concurrent runs can attach real OMP to a test daemon.

Before declaring the integration working, observe a real OMP session in the real AgentDeck dashboard and verify the intended Stream Deck+ controls. Keep automated results and live evidence separate. Service replacement, credential changes, and other destructive operations require Lee's explicit approval.
