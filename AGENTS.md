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

The local bridge currently requires a daemon advertising `mode: "daemon"` and `sameSocketControl: true`. Do not infer the capability from the product name or claim installing a daemon alone fixes protocol errors. Health responses can contain pairing credentials; print only an explicit allowlist of diagnostic fields.

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

- `bun test && bun run check && bun run smoke`: 46 tests pass, TypeScript passes,
  and all 15 fake-daemon smoke assertions pass.
- `bun scripts/live-smoke.mjs`: a fresh real OMP process registers with the
  isolated daemon on 9139. Idle prompts reach OMP. Deny blocks an actual read;
  Allow returns the real package data. Interrupt releases a pending approval
  within the five-second check. EOF shutdown removes the remote session.
- `AGENTDECK_TEST_RECONNECT=1 bun scripts/live-smoke.mjs`: after restarting
  the disposable real daemon during approval, the same OMP session re-registers.
- `AGENTDECK_TEST_STREAMING=1 bun scripts/live-smoke.mjs`: the final source
  produces streaming output, accepts a queued steering prompt, aborts the
  current generation, and answers `STEERING_CONFIRMED`. The final live run
  enabled both streaming and reconnect checks and passed every scenario.

These controls were sent over AgentDeck's real WebSocket, not through physical
buttons. The upstream `dashboard` command is a monitoring TUI, not a web page
or an approval widget. The TUI was launched, but the rendered OMP row and
physical Stream Deck+ controls remain unverified. Do not report hardware parity.

Remaining boundaries:

- The existing Swift service on 9120 lacks `sameSocketControl:true` and cannot
  provide this bridge's reverse path. No service was installed or replaced.
- Usage, cost, context utilization, model updates, tool-progress detail, subagent
  activity, and timeline parity are absent. `navigate_option` and `switch_mode`
  remain no-ops. This gate does not implement OMP's native question UI.
- Supplied question or request-ID mismatches are rejected. Legacy commands
  may omit both. Identical question text does not identify a unique request.
- The worker route is internal upstream protocol. No upstream source changes
  were necessary for the verified control loop; no upstream PR was opened.

## Verification standard

For protocol changes, exercise actual upstream consumer shapes, not only a fake that accepts arbitrary JSON. Prove startup without a daemon, capability rejection, structured prompt rendering, stale question rejection, idle and streaming prompt injection, interrupt, gate resolution, reconnect, and shutdown at the appropriate runtime boundary. Treat registration, rendered controls, and successful device actions as separate acceptance checks.

Before declaring the integration working, observe a real OMP session in the real AgentDeck dashboard and verify the intended Stream Deck+ controls. Keep automated results and live evidence separate. Service replacement, credential changes, and other destructive operations require Lee's explicit approval.
