/**
 * Venice AI MSW (Mock Service Worker) fixtures for integration tests.
 *
 * These fixtures intercept HTTP calls to the Venice AI API and return
 * deterministic responses, keeping integration tests fast and offline.
 */

/** Standard Venice AI chat completion fixture — used for happy-path tests. */
export const veniceSuccessResponse = {
  id: "chatcmpl-test-fixture-001",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "venice-xl",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: JSON.stringify({
          summary: "Mock agent output for integration testing.",
          keyFindings: ["Finding 1", "Finding 2", "Finding 3"],
          sources: [{ url: "https://example.com/1", title: "Source 1" }],
          confidence: 0.85,
        }),
      },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 150,
    completion_tokens: 80,
    total_tokens: 230,
  },
};

/** Venice AI 500 error response — used for circuit breaker tests. */
export const veniceErrorResponse = {
  error: {
    message: "Internal server error — mock failure for testing",
    type: "server_error",
    code: "internal_server_error",
  },
};

/** Venice AI 429 rate limit response — used for upstream throttle tests. */
export const veniceRateLimitResponse = {
  error: {
    message: "Rate limit exceeded — mock throttle for testing",
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  },
};
