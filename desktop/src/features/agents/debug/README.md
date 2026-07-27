# DEBUG HARNESS — TEMPORARY, NOT FOR RELEASE

A dev-only harness for testing the composer live-activity feature without
real agents. It simulates up to two synthetic agents ("Alpha Debug" /
"Beta Debug") working and/or streaming progress in the channel currently in
view.

## What it does

- A floating "Debug agents" pill (bottom-right, dev builds only) expands into
  a panel with per-agent **Working** / **Progress** / **Typing** switches and
  an **Emit once** button.
- **Working** emits `turn_started` into `activeAgentTurnsStore` +
  `observerRelayStore` and keeps the turn alive with `turn_liveness`
  heartbeats every 10s (the store prunes idle turns after 25s). Toggling off
  emits `turn_completed`, exercising the terminal/tombstone path.
- **Progress** streams scripted ACP `session/update` frames (thought, tool
  call, chunked assistant message, usage) every 2.5s so the live-activity
  transcript renders realistic content.
- **Typing** simulates the basic "is typing" situation: a synthetic
  channel-scoped typing entry (as if a kind-20002 typing indicator arrived)
  with NO observer turn. This exercises the typing-fallback path —
  `useChannelActivityTyping` → `reportChannelBotTyping` →
  `ChannelComposerActivityRow` diverts typing-only agents out of the pill
  strip and into the combined typing indicator group (humans + agents,
  overlapping avatars, "X and Y are typing…"). Independent of
  Working/Progress, so you can also test observer-over-typing precedence by
  enabling both. Unlike real typing indicators there is no TTL; the entry
  stays until toggled off.
- Two synthetic `RelayAgent` entries are appended to the relay-agent roster in
  `useChannelActivityTyping` so the composer activity bar can resolve the
  working pubkeys to named agents.

## How to remove

Everything is marked with the string `DEBUG HARNESS`. To rip it out:

1. Delete this folder: `desktop/src/features/agents/debug/`.
2. `desktop/src/features/channels/ui/useChannelActivityTyping.ts` — remove the
   `useDebugHarnessRelayAgents` / `useDebugHarnessTypingEntries` imports, the
   `relayAgentsWithDebug` block (passing `relayAgents` straight into
   `buildChannelAgentSessionCandidates` again), and the
   `typingEntriesWithDebug` block (using `typingEntries` directly again) —
   restoring both in the memo deps.
3. `desktop/src/app/AppShell.tsx` — remove the `DebugHarnessMount` import and
   its one-line JSX mount.

Verify nothing is left:

```bash
grep -rn "DEBUG HARNESS\|debugAgentHarness\|DebugHarnessMount\|AgentActivityDebugPanel" desktop/src
```
