import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "./circuit-breaker.js";

function makeBreaker(options: { threshold?: number; cooldownMs?: number } = {}): {
  breaker: CircuitBreaker;
  advance: (ms: number) => void;
} {
  let now = 1_000;
  const breaker = new CircuitBreaker({
    threshold: options.threshold ?? 3,
    cooldownMs: options.cooldownMs ?? 10_000,
    now: () => now,
  });
  return { breaker, advance: (ms) => (now += ms) };
}

describe("circuit breaker tripping", () => {
  test("stays closed below the threshold", () => {
    const { breaker } = makeBreaker();

    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.recordFailure()).toEqual({ tripped: false, failures: 1 });
    expect(breaker.recordFailure()).toEqual({ tripped: false, failures: 2 });
    expect(breaker.state).toBe("closed");
    expect(breaker.canAttempt()).toBe(true);
  });

  test("trips at the threshold and blocks every attempt", () => {
    const { breaker } = makeBreaker({ threshold: 3 });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.recordFailure()).toEqual({ tripped: true, failures: 3 });

    expect(breaker.state).toBe("open");
    expect(breaker.consecutiveFailures).toBe(3);
    expect(breaker.canAttempt()).toBe(false);
  });

  test("a threshold of one trips on the first failure", () => {
    const { breaker } = makeBreaker({ threshold: 1 });
    expect(breaker.recordFailure()).toEqual({ tripped: true, failures: 1 });
    expect(breaker.canAttempt()).toBe(false);
  });
});

describe("circuit breaker cooldown", () => {
  test("stays open for the whole cooldown and then allows exactly one probe", () => {
    const { breaker, advance } = makeBreaker({ threshold: 2, cooldownMs: 600_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(false);

    advance(599_999);
    expect(breaker.canAttempt()).toBe(false);
    expect(breaker.state).toBe("open");

    advance(1);
    // Half-open: the first caller gets the probe…
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.state).toBe("half-open");
    // …and every concurrent caller keeps delegating.
    expect(breaker.canAttempt()).toBe(false);
  });

  test("a successful half-open probe closes the circuit and resets the count", () => {
    const { breaker, advance } = makeBreaker({ threshold: 3, cooldownMs: 1_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    advance(1_000);

    expect(breaker.canAttempt()).toBe(true);
    breaker.recordSuccess();

    expect(breaker.state).toBe("closed");
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.canAttempt()).toBe(true);
  });

  test("a failed half-open probe re-trips the circuit for a fresh cooldown", () => {
    const { breaker, advance } = makeBreaker({ threshold: 3, cooldownMs: 1_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    advance(1_000);

    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.recordFailure()).toEqual({ tripped: true, failures: 4 });
    expect(breaker.state).toBe("open");
    expect(breaker.canAttempt()).toBe(false);

    // The new cooldown starts at the re-trip, not at the original one.
    advance(999);
    expect(breaker.canAttempt()).toBe(false);
    advance(1);
    expect(breaker.canAttempt()).toBe(true);
  });

  test("a success between failures breaks the consecutive run", () => {
    const { breaker } = makeBreaker({ threshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();

    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.recordFailure()).toEqual({ tripped: false, failures: 1 });
  });
});
