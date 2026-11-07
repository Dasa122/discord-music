import { describe, expect, test } from "bun:test";
import { FirstAudioTimer } from "./first-audio.js";

describe("FirstAudioTimer", () => {
  test("fires once per track with the elapsed time and source", () => {
    let now = 1_000;
    const timer = new FirstAudioTimer(() => now);

    timer.start("track-a");
    timer.setSource("track-a", "cache");
    now += 420;

    expect(timer.markPlaying(true)).toEqual({ ms: 420, source: "cache", trackId: "track-a" });
    // A later Playing transition (e.g. after resume) must not log again.
    now += 1_000;
    expect(timer.markPlaying(true)).toBeNull();
    expect(timer.active).toBe(false);
  });

  test("ignores a Playing transition for another resource", () => {
    const timer = new FirstAudioTimer(() => 0);
    timer.start("track-a");

    expect(timer.markPlaying(false)).toBeNull();
    expect(timer.active).toBe(true);
    expect(timer.markPlaying(true)?.trackId).toBe("track-a");
  });

  test("clear resets the timer so a skipped track never logs", () => {
    let now = 0;
    const timer = new FirstAudioTimer(() => now);
    timer.start("track-a");
    now += 250;

    // skip/stop/endSession clears before the next track starts.
    timer.clear();
    expect(timer.active).toBe(false);
    expect(timer.markPlaying(true)).toBeNull();

    timer.start("track-b");
    now += 100;
    expect(timer.markPlaying(true)).toEqual({ ms: 100, source: "stream", trackId: "track-b" });
  });

  test("starting the next track replaces the previous marker", () => {
    let now = 0;
    const timer = new FirstAudioTimer(() => now);
    timer.start("track-a");
    timer.setSource("track-a", "stream");
    now += 50;
    timer.start("track-b");
    timer.setSource("track-b", "cache");
    now += 75;

    expect(timer.markPlaying(true)).toEqual({ ms: 75, source: "cache", trackId: "track-b" });
  });
});
