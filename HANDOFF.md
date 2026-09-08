# Handoff — agentdeck-omp (2026-09-08)

Read this first when resuming. `AGENTS.md` holds standing rules and upstream
facts; `DESIGN.md` holds the design. This file is the current state and the
next actions.

## Goal

Make the `agentdeck-omp` OMP extension a daily-use AgentDeck (Stream Deck)
integration at parity with Claude Code: one Session Slot key per OMP session,
loud "needs you" rendering, tap into a detail view, Allow/Deny/answer from the
deck, canned prompt keys. Git buttons are out of scope.

## State at handoff

The current integration baseline reports active ask gates as
`awaiting_option` on both `session_push_state` and forwarded `state_update`
frames. Ordinary tool gates remain `awaiting_permission`.

Latest prior code commits:

- `3b6c572` Share the Allow, Always, and Deny option indexes between prompt
  construction and command settlement.
- `5cde06e` Add tiered tool gating and session-scoped Always approval.
- `779c873` Record physical Session Slot verification.
- `511f377` Document the daily extension install through the
  `~/.omp/agent/extensions` symlink.

Current gate: `bun test` 66 pass, 0 fail, and 176 assertions;
`bun run check` clean; `bun run smoke` PASS. Real smoke on 9120 passed
registration and switching, read bypass, Deny, Allow, interrupt, ask with
`awaiting_option`, session-scoped Always, and shutdown.

### The daily install (this session's real finding)

Until 2026-09-08 the extension existed only inside this repository and was
loaded only by the smoke scripts (`omp --no-extensions --extension
src/index.ts`). Daily OMP sessions (Herdr) load extensions from
`~/.omp/agent/extensions/`, which had nothing from this project. Result: no
session ever registered; the Stream Deck showed the plugin's empty-deck
placeholder (`HUB READY / CONNECTED`, `NO SESSION / WAITING`, `AgentDeck /
IDLE`), which are inert status cards rendered only when the daemon has zero
sessions (upstream `plugin/src/session-slot-manager.ts:795-823`).

Fix applied: symlink `~/.omp/agent/extensions/agentdeck-omp ->
<repo>/src`. OMP discovers `extensions/<dir>/index.ts` through symlinks
(`loader.ts` `discoverExtensionsInDir`), so every plain `omp` launch loads the
working tree with no build step.

Verified: a plain `omp --mode rpc` launch with default discovery (no flags)
registered on the daily daemon 9120; `sessions_list` showed
`agentType:"omp"`, `state:"idle"`, `permissionMode:"bypassPermissions"`,
`projectName:"agentdeck-omp"`.

Sessions started before the symlink existed do not have the extension. Lee
restarted his OMP sessions, and the new sessions loaded it.

Measurement note: there is no HTTP `/sessions` route on the daemon. Read the
registry through a WebSocket `client_register` (`clientType:"companion"`) and
the `sessions_list` frame. Print allow-listed fields only (`id` prefix,
`agentType`, `state`, `permissionMode`, `projectName`, `port`); frames carry
`pairingToken`.

## Physical deck verification

Verified on 2026-09-08: Lee confirmed that the restarted OMP session appears
as a Session Slot key on the physical Stream Deck. This completes the
post-restart registration check.

If the deck returns to the placeholder, check that the symlink resolves, the
session started after the symlink existed, the daemon on 9120 reports
`mode:"daemon"` and `sameSocketControl:true`, and `sessions_list` contains the
OMP session.

The ask-gate state is verified independently on the push-state and focused
event paths. This matters because AgentDeck uses both channels when projecting
session state.

## Open decisions Lee has not answered yet

1. **Explain key.** Not addable from this repo. The idle preset row (`GO ON /
   REVIEW / COMMIT / CLEAR`) is hardcoded per agent family upstream
   (`session-slot-manager.ts:173-178`); the only dynamic slot is
   `suggestedPrompt`, now `Approved`. Options: (a) upstream PR adding an `omp`
   preset row selected by `agentType` (also fixes `COMMIT`/`CLEAR` sending
   Claude slash commands to OMP); (b) swap the dynamic slot to `Explain`.
   Before wiring either, verify `send_prompt` with `/explain` triggers Lee's
   `/explain` skill in OMP.
2. **Tap-to-focus default**: on by default under Herdr, or opt-in env flag.

## Pending work, in priority order

Each item: one RED test at the seams, run it, GREEN, refactor; then
`bun test && bun run check && bun run smoke`; then the real smoke on 9120;
then commit and push to `main` (no PR, Lee's decision).

1. **Herdr tap-to-focus.** On `session_focus_down`, run
   `herdr agent focus "$HERDR_PANE_ID"` when `HERDR_ENV=1` and
   `HERDR_PANE_ID` is set; suppress the focus_down that arrives within about
   two seconds of socket open (reconnect echo). Inject a `focusTerminal` dep in
   `BridgeDeps` for the test. Load `skill://herdr` before any Herdr command.
   Upstream `focus_session` only sets daemon focus; AgentDeck does not raise
   the agent window.
2. **Upstream issue drafts** for `puritysb/AgentDeck` (text for Lee's review,
   nothing posted): (1) add `omp` to `AgentType` with accent and glyph
   (`shared/src/adapter.ts:8-17`; unknown types render gray with the OpenClaw
   glyph; a missing type defaults to `claude-code`); (2) accept
   `contextPercent`/`totalTokens` on `session_push_state` and render them;
   (3) accept `goal` on `session_push_state` or relay `user_prompt`;
   (4) `omp` preset row or configurable prompt keys.

## Constraints and conventions

- All changes stay in this repository. Never modify upstream AgentDeck or OMP.
  Upstream reference checkout (read-only, Main agent only):
  `/tmp/agentdeck-omp-upstream-20260907` (AgentDeck Node 1.2.1). OMP source
  pin `daf07999c2fee9b22edc7bf8fea1fb6272e0df5e` read from raw GitHub
  (`packages/coding-agent/src/...`). Installed OMP is 18.1.11 (Homebrew).
- Never print raw `/health` bodies, full `get_state`, pairing URLs, env
  dumps, or daemon frames. Never grep or glob the `~/.omp/agent` root: its
  `cache/document-conversions/` holds personal documents. Scope searches to
  named config files or `~/.omp/agent/extensions/`.
- Destructive operations, credential changes, service replacement, and
  process termination need Lee's express approval naming the targets. Delete
  with `/usr/bin/trash`.
- Lint rule `ts-no-inline-cast-access`: never `(x as {...}).field`; narrow
  with `in`/`typeof`. Pre-existing casts in the `tool_call` handler are
  tolerated; add no new ones.
- Run fake-daemon tests and the real-daemon smoke sequentially, never
  concurrently (shared 9120-9139 range).
- Delegate only through OMP-native `task`/`hub`. Herdr is the session cockpit.
- End completed units with the `lee-personal` status line.

## Commands

- `bun test`; `bun run check`; `bun run smoke` (fake daemon 9131-9139).
- Real smoke: `hub start` name `agentdeck-daily-live-smoke`, application
  `bun`, args `["scripts/live-smoke.mjs"]`, env
  `AGENTDECK_TEST_PORT=9120 OMP_TEST_MODEL=openai-codex/gpt-6-astra`,
  `pty:false`, ready log `PASS real shutdown removes session|rror`, timeout
  200. `hub logs` tails include the previous run; grep `^PASS`.
- Format: `bunx @biomejs/biome format --line-width=120 --write src test scripts/live-smoke.mjs`.
- Daemon check: `curl -s http://127.0.0.1:9120/health | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['mode'],d['sameSocketControl'],d['pid'])"`
  -> `daemon True <pid>`.

## Key code locations (post-`5954c87`)

- `src/extension.ts`: `DEFAULT_PORTS` L77; `permissionMode` ~L107;
  `AskHold`/`pending` ~L116-127; `hold` ~L137-154; `IDLE_SUGGESTED_PROMPT`
  and `stateUpdate` ~L156-187; `push` ~L191; `settle` ~L200; `applyCommand`
  ~L212-245; `tool_call` ~L247-262; `tool_approval_requested` ~L270-278;
  `session_start` ~L311.
- `src/agentdeck.ts`: `OMP_AGENT_TYPE` L27; `buildPushState` L69-77;
  `probeDaemons` L109; `PluginCommand` L201; `BridgeClient` L211;
  `pushState` ~L302; `ApprovalGate.answer`/`decide` ~L380-391.
- `src/mapping.ts`: mode mapping L36-52; ask helpers L100-151.
- `src/index.ts`: extension entry; `AGENTDECK_PORT_WINDOW` parsing.
- Tests: `test/extension.test.ts` (seam: `registerBridge` with `fakePi` and
  `fakeSocket`), `test/agentdeck.test.ts`, `test/mapping.test.ts`.

## Upstream plugin facts used this session

- Empty-deck placeholder: `session-slot-manager.ts:795-823`, only when
  `_sessions.length === 0`.
- Idle preset row hardcoded: `session-slot-manager.ts:173-178`;
  `suggestedPrompt` handling `:161-166, 537-539, 1196+`.
- `plugin.ts:249` recognizes only known `agentType`s for `proxiedAgentType`
  (harmless). Command gating `plugin.ts:114-116` excludes only `openclaw`.
- Unknown `agentType` strings pass the daemon verbatim and render neutral;
  never send literal `"yolo"` as `permissionMode` (Android enum).
