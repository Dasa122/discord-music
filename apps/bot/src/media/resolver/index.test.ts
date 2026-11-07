import { describe, expect, test } from "bun:test";
import type { ResolvedTrack } from "../ytdlp.js";
import { createResolver, type ResolverConfig, type ResolverLog } from "./index.js";
import { type TrackResolver, UnsupportedQueryError } from "./types.js";

const config: ResolverConfig = {
  resolver: "ytdlp",
  innertubeClient: "IOS",
  failureThreshold: 3,
  cooldownMs: 600_000,
  ytdlp: { path: "yt-dlp", denoPath: "deno" },
};

function track(id: string): ResolvedTrack {
  return {
    videoId: id,
    title: id,
    webpageUrl: `https://www.youtube.com/watch?v=${id}`,
    durationSec: 30,
    thumbnailUrl: null,
    isPlaylist: false,
  };
}

interface Spies {
  log: ResolverLog & { entries: { level: string; message: string; fields?: unknown }[] };
}

function spyLog(): Spies["log"] {
  const entries: { level: string; message: string; fields?: unknown }[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    entries.push({ level, message, fields });
  };
  return { debug: push("debug"), info: push("info"), warn: push("warn"), entries };
}

function fakeResolver(name: string, calls: string[]): TrackResolver {
  return {
    async resolve(query) {
      calls.push(`${name}:resolve:${query}`);
      return track(`${name}-${query}`);
    },
    async resolveSearch(query, limit) {
      calls.push(`${name}:search:${query}:${limit}`);
      return [track(`${name}-${query}`)];
    },
  };
}

describe("resolver selection matrix", () => {
  test("RESOLVER=ytdlp uses yt-dlp and never builds the innertube client", async () => {
    const calls: string[] = [];
    const log = spyLog();
    let innertubeBuilt = 0;

    const resolver = createResolver(
      { ...config, resolver: "ytdlp" },
      {
        ytdlp: () => fakeResolver("ytdlp", calls),
        innertube: () => {
          innertubeBuilt += 1;
          return fakeResolver("innertube", calls);
        },
        log,
      },
    );

    const resolved = await resolver.resolve("a song");
    await resolver.resolveSearch("a song", 2);

    expect(resolved.title).toBe("ytdlp-a song");
    expect(innertubeBuilt).toBe(0);
    expect(calls).toEqual(["ytdlp:resolve:a song", "ytdlp:search:a song:2"]);
    expect(log.entries.map((entry) => entry.message)).toEqual(["resolver_selected"]);
  });

  test("RESOLVER=innertube uses the innertube resolver while healthy", async () => {
    const calls: string[] = [];
    const log = spyLog();

    const resolver = createResolver(
      { ...config, resolver: "innertube" },
      {
        ytdlp: () => fakeResolver("ytdlp", calls),
        innertube: () => fakeResolver("innertube", calls),
        log,
      },
    );

    const resolved = await resolver.resolve("a song");

    expect(resolved.title).toBe("innertube-a song");
    expect(calls).toEqual(["innertube:resolve:a song"]);
    expect(log.entries[0]?.fields).toMatchObject({ resolver: "innertube", client: "IOS" });
  });

  test("RESOLVER=innertube delegates to yt-dlp while the breaker is tripped", async () => {
    const calls: string[] = [];
    const log = spyLog();
    let now = 0;

    const innertube: TrackResolver = {
      async resolve(query) {
        calls.push(`innertube:resolve:${query}`);
        throw new Error("youtube said no");
      },
      async resolveSearch() {
        throw new Error("youtube said no");
      },
    };

    const resolver = createResolver(
      { ...config, resolver: "innertube", failureThreshold: 2 },
      {
        ytdlp: () => fakeResolver("ytdlp", calls),
        innertube: () => innertube,
        now: () => now,
        log,
      },
    );

    // Two failures trip the breaker; each one still returns from yt-dlp.
    await resolver.resolve("one");
    await resolver.resolve("two");
    expect(calls.filter((call) => call.startsWith("innertube"))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("ytdlp"))).toHaveLength(2);

    // Tripped: no innertube call at all.
    await resolver.resolve("three");
    expect(calls.filter((call) => call.startsWith("innertube"))).toHaveLength(2);
    expect(calls.at(-1)).toBe("ytdlp:resolve:three");

    // The cooldown expires and one probe is let through again.
    now += 600_000;
    await resolver.resolve("four");
    expect(calls.filter((call) => call.startsWith("innertube"))).toHaveLength(3);
  });

  test("a resolver failure never fails the call: yt-dlp's result is returned", async () => {
    const resolver = createResolver(
      { ...config, resolver: "innertube" },
      {
        ytdlp: () => ({ resolve: async () => track("fallback"), resolveSearch: async () => [] }),
        innertube: () => ({
          resolve: async () => {
            throw new Error("boom");
          },
          resolveSearch: async () => [],
        }),
        log: spyLog(),
      },
    );

    expect((await resolver.resolve("anything")).title).toBe("fallback");
  });
});

describe("resolver fallback logging", () => {
  test("resolver_tripped and resolver_fallback are emitted once per trip, not per call", async (): Promise<void> => {
    const log = spyLog();
    const resolver = createResolver(
      { ...config, resolver: "innertube", failureThreshold: 3 },
      {
        ytdlp: () => ({ resolve: async () => track("fallback"), resolveSearch: async () => [] }),
        innertube: () => ({
          resolve: async () => {
            throw new Error("nope");
          },
          resolveSearch: async () => [],
        }),
        log,
      },
    );

    for (let i = 0; i < 6; i += 1) await resolver.resolve(`q${i}`);

    const tripped = log.entries.filter((entry) => entry.message === "resolver_tripped");
    const fallback = log.entries.filter((entry) => entry.message === "resolver_fallback");
    expect(tripped).toHaveLength(1);
    expect(tripped[0]?.level).toBe("warn");
    expect(tripped[0]?.fields).toEqual({ failures: 3, cooldownMs: 600_000 });
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.level).toBe("warn");
    expect(fallback[0]?.fields).toEqual({ reason: "resolve:error" });
  });

  test("the reason names the open circuit for calls made while it is open", async () => {
    const log = spyLog();
    let primaryFails = true;
    const resolver = createResolver(
      { ...config, resolver: "innertube", failureThreshold: 1 },
      {
        ytdlp: () => ({ resolve: async () => track("fallback"), resolveSearch: async () => [] }),
        innertube: () => ({
          resolve: async () => {
            if (primaryFails) throw new Error("nope");
            return track("primary");
          },
          resolveSearch: async () => [],
        }),
        log,
      },
    );

    await resolver.resolve("first");
    primaryFails = false;
    await resolver.resolve("second");

    const fallback = log.entries.filter((entry) => entry.message === "resolver_fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.fields).toEqual({ reason: "resolve:tripped" });
  });

  test("an unsupported query falls back without counting a failure", async (): Promise<void> => {
    const log = spyLog();
    const resolver = createResolver(
      { ...config, resolver: "innertube", failureThreshold: 2 },
      {
        ytdlp: () => ({ resolve: async () => track("fallback"), resolveSearch: async () => [] }),
        innertube: () => ({
          resolve: async () => {
            throw new UnsupportedQueryError("a playlist is yt-dlp's job");
          },
          resolveSearch: async () => [],
        }),
        log,
      },
    );

    for (let i = 0; i < 5; i += 1) expect((await resolver.resolve(`q${i}`)).title).toBe("fallback");

    expect(log.entries.filter((entry) => entry.message === "resolver_tripped")).toHaveLength(0);
    expect(log.entries.filter((entry) => entry.message === "resolver_fallback")).toHaveLength(0);
    expect(log.entries.filter((entry) => entry.message === "resolver_unsupported")).toHaveLength(5);
  });
});
