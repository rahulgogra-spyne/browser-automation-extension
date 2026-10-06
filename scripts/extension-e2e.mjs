// Loads the real unpacked extension into Edge/Chromium and drives its
// background worker (the same messages the popup sends) against the mock
// CRMs and an in-process backend:
//   1. capture a VinSolutions and a CDK customer with the saved layouts (no AI)
//   2. save them: customer + message CSVs written through chrome.downloads
//   3. VinSolutions ships layout 2: the capture falls back to AI, reports the
//      failure, the backend re-maps the page, and the next capture uses the
//      new layout again
// Uses a copy of backend/config/crm-structures.json, and OpenAI for the AI
// fallback and the re-map.
//
//   node --env-file=backend/.env scripts/extension-e2e.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockCrms } from '../mock-crms/server.js';
import { createApp } from '../backend/src/app.js';
import { createOpenAIExtractor } from '../backend/src/openai-extractor.js';
import { createConfigStore } from '../backend/src/crm/config-store.js';
import { loadSites } from '../backend/src/crm/sites.js';
import { createMapperLLM } from '../backend/src/mapper/llm.js';
import { createJobs } from '../backend/src/mapper/jobs.js';
import { mapCrm } from '../backend/src/mapper/agent.js';

const { chromium } = createRequire(new URL('../backend/package.json', import.meta.url))('playwright-core');
const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const EXTENSION = root('extension');
const PORT = 8797;
const { OPENAI_API_KEY, OPENAI_MODEL = 'gpt-4.1-mini', MAPPER_MODEL } = process.env;
if (!OPENAI_API_KEY) throw new Error('Run with --env-file=backend/.env (needs OPENAI_API_KEY).');

const work = mkdtempSync(join(tmpdir(), 'lead-capture-ext-'));
const configPath = join(work, 'crm-structures.json');
// Start without the SugarCRM-family mock: the extension has to map it itself.
const shipped = JSON.parse(readFileSync(root('backend/config/crm-structures.json'), 'utf8'));
delete shipped.crms.sugar;
writeFileSync(configPath, JSON.stringify(shipped));
const store = createConfigStore(configPath);
const sites = loadSites(root('backend/config/crm-sites.json'));
const llm = createMapperLLM({ apiKey: OPENAI_API_KEY, model: MAPPER_MODEL || OPENAI_MODEL });
const jobs = createJobs({
  sites,
  store,
  log: (line) => console.log(`   backend: ${line}`),
  runJob: (job) => mapCrm({ site: job.site, llm, store, onlyUrl: job.type === 'remap' ? job.url : null, reason: job.reason, log: () => {} }),
});
const app = createApp({
  extractPage: createOpenAIExtractor({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL }),
  model: OPENAI_MODEL,
  log: { info() {}, error: (m) => console.log(`   backend error: ${m}`) },
  crm: { store, sites, jobs, llm },
});
const server = app.listen(PORT, '127.0.0.1');
const mocks = await startMockCrms();

// Branded Chrome ignores --load-extension, so try Edge first.
async function launch() {
  for (const channel of ['msedge', 'chromium', 'chrome']) {
    let context;
    try {
      context = await chromium.launchPersistentContext(join(work, `profile-${channel}`), {
        channel,
        headless: true,
        acceptDownloads: true,
        downloadsPath: join(work, 'downloads'),
        args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      });
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 8000 }));
      console.log(`   extension loaded in ${channel} (id ${new URL(worker.url()).host})`);
      return { context, extensionId: new URL(worker.url()).host };
    } catch (error) {
      console.log(`   ${channel}: ${error.message.split('\n')[0]}`);
      await context?.close().catch(() => {});
    }
  }
  throw new Error('Could not load the extension in any browser.');
}

const step = (title) => console.log(`\n=== ${title}`);
let context;
try {
  step('Load the unpacked extension');
  const launched = await launch();
  context = launched.context;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${launched.extensionId}/options/options.html`);
  const settings = { backendUrl: `http://localhost:${PORT}`, capturedBy: 'extension-e2e' }; // every kind of data (the default)
  await ext.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
  const send = (message) => ext.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const tabIdOf = (pattern) => ext.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0].id, pattern);

  const vin = await context.newPage();
  await vin.goto('http://localhost:4101/vinconnect/customer?GlobalCustomerID=1003');
  const cdk = await context.newPage();
  await cdk.goto('http://localhost:4102/login');
  await cdk.fill('#username', 'demo.sales');
  await cdk.fill('#password', 'mock-crm-2026');
  await cdk.click('button[type=submit]');
  await cdk.waitForURL(/elead/);
  await cdk.goto('http://localhost:4102/elead/app.html#/customer/1004/profile');
  await cdk.waitForSelector('.cdk-field__value');

  const summarize = (r) =>
    r.ok
      ? `mode=${r.mode} site="${r.site}" layout v${r.configVersion ?? '-'} record=${r.recordId || '-'}; ` +
        `${r.records[0].fields.length} fields (${r.records[0].fields.slice(0, 4).map((f) => `${f.key}=${f.value}`).join(', ')}); ` +
        `lists ${Object.entries(r.records[0].collections ?? {}).map(([k, v]) => `${k} ${v.length}`).join(', ') || 'none'}`
      : `ERROR ${r.error}`;
  const saveCapture = (r, page) =>
    send({
      type: 'save',
      records: [{ fields: Object.fromEntries(r.records[0].fields.map((f) => [f.key, f.value])), collections: r.records[0].collections }],
      meta: { pageUrl: page.url(), pageTitle: 'test', site: r.site, recordId: r.recordId },
    });

  step('1. Capture with the saved layouts (no AI)');
  const vinResult = await send({ type: 'extract', tabId: await tabIdOf('http://localhost:4101/*') });
  console.log(`   VinSolutions #1003: ${summarize(vinResult)}`);
  const cdkResult = await send({ type: 'extract', tabId: await tabIdOf('http://localhost:4102/*') });
  console.log(`   CDK #1004:          ${summarize(cdkResult)}`);

  step('2. Save to CSV');
  for (const [result, page] of [[vinResult, vin], [cdkResult, cdk]]) {
    const saved = await saveCapture(result, page);
    console.log(`   ${saved.ok ? `saved: ${saved.added} new, ${saved.messagesAdded} messages -> ${saved.filename}, ${saved.messagesFilename}${saved.fileError ? ` FILE ERROR ${saved.fileError}` : ''}` : `ERROR ${saved.error}`}`);
  }
  const status = await send({ type: 'status' });
  console.log(`   today: ${status.count} customers, ${status.messages} messages; files downloaded: ${readdirSync(join(work, 'downloads')).length}`);

  step('3. VinSolutions ships layout 2');
  mocks.setLayout('vinsolutions', 2);
  await vin.reload();
  const fallback = await send({ type: 'extract', tabId: await tabIdOf('http://localhost:4101/*') });
  console.log(`   first capture: ${summarize(fallback)}`);
  console.log(`   notice: ${fallback.notice}`);
  await new Promise((r) => setTimeout(r, 200));
  while (!jobs.idle()) await new Promise((r) => setTimeout(r, 500));
  console.log(`   backend config for vinsolutions is now v${store.getCrm('vinsolutions').version}`);
  const healed = await send({ type: 'extract', tabId: await tabIdOf('http://localhost:4101/*') });
  console.log(`   next capture:  ${summarize(healed)}`);
  const crmStatus = await send({ type: 'crmStatus' });
  console.log(`   options page view: ${crmStatus.crms.map((c) => `${c.name} v${c.version} (${c.pageTypes.map((pt) => `${pt.id}:${pt.role}`).join(', ')})`).join('; ')}`);

  step('4. SugarCRM-family mock: mapped from the signed-in browser for every kind of data, each captured as soon as its layout is ready');
  const sugar = await context.newPage();
  await sugar.goto('http://localhost:4103/app/');
  await sugar.waitForSelector("button:has-text('Save')", { timeout: 10_000 }).catch(() => null);
  if (await sugar.locator("button:has-text('Save')").count()) await sugar.click("button:has-text('Save')");
  const before = await send({ type: 'extract', tabId: await tabIdOf('http://localhost:4103/*') });
  console.log(`   before mapping: mode=${before.mode} dataset=${before.dataset} (${before.records?.length ?? 0} records read by AI)`);
  const t0 = Date.now();
  // While the mapping runs, note when the first records were saved.
  let firstCaptureAt = null;
  const watcher = setInterval(async () => {
    const { bulk } = await send({ type: 'bulkStatus' }).catch(() => ({}));
    if (!firstCaptureAt && bulk?.saved) firstCaptureAt = Date.now();
  }, 1000);
  const mapped = await send({ type: 'mapCrm', startUrl: 'http://localhost:4103/app/', reason: 'e2e' });
  const mappedAt = Date.now();
  const { mapping } = await ext.evaluate(() => chrome.storage.session.get('mapping'));
  console.log(`   mapped from the browser in ${((mappedAt - t0) / 1000).toFixed(0)}s: ${mapped.ok ? `v${mapped.version} ${mapped.pageTypes.join(', ')}` : `ERROR ${mapped.error}`}`);
  console.log(`   looked for: ${mapping?.targetLabel}`);
  for (const line of (mapping?.log ?? []).filter((l) => /^ {2}(users|customers|deals|appointments|tasks|vehicles):|Layout ready|Saved /.test(l))) console.log(`   agent: ${line.trim()}`);
  // The capture that ran beside the mapping may still be finishing.
  let alongside = null;
  for (let i = 0; i < 300; i++) {
    alongside = (await send({ type: 'bulkStatus' })).bulk;
    if (!alongside || alongside.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  clearInterval(watcher);
  const sugarCrm = store.getCrm('localhost-4103');
  console.log(`   server config: targets=${sugarCrm?.targets} ${sugarCrm?.pageTypes.map((pt) => `${pt.id}:${pt.role}${pt.dataset ? `(${pt.dataset})` : ''}`).join(', ')} mappedBy=${sugarCrm?.mappedBy}`);
  console.log(`   captured beside the mapping: ${alongside ? `${alongside.status}, ${alongside.found} found, ${alongside.captured} captured ${JSON.stringify(alongside.byKind)}, ${alongside.saved} saved, ${alongside.failed} failed, ${alongside.aiFallbacks} by AI` : 'nothing'}`);
  console.log(`   first records were saved ${firstCaptureAt ? `${((firstCaptureAt - t0) / 1000).toFixed(0)}s in (mapping ended at ${((mappedAt - t0) / 1000).toFixed(0)}s)` : 'only after the mapping'}`);
  const afterMap = await send({ type: 'status' });
  console.log(`   today's rows by kind: ${JSON.stringify(afterMap.datasets)}, ${afterMap.messages} messages; files: ${afterMap.files.join(', ')}`);
  const stored = await ext.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const pick = (prefix) => Object.entries(all).find(([k]) => k.startsWith(prefix))?.[1] ?? [];
    return { users: pick('rows.users:'), deals: pick('rows.deals:'), customers: pick('rows:') };
  });
  const show = (row) => Object.entries(row).filter(([k, v]) => v && !/^(record_id|captured_at|page_url|page_title|captured_by|site|crm_record_id|messages_count|unverified_fields)$/.test(k)).map(([k, v]) => `${k}=${v}`).join(', ');
  console.log(`   a user row:     ${stored.users[0] ? show(stored.users[0]) : '-'}`);
  console.log(`   a deal row:     ${stored.deals[0] ? show(stored.deals[0]) : '-'}`);
  console.log(`   a customer row: ${stored.customers.find((r) => r.site?.includes('4103')) ? show(stored.customers.find((r) => r.site?.includes('4103'))).slice(0, 260) : '-'}`);
  const alongsideOk = Boolean(mapped.ok && mapped.capturing && alongside?.status === 'done' && alongside.byKind?.users === 5 && alongside.byKind?.customers === 5 && alongside.byKind?.deals === 5 && !alongside.failed && firstCaptureAt && firstCaptureAt < mappedAt);

  step('5. Capture with that mapping: a list page, "capture all", and message bodies from their own pages');
  await sugar.goto('http://localhost:4103/app/?module=Contacts&action=index');
  await sugar.waitForSelector('#contacts-table');
  const listResult = await send({ type: 'extract', tabId: await tabIdOf('http://localhost:4103/*') });
  console.log(`   contacts list: mode=${listResult.mode} entity=${listResult.entity} count=${listResult.count} (${listResult.items?.map((i) => i.title).join(', ')})`);
  const all = await send({ type: 'captureList', crmId: listResult.crmId, recordPageType: listResult.recordPageType, urls: listResult.items.map((i) => i.url) });
  for (const r of all.records) {
    const history = r.collections.history ?? [];
    const withBody = history.filter((h) => h.link && h.body && h.body.includes('Regards')).length;
    console.log(`   ${r.recordId.slice(-4)}: ${r.fields.find((f) => f.key === 'first_name')?.value} ${r.fields.find((f) => f.key === 'last_name')?.value}; history ${history.length} (${withBody} email bodies fetched from their pages); texts ${(r.collections.text_messages ?? []).length}`);
  }
  if (all.failed?.length) console.log(`   failed: ${JSON.stringify(all.failed)}`);
  const savedAll = await send({
    type: 'save',
    records: all.records.map((r) => ({ fields: Object.fromEntries(r.fields.map((f) => [f.key, f.value])), collections: r.collections, pageUrl: r.pageUrl, recordId: r.recordId })),
    meta: { pageUrl: sugar.url(), pageTitle: 'Contacts', site: all.site },
  });
  console.log(`   saved: ${savedAll.added} new customers, ${savedAll.messagesAdded} messages`);

  step('6. A dashboard that only links to records');
  await sugar.goto('http://localhost:4103/app/');
  await sugar.waitForSelector('.sg-recent-item');
  const dash = await send({ type: 'extract', tabId: await tabIdOf('http://localhost:4103/*') });
  console.log(`   home dashboard: mode=${dash.mode} source=${dash.source} entity=${dash.entity} count=${dash.count} (${dash.items?.map((i) => i.title).join(', ')})`);
  const fromDash = await send({ type: 'captureList', crmId: dash.crmId, recordPageType: dash.recordPageType, urls: dash.items.map((i) => i.url) });
  console.log(`   captured ${fromDash.records.length} records from the dashboard's links; first: ${fromDash.records[0]?.fields.slice(0, 3).map((f) => `${f.key}=${f.value}`).join(', ')}`);

  step('7. The whole CRM again, with the saved layouts only (no AI): every page of every list of every kind');
  const t1 = Date.now();
  const whole = await send({ type: 'captureCrm', crmId: dash.crmId, startUrl: sugar.url() });
  console.log(`   ${whole.ok ? `${whole.status} in ${((Date.now() - t1) / 1000).toFixed(0)}s: ${whole.lists} list(s), ${whole.pages} pages walked, ${whole.found} records found, ${whole.captured} captured ${JSON.stringify(whole.byKind)}, ${whole.saved} saved, ${whole.failed} failed, ${whole.aiFallbacks} by AI` : `ERROR ${whole.error}`}`);
  const after = await send({ type: 'status' });
  console.log(`   today's files now hold ${JSON.stringify(after.datasets)} and ${after.messages} messages (capturing again updated rows, it did not duplicate them)`);
  const reference = await ext.evaluate(async () => {
    const { referenceRows } = await import(chrome.runtime.getURL('lib/reference.js'));
    const all = await chrome.storage.local.get(null);
    const datasets = {};
    for (const [k, v] of Object.entries(all)) {
      const m = k.match(/^rows(?:\.([a-z_]+))?:/);
      if (m) datasets[m[1] ?? 'customers'] = v;
    }
    return referenceRows({ datasets });
  });
  const refOf = (dataset, field) => reference.filter((r) => r.dataset === dataset && r.field === field).map((r) => `${r.value} (${r.count})`).join(', ');
  console.log(`   reference file: ${reference.length} values, e.g. deal stages: ${refOf('deals', 'stage')}; lead sources: ${refOf('deals', 'lead_source') || refOf('customers', 'lead_source')}; user roles: ${refOf('users', 'role')}`);
  const noDuplicates = after.datasets.users === afterMap.datasets.users && after.datasets.deals === afterMap.datasets.deals;

  step('8. Whole-CRM capture heals itself when the layout stops fitting (VinSolutions back on layout 1)');
  mocks.setLayout('vinsolutions', 1); // its config (v3) was mapped on layout 2
  const t2 = Date.now();
  const healedRun = await send({ type: 'captureCrm', crmId: 'vinsolutions', startUrl: 'http://localhost:4101/vinconnect/' });
  console.log(`   ${healedRun.ok ? `${healedRun.status} in ${((Date.now() - t2) / 1000).toFixed(0)}s: ${healedRun.pages} pages, ${healedRun.found} found, ${healedRun.captured} captured (${healedRun.remapped} re-map, ${healedRun.aiFallbacks} by AI), ${healedRun.failed} failed` : `ERROR ${healedRun.error}`}`);
  console.log(`   vinsolutions config is now v${store.getCrm('vinsolutions')?.version}, mappedBy ${store.getCrm('vinsolutions')?.mappedBy}`);
  const bodiesOk = all.records.every((r) => (r.collections.history ?? []).filter((h) => h.link).every((h) => h.body?.includes('Regards')));

  process.exitCode = alongsideOk && noDuplicates &&
    vinResult.mode === 'config' && cdkResult.mode === 'config' && fallback.mode === 'ai-fallback' && healed.mode === 'config' && listResult.mode === 'list' && all.records.length === 3 && bodiesOk && dash.mode === 'list' && fromDash.records.length === dash.count && mapped.ok && before.mode === 'ai' && whole.ok && whole.found === 15 && whole.captured === 15 && healedRun.ok && healedRun.captured === 5 && healedRun.remapped === 1 ? 0 : 1;
} finally {
  await context?.close();
  await mocks.close();
  server.close();
}
