// =============================================================================
// DEBUG HARNESS — TEMPORARY CODE. NOT FOR RELEASE.
//
// Floating panel controlling the synthetic-agent activity harness
// (debugAgentHarness.ts). Dev builds only.
//
// Removal: delete this `debug/` folder and revert the two call sites marked
// with "DEBUG HARNESS (remove)" — see README.md in this folder.
// =============================================================================

import { Bug, ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Switch } from "@/shared/ui/switch";
import {
  DEBUG_AGENT_SLOTS,
  type DebugAgentSlotId,
  type DebugAgentSlotState,
  emitDebugAgentProgressOnce,
  endAllDebugAgentTurns,
  setDebugAgentProgress,
  setDebugAgentTyping,
  setDebugAgentWorking,
  useDebugAgentHarness,
} from "./debugAgentHarness";

function SlotControls({
  canStart,
  slot,
  state,
}: {
  canStart: boolean;
  slot: DebugAgentSlotId;
  state: DebugAgentSlotState;
}) {
  const workingId = `debug-agent-${slot}-working`;
  const progressId = `debug-agent-${slot}-progress`;
  const typingId = `debug-agent-${slot}-typing`;
  const active = state.working || state.typing;
  return (
    <div className="rounded-md border border-border/60 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            active ? "animate-pulse bg-green-500" : "bg-muted-foreground/40",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {state.name}
        </span>
        <Button
          disabled={!canStart && !state.working}
          onClick={() => emitDebugAgentProgressOnce(slot)}
          size="xs"
          type="button"
          variant="outline"
        >
          Emit once
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
          htmlFor={workingId}
        >
          <Switch
            checked={state.working}
            disabled={!canStart && !state.working}
            id={workingId}
            onCheckedChange={(on) => setDebugAgentWorking(slot, on)}
          />
          Working
        </label>
        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
          htmlFor={progressId}
        >
          <Switch
            checked={state.progress}
            disabled={!canStart && !state.working}
            id={progressId}
            onCheckedChange={(on) => setDebugAgentProgress(slot, on)}
          />
          Progress
        </label>
        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
          htmlFor={typingId}
        >
          <Switch
            checked={state.typing}
            disabled={!canStart && !state.typing}
            id={typingId}
            onCheckedChange={(on) => setDebugAgentTyping(slot, on)}
          />
          Typing
        </label>
      </div>
    </div>
  );
}

/**
 * Floating settings pane (bottom-right) that simulates up to two agents
 * working and/or streaming progress in the channel currently in view.
 */
export function AgentActivityDebugPanel() {
  const [expanded, setExpanded] = React.useState(false);
  const harness = useDebugAgentHarness();

  if (!import.meta.env.DEV) {
    return null;
  }

  const anyWorking = DEBUG_AGENT_SLOTS.some(
    (slot) => harness.slots[slot].working || harness.slots[slot].typing,
  );
  const canStart = harness.activeChannelId !== null;

  if (!expanded) {
    return (
      <Button
        className="fixed bottom-4 right-4 z-[100] shadow-lg"
        data-testid="agent-debug-harness-toggle"
        onClick={() => setExpanded(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <Bug />
        Debug agents
        {anyWorking ? (
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse"
          />
        ) : null}
      </Button>
    );
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
      data-testid="agent-debug-harness-panel"
    >
      <div className="flex items-center gap-1.5">
        <Bug aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 text-xs font-semibold">
          Agent debug harness
        </span>
        <Button
          aria-label="Collapse debug harness"
          onClick={() => setExpanded(false)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ChevronDown />
        </Button>
      </div>
      <p
        className="mt-1 truncate text-2xs text-muted-foreground"
        title={harness.activeChannelId ?? undefined}
      >
        {canStart
          ? `Target channel: ${harness.activeChannelId}`
          : "Open a channel to target it."}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {DEBUG_AGENT_SLOTS.map((slot) => (
          <SlotControls
            canStart={canStart}
            key={slot}
            slot={slot}
            state={harness.slots[slot]}
          />
        ))}
      </div>
      <Button
        className="mt-2 w-full"
        disabled={!anyWorking}
        onClick={endAllDebugAgentTurns}
        size="xs"
        type="button"
        variant="outline"
      >
        End all turns
      </Button>
    </div>
  );
}
