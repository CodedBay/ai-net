# Venice AI Prompting Guide

This guide is for developers building research, risk, coding, design, and report agents on ai-net. It covers model selection, prompt structure, context and cost budgets, batch and streaming requests, and failure handling.

## API and Model Selection

Venice provides an OpenAI-compatible chat completions endpoint:

```text
POST https://api.venice.ai/api/v1/chat/completions
Authorization: Bearer $VENICE_API_KEY
```

Use the model catalog to confirm IDs, availability, context limits, capabilities, and current rates before deploying. The table below reflects the public catalog queried on **2026-10-22**. Prices are USD per 1 million input/output tokens; the catalog is authoritative and rates can change.

| Model ID | Suggested use | Input / 1M tokens | Output / 1M tokens | Context tokens |
|---|---|---:|---:|---:|
| `qwen-3-8-flash` | Research triage, design briefs, report drafts | $0.14 | $0.49 | 1,000,000 |
| `z-ai-glm-5-3-flash` | Lower-cost risk analysis and structured extraction | $0.15 | $0.50 | 1,048,576 |
| `qwen3-coder-480b-a35b-instruct-turbo` | Code generation and review | $0.35 | $1.50 | 256,000 |
| `llama-3.3-70b` | General-purpose analysis and synthesis | $0.70 | $2.80 | 128,000 |
| `z-ai-glm-5-3` | Complex, high-consequence risk analysis | $1.75 | $5.50 | 1,000,000 |

These are starting points, not quality guarantees. Evaluate candidates with representative tasks, a fixed rubric, and a token budget before selecting a production model. ai-net's backend currently maps agent kinds to `venice-xl` and `venice-code`; those IDs were not present in the public catalog when this guide was checked. Verify or update that mapping against the live catalog before relying on it. The examples below use catalog IDs.

## Prompt Patterns

Keep system instructions stable and put task-specific data in the user message. State the audience, scope, evidence rules, output shape, and what the model should do when information is missing. Treat output as untrusted input: validate structured responses before using them.

The following templates cover the five ai-net agent types:

```typescript
type AgentKind = 'research' | 'risk' | 'coding' | 'design' | 'report';

const systemPrompts: Record<AgentKind, string> = {
  research: `You are a research analyst. Separate sourced facts from inference.
Return a concise summary, key findings, and sources with title and URL.
Do not invent citations; state when evidence is unavailable.`,
  risk: `You are a risk analyst. Identify concrete risks, their evidence,
likelihood and impact, mitigations, and unresolved assumptions. Do not present
an estimate as a verified fact. Return a structured, concise analysis.`,
  coding: `You are a senior software engineer. Use only the supplied repository
context and requirements. Propose the smallest correct change, explain edge
cases, and include focused verification steps. Never claim a command or test
was run unless it actually was.`,
  design: `You are a product designer. Respect the supplied users, platform,
accessibility requirements, and design constraints. Return a clear hierarchy,
interaction states, responsive behavior, and rationale; flag conflicts rather
than silently ignoring requirements.`,
  report: `You are a report editor. Synthesize only the supplied findings,
preserve attribution and uncertainty, remove repetition, and distinguish
conclusions from open questions. Return an executive summary followed by
evidence-based findings and sources.`,
};
```

For example, ask the research agent for a market comparison with a bounded date range and explicit source requirements. Ask the risk agent to assess a named threat model, not to declare a system “safe.” Give the coding agent the relevant files and acceptance criteria rather than an entire repository dump. Give the design agent viewport, accessibility, and component constraints. Ask the report agent to synthesize validated upstream results and retain their source IDs.

## TypeScript: Batch Requests

This minimal helper uses the native `fetch` API and the documented chat-completions response shape. Keep `VENICE_API_KEY` in the process environment or a secret manager; never put it in source control or client-side code.

```typescript
type Message = { role: 'system' | 'user' | 'assistant'; content: string };
type ChatResponse = { choices?: Array<{ message?: { content?: string } }> };

async function complete(
  model: string,
  messages: Message[],
  maxTokens = 800,
): Promise<string> {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) throw new Error('VENICE_API_KEY is required');

  const response = await fetch('https://api.venice.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Venice returned HTTP ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Venice response has no message content');
  return content;
}

const result = await complete('qwen-3-8-flash', [
  { role: 'system', content: systemPrompts.research },
  { role: 'user', content: 'Compare the supplied market evidence for 2025. Cite only the supplied sources.' },
]);
console.log(result);
```

Use `max_tokens` to cap generated output. ai-net's backend defaults to 2,048 completion tokens and rejects requests above its 8,192-token hard cap; the task API also limits prompt characters. These are ai-net safeguards, not Venice-wide limits.

## Context and Token Budgets

- Reserve room for the system prompt, user request, retrieved context, and expected output within the selected model's context window.
- Tokenization varies by model. `Math.ceil(text.length / 4)` is only a rough early warning; use a tokenizer appropriate to the selected model for production budgets.
- For long inputs, split at semantic boundaries (documents, sections, or records), not arbitrary character offsets. Keep source IDs and metadata attached to every chunk.
- Summarize chunks into a fixed schema with source IDs, then synthesize those summaries. Retain access to the original passages for citation checks; summaries can omit important qualifiers.
- Limit retrieval to the most relevant, non-duplicated passages. Do not repeatedly resend the full conversation when a compact state summary will do.
- Set maximum input and output budgets per task type and stop or request clarification when the budget is insufficient.

### Estimating Cost

Use the provider's returned usage values where available. Before a request, estimate with:

```text
estimated USD = input tokens * input USD per 1M / 1,000,000
              + output tokens * output USD per 1M / 1,000,000
```

Example using `qwen-3-8-flash`: 12,000 input tokens and 1,500 output tokens at the listed rates estimate to `$0.002415` before any provider-specific adjustments. Retries and uncached calls add cost; caching can reduce repeated identical work, but do not assume a cache hit. Use measured usage and current rates for billing decisions.

## Streaming Responses

Streaming sends `stream: true` and returns server-sent event frames. The example below demonstrates the contract; production code should also handle cancellation, partial frames, and request timeouts.

```typescript
type StreamPayload = { choices?: Array<{ delta?: { content?: string } }> };

async function streamCompletion(
  model: string,
  messages: Message[],
  onToken: (token: string) => void,
): Promise<void> {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) throw new Error('VENICE_API_KEY is required');

  const response = await fetch('https://api.venice.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 800, stream: true }),
  });
  if (!response.ok) throw new Error(`Venice returned HTTP ${response.status}`);
  if (!response.body) throw new Error('Venice response has no stream body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    if (done) buffer += decoder.decode();

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        const payload = JSON.parse(line.slice(6)) as StreamPayload;
        const token = payload.choices?.[0]?.delta?.content;
        if (typeof token === 'string') onToken(token);
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
}
```

Use streaming when partial text improves perceived latency, such as a user-facing draft. Use a batch response when the caller needs a complete result before validation, JSON parsing, or an on-chain action. Do not treat partial streamed output as a completed or validated result.

## Errors and Local Development

| Condition | Recommended handling |
|---|---|
| `401` or `403` | Stop retries; check key validity, permissions, and secret configuration. |
| `400` or `422` | Inspect the model ID and request schema; correct the request instead of retrying unchanged input. |
| `429` | Honor `Retry-After` when provided; otherwise use bounded exponential backoff with jitter and enforce a per-task retry budget. |
| `5xx`, timeout, or network failure | Retry a small bounded number of times, then fail gracefully or use a permitted cached result. Avoid retry storms. |
| Model unavailable | Check the live model catalog and select an explicitly supported alternative; do not silently change models for safety-sensitive tasks. |
| Refusal or filtered output | Surface a safe, actionable error. Do not retry by weakening policy or disguising the request. |
| Invalid structured output | Parse and validate against a schema. Allow at most a bounded repair attempt, and never trust unvalidated fields. |

For local development, set a development-only key through an ignored `.env` file, keep `max_tokens` small, and send a short representative prompt. Mock the HTTP boundary for deterministic unit checks; do not make CI depend on a paid live API. Record model ID, latency, status, retry count, and provider usage, but never log API keys or full sensitive prompts. ai-net's client already uses timeouts, bounded retries, provider failover, a circuit breaker, and optional cached fallback; direct API callers should implement equivalent controls appropriate to their application.

## References

- [Venice API model catalog](https://api.venice.ai/api/v1/models) — model IDs, context limits, capabilities, and price metadata.
- [Venice model-list API reference](https://docs.venice.ai/api-reference/endpoint/models/list)
- [Venice chat-completions API reference](https://docs.venice.ai/api-reference/endpoint/chat/completions)
- [ai-net Venice client](../backend/src/services/venice/client.ts) — internal agent mapping, retries, streaming, and token limits.
- [AI-Agent Integration Guide](ai-agent-integration-guide.md)