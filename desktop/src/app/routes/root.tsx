import { createRootRoute } from "@tanstack/react-router";

import { AppShell } from "@/app/AppShell";
// DEBUG HARNESS (remove): see desktop/src/features/agents/debug/README.md
import { DebugHarnessMount } from "@/features/agents/debug/DebugHarnessMount";

function RootComponent() {
  return (
    <>
      <AppShell />
      {/* DEBUG HARNESS (remove) */}
      <DebugHarnessMount />
    </>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
