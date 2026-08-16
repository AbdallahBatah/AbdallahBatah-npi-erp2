/**
 * Load profile for the read-heavy finance endpoints.
 *
 * These are the pages a controller leaves open all day, and they are the ones
 * whose cost grows with history rather than with traffic: the trial balance and
 * the general ledger aggregate every journal line ever written, and the VAT
 * return scans every invoice in the period. A response time measured against a
 * seeded database is therefore a floor, not a forecast — re-run this against a
 * copy of a real customer's data before putting any number in a contract.
 *
 *   k6 run -e BASE_URL=http://localhost:4000/api -e EMAIL=admin@npi.sa -e PASSWORD=Admin@123 perf/reports.k6.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000/api';
const EMAIL = __ENV.EMAIL || 'admin@npi.sa';
const PASSWORD = __ENV.PASSWORD || 'Admin@123';

// One trend per endpoint: a single aggregate p95 hides which report is the slow
// one, and "the finance module is slow" is not an actionable number.
const trends = {
  trialBalance: new Trend('rt_trial_balance', true),
  vatReturn: new Trend('rt_vat_return', true),
  poc: new Trend('rt_poc', true),
  profitability: new Trend('rt_profitability', true),
  balanceSheet: new Trend('rt_balance_sheet', true),
  summary: new Trend('rt_finance_summary', true),
};

export const options = {
  // Ramp until something bends, rather than sitting at one comfortable level:
  // the useful output is the load at which p95 leaves its plateau.
  stages: [
    { duration: '30s', target: 5 },
    { duration: '1m', target: 15 },
    { duration: '1m', target: 30 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    // Deliberately loose. These are tripwires that mark the point of
    // degradation, not a service level anyone has agreed to yet.
    http_req_failed: ['rate<0.01'],
    rt_trial_balance: ['p(95)<2000'],
    rt_vat_return: ['p(95)<2000'],
  },
};

export function setup() {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${res.body}`);
  }
  return { token: res.json('accessToken') || res.json('token') };
}

export default function (data) {
  const params = {
    headers: { Authorization: `Bearer ${data.token}` },
  };

  const calls = [
    ['trialBalance', '/finance/reports/trial-balance'],
    ['vatReturn', '/finance/reports/vat-return'],
    ['poc', '/finance/reports/poc'],
    ['profitability', '/finance/reports/profitability'],
    ['balanceSheet', '/finance/reports/balance-sheet'],
    ['summary', '/finance/summary'],
  ];

  for (const [name, path] of calls) {
    const res = http.get(`${BASE}${path}`, params);
    trends[name].add(res.timings.duration);
    check(res, { [`${name} 200`]: (r) => r.status === 200 });
  }

  sleep(1);
}
