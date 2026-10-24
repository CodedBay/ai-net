import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('task_poll_error_rate');
const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    polling: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 100,
      maxVUs: 300,
    },
  },
  thresholds: {
    task_poll_error_rate: ['rate<0.001'],
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
};

export function setup() {
  const walletPublicKey = `load-test-poll-${Date.now()}`;
  const response = http.post(
    `${baseUrl}/api/tasks`,
    JSON.stringify({ prompt: 'Seed task for polling load test.', walletPublicKey, maxBudgetXLM: 1 }),
    {
      headers: {
        'Content-Type': 'application/json',
        walletpublickey: walletPublicKey,
        'Idempotency-Key': `load-poll-${Date.now()}`,
      },
    },
  );
  if (response.status !== 201) {
    throw new Error(`Failed to seed polling task (${response.status}): ${response.body}`);
  }
  return { walletPublicKey, taskId: JSON.parse(response.body).taskId };
}

export default function (data) {
  const response = http.get(`${baseUrl}/api/tasks/${data.taskId}`, {
    headers: { walletpublickey: data.walletPublicKey },
  });
  const ok = check(response, { 'task poll returns 200': (result) => result.status === 200 });
  errorRate.add(!ok);
}