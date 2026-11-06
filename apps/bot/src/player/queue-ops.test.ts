import { describe, expect, test } from "bun:test";
import type { QueueTrack } from "@music/shared";
import { QueueController } from "./queue-ops.js";

function track(id: string): QueueTrack {
  return {
    id,
    title: `Track ${id}`,
    url: `https://example.com/${id}`,
    durationSec: 30,
    thumbnailUrl: null,
    source: "unknown",
    requestedBy: { id: "1", name: "Ada" },
  };
}

function seededRng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

describe("QueueController enqueue and skip", () => {
  test("enqueue respects the per-guild maximum", () => {
    const queue = new QueueController();
    const added = queue.enqueue([track("a"), track("b"), track("c")], 2);
    expect(added).toBe(2);
    expect(queue.queue.map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("skip removes the current track plus count - 1 queued tracks", () => {
    const queue = new QueueController();
    queue.current = track("a");
    queue.enqueue([track("b"), track("c"), track("d")]);

    const removed = queue.skip(2);
    expect(removed.map((item) => item.id)).toEqual(["a", "b"]);
    expect(queue.current?.id).toBe("c");
    expect(queue.queue.map((item) => item.id)).toEqual(["d"]);
  });

  test("skip past the end leaves the player empty", () => {
    const queue = new QueueController();
    queue.current = track("a");
    queue.enqueue([track("b")]);

    const removed = queue.skip(5);
    expect(removed.map((item) => item.id)).toEqual(["a", "b"]);
    expect(queue.current).toBeNull();
    expect(queue.queue).toHaveLength(0);
  });
});

describe("loop modes", () => {
  test("loop off advances to the next track", () => {
    const queue = new QueueController();
    queue.current = track("a");
    queue.enqueue([track("b")]);

    const action = queue.onTrackEnd();
    expect(action).toEqual({ type: "play", track: expect.objectContaining({ id: "b" }) });
    expect(queue.current?.id).toBe("b");
    expect(queue.queue).toHaveLength(0);
  });

  test("loop track replays the same track", () => {
    const queue = new QueueController();
    queue.current = track("a");
    queue.enqueue([track("b")]);
    queue.setLoop("track");

    expect(queue.onTrackEnd()).toEqual({ type: "replay" });
    expect(queue.current?.id).toBe("a");
    expect(queue.queue.map((item) => item.id)).toEqual(["b"]);
  });

  test("loop queue rotates the current track to the back", () => {
    const queue = new QueueController();
    queue.current = track("a");
    queue.enqueue([track("b")]);
    queue.setLoop("queue");

    expect(queue.onTrackEnd()).toEqual({
      type: "play",
      track: expect.objectContaining({ id: "b" }),
    });
    expect(queue.current?.id).toBe("b");
    expect(queue.queue.map((item) => item.id)).toEqual(["a"]);

    expect(queue.onTrackEnd()).toEqual({
      type: "play",
      track: expect.objectContaining({ id: "a" }),
    });
    expect(queue.current?.id).toBe("a");
    expect(queue.queue.map((item) => item.id)).toEqual(["b"]);
  });

  test("ending an empty queue reports empty", () => {
    const queue = new QueueController();
    expect(queue.onTrackEnd()).toEqual({ type: "empty" });
  });
});

describe("queue mutations", () => {
  test("shuffle is deterministic for a seeded RNG and preserves membership", () => {
    const first = new QueueController(seededRng(1234));
    const second = new QueueController(seededRng(1234));
    const tracks = ["a", "b", "c", "d", "e", "f"].map(track);
    first.enqueue(tracks);
    second.enqueue(tracks);

    first.shuffle();
    second.shuffle();

    const firstIds = first.queue.map((item) => item.id);
    const secondIds = second.queue.map((item) => item.id);
    expect(firstIds).toEqual(secondIds);
    expect([...firstIds].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("remove uses a zero-based index and rejects out-of-range values", () => {
    const queue = new QueueController();
    queue.enqueue([track("a"), track("b"), track("c")]);

    expect(queue.remove(1)?.id).toBe("b");
    expect(queue.queue.map((item) => item.id)).toEqual(["a", "c"]);
    expect(queue.remove(9)).toBeNull();
  });

  test("move reorders a track and rejects bad positions", () => {
    const queue = new QueueController();
    queue.enqueue([track("a"), track("b"), track("c")]);

    expect(queue.move(0, 2)).toBe(true);
    expect(queue.queue.map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(queue.move(0, 9)).toBe(false);
    expect(queue.move(1, 1)).toBe(false);
  });
});
