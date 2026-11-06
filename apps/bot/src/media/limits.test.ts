import { describe, expect, test } from "bun:test";
import { commandRateKey, QueuedSemaphore, SlidingWindowRateLimiter } from "./limits.js";

describe("QueuedSemaphore", () => {
  test("caps concurrency and queues the rest", async () => {
    const semaphore = new QueuedSemaphore(2, 1_000);

    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    expect(semaphore.inUse).toBe(2);
    expect(semaphore.tryAcquire()).toBeNull();

    let thirdGranted = false;
    const third = semaphore.acquire().then((release) => {
      thirdGranted = true;
      return release;
    });

    await Bun.sleep(5);
    expect(thirdGranted).toBe(false);
    expect(semaphore.waiting).toBe(1);

    first();
    const thirdRelease = await third;
    expect(thirdGranted).toBe(true);
    expect(semaphore.inUse).toBe(2);

    // Releasing twice must not free a second slot.
    first();
    expect(semaphore.inUse).toBe(2);

    second();
    thirdRelease();
    expect(semaphore.inUse).toBe(0);
  });

  test("rejects with the supplied error when the wait cap expires", async () => {
    const semaphore = new QueuedSemaphore(1, 20);
    const held = await semaphore.acquire();

    await expect(semaphore.acquire(() => new Error("EXTRACTION_BUSY"))).rejects.toThrow(
      "EXTRACTION_BUSY",
    );

    held();
    expect(semaphore.inUse).toBe(0);
    expect(semaphore.waiting).toBe(0);
  });

  test("rejects invalid limits", () => {
    expect(() => new QueuedSemaphore(0, 100)).toThrow();
    expect(() => new QueuedSemaphore(1, 0)).toThrow();
  });
});

describe("SlidingWindowRateLimiter", () => {
  test("allows the limit then reports the wait time", () => {
    const limiter = new SlidingWindowRateLimiter(3, 30_000);
    const start = 1_000_000;

    expect(limiter.take("g:u", start)).toBe(0);
    expect(limiter.take("g:u", start + 1_000)).toBe(0);
    expect(limiter.take("g:u", start + 2_000)).toBe(0);

    // The oldest hit (start) leaves the window at start + 30s.
    expect(limiter.take("g:u", start + 10_000)).toBe(20_000);
    expect(limiter.take("g:u", start + 31_000)).toBe(0);
  });

  test("keys are independent", () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000);
    expect(limiter.take("g1:u1", 0)).toBe(0);
    expect(limiter.take("g1:u2", 0)).toBe(0);
    expect(limiter.take("g2:u1", 0)).toBe(0);
    expect(limiter.take("g1:u1", 10)).toBeGreaterThan(0);
  });

  test("prune drops expired keys", () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000);
    limiter.take("a", 0);
    limiter.take("b", 0);
    expect(limiter.size).toBe(2);
    limiter.prune(10_000);
    expect(limiter.size).toBe(0);
  });

  test("builds a stable guild+user key", () => {
    expect(commandRateKey("g1", "u1")).toBe("g1:u1");
  });
});
