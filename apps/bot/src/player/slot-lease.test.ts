import { describe, expect, test } from "bun:test";
import { SlotLease, StreamSemaphore } from "./guild-player.js";

describe("SlotLease", () => {
  test("acquires and releases the shared semaphore", () => {
    const semaphore = new StreamSemaphore(1);
    const lease = new SlotLease(semaphore);

    const generation = lease.acquire();
    expect(generation).not.toBeNull();
    expect(semaphore.inUse).toBe(1);

    lease.release(generation);
    expect(semaphore.inUse).toBe(0);
  });

  test("a second acquire while holding returns the same generation", () => {
    const semaphore = new StreamSemaphore(1);
    const lease = new SlotLease(semaphore);

    const first = lease.acquire();
    expect(lease.acquire()).toBe(first);
    expect(semaphore.inUse).toBe(1);
  });

  test("returns null when the semaphore is exhausted", () => {
    const semaphore = new StreamSemaphore(1);
    const squatter = new SlotLease(semaphore);
    const lease = new SlotLease(semaphore);

    expect(squatter.acquire()).not.toBeNull();
    expect(lease.acquire()).toBeNull();
    expect(lease.holdsSlot).toBe(false);
  });

  test("a stale release cannot free a newer stream's slot", () => {
    const semaphore = new StreamSemaphore(1);
    const lease = new SlotLease(semaphore);

    const first = lease.acquire();
    lease.release(first);
    expect(semaphore.inUse).toBe(0);

    const second = lease.acquire();
    expect(second).not.toBeNull();
    expect(semaphore.inUse).toBe(1);

    // The old stream finishing late must not decrement the global counter.
    lease.release(first);
    expect(semaphore.inUse).toBe(1);

    lease.release(second);
    expect(semaphore.inUse).toBe(0);
  });

  test("releasing without a token releases the current lease once", () => {
    const semaphore = new StreamSemaphore(2);
    const lease = new SlotLease(semaphore);

    lease.acquire();
    lease.release();
    lease.release();
    expect(semaphore.inUse).toBe(0);
  });
});
