import * as React from "react";

import type { Channel } from "@/shared/api/types";

export function useOffscreenActivityChannelIds({
  activeWorkingByChannelId,
  channels,
  previewActivityChannelIds,
  unreadChannelIds,
}: {
  activeWorkingByChannelId: ReadonlyMap<string, unknown>;
  channels: readonly Channel[];
  previewActivityChannelIds: ReadonlySet<string>;
  unreadChannelIds: ReadonlySet<string>;
}) {
  return React.useMemo(() => {
    const channelIds = new Set([
      ...previewActivityChannelIds,
      ...activeWorkingByChannelId.keys(),
    ]);

    // Direct messages use their own unread indicator rather than the channel
    // preview dot, but should remain discoverable when their row is offscreen.
    for (const channel of channels) {
      if (channel.channelType === "dm" && unreadChannelIds.has(channel.id)) {
        channelIds.add(channel.id);
      }
    }

    return channelIds;
  }, [
    activeWorkingByChannelId,
    channels,
    previewActivityChannelIds,
    unreadChannelIds,
  ]);
}
