// =============================================================================
// DEBUG HARNESS — TEMPORARY CODE. NOT FOR RELEASE.
//
// Simulates up to two synthetic agents "working" / "making progress" so the
// composer live-activity surfaces can be tested without real agents. Drives
// the same stores the real observer pipeline feeds (activeAgentTurnsStore +
// observerRelayStore) with synthetic observer events.
//
// Removal: delete this `debug/` folder and revert the two call sites marked
// with "DEBUG HARNESS (remove)" — see README.md in this folder.
// =============================================================================

import * as React from "react";

import { syncAgentTurnsFromEvents } from "@/features/agents/activeAgentTurnsStore";
import { injectObserverEventsForE2E } from "@/features/agents/observerRelayStore";
import type { ObserverEvent } from "@/features/agents/ui/agentSessionTypes";
import type { RelayAgent } from "@/shared/api/types";

export type DebugAgentSlotId = "a" | "b";

export const DEBUG_AGENT_SLOTS: readonly DebugAgentSlotId[] = ["a", "b"];

/** Fixed synthetic identities (valid lowercase 64-hex pubkeys). Names are
 * chosen so avatar initials differ per slot (AD / BD — see getInitials). */
const DEBUG_AGENT_DEFS: Record<
  DebugAgentSlotId,
  { pubkey: string; name: string }
> = {
  a: { pubkey: "da0a".repeat(16), name: "Alpha Debug" },
  b: { pubkey: "db0b".repeat(16), name: "Beta Debug" },
};

/** Matches the real harness liveness cadence (BUZZ_ACP_TURN_LIVENESS_SECS);
 * must stay under the 25s prune bound in activeAgentTurnsStore. */
const LIVENESS_INTERVAL_MS = 10_000;
/** Cadence of scripted transcript frames while "Progress" is on. */
const PROGRESS_INTERVAL_MS = 2_500;

export type DebugAgentSlotState = {
  pubkey: string;
  name: string;
  working: boolean;
  progress: boolean;
  /** Channel the current turn targets (captured when Working toggled on). */
  channelId: string | null;
};

export type DebugHarnessSnapshot = {
  /** Channel currently in view — the target for newly started turns. */
  activeChannelId: string | null;
  slots: Record<DebugAgentSlotId, DebugAgentSlotState>;
};

type SlotRuntime = {
  seq: number;
  turnCounter: number;
  cycle: number;
  scriptStep: number;
  sessionId: string;
  turnId: string | null;
  channelId: string | null;
  livenessTimer: ReturnType<typeof setInterval> | null;
  progressTimer: ReturnType<typeof setInterval> | null;
};

function createRuntime(slot: DebugAgentSlotId): SlotRuntime {
  return {
    // Seed above any previously processed seq so the turns-store watermark
    // never rejects fresh harness events.
    seq: Date.now(),
    turnCounter: 0,
    cycle: 0,
    scriptStep: 0,
    sessionId: `debug-session-${slot}`,
    turnId: null,
    channelId: null,
    livenessTimer: null,
    progressTimer: null,
  };
}

const runtimes: Record<DebugAgentSlotId, SlotRuntime> = {
  a: createRuntime("a"),
  b: createRuntime("b"),
};

const slotStates: Record<DebugAgentSlotId, DebugAgentSlotState> = {
  a: {
    pubkey: DEBUG_AGENT_DEFS.a.pubkey,
    name: DEBUG_AGENT_DEFS.a.name,
    working: false,
    progress: false,
    channelId: null,
  },
  b: {
    pubkey: DEBUG_AGENT_DEFS.b.pubkey,
    name: DEBUG_AGENT_DEFS.b.name,
    working: false,
    progress: false,
    channelId: null,
  },
};

let activeChannelId: string | null = null;

const listeners = new Set<() => void>();

function buildSnapshot(): DebugHarnessSnapshot {
  return {
    activeChannelId,
    slots: {
      a: { ...slotStates.a },
      b: { ...slotStates.b },
    },
  };
}

let snapshot: DebugHarnessSnapshot = buildSnapshot();

function notify() {
  snapshot = buildSnapshot();
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeDebugAgentHarness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDebugAgentHarnessSnapshot(): DebugHarnessSnapshot {
  return snapshot;
}

/** React hook for the floating panel UI. */
export function useDebugAgentHarness(): DebugHarnessSnapshot {
  return React.useSyncExternalStore(
    subscribeDebugAgentHarness,
    getDebugAgentHarnessSnapshot,
  );
}

// -----------------------------------------------------------------------------
// Event emission
// -----------------------------------------------------------------------------

/**
 * Emit one synthetic observer event for a slot into BOTH stores — the turns
 * store (working signal) and the observer store (transcript). Mirrors what
 * the E2E `__BUZZ_E2E_SEED_ACTIVE_TURNS__` bridge does.
 */
function emitObserverEvent(
  slot: DebugAgentSlotId,
  kind: string,
  payload: unknown,
) {
  const runtime = runtimes[slot];
  if (!runtime.channelId) return;
  runtime.seq += 1;
  const event: ObserverEvent = {
    seq: runtime.seq,
    timestamp: new Date().toISOString(),
    kind,
    agentIndex: 0,
    channelId: runtime.channelId,
    sessionId: runtime.sessionId,
    turnId: runtime.turnId,
    payload,
  };
  syncAgentTurnsFromEvents(DEBUG_AGENT_DEFS[slot].pubkey, [event]);
  injectObserverEventsForE2E(DEBUG_AGENT_DEFS[slot].pubkey, [event]);
}

// -----------------------------------------------------------------------------
// Scripted progress frames
// -----------------------------------------------------------------------------

type ProgressFrameContext = {
  slot: DebugAgentSlotId;
  agentName: string;
  cycle: number;
};

/**
 * One full "work cycle" of ACP `session/update` frames, in the shapes the
 * transcript parser renders (see agentSessionTranscript.ts): thought, tool
 * call start/finish, a streamed three-chunk assistant message, and a usage
 * tick. Frames are emitted as `acp_read` events — that is the kind the
 * transcript parser expects for `session/update`.
 */
const PROGRESS_SCRIPT: Array<
  (ctx: ProgressFrameContext) => Record<string, unknown>
> = [
  ({ agentName }) => ({
    sessionUpdate: "agent_thought_chunk",
    content: {
      type: "text",
      text: `Thinking through the next step for ${agentName}…\n`,
    },
  }),
  ({ slot, cycle }) => ({
    sessionUpdate: "tool_call",
    toolCallId: `debug-tool-${slot}-${cycle}`,
    title: "Read composer wiring",
    kind: "read",
    status: "in_progress",
    rawInput: { path: "desktop/src/features/channels/ui/ChannelPane.tsx" },
  }),
  ({ slot, cycle }) => ({
    sessionUpdate: "tool_call_update",
    toolCallId: `debug-tool-${slot}-${cycle}`,
    status: "completed",
    rawOutput: { summary: "Read 812 lines from ChannelPane.tsx" },
  }),
  ({ slot, cycle }) => ({
    sessionUpdate: "agent_message_chunk",
    messageId: `debug-msg-${slot}-${cycle}`,
    content: {
      type: "text",
      text: `Pass ${cycle + 1}: I inspected the composer wiring `,
    },
  }),
  ({ slot, cycle }) => ({
    sessionUpdate: "agent_message_chunk",
    messageId: `debug-msg-${slot}-${cycle}`,
    content: {
      type: "text",
      text: "and traced the live-activity feed to the observer store. ",
    },
  }),
  ({ slot, cycle }) => ({
    sessionUpdate: "agent_message_chunk",
    messageId: `debug-msg-${slot}-${cycle}`,
    content: {
      type: "text",
      text: "Next I will verify the turn-resurrection path end to end.",
    },
  }),
  ({ cycle }) => ({
    sessionUpdate: "usage_update",
    used: 1_200 + cycle * 340,
    size: 8_192,
  }),
];

function emitNextProgressFrame(slot: DebugAgentSlotId) {
  const runtime = runtimes[slot];
  if (!runtime.turnId) return;
  const step = PROGRESS_SCRIPT[runtime.scriptStep];
  if (!step) return;
  const update = step({
    slot,
    agentName: DEBUG_AGENT_DEFS[slot].name,
    cycle: runtime.cycle,
  });
  emitObserverEvent(slot, "acp_read", {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: runtime.sessionId,
      update,
    },
  });
  runtime.scriptStep += 1;
  if (runtime.scriptStep >= PROGRESS_SCRIPT.length) {
    runtime.scriptStep = 0;
    runtime.cycle += 1;
  }
}

// -----------------------------------------------------------------------------
// Timers
// -----------------------------------------------------------------------------

function stopLivenessTimer(runtime: SlotRuntime) {
  if (runtime.livenessTimer) {
    clearInterval(runtime.livenessTimer);
    runtime.livenessTimer = null;
  }
}

function stopProgressTimer(runtime: SlotRuntime) {
  if (runtime.progressTimer) {
    clearInterval(runtime.progressTimer);
    runtime.progressTimer = null;
  }
}

// -----------------------------------------------------------------------------
// Public controls
// -----------------------------------------------------------------------------

/**
 * Called from useChannelActivityTyping so turns started from the panel target the
 * channel the user is currently viewing.
 */
export function reportDebugHarnessActiveChannel(channelId: string | null) {
  if (activeChannelId === channelId) return;
  activeChannelId = channelId;
  notify();
}

/**
 * Toggle a slot's "working" state. On: emits `turn_started` in the active
 * channel and keeps the turn alive with `turn_liveness` heartbeats. Off:
 * emits `turn_completed` (exercising the terminal/tombstone path) and stops
 * all timers, including progress.
 */
export function setDebugAgentWorking(slot: DebugAgentSlotId, on: boolean) {
  const runtime = runtimes[slot];
  const state = slotStates[slot];
  if (state.working === on) return;

  if (on) {
    if (!activeChannelId) return;
    runtime.channelId = activeChannelId;
    runtime.turnCounter += 1;
    runtime.turnId = `debug-turn-${slot}-${runtime.turnCounter}`;
    runtime.scriptStep = 0;
    emitObserverEvent(slot, "turn_started", null);
    stopLivenessTimer(runtime);
    runtime.livenessTimer = setInterval(() => {
      emitObserverEvent(slot, "turn_liveness", null);
    }, LIVENESS_INTERVAL_MS);
    state.working = true;
    state.channelId = runtime.channelId;
  } else {
    stopLivenessTimer(runtime);
    stopProgressTimer(runtime);
    emitObserverEvent(slot, "turn_completed", null);
    runtime.turnId = null;
    runtime.channelId = null;
    state.working = false;
    state.progress = false;
    state.channelId = null;
  }
  notify();
}

/**
 * Toggle a slot's scripted progress stream. Implies working — toggling
 * progress on for an idle slot starts its turn first.
 */
export function setDebugAgentProgress(slot: DebugAgentSlotId, on: boolean) {
  const runtime = runtimes[slot];
  const state = slotStates[slot];
  if (state.progress === on) return;

  if (on) {
    if (!state.working) {
      setDebugAgentWorking(slot, true);
      if (!slotStates[slot].working) return;
    }
    emitNextProgressFrame(slot);
    stopProgressTimer(runtime);
    runtime.progressTimer = setInterval(() => {
      emitNextProgressFrame(slot);
    }, PROGRESS_INTERVAL_MS);
    state.progress = true;
  } else {
    stopProgressTimer(runtime);
    state.progress = false;
  }
  notify();
}

/** Emit a single scripted progress frame (starts the turn if needed). */
export function emitDebugAgentProgressOnce(slot: DebugAgentSlotId) {
  if (!slotStates[slot].working) {
    setDebugAgentWorking(slot, true);
    if (!slotStates[slot].working) return;
  }
  emitNextProgressFrame(slot);
}

/** Ends every running debug turn (both slots). */
export function endAllDebugAgentTurns() {
  for (const slot of DEBUG_AGENT_SLOTS) {
    setDebugAgentWorking(slot, false);
  }
}

// -----------------------------------------------------------------------------
// Roster injection (useChannelActivityTyping)
// -----------------------------------------------------------------------------

const EMPTY_RELAY_AGENTS: RelayAgent[] = [];
let cachedRosterChannelId: string | null = null;
let cachedRosterAgents: RelayAgent[] = EMPTY_RELAY_AGENTS;

/**
 * Synthetic `RelayAgent` entries scoped to the active channel so they pass
 * `getChannelAgentSessionAgents` and show up in the composer activity bar.
 * Reference-stable per channel id.
 */
function getDebugHarnessRelayAgents(channelId: string | null): RelayAgent[] {
  if (!import.meta.env.DEV || !channelId) return EMPTY_RELAY_AGENTS;
  if (cachedRosterChannelId !== channelId) {
    cachedRosterChannelId = channelId;
    cachedRosterAgents = DEBUG_AGENT_SLOTS.map((slot) => ({
      pubkey: DEBUG_AGENT_DEFS[slot].pubkey,
      name: DEBUG_AGENT_DEFS[slot].name,
      agentType: "debug-harness",
      channels: [],
      channelIds: [channelId],
      capabilities: [],
      status: "online",
      respondTo: null,
      respondToAllowlist: [],
    }));
  }
  return cachedRosterAgents;
}

/**
 * DEBUG HARNESS hook for useChannelActivityTyping: appends the synthetic debug agents to
 * the relay-agent roster and reports the viewed channel to the harness. A
 * no-op passthrough in production builds.
 */
export function useDebugHarnessRelayAgents(
  relayAgents: RelayAgent[] | undefined,
  channelId: string | null,
): RelayAgent[] {
  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    reportDebugHarnessActiveChannel(channelId);
    return () => {
      reportDebugHarnessActiveChannel(null);
    };
  }, [channelId]);

  const debugAgents = getDebugHarnessRelayAgents(channelId);
  return React.useMemo(() => {
    const base = relayAgents ?? EMPTY_RELAY_AGENTS;
    if (debugAgents.length === 0) return base;
    return [...base, ...debugAgents];
  }, [relayAgents, debugAgents]);
}
