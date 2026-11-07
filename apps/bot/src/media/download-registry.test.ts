import { describe, expect, test } from "bun:test";
import { DownloadRegistry, PROGRESS_THROTTLE_MS } from "./download-registry.js";

function makeRegistry(overrides: { maxBytes?: number } = {}) {
  let clock = 0;
  const registry = new DownloadRegistry({
    maxBytes: overrides.maxBytes ?? 1_000,
    store: "local",
    now: () => clock,
  });
  return {
    registry,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

describe("DownloadRegistry state transitions", () => {
  test("queued → downloading → ready with bytes and percent", () => {
    const { registry, advance } = makeRegistry();
    registry.begin("session-1", "vid", "A track");

    let entry = registry.snapshot().entries[0];
    expect(entry?.state).toBe("queued");
    expect(entry?.bytes).toBe(0);
    expect(entry?.percent).toBeNull();
    expect(entry?.startedAt).not.toBeNull();
    expect(entry?.finishedAt).toBeNull();

    advance(10);
    registry.progress("vid", { bytes: 100, totalBytes: 400 });
    entry = registry.snapshot().entries[0];
    expect(entry?.state).toBe("downloading");
    expect(entry?.bytes).toBe(100);
    expect(entry?.totalBytes).toBe(400);
    expect(entry?.percent).toBe(25);

    advance(10);
    registry.ready("vid", { bytes: 400, gainDb: 2.5 });
    entry = registry.snapshot().entries[0];
    expect(entry?.state).toBe("ready");
    expect(entry?.bytes).toBe(400);
    expect(entry?.percent).toBe(100);
    expect(entry?.gainDb).toBe(2.5);
    expect(entry?.finishedAt).not.toBeNull();
    expect(entry?.error).toBeNull();
  });

  test("a failure records a short code and keeps the entry", () => {
    const { registry, advance } = makeRegistry();
    registry.begin("session-1", "vid", "A track");
    advance(10);
    registry.progress("vid", { bytes: 50, totalBytes: null });
    advance(10);
    registry.fail("vid", "DOWNLOAD_ABORTED");

    const entry = registry.snapshot().entries[0];
    expect(entry?.state).toBe("failed");
    expect(entry?.error).toBe("DOWNLOAD_ABORTED");
    expect(entry?.finishedAt).not.toBeNull();
  });

  test("progress with an unknown total leaves percent null", () => {
    const { registry, advance } = makeRegistry();
    registry.begin("session-1", "vid", "A track");
    advance(10);
    registry.progress("vid", { bytes: 123, totalBytes: null });

    const entry = registry.snapshot().entries[0];
    expect(entry?.totalBytes).toBeNull();
    expect(entry?.percent).toBeNull();
  });

  test("progress for an unknown or finished track is ignored", () => {
    const { registry, advance } = makeRegistry();
    registry.progress("missing", { bytes: 1, totalBytes: 2 });

    registry.begin("session-1", "vid", "A track");
    advance(10);
    registry.ready("vid", { bytes: 10, gainDb: null });
    registry.progress("vid", { bytes: 5, totalBytes: 10 });

    expect(registry.snapshot().entries).toHaveLength(1);
    expect(registry.snapshot().entries[0]?.bytes).toBe(10);
  });
});

describe("DownloadRegistry throttling", () => {
  test("collapses progress writes within the throttle window", () => {
    expect(PROGRESS_THROTTLE_MS).toBe(500);
    const { registry, advance } = makeRegistry();
    registry.begin("session-1", "vid", "A track");

    // The first event is a state transition (queued → downloading) and lands.
    registry.progress("vid", { bytes: 100, totalBytes: 1_000 });
    expect(registry.snapshot().entries[0]?.bytes).toBe(100);

    // Two more within 500 ms are dropped.
    advance(400);
    registry.progress("vid", { bytes: 200, totalBytes: 1_000 });
    advance(50);
    registry.progress("vid", { bytes: 300, totalBytes: 1_000 });
    expect(registry.snapshot().entries[0]?.bytes).toBe(100);

    // The window has elapsed, so the next write lands.
    advance(100);
    registry.progress("vid", { bytes: 400, totalBytes: 1_000 });
    expect(registry.snapshot().entries[0]?.bytes).toBe(400);
  });

  test("state transitions always write, regardless of the throttle", () => {
    const { registry, advance } = makeRegistry();
    registry.begin("session-1", "vid", "A track");
    registry.progress("vid", { bytes: 100, totalBytes: 1_000 });
    advance(10);
    registry.ready("vid", { bytes: 1_000, gainDb: null });

    const entry = registry.snapshot().entries[0];
    expect(entry?.state).toBe("ready");
    expect(entry?.bytes).toBe(1_000);
  });
});

describe("DownloadRegistry snapshot", () => {
  test("dedupes by trackId", () => {
    const { registry, advance } = makeRegistry();
    registry.begin("session-1", "vid", "First title");
    advance(10);
    registry.begin("session-1", "vid", "Second title");

    const entries = registry.snapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("Second title");
  });

  test("is sorted newest-first", () => {
    const { registry, advance } = makeRegistry();
    registry.begin("session-1", "old", "Old");
    advance(10);
    registry.begin("session-1", "new", "New");

    expect(registry.snapshot().entries.map((entry) => entry.trackId)).toEqual(["new", "old"]);
  });

  test("sums bytes only for ready entries and matches the contract shape", () => {
    const { registry, advance } = makeRegistry({ maxBytes: 5_000 });
    registry.begin("session-1", "a", "A");
    advance(10);
    registry.ready("a", { bytes: 1_200, gainDb: null });

    registry.begin("session-1", "b", "B");
    advance(10);
    registry.ready("b", { bytes: 300, gainDb: -2 });

    registry.begin("session-1", "c", "C");
    advance(10);
    registry.progress("c", { bytes: 500, totalBytes: 1_000 });

    const snapshot = registry.snapshot();
    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.totalBytes).toBe(1_500);
    expect(snapshot.maxBytes).toBe(5_000);
    expect(snapshot.store).toBe("local");
    expect(Object.keys(snapshot.entries[0] ?? {}).sort()).toEqual([
      "bytes",
      "error",
      "finishedAt",
      "gainDb",
      "percent",
      "startedAt",
      "state",
      "title",
      "totalBytes",
      "trackId",
    ]);
  });

  test("sessionId is null and entries are empty before any session", () => {
    const { registry } = makeRegistry();
    expect(registry.snapshot()).toEqual({
      sessionId: null,
      entries: [],
      totalBytes: 0,
      maxBytes: 1_000,
      store: "local",
    });
  });

  test("setGain updates the entry in place without changing its state", () => {
    const { registry, advance } = makeRegistry();
    registry.begin("session-1", "vid", "A");
    advance(10);
    registry.ready("vid", { bytes: 100, gainDb: null });
    expect(registry.snapshot().entries[0]?.gainDb).toBeNull();

    registry.setGain("vid", 4.5);
    const entry = registry.snapshot().entries[0];
    expect(entry?.state).toBe("ready");
    expect(entry?.gainDb).toBe(4.5);
  });

  test("clear drops every entry and the session", () => {
    const { registry, advance } = makeRegistry();
    registry.begin("session-1", "vid", "A");
    advance(10);
    registry.ready("vid", { bytes: 10, gainDb: null });
    registry.clear();

    expect(registry.snapshot()).toEqual({
      sessionId: null,
      entries: [],
      totalBytes: 0,
      maxBytes: 1_000,
      store: "local",
    });
  });
});
