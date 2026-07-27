# DEBUG HARNESS — TEMPORARY, NOT FOR RELEASE

A dev-only harness for testing the composer live-activity feature
(`composerLiveActivity` preview flag) without real agents. It simulates up to
two synthetic agents ("Alpha Debug" / "Beta Debug") working and/or
streaming progress in the channel currently in view.

## What it does

- A floating "Debug agents" pill (bottom-right, dev builds only) expands into
  a panel with per-agent **Working** / **Progress** switches and an
  **Emit once** button.
- **Working** emits `turn_started` into `activeAgentTurnsStore` +
  `observerRelayStore` and keeps the turn alive with `turn_liveness`
  heartbeats every 10s (the store prunes idle turns after 25s). Toggling off
  emits `turn_completed`, exercising the terminal/tombstone path.
- **Progress** streams scripted ACP `session/update` frames (thought, tool
  call, chunked assistant message, usage) every 2.5s so the live-activity
  transcript renders realistic content.
- Two synthetic `RelayAgent` entries are appended to the relay-agent roster in
  `useChannelActivityTyping` so the composer activity bar can resolve the
  working pubkeys to named agents.

## How to remove

Everything is marked with the string `DEBUG HARNESS`. To rip it out:

1. Delete this folder: `desktop/src/features/agents/debug/`.
2. `desktop/src/features/channels/ui/useChannelActivityTyping.ts` — remove the
   `useDebugHarnessRelayAgents` import and the `relayAgentsWithDebug` block,
   passing `relayAgents` straight into `buildChannelAgentSessionCandidates`
   again (and restoring it in the memo deps).
3. `desktop/src/app/AppShell.tsx` — remove the `DebugHarnessMount` import and
   its one-line JSX mount.

Verify nothing is left:

```bash
grep -rn "DEBUG HARNESS\|debugAgentHarness\|DebugHarnessMount\|AgentActivityDebugPanel" desktop/src
```
