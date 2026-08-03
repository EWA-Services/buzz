/**
 * Boundary tests for useUnreadChannels — exercises the real parent-to-owner
 * boundary between useUnreadChannels and useObservedUnreadPersistence.
 *
 * These tests mount the FULL production hook (via createRoot + act) to verify
 * that markChannelRead and markAllChannelsRead are scope-safe: a stale callback
 * captured under scope A cannot corrupt scope B's refs or storage after a
 * scope switch. Coverage for both happy paths (current scope mutates correctly)
 * and stale paths (scope-A callback rejects after B loads) is included.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  installDOMShim,
  installFreshStorage,
  seedStorage,
  mountUnreadChannels,
} from "./observedUnreadTestHarness.mjs";

// DOM shim must run before any React import (harness imports React at parse time).
installDOMShim();
installFreshStorage();

import { readObservedUnreadFromStorage } from "./observedUnreadStorage.ts";
import { act } from "react";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RELAY = "wss://relay.example.com";

// ── Tests ─────────────────────────────────────────────────────────────────────

test("markChannelRead happy path: current scope removes channel from observed refs and persists snapshot", async () => {
  installFreshStorage();

  const PUBKEY = "pubkey-happy-mcr";
  // Pre-seed storage so hydration populates latestByChannelRef for channel-1.
  const readAt = seedStorage(PUBKEY, RELAY, "channel-1");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY });

  // Calling markChannelRead with readAt >= observed latest triggers clearObserved.
  // Under the current scope this must delegate to observedPersistence.removeChannel,
  // which deletes channel-1 from both in-memory refs and schedules a write.
  // Wrap in act() because markChannelRead calls bumpLatestVersion (useReducer).
  await act(async () => {
    harness.markChannelRead("channel-1", readAt);
  });

  // Flush the debounce synchronously via pagehide.
  harness.flushStorage();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored === null || !stored.has("channel-1"),
    "channel-1 must be absent from storage after markChannelRead under current scope",
  );

  await harness.unmount();
});

test("markChannelRead happy path: topLevelOnly=true leaves observed refs intact (no clearObserved)", async () => {
  installFreshStorage();

  const PUBKEY = "pubkey-happy-mcr-tlo";
  const readAt = seedStorage(PUBKEY, RELAY, "channel-tlo");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY });

  // topLevelOnly=true: observedLatest is passed as undefined to
  // resolveChannelReadMarker, so clearObserved is false — the observed refs
  // must remain intact.
  await act(async () => {
    harness.markChannelRead("channel-tlo", readAt, { topLevelOnly: true });
  });
  harness.flushStorage();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored?.has("channel-tlo"),
    "channel-tlo must remain in storage when topLevelOnly=true",
  );

  await harness.unmount();
});

test("markChannelRead stale: scope-A callback rejects after scope B loads — B storage survives flush", async () => {
  installFreshStorage();

  const PUBKEY_A = "pubkey-a-mcr";
  const PUBKEY_B = "pubkey-b-mcr";
  // Both scopes share the same channel ID so the stale callback targets the
  // exact channel present in B's hydrated refs. Without the scope fence, the
  // pre-fix parent deleted "channel-shared" from B's refs before the owner
  // operation could reject; a subsequent pagehide flush would then write an
  // empty map to B's bucket, overwriting the seeded event.
  const SHARED_CHANNEL = "channel-shared";

  // Seed A and B each with the same channel so hydration populates both scopes.
  const readAtA = seedStorage(PUBKEY_A, RELAY, SHARED_CHANNEL, "evt-a");
  seedStorage(PUBKEY_B, RELAY, SHARED_CHANNEL, "evt-b");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY_A });

  // Capture markChannelRead from scope A before the switch.
  const staleMarkChannelRead = harness.markChannelRead;

  // Switch to scope B. The persistence hook's hydration effect flushes A
  // synchronously, resets refs, and loads B's storage (channel-shared/evt-b).
  await harness.render(PUBKEY_B);

  // Confirm B's storage has the seeded event before any stale call.
  assert.ok(
    readObservedUnreadFromStorage(PUBKEY_B, RELAY)?.has(SHARED_CHANNEL),
    "B's channel-shared must be present before the stale call",
  );

  // Invoke the stale scope-A markChannelRead. The marker timestamp equals B's
  // observed latest (seeded at NOW_S), so clearObserved would be true — the
  // pre-fix parent would delete channel-shared from B's refs. The fenced owner
  // (removeChannel) validates its captured scope-A against the current
  // scopeLoadedRef (scope B) and returns early. B's refs are untouched.
  await act(async () => {
    staleMarkChannelRead(SHARED_CHANNEL, readAtA);
  });

  // Flush via pagehide: this writes the current in-memory refs to B's bucket.
  // If the stale call corrupted B's refs (pre-fix), the flush overwrites the
  // bucket with an empty or partial map. With the fence in place, the refs
  // still hold evt-b and the flush preserves the seeded event.
  harness.flushStorage();

  const storedBAfter = readObservedUnreadFromStorage(PUBKEY_B, RELAY);
  assert.ok(
    storedBAfter?.has(SHARED_CHANNEL),
    "B's channel-shared must survive the post-stale-call flush (stale scope-A markChannelRead must not corrupt B's refs)",
  );

  await harness.unmount();
});

test("markAllChannelsRead happy path: current scope clears all observed refs and clears storage bucket", async () => {
  installFreshStorage();

  const PUBKEY = "pubkey-happy-mar";
  seedStorage(PUBKEY, RELAY, "channel-1");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY });

  // Under the current scope, clearAll must clear both in-memory refs and
  // cancel any pending write before wiping the storage bucket.
  await act(async () => {
    harness.markAllChannelsRead();
  });

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  // clearObservedUnreadStorage removes the key entirely; null is the expected result.
  assert.ok(
    stored === null || stored.size === 0,
    "storage bucket must be empty after markAllChannelsRead under current scope",
  );

  await harness.unmount();
});

test("markAllChannelsRead stale: scope-A callback rejects after scope B loads — B storage survives flush", async () => {
  installFreshStorage();

  const PUBKEY_A = "pubkey-a-mar";
  const PUBKEY_B = "pubkey-b-mar";

  seedStorage(PUBKEY_A, RELAY, "channel-1");
  seedStorage(PUBKEY_B, RELAY, "channel-2");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY_A });

  // Capture markAllChannelsRead from scope A.
  const staleMarkAllChannelsRead = harness.markAllChannelsRead;

  // Switch to scope B. Hydration flushes A and loads B's storage (channel-2).
  await harness.render(PUBKEY_B);

  assert.ok(
    readObservedUnreadFromStorage(PUBKEY_B, RELAY)?.has("channel-2"),
    "B's channel-2 must be present before the stale call",
  );

  // Invoke the stale scope-A markAllChannelsRead. The pre-fix parent reset
  // both B-scope observed refs to new Maps before the fenced clearAll() could
  // reject. A subsequent pagehide flush would then write an empty map to B's
  // bucket, erasing the seeded event. With the fence in place, clearAll()
  // validates its captured scope-A against the current scopeLoadedRef (scope
  // B) and returns early — B's refs still hold channel-2.
  await act(async () => {
    staleMarkAllChannelsRead();
  });

  // Flush via pagehide: this writes the current in-memory refs to B's bucket.
  // If the stale call wiped B's refs (pre-fix), the flush overwrites the bucket
  // with an empty map. With the fence in place, the refs are intact and the
  // flush preserves channel-2.
  harness.flushStorage();

  const storedBAfter = readObservedUnreadFromStorage(PUBKEY_B, RELAY);
  assert.ok(
    storedBAfter?.has("channel-2"),
    "B's channel-2 must survive the post-stale-call flush (stale scope-A markAllChannelsRead must not wipe B's refs)",
  );

  await harness.unmount();
});
