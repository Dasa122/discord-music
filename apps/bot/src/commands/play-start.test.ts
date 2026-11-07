import { describe, expect, test } from "bun:test";
import { PlayerError } from "../errors.js";
import { startPlayInParallel } from "./play-start.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startPlayInParallel", () => {
  test("join and resolve start before either finishes", async () => {
    const events: string[] = [];
    const result = await startPlayInParallel({
      join: async () => {
        events.push("join-start");
        await delay(300);
        events.push("join-done");
      },
      resolve: async () => {
        events.push("resolve-start");
        await delay(0);
        events.push("resolve-done");
        return "resolved-track";
      },
    });

    // Both calls were entered before the 300 ms join finished; the resolve did
    // not wait for the join.
    expect(events).toEqual(["join-start", "resolve-start", "resolve-done", "join-done"]);
    expect(result.resolved).toBe("resolved-track");
    expect(result.joinMs).toBeGreaterThanOrEqual(250);
    expect(result.resolveMs).toBeLessThan(result.joinMs);
  });

  test("a join rejection surfaces the connection error and cleans up the session", async () => {
    let cleaned = 0;
    const run = startPlayInParallel<string>({
      join: async () => {
        await delay(10);
        throw new PlayerError("VOICE_CONNECT_FAILED", "Could not connect to the voice channel.");
      },
      resolve: async () => {
        await delay(50);
        return "still-resolving";
      },
      onJoinFailure: () => {
        cleaned += 1;
      },
    });

    await expect(run).rejects.toMatchObject({ code: "VOICE_CONNECT_FAILED" });
    expect(cleaned).toBe(1);
  });
});
