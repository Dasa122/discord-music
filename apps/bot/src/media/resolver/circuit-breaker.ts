export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  threshold: number;
  /** How long the circuit stays open before one probe is allowed. */
  cooldownMs: number;
  /** Injectable clock so the cooldown is testable without sleeping. */
  now?: () => number;
}

export interface FailureOutcome {
  /** True when this failure opened (or re-opened) the circuit. */
  tripped: boolean;
  /** Consecutive failures including this one while the circuit was closed. */
  failures: number;
}

/**
 * Consecutive-failure breaker for the optional resolver.
 *
 * closed     → every call may attempt the primary.
 * open       → every call is delegated until the cooldown expires.
 * half-open  → exactly one probe is let through; success closes the circuit,
 *              failure re-opens it for a fresh cooldown.
 *
 * Pure state machine: no clock, no logging, no I/O.
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private currentState: CircuitBreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(options: CircuitBreakerOptions) {
    this.threshold = Math.max(1, Math.trunc(options.threshold));
    this.cooldownMs = Math.max(0, options.cooldownMs);
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitBreakerState {
    return this.currentState;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Whether the primary resolver may be attempted right now. */
  canAttempt(): boolean {
    if (this.currentState === "closed") return true;

    if (this.currentState === "open") {
      if (this.now() - this.openedAt < this.cooldownMs) return false;
      this.currentState = "half-open";
      this.probeInFlight = true;
      return true;
    }

    // half-open: a probe is already running, so nobody else may try.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.currentState = "closed";
    this.failures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  recordFailure(): FailureOutcome {
    // A failed half-open probe counts as a fresh consecutive failure.
    this.failures += 1;
    const wasHalfOpen = this.currentState === "half-open";

    if (!wasHalfOpen && this.failures < this.threshold) {
      return { tripped: false, failures: this.failures };
    }

    this.currentState = "open";
    this.openedAt = this.now();
    this.probeInFlight = false;
    return { tripped: true, failures: this.failures };
  }
}
