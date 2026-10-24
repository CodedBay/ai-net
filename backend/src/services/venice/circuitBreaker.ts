import { VeniceCircuitBreaker, type VeniceCircuitState } from '../veniceCircuitBreaker.js';

export type CircuitState = VeniceCircuitState;

/** @deprecated Use VeniceCircuitBreaker. Kept for existing client integrations. */
export class CircuitBreaker extends VeniceCircuitBreaker {
  constructor(nowFn?: () => number) {
    super({
      now: nowFn,
      // Legacy contract of the original CircuitBreaker: open after 3
      // consecutive failures, stay open for 60 s, and close on the first
      // successful HALF_OPEN probe.  Failure counting is cumulative (no
      // sliding window) until a success resets it.
      failureThreshold: 3,
      openDurationMs: 60_000,
      halfOpenSuccessThreshold: 1,
      failureWindowMs: Number.MAX_SAFE_INTEGER,
    });
  }
}
