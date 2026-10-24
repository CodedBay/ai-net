import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const responseTime = new Trend('submit_task_response_time');
const errorRate = new Rate('submit_task_error_rate');
const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    submissions: { executor: 'per-vu-iterations', vus: 20, iterations: 1, maxDuration: '30s' },
  },
  thresholds: {
    submit_task_response_time: ['p(99)<2000'],
    submit_task_error_rate: ['rate<0.001'],
    http_req_duration: ['p(99)<2000'],
    http_req_failed: ['rate<0.001'],
  },
};

export default function () {
  const walletPublicKey = `load-test-${__VU}-${__ITER}`;
  const response = http.post(
    `${baseUrl}/api/tasks`,
    JSON.stringify({
      prompt: 'Load test task submission; do not call external services.',
      walletPublicKey,
      maxBudgetXLM: 1,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        walletpublickey: walletPublicKey,
        'Idempotency-Key': `load-${__VU}-${__ITER}-${Date.now()}`,
      },
    },
  );
  responseTime.add(response.timings.duration);
  const ok = check(response, {
    'task accepted': (result) => result.status === 201,
    'response includes task ID': (result) => {
      try {
        return Boolean(JSON.parse(result.body).taskId);
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!ok);
}