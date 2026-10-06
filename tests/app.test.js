import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../backend/src/app.js';
import { HttpError } from '../backend/src/errors.js';

const quiet = { info() {}, error() {} };
const page = {
  url: 'https://crm.example/leads',
  title: 'Leads',
  selection: '',
  frames: [
    {
      url: 'https://crm.example/leads',
      isTop: true,
      text: 'Name | Cell | Source\nJane Roe | 214-555-0147 | Cars.com\nAl Smith | 972-555-0199 | Walk-in',
      phones: [],
      emails: [],
    },
  ],
};

// What a model might return for that page, including things cleanup must fix.
const modelOutput = {
  page_type: 'Leads table',
  fields: [
    { key: 'full_name', label: 'Name' },
    { key: 'Cell Phone', label: 'Cell' },
    { key: 'lead_source', label: 'Source' },
  ],
  records: [
    {
      values: [
        { key: 'full_name', value: 'Jane Roe' },
        { key: 'Cell Phone', value: '214-555-0147' },
        { key: 'lead_source', value: 'Cars.com' },
        { key: 'email', value: 'made.up@example.com' },
        { key: 'full_name', value: 'duplicate key, dropped' },
      ],
    },
    { values: [{ key: 'full_name', value: 'Al Smith' }, { key: 'lead_source', value: '  ' }] },
    { values: [] },
  ],
};

let server;
let base;
let calls = 0;
let nextError = null;

before(async () => {
  const app = createApp({
    apiKey: 'secret',
    model: 'test-model',
    log: quiet,
    extractPage: async (prompt) => {
      calls++;
      if (nextError) throw nextError;
      assert.match(prompt, /Jane Roe/);
      return modelOutput;
    },
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (body, key = 'secret') =>
  fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });

test('rejects a wrong API key', async () => {
  const res = await post(page, 'nope');
  assert.equal(res.status, 401);
});

test('rejects a request without page content', async () => {
  const res = await post({ url: 'x', frames: [] });
  assert.equal(res.status, 400);
});

test('returns cleaned, verified records, then serves repeats from cache', async () => {
  const res = await post(page);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.pageType, 'Leads table');
  assert.equal(data.records.length, 2, 'empty records are dropped');

  const [jane, al] = data.records;
  assert.deepEqual(
    jane.fields?.map((f) => [f.key, f.label, f.check]),
    [
      ['full_name', 'Name', 'verified'],
      ['cell_phone', 'Cell', 'verified'],
      ['lead_source', 'Source', 'verified'],
      ['email', 'Email', 'not_on_page'],
    ],
  );
  assert.deepEqual(al.fields?.map((f) => f.key), ['full_name'], 'blank values are dropped');
  assert.equal(data.cached, false);

  const before = calls;
  const again = await (await post(page)).json();
  assert.equal(again.cached, true);
  assert.equal(calls, before, 'no second LLM call');
});

test('upstream errors come back with a readable message', async () => {
  nextError = new HttpError(502, 'OpenAI rate limit or quota reached. Try again shortly.');
  const res = await post({ ...page, title: 'different page' });
  nextError = null;
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /rate limit/);
});

test('malformed JSON gets a 400', async () => {
  const res = await fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});
