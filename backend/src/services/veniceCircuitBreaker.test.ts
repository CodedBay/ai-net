import { CircuitOpenError } from './venice/errors';
import { VeniceClient } from './venice/client';
import { VeniceCircuitBreaker } from './veniceCircuitBreaker';

describe('VeniceCircuitBreaker', () => {
  it('opens after five failures within the window and fast-fails requests', () => {
    const breaker = new VeniceCircuitBreaker({ now: () => 10_000 });
    for (let failure = 0; failure < 5; failure += 1) breaker.recordFailure();

    expect(breaker.getState()).toBe('OPEN');
    expect(() => breaker.assertClosed()).toThrow(CircuitOpenError);
  });

  it('expires failures outside the 60-second window', () => {
    let now = 0;
    const breaker = new VeniceCircuitBreaker({ now: () => now });
    for (let failure = 0; failure < 4; failure += 1) breaker.recordFailure();
    now = 60_001;

    expect(breaker.getFailureCount()).toBe(0);
    for (let failure = 0; failure < 5; failure += 1) breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
  });

  it('recovers after two consecutive half-open successes', () => {
    let now = 0;
    const breaker = new VeniceCircuitBreaker({ now: () => now });
    for (let failure = 0; failure < 5; failure += 1) breaker.recordFailure();
    now = 30_000;

    expect(breaker.getState()).toBe('HALF_OPEN');
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('HALF_OPEN');
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('reopens on a half-open failure', () => {
    let now = 0;
    const breaker = new VeniceCircuitBreaker({ now: () => now });
    for (let failure = 0; failure < 5; failure += 1) breaker.recordFailure();
    now = 30_000;
    breaker.getState();
    breaker.recordFailure();

    expect(breaker.getState()).toBe('OPEN');
  });
});

describe('Venice client circuit integration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens after repeated upstream 500 responses and skips the next fetch', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);
    const client = new VeniceClient({
      apiKey: 'test-key',
      maxRetries: 0,
      enableCacheFallback: false,
    });

    for (let call = 0; call < 5; call += 1) {
      await expect(client.complete('test prompt', 'research', { force: true })).rejects.toThrow();
    }
    expect(client.getCircuitState()).toBe('OPEN');
    await expect(client.complete('test prompt', 'research', { force: true })).rejects.toThrow(CircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});