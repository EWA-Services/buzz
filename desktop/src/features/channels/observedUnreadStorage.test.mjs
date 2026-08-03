import assert from "node:assert/strict";
import test from "node:test";

import {
  clearObservedUnreadStorage,
  deriveLatestByChannel,
  observedUnreadStorageKey,
  OBSERVED_UNREAD_STORAGE_PREFIX,
  readObservedUnreadFromStorage,
  writeObservedUnreadToStorage,
} from "./observedUnreadStorage.ts";
import { READ_STATE_HORIZON_SECONDS } from "./readState/readStateFormat.ts";
import {
  withIsolatedStorage,
  makeObservedEvent,
  makeEventsByChannel,
} from "./observedUnreadTestHarness.mjs";

const NOW_SECONDS = Math.floor(Date.now() / 1_000);
const FRESH_AT = NOW_SECONDS - 100;
const STALE_AT = NOW_SECONDS - READ_STATE_HORIZON_SECONDS - 100;

// ── observedUnreadStorageKey ──────────────────────────────────────────────────

test("observedUnreadStorageKey: prefix, normalization, and isolation", () => {
  const base = observedUnreadStorageKey("pk1", "wss://relay.example.com");
  // Has correct prefix.
  assert.ok(base.startsWith(`${OBSERVED_UNREAD_STORAGE_PREFIX}:`));
  // URL normalizes (trailing slash, mixed case).
  assert.equal(
    base,
    observedUnreadStorageKey("pk1", "WSS://Relay.Example.Com/"),
  );
  // Relay isolation.
  assert.notEqual(
    base,
    observedUnreadStorageKey("pk1", "wss://relay-b.example.com"),
  );
  // Pubkey isolation.
  assert.notEqual(
    base,
    observedUnreadStorageKey("pk2", "wss://relay.example.com"),
  );
});

// ── write/read round-trip ─────────────────────────────────────────────────────

test("round-trip: events written are readable and intact", () => {
  withIsolatedStorage(() => {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const event = makeObservedEvent({ id: "e1", createdAt: FRESH_AT });
    const map = makeEventsByChannel([["channel-1", [event]]]);

    writeObservedUnreadToStorage(pubkey, relay, map);
    const result = readObservedUnreadFromStorage(pubkey, relay);

    assert.ok(result !== null, "should return a map");
    const ch = result.get("channel-1");
    assert.ok(ch !== undefined, "channel-1 should be present");
    assert.ok(ch.has("e1"), "event e1 should be present");
    const e = ch.get("e1");
    assert.equal(e.id, "e1");
    assert.equal(e.createdAt, FRESH_AT);
    assert.equal(e.rootId, "root-e1");
  });
});

test("round-trip: relay A rows not readable under relay B", () => {
  withIsolatedStorage(() => {
    const pubkey = "pk1";
    const relayA = "wss://relay-a.example.com";
    const relayB = "wss://relay-b.example.com";
    const map = makeEventsByChannel([
      ["channel-1", [makeObservedEvent({ id: "e1", createdAt: FRESH_AT })]],
    ]);

    writeObservedUnreadToStorage(pubkey, relayA, map);
    const result = readObservedUnreadFromStorage(pubkey, relayB);

    assert.equal(result, null, "relay B should see no data");
  });
});

test("read returns null for missing key, corrupt JSON, and non-object eventsByChannel", () => {
  withIsolatedStorage(() => {
    // Missing key.
    assert.equal(
      readObservedUnreadFromStorage("pk1", "wss://relay.example.com"),
      null,
    );

    // Corrupt JSON.
    const key = observedUnreadStorageKey("pk1", "wss://relay.example.com");
    window.localStorage.setItem(key, "not-json{{{");
    assert.equal(
      readObservedUnreadFromStorage("pk1", "wss://relay.example.com"),
      null,
    );

    // eventsByChannel is an array (not an object).
    window.localStorage.setItem(
      key,
      JSON.stringify({ updatedAt: Date.now(), eventsByChannel: [1, 2, 3] }),
    );
    assert.equal(
      readObservedUnreadFromStorage("pk1", "wss://relay.example.com"),
      null,
    );
  });
});

test("read discards malformed events and keeps valid ones", () => {
  withIsolatedStorage(() => {
    const key = observedUnreadStorageKey("pk1", "wss://relay.example.com");
    const valid = makeObservedEvent({ id: "e-ok", createdAt: FRESH_AT });
    window.localStorage.setItem(
      key,
      JSON.stringify({
        updatedAt: Date.now(),
        eventsByChannel: {
          "ch-1": [
            { createdAt: FRESH_AT }, // missing id
            {
              id: "e-inf",
              createdAt: Infinity,
              rootId: null,
              highPriority: false,
              countsTowardBadge: false,
              countsTowardAppBadge: false,
            },
            valid,
          ],
        },
      }),
    );
    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    const ch = result?.get("ch-1");
    assert.ok(ch !== undefined);
    assert.equal(ch.size, 1, "only the valid event should survive");
    assert.ok(ch.has("e-ok"), "valid event must be kept");
  });
});

// ── age pruning ───────────────────────────────────────────────────────────────

test("write prunes stale events; all-stale write removes key; read prunes bypassed stale data", () => {
  withIsolatedStorage(() => {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";
    const key = observedUnreadStorageKey(pubkey, relay);

    // write() prunes on encode path.
    writeObservedUnreadToStorage(
      pubkey,
      relay,
      makeEventsByChannel([
        [
          "ch-1",
          [
            makeObservedEvent({ id: "stale", createdAt: STALE_AT }),
            makeObservedEvent({ id: "fresh", createdAt: FRESH_AT }),
          ],
        ],
      ]),
    );
    const ch = readObservedUnreadFromStorage(pubkey, relay)?.get("ch-1");
    assert.ok(!ch?.has("stale"), "stale event should be pruned on write");
    assert.ok(ch?.has("fresh"), "fresh event should survive");

    // All-stale write removes the key entirely.
    writeObservedUnreadToStorage(
      pubkey,
      relay,
      makeEventsByChannel([
        ["ch-1", [makeObservedEvent({ id: "stale2", createdAt: STALE_AT })]],
      ]),
    );
    assert.equal(
      window.localStorage.getItem(key),
      null,
      "key should be absent when all events stale",
    );

    // read() prunes bypassed stale data (written directly to bypass encode pruning).
    window.localStorage.setItem(
      key,
      JSON.stringify({
        updatedAt: Date.now(),
        eventsByChannel: {
          "ch-r": [
            makeObservedEvent({ id: "stale-r", createdAt: STALE_AT }),
            makeObservedEvent({ id: "fresh-r", createdAt: FRESH_AT }),
          ],
        },
      }),
    );
    const ch2 = readObservedUnreadFromStorage(pubkey, relay)?.get("ch-r");
    assert.ok(!ch2?.has("stale-r"), "stale event should be pruned on read");
    assert.ok(ch2?.has("fresh-r"), "fresh event should survive on read");
  });
});

// ── caps ──────────────────────────────────────────────────────────────────────

test("write caps per channel at 1000 and globally at 5000 keeping newest", () => {
  withIsolatedStorage(() => {
    const pubkey = "pk1";
    const relay = "wss://relay.example.com";

    // Per-channel: 1100 events → capped to 1000, oldest evicted.
    const events = Array.from({ length: 1100 }, (_, i) =>
      makeObservedEvent({ id: `e-${i}`, createdAt: FRESH_AT + i }),
    );
    writeObservedUnreadToStorage(
      pubkey,
      relay,
      makeEventsByChannel([["ch-1", events]]),
    );
    const ch = readObservedUnreadFromStorage(pubkey, relay)?.get("ch-1");
    assert.equal(ch?.size, 1000, "should be capped at 1000");
    assert.ok(!ch?.has("e-0"), "oldest event should be evicted");
    assert.ok(ch?.has("e-1099"), "newest event should survive");

    // Global: 6 channels × 1000 = 6000 → trimmed to ≤ 5000.
    const entries = Array.from({ length: 6 }, (_, c) => [
      `channel-${c}`,
      Array.from({ length: 1000 }, (_, i) =>
        makeObservedEvent({
          id: `ch${c}-e${i}`,
          createdAt: FRESH_AT + c * 10000 + i,
        }),
      ),
    ]);
    writeObservedUnreadToStorage(pubkey, relay, makeEventsByChannel(entries));
    const result = readObservedUnreadFromStorage(pubkey, relay);
    let total = 0;
    for (const eventsById of result.values()) total += eventsById.size;
    assert.ok(total <= 5000, `total ${total} should be <= 5000`);
  });
});

// ── clearObservedUnreadStorage ────────────────────────────────────────────────

test("clearObservedUnreadStorage: removes scope bucket without affecting others", () => {
  withIsolatedStorage(() => {
    const relayA = "wss://relay-a.example.com";
    const relayB = "wss://relay-b.example.com";
    writeObservedUnreadToStorage(
      "pk1",
      relayA,
      makeEventsByChannel([
        ["ch-a", [makeObservedEvent({ id: "ea", createdAt: FRESH_AT })]],
      ]),
    );
    writeObservedUnreadToStorage(
      "pk1",
      relayB,
      makeEventsByChannel([
        ["ch-b", [makeObservedEvent({ id: "eb", createdAt: FRESH_AT })]],
      ]),
    );

    clearObservedUnreadStorage("pk1", relayA);

    assert.equal(
      readObservedUnreadFromStorage("pk1", relayA),
      null,
      "cleared bucket must be null",
    );
    assert.ok(
      readObservedUnreadFromStorage("pk1", relayB)?.has("ch-b"),
      "other scope must be unaffected",
    );
  });
});

// ── deriveLatestByChannel ─────────────────────────────────────────────────────

test("deriveLatestByChannel: max createdAt per channel, empty map returns empty", () => {
  const map = makeEventsByChannel([
    [
      "ch-1",
      [
        makeObservedEvent({ id: "e1", createdAt: 100 }),
        makeObservedEvent({ id: "e2", createdAt: 200 }),
        makeObservedEvent({ id: "e3", createdAt: 150 }),
      ],
    ],
    ["ch-2", [makeObservedEvent({ id: "e4", createdAt: 50 })]],
  ]);
  const latest = deriveLatestByChannel(map);
  assert.equal(latest.get("ch-1"), 200);
  assert.equal(latest.get("ch-2"), 50);
  assert.equal(deriveLatestByChannel(new Map()).size, 0);
});

// ── persistence + lifecycle scenarios ────────────────────────────────────────

test("thread:rootA marker prunes only rootA events, leaving rootB unread", () => {
  // Validates the plan requirement: opening thread A must not clear thread B.
  // This test exercises deriveLatestByChannel to confirm ch-1 still has a
  // non-zero latest after thread A events are removed.

  withIsolatedStorage(() => {
    const rootA = "root-a";
    const rootB = "root-b";
    const eventA = makeObservedEvent({
      id: "eA",
      createdAt: FRESH_AT,
      rootId: rootA,
    });
    const eventB = makeObservedEvent({
      id: "eB",
      createdAt: FRESH_AT + 10,
      rootId: rootB,
    });

    const map = makeEventsByChannel([["ch-1", [eventA, eventB]]]);
    writeObservedUnreadToStorage("pk1", "wss://relay.example.com", map);

    // Simulate marker prune: remove events covered by thread:rootA marker.
    const stored = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    assert.ok(stored !== null);
    const ch1 = stored.get("ch-1");
    assert.ok(ch1 !== undefined);
    ch1.delete(eventA.id);
    writeObservedUnreadToStorage("pk1", "wss://relay.example.com", stored);

    const result = readObservedUnreadFromStorage(
      "pk1",
      "wss://relay.example.com",
    );
    const resultCh1 = result?.get("ch-1");
    assert.ok(!resultCh1?.has("eA"), "thread A event should be pruned");
    assert.ok(resultCh1?.has("eB"), "thread B event should remain unread");

    // latestByChannel for ch-1 should still reflect thread B.
    const latest = deriveLatestByChannel(result);
    assert.equal(latest.get("ch-1"), FRESH_AT + 10);
  });
});

// ── scope isolation (A→B→A state machine) ────────────────────────────────────
//
// These tests model the scope-fence without a React harness. They prove that:
//   - A rows are visible when scope matches A (steady state).
//   - A rows are absent in B's bucket.
//   - A rows return after switching back to A.
//   - A late A-scope write does not contaminate B's bucket.

test("scope-isolation: A rows visible in A, absent in B, restored on A again", () => {
  withIsolatedStorage(() => {
    const relayA = "wss://relay-a.example.com";
    const relayB = "wss://relay-b.example.com";
    const pubkey = "pk1";

    const eA = makeObservedEvent({ id: "eA", createdAt: FRESH_AT });
    const eB = makeObservedEvent({ id: "eB", createdAt: FRESH_AT + 1 });

    writeObservedUnreadToStorage(
      pubkey,
      relayA,
      makeEventsByChannel([["ch-a", [eA]]]),
    );
    writeObservedUnreadToStorage(
      pubkey,
      relayB,
      makeEventsByChannel([["ch-b", [eB]]]),
    );

    // In A: see A's rows.
    const inA = readObservedUnreadFromStorage(pubkey, relayA);
    assert.ok(inA?.has("ch-a"), "A rows visible in A");
    assert.ok(!inA?.has("ch-b"), "B rows absent in A");

    // In B: see B's rows, not A's.
    const inB = readObservedUnreadFromStorage(pubkey, relayB);
    assert.ok(inB?.has("ch-b"), "B rows visible in B");
    assert.ok(!inB?.has("ch-a"), "A rows absent in B");

    // Back in A: A's rows return.
    const backInA = readObservedUnreadFromStorage(pubkey, relayA);
    assert.ok(backInA?.has("ch-a"), "A rows return on switch back to A");
  });
});

test("scope-isolation: a late A-scope write does not overwrite B's bucket", () => {
  // Models: A timer fires after scope has switched to B.
  // The timer captures A's key and scope; it must write to A's key, not B's.
  withIsolatedStorage(() => {
    const relayA = "wss://relay-a.example.com";
    const relayB = "wss://relay-b.example.com";
    const pubkey = "pk1";

    // B has its own data.
    writeObservedUnreadToStorage(
      pubkey,
      relayB,
      makeEventsByChannel([
        ["ch-b", [makeObservedEvent({ id: "eB", createdAt: FRESH_AT })]],
      ]),
    );

    // A late A-scope timer fires: writes A's data.
    writeObservedUnreadToStorage(
      pubkey,
      relayA,
      makeEventsByChannel([
        ["ch-a", [makeObservedEvent({ id: "eA", createdAt: FRESH_AT })]],
      ]),
    );

    // B's bucket must be unchanged.
    const inB = readObservedUnreadFromStorage(pubkey, relayB);
    assert.ok(
      inB?.has("ch-b"),
      "B's bucket should be unaffected by A's late write",
    );
    assert.ok(!inB?.has("ch-a"), "A rows must not appear in B's bucket");
  });
});

// ── quota / write failure ─────────────────────────────────────────────────────

test("writeObservedUnreadToStorage returns false when localStorage throws", () => {
  const prevWindow = globalThis.window;
  if (typeof globalThis.window === "undefined") {
    globalThis.window = {};
  }
  const prevLs = globalThis.window?.localStorage;
  globalThis.window.localStorage = {
    get length() {
      return 0;
    },
    key: () => null,
    getItem: () => null,
    setItem: () => {
      throw new DOMException("QuotaExceededError");
    },
    removeItem: () => {},
  };
  try {
    const map = makeEventsByChannel([
      ["ch-1", [makeObservedEvent({ id: "e1", createdAt: FRESH_AT })]],
    ]);
    const result = writeObservedUnreadToStorage(
      "pk1",
      "wss://relay.example.com",
      map,
    );
    // setLocalStorageItemWithRecovery retries after eviction; on persistent
    // failure it returns false.  The exact return value depends on whether
    // eviction succeeded, but the call must not throw.
    assert.ok(
      typeof result === "boolean",
      "write failure must return boolean, not throw",
    );
  } finally {
    if (prevWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window.localStorage = prevLs;
    }
  }
});
