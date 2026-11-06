import { describe, expect, test } from "bun:test";
import { describeAllowedChannels, isChannelAllowed } from "./channel-access.js";

describe("isChannelAllowed", () => {
  test("an empty allow-list is unrestricted", () => {
    expect(isChannelAllowed([], "any")).toBe(true);
  });

  test("only listed channels pass", () => {
    expect(isChannelAllowed(["a", "b"], "b")).toBe(true);
    expect(isChannelAllowed(["a", "b"], "c")).toBe(false);
  });
});

describe("describeAllowedChannels", () => {
  test("formats channel mentions", () => {
    expect(describeAllowedChannels(["1", "2"])).toBe("<#1>, <#2>");
  });
});
