import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const responseTime = new Trend('get_agents_response_time');
const errorRate = new Rate('get_agents_error_rate');
const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    agents: { executor: 'constant-vus', vus: 100, duration: '60s' },
  },
  thresholds: {
    get_agents_response_time: ['p(95)<500'],
    get_agents_error_rate: ['rate<0.001'],
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
};

export default function () {
  const response = http.get(`${baseUrl}/api/agents`, {
    headers: { Accept: 'application/json' },
  });
  responseTime.add(response.timings.duration);
  const ok = check(response, {
    'agents endpoint returns 200': (result) => result.status === 200,
    'agents response is JSON': (result) => {
      try {
        JSON.parse(result.body);
        return true;
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!ok);
  sleep(0.1);
}
