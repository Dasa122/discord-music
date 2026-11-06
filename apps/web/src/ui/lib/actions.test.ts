import { describe, expect, test } from "bun:test";
import {
  clearAction,
  disconnectAction,
  loopAction,
  moveAction,
  nextLoopMode,
  pauseAction,
  playAction,
  playPlaylistAction,
  removeAction,
  seekAction,
  shuffleAction,
  skipAction,
  stopAction,
  volumeAction,
} from "./actions";

describe("action body builders", () => {
  test("builds volume bodies clamped to 0–200", () => {
    expect(volumeAction(150)).toEqual({ type: "volume", volume: 150 });
    expect(volumeAction(400)).toEqual({ type: "volume", volume: 200 });
    expect(volumeAction(-5)).toEqual({ type: "volume", volume: 0 });
    expect(volumeAction(42.6)).toEqual({ type: "volume", volume: 43 });
  });

  test("builds seek bodies rounded and clamped to zero", () => {
    expect(seekAction(61.7)).toEqual({ type: "seek", positionSec: 62 });
    expect(seekAction(-10)).toEqual({ type: "seek", positionSec: 0 });
  });

  test("builds loop bodies and cycles off → track → queue → off", () => {
    expect(loopAction("track")).toEqual({ type: "loop", mode: "track" });
    expect(nextLoopMode("off")).toBe("track");
    expect(nextLoopMode("track")).toBe("queue");
    expect(nextLoopMode("queue")).toBe("off");
  });

  test("builds move bodies", () => {
    expect(moveAction(3, 1)).toEqual({ type: "move", from: 3, to: 1 });
  });

  test("builds the remaining control bodies", () => {
    expect(playAction("https://example.com/song")).toEqual({
      type: "play",
      query: "https://example.com/song",
    });
    expect(pauseAction()).toEqual({ type: "pause" });
    expect(skipAction()).toEqual({ type: "skip" });
    expect(skipAction(2)).toEqual({ type: "skip", count: 2 });
    expect(stopAction()).toEqual({ type: "stop" });
    expect(shuffleAction()).toEqual({ type: "shuffle" });
    expect(removeAction(4)).toEqual({ type: "remove", index: 4 });
    expect(clearAction()).toEqual({ type: "clear" });
    expect(disconnectAction()).toEqual({ type: "disconnect" });
    expect(playPlaylistAction("playlist-1")).toEqual({
      type: "playPlaylist",
      playlistId: "playlist-1",
    });
  });
});
