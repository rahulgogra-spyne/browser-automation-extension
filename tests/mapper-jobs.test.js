import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigStore } from '../backend/src/crm/config-store.js';
import { createJobs } from '../backend/src/mapper/jobs.js';

const site = { id: 'vinsolutions', name: 'VinSolutions', match: { hosts: ['localhost:4101'] } };
const pageType = (id, extra = {}) => ({ id, urlRegex: `^/${id}`, views: [], ...extra });
const tempStore = () => createConfigStore(join(mkdtempSync(join(tmpdir(), 'crm-config-')), 'crm-structures.json'));
const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

test('config store versions each mapping, merges page re-maps and keeps history', () => {
  const store = tempStore();
  store.saveMapping(site, [pageType('customer_record'), pageType('lead_list')], { reason: 'first', mappedBy: 'test', replaceAll: true });
  const etag = store.etag();
  const v2 = store.saveMapping(site, [pageType('customer_record', { note: 'new' })], { reason: 'failure', mappedBy: 'test', replaceAll: false });
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.pageTypes.map((pt) => pt.id).sort(), ['customer_record', 'lead_list']);
  assert.equal(v2.pageTypes.find((pt) => pt.id === 'customer_record').note, 'new');
  assert.deepEqual(v2.history.map((h) => h.reason), ['failure', 'first']);
  assert.notEqual(store.etag(), etag);
  const onDisk = JSON.parse(readFileSync(store.path, 'utf8'));
  assert.equal(onDisk.crms.vinsolutions.version, 2);
});

test('a failed mapping attempt keeps the previous rules', () => {
  const store = tempStore();
  store.saveMapping(site, [pageType('customer_record')], { reason: 'first', mappedBy: 'test', replaceAll: true });
  store.recordFailedAttempt(site, { reason: 'daily refresh', error: 'validation failed' });
  const crm = store.getCrm('vinsolutions');
  assert.equal(crm.version, 1);
  assert.equal(crm.pageTypes.length, 1);
  assert.deepEqual([crm.lastAttempt.ok, crm.lastAttempt.error], [false, 'validation failed']);
});

test('jobs run one at a time, collapse duplicates and cool down after a re-map', async () => {
  const store = tempStore();
  const ran = [];
  let release;
  const jobs = createJobs({
    sites: [site],
    store,
    log: () => {},
    runJob: async (job) => {
      ran.push(`${job.type}:${job.url ?? ''}`);
      if (job.type === 'full') await new Promise((r) => (release = r));
      return { version: ran.length };
    },
  });
  assert.equal(jobs.enqueueFull('vinsolutions').queued, true);
  assert.equal(jobs.enqueueFull('vinsolutions').reason, 'already queued');
  assert.equal(jobs.enqueueFull('nope').queued, false);
  const remap = { crmId: 'vinsolutions', pageTypeId: 'customer_record', url: 'http://x/1', reason: 'missing email' };
  assert.equal(jobs.enqueueRemap(remap).queued, true);
  assert.equal(jobs.enqueueRemap({ ...remap, url: 'http://x/2' }).reason, 'already queued', 'same page type, other record');
  await until(() => release);
  assert.equal(jobs.status().running.type, 'full', 'the re-map waits for the running job');
  release();
  await until(() => jobs.idle());
  assert.deepEqual(ran, ['full:', 'remap:http://x/1']);
  assert.equal(jobs.enqueueRemap(remap).reason, 're-mapped moments ago');
  assert.deepEqual(jobs.status().recent.map((j) => j.status), ['done', 'done']);
});

test('the schedule maps CRMs that were never mapped or are a day old', () => {
  const store = tempStore();
  const queued = [];
  const jobs = createJobs({ sites: [site, { ...site, id: 'cdk' }], store, log: () => {}, runJob: () => new Promise(() => {}) });
  store.saveMapping(site, [pageType('customer_record')], { reason: 'fresh', mappedBy: 'test', replaceAll: true });
  jobs.checkSchedule();
  for (const job of [jobs.status().running, ...jobs.status().queued].filter(Boolean)) queued.push(`${job.crmId}:${job.reason}`);
  assert.deepEqual(queued, ['cdk:first mapping'], 'vinsolutions was mapped just now');
});
