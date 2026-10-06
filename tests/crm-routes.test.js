import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/src/app.js';
import { createConfigStore } from '../backend/src/crm/config-store.js';

const site = { id: 'cdk', name: 'CDK (mock)', match: { hosts: ['localhost:4102'] } };
const store = createConfigStore(join(mkdtempSync(join(tmpdir(), 'crm-routes-')), 'crm-structures.json'));
store.saveMapping(site, [{ id: 'customer_record', urlRegex: '^/x', views: [{ name: 'Profile' }], validation: { ok: true } }], {
  reason: 'test',
  mappedBy: 'test',
  replaceAll: true,
});
const calls = [];
const jobs = {
  enqueueRemap: (job) => (calls.push(['remap', job]), { queued: true, jobId: 7 }),
  enqueueFull: (crmId, reason) => (calls.push(['full', crmId, reason]), { queued: true, jobId: 8 }),
  status: () => ({ running: null, queued: [], recent: [] }),
};

let server;
let base;
before(async () => {
  const app = createApp({ extractPage: async () => ({}), apiKey: 'secret', log: { info() {}, error() {} }, crm: { store, sites: [site], jobs } });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (method, path, { body, headers = {} } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': 'secret', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

test('config is served with an ETag and revalidates to 304', async () => {
  assert.equal((await call('GET', '/api/config', { headers: { 'x-api-key': 'nope' } })).status, 401);
  const res = await call('GET', '/api/config');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).crms.cdk.version, 1);
  const again = await call('GET', '/api/config', { headers: { 'if-none-match': res.headers.get('etag') } });
  assert.equal(again.status, 304);
});

test('an extraction failure queues a re-map of that page', async () => {
  const res = await call('POST', '/api/extraction-failures', {
    body: { crmId: 'cdk', pageTypeId: 'customer_record', url: 'http://localhost:4102/elead/app.html#/customer/1003/profile', missing: ['email'], errors: [{ view: 'Notes', error: 'tab_not_found' }] },
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { queued: true, jobId: 7 });
  const [kind, job] = calls.at(-1);
  assert.equal(kind, 'remap');
  assert.equal(job.reason, 'extraction failed (missing email, Notes: tab_not_found)');
  assert.equal((await call('POST', '/api/extraction-failures', { body: { crmId: 'cdk' } })).status, 400);
});

test('mapper status lists every CRM and a run can be requested', async () => {
  const status = await (await call('GET', '/api/mapper/status')).json();
  assert.deepEqual(status.crms[0].pageTypes, [{ id: 'customer_record', role: 'record', entity: null, views: ['Profile'], ok: true }]);
  const res = await call('POST', '/api/mapper/run', { body: { crmId: 'cdk' } });
  assert.equal(res.status, 202);
  assert.deepEqual(calls.at(-1), ['full', 'cdk', 'requested from the extension']);
});
