/**
 * Load profile for the invoice write path.
 *
 * This is the interesting one. Issuing an invoice takes a serializable
 * transaction, reads the head of the ZATCA hash chain, signs, posts a journal
 * and opens a retention entry. Concurrent issues genuinely contend: PostgreSQL
 * aborts the loser and PrismaService retries it. So the number to watch here is
 * not only p95 but the retry rate hiding inside it — throughput can look fine
 * while every second request is silently being done twice.
 *
 * The chain read is also unindexed (EInvoiceDocument carries no index at all)
 * and scans the whole e-invoice history inside that transaction, so this
 * scenario degrades as the database grows, not as traffic grows. Run it against
 * a database with a realistic invoice count or it will flatter the system.
 *
 *   k6 run -e BASE_URL=http://localhost:4000/api perf/invoicing.k6.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000/api';
const EMAIL = __ENV.EMAIL || 'admin@npi.sa';
const PASSWORD = __ENV.PASSWORD || 'Admin@123';

const issueTime = new Trend('rt_invoice_issue', true);
const conflictRate = new Rate('invoice_issue_conflicts');

export const options = {
  stages: [
    { duration: '30s', target: 3 },
    { duration: '1m', target: 8 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.02'],
    rt_invoice_issue: ['p(95)<3000'],
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
  const json = {
    headers: { Authorization: `Bearer ${data.token}`, 'Content-Type': 'application/json' },
  };

  // A contract and one verified milestone per iteration, so every virtual user
  // issues a genuinely new invoice and they all contend for the same chain head.
  const customers = http.get(`${BASE}/crm/customers`, json);
  const customerId = customers.json('0.id');
  if (!customerId) return;

  const contract = http.post(
    `${BASE}/commercial/contracts`,
    JSON.stringify({
      customerId,
      contractType: 'EPC',
      totalValue: 100000,
      retentionPct: 5,
      milestones: [
        { sequence: 1, descriptionAr: 'قياس أداء', descriptionEn: 'Load test stage', amount: 100000 },
      ],
    }),
    json,
  );
  if (!check(contract, { 'contract created': (r) => r.status === 201 || r.status === 200 })) return;

  const contractId = contract.json('id');
  const milestoneId = contract.json('milestones.0.id');
  http.post(`${BASE}/commercial/contracts/${contractId}/activate`, null, json);
  http.post(
    `${BASE}/commercial/contracts/${contractId}/milestones/verify`,
    JSON.stringify({ milestoneId }),
    json,
  );

  const draft = http.post(
    `${BASE}/finance/invoices/from-milestone`,
    JSON.stringify({ contractId, milestoneId }),
    json,
  );
  const invoiceId = draft.json('id');
  if (!invoiceId) return;

  const issued = http.post(`${BASE}/finance/invoices/${invoiceId}/issue`, null, json);
  issueTime.add(issued.timings.duration);
  // A 500 here means the retry gave up: the conflict outlived four attempts.
  conflictRate.add(issued.status >= 500);
  check(issued, { 'invoice issued': (r) => r.status === 201 || r.status === 200 });

  sleep(1);
}
