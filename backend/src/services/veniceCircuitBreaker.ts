import { metricsService } from './metrics';
import { CircuitOpenError } from './venice/errors';

export type VeniceCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface VeniceCircuitBreakerOptions {
  failureThreshold?: number;
  failureWindowMs?: number;
  openDurationMs?: number;
  halfOpenSuccessThreshold?: number;
  now?: () => number;
}

export class VeniceCircuitBreaker {
  private state: VeniceCircuitState = 'CLOSED';
  private readonly failures: number[] = [];
  private openedAt = 0;
  private halfOpenSuccesses = 0;
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly openDurationMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly now: () => number;

  constructor(options: VeniceCircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.failureWindowMs = options.failureWindowMs ?? 60_000;
    this.openDurationMs = options.openDurationMs ?? 30_000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
    this.now = options.now ?? Date.now;
    this.publishState();
  }

  getState(): VeniceCircuitState {
    this.evaluateState();
    return this.state;
  }

  getFailureCount(): number {
    this.pruneFailures();
    return this.failures.length;
  }

  assertClosed(): void {
    this.evaluateState();
    if (this.state === 'OPEN') throw new CircuitOpenError();
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses < this.halfOpenSuccessThreshold) return;
    }
    this.failures.length = 0;
    this.halfOpenSuccesses = 0;
    this.setState('CLOSED');
  }

  recordFailure(): void {
    this.evaluateState();
    if (this.state === 'HALF_OPEN') {
      this.open();
      return;
    }
    if (this.state === 'OPEN') return;

    this.pruneFailures();
    this.failures.push(this.now());
    if (this.failures.length >= this.failureThreshold) this.open();
  }

  private evaluateState(): void {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.openDurationMs) {
      this.halfOpenSuccesses = 0;
      this.setState('HALF_OPEN');
    }
  }

  private pruneFailures(): void {
    const cutoff = this.now() - this.failureWindowMs;
    while (this.failures.length > 0 && this.failures[0]! < cutoff) this.failures.shift();
  }

  private open(): void {
    this.openedAt = this.now();
    this.halfOpenSuccesses = 0;
    this.setState('OPEN');
  }

  private setState(state: VeniceCircuitState): void {
    if (this.state === state) return;
    this.state = state;
    this.publishState();
  }

  private publishState(): void {
    metricsService.setVeniceCircuitBreakerState(this.state.toLowerCase().replace('_', '-') as 'closed' | 'open' | 'half-open');
  }
}