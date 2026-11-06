import { expect, test } from "bun:test";
import { controlActionSchema, playerStateSchema } from "../packages/shared/src/index.ts";

test("shared schemas are wired for the workspace", () => {
  const state = playerStateSchema.parse({
    guildId: "1",
    connected: false,
    voiceChannelId: null,
    textChannelId: null,
    playing: false,
    paused: false,
    positionSec: 0,
    volume: 100,
    loop: "off",
    current: null,
    queue: [],
    updatedAt: new Date().toISOString(),
  });

  expect(state.queue).toHaveLength(0);
  expect(controlActionSchema.parse({ type: "pause" })).toEqual({ type: "pause" });
});
