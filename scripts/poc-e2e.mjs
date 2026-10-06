// End-to-end proof of concept against the mock CRMs, using the real mapping
// agent (a few OpenAI calls per CRM):
//   1. the job queue maps both mock CRMs into a fresh CRM structure config
//   2. every mock customer is captured the way the extension does it (same
//      runtime, config matching, checks and CSV code), with no AI, and each
//      value is compared with the mock's source data
//   3. each mock ships a "new release" (layout 2): capture fails, the failure
//      queues a re-map of that page (as POST /api/extraction-failures does),
//      and capture works again on every customer
// Output in poc-output/: the config and the two daily CSV files.
//
//   node --env-file=backend/.env scripts/poc-e2e.mjs
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockCrms } from '../mock-crms/server.js';
import { customers } from '../mock-crms/data.js';
import { recordId } from '../mock-crms/sugar.js';
import { createConfigStore } from '../backend/src/crm/config-store.js';
import { loadSites } from '../backend/src/crm/sites.js';
import { createMapperLLM } from '../backend/src/mapper/llm.js';
import { createJobs } from '../backend/src/mapper/jobs.js';
import { mapCrm } from '../backend/src/mapper/agent.js';
import { openBrowser, openSession, goto, contentFrames } from '../backend/src/mapper/browser.js';
import { findCrm, findPageType, assessExtraction, describeProblems } from '../extension/lib/crm-config.js';
import { buildCapture } from '../extension/lib/capture.js';
import { findDuplicateIndex, mergeRow } from '../extension/lib/records.js';
import { toCsv } from '../extension/lib/csv.js';
import { MESSAGE_COLUMNS } from '../extension/lib/messages.js';
import { localDateKey, localTimestamp } from '../extension/lib/dates.js';

const OUT = fileURLToPath(new URL('../poc-output/', import.meta.url));
const { OPENAI_API_KEY, OPENAI_MODEL = 'gpt-4.1-mini', MAPPER_MODEL } = process.env;
if (!OPENAI_API_KEY) throw new Error('Run with --env-file=backend/.env (needs OPENAI_API_KEY).');

const RECORD_URL = {
  vinsolutions: (id) => `http://localhost:4101/vinconnect/customer?GlobalCustomerID=${id}`,
  cdk: (id) => `http://localhost:4102/elead/app.html#/customer/${id}/profile`,
  sugar: (id) => `http://localhost:4103/app/?action=DetailView&module=Contacts&record=${recordId(id)}`,
};
const step = (title) => console.log(`\n=== ${title}`);
const digits = (s) => String(s ?? '').replace(/\D/g, '');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const mocks = await startMockCrms();
const store = createConfigStore(`${OUT}crm-structures.json`);
const sites = loadSites(fileURLToPath(new URL('../backend/config/crm-sites.json', import.meta.url)));
const llm = createMapperLLM({ apiKey: OPENAI_API_KEY, model: MAPPER_MODEL || OPENAI_MODEL });
const jobs = createJobs({
  sites,
  store,
  log: (line) => console.log(line),
  runJob: (job) =>
    mapCrm({ site: job.site, llm, store, onlyUrl: job.type === 'remap' ? job.url : null, reason: job.reason, log: (line) => console.log(`   ${line}`) }),
});
const waitIdle = async () => {
  await new Promise((r) => setTimeout(r, 50));
  while (!jobs.idle()) await new Promise((r) => setTimeout(r, 500));
};
const browser = await openBrowser();

// What the extension does on a click, minus the popup.
async function capture(page, site, url) {
  await goto(page, url);
  const crm = findCrm(store.get(), url);
  const hit = crm && findPageType(crm.crm, url);
  if (!hit || hit.pageType.role !== 'record') return { ok: false, problems: 'no mapped record page type for this URL' };
  let result = null;
  for (const frame of contentFrames(page, site.match.hosts)) {
    result = await frame.evaluate((pt) => window.__crmRuntime.extractPage(pt), hit.pageType).catch(() => null);
    if (result) break;
  }
  const verdict = assessExtraction(hit.pageType, result);
  return { ok: verdict.ok, problems: describeProblems(verdict), result, crm, hit, title: await page.title() };
}

// Compares a capture with the mock's own data.
function mismatches(customer, fields, collections) {
  const out = [];
  const name = `${fields.first_name ?? ''} ${fields.last_name ?? ''}`.toLowerCase();
  if (name.trim() !== `${customer.first} ${customer.last}`.toLowerCase()) out.push(`name "${name.trim()}"`);
  if (fields.email !== customer.email) out.push(`email "${fields.email}"`);
  if (digits(fields.phone_mobile) !== digits(customer.cell)) out.push(`mobile "${fields.phone_mobile}"`);
  const expected = customer.texts.length + customer.emails.length + customer.calls.length + customer.notes.length;
  const got = Object.values(collections).reduce((n, list) => n + list.length, 0);
  if (got !== expected) out.push(`${got} messages & notes instead of ${expected}`);
  return out;
}

const rows = [];
const messages = [];
async function captureAll(label) {
  let problems = 0;
  for (const site of sites) {
    const { context, page } = await openSession(browser, site);
    for (const customer of customers) {
      const url = RECORD_URL[site.id](customer.id);
      const cap = await capture(page, site, url);
      if (!cap.ok) {
        problems++;
        console.log(`   ${site.id} #${customer.id}: FAILED (${cap.problems})`);
        continue;
      }
      const { fields, collections } = cap.result;
      const meta = { pageUrl: url, pageTitle: cap.title, site: cap.crm.crm.name, recordId: cap.hit.recordId };
      const built = await buildCapture({ records: [{ fields, collections }], meta, settings: { capturedBy: label }, capturedAt: localTimestamp() });
      for (const row of built.rows) {
        const i = findDuplicateIndex(rows, row);
        if (i >= 0) rows[i] = mergeRow(rows[i], row);
        else rows.push(row);
      }
      for (const m of built.messages) if (!messages.some((x) => x.message_id === m.message_id)) messages.push(m);
      const wrong = mismatches(customer, fields, collections);
      problems += wrong.length;
      const lists = Object.entries(collections).map(([k, v]) => `${k} ${v.length}`).join(', ');
      console.log(`   ${site.id} #${customer.id} ${fields.first_name} ${fields.last_name}: ${Object.keys(fields).length} fields; ${lists}${wrong.length ? `  MISMATCH: ${wrong.join('; ')}` : ''}`);
    }
    await context.close();
  }
  return problems;
}

try {
  step('1. The mapping agent maps both CRMs (queued like the daily schedule)');
  for (const site of sites) jobs.enqueueFull(site.id, 'proof of concept');
  await waitIdle();
  for (const [id, crm] of Object.entries(store.get().crms)) {
    for (const pt of crm.pageTypes) {
      if (pt.role === 'list') console.log(`   ${id} v${crm.version}: ${pt.id} (list of ${pt.entity}s -> ${pt.recordPageType})`);
      else console.log(`   ${id} v${crm.version}: ${pt.id} (${pt.role}) views ${pt.views.map((v) => v.name).join(' / ')}; ${pt.views.reduce((n, v) => n + Object.keys(v.fields).length, 0)} fields; lists ${pt.views.flatMap((v) => Object.keys(v.collections)).join(', ') || '-'}`);
    }
  }

  step('2. Capture every customer with the saved layouts (no AI)');
  const firstPass = await captureAll('poc: saved layout');
  console.log(firstPass ? `   ${firstPass} problems` : '   every value matches the mock CRM data');

  step('3. Each CRM ships a new release (layout 2): detect, re-map, recover');
  for (const site of sites) {
    mocks.setLayout(site.id, 2);
    const { context, page } = await openSession(browser, site);
    const url = RECORD_URL[site.id](1003);
    const before = await capture(page, site, url);
    console.log(`   ${site.id}: capture on the new layout ${before.ok ? 'still works' : `fails (${before.problems})`}`);
    if (!before.ok) {
      const queued = jobs.enqueueRemap({ crmId: site.id, pageTypeId: before.hit?.pageType.id, url, reason: `extraction failed (${before.problems})` });
      console.log(`   ${site.id}: failure reported, re-map queued: ${queued.queued}`);
      await waitIdle();
      const after = await capture(page, site, url);
      console.log(`   ${site.id}: config now v${store.getCrm(site.id).version}; capture ${after.ok ? `works again (${Object.keys(after.result.fields).length} fields)` : `still fails (${after.problems})`}`);
    }
    await context.close();
  }
  const secondPass = await captureAll('poc: re-mapped layout');
  console.log(secondPass ? `   ${secondPass} problems` : '   every customer captures correctly on the new layouts');

  step('4. CSV files');
  const date = localDateKey();
  writeFileSync(`${OUT}leads_${date}.csv`, `﻿${toCsv(rows)}`);
  writeFileSync(`${OUT}leads_messages_${date}.csv`, `﻿${toCsv(messages, MESSAGE_COLUMNS)}`);
  console.log(`   ${rows.length} customer rows  -> poc-output/leads_${date}.csv`);
  console.log(`   ${messages.length} message rows -> poc-output/leads_messages_${date}.csv`);
  console.log(`   config                -> poc-output/crm-structures.json`);
  process.exitCode = firstPass || secondPass ? 1 : 0;
} finally {
  await browser.close();
  await mocks.close();
}
