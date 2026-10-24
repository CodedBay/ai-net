export class CircuitOpenError extends Error {
  readonly code = 'llm_unavailable';
  readonly statusCode = 503;
  readonly retryAfter = 30;

  constructor(message = 'Venice AI is temporarily unavailable. Please retry in 30 seconds.') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class TokenBudgetExceededError extends Error {
  constructor(requested: number, cap: number) {
    super(`Token budget exceeded: requested ${requested}, hard cap is ${cap}`);
    this.name = 'TokenBudgetExceededError';
  }
}
