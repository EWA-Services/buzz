// =============================================================================
// DEBUG HARNESS — TEMPORARY CODE. NOT FOR RELEASE.
//
// Self-gating mount for the floating debug panel. Statically imported from
// routes/root.tsx so the call site stays small; the panel itself is loaded
// lazily and only in dev builds — with `import.meta.env.DEV` inlined to false
// at build time, the dynamic import below is dead code and no production
// chunk is emitted for the panel or the harness.
//
// Removal: delete this `debug/` folder and revert the two call sites marked
// with "DEBUG HARNESS (remove)" — see README.md in this folder.
// =============================================================================

import * as React from "react";

const LazyAgentActivityDebugPanel = import.meta.env.DEV
  ? React.lazy(async () => {
      const module = await import("./AgentActivityDebugPanel");
      return { default: module.AgentActivityDebugPanel };
    })
  : null;

/** Mounts the dev-only agent-activity debug panel; renders nothing in prod. */
export function DebugHarnessMount() {
  if (!LazyAgentActivityDebugPanel) {
    return null;
  }
  return (
    <React.Suspense fallback={null}>
      <LazyAgentActivityDebugPanel />
    </React.Suspense>
  );
}
