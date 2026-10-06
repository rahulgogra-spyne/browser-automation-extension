// The real extension against the Drawer CRM mock, without OpenAI: its lists
// are mapped in Playwright with a scripted stand-in for the LLM, the layouts
// are served by an in-process backend, and the unpacked extension loaded in
// Edge runs "Capture whole CRM" on each:
//   /crm/               rows open a drawer (no address): every row's drawer is
//                       opened, its tabs read, and closed again
//   /crm/people         rows open their page only by script
//   /crm/leads          a script-driven "next" button (and a setup wizard's
//                       "Next" elsewhere, which must never be pressed)
//   /crm/leads-classic  an ASP.NET "Next >" that posts the page back
// and a CDK Unify-style launcher on a host of its own, mapped by the
// extension itself: its application cards are plain focusable divs drawn
// after a fetch, and the CRM's card opens the CRM in a new tab.
//
//   npm run e2e:no-ai
import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockCrms } from '../mock-crms/server.js';
import { customers } from '../mock-crms/data.js';
import { createApp } from '../backend/src/app.js';
import { createConfigStore } from '../backend/src/crm/config-store.js';
import { openBrowser, openSession, playwrightAdapter } from '../backend/src/mapper/browser.js';
import { mapCrm } from '../extension/lib/mapper/agent.js';
import { DATASETS } from '../extension/lib/mapper/datasets.js';
import { fakeLLM } from '../tests/fixtures/drawer-llm.js';

const { chromium } = createRequire(new URL('../backend/package.json', import.meta.url))('playwright-core');
const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const PORT = 8798;
const DRAWER_PORT = 4704;
const LAUNCHER_PORT = 4705;

// A launcher like CDK Unify's /applications: a header with the signed-in
// user's initials, and application cards (div tabindex="0", handlers added
// by script, no pointer cursor) that arrive from an API after the page loads.
// "Modern Retail CRM" opens the CRM (the Drawer CRM, another host) in a new tab.
const launcherPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Unify (mock)</title>
<style>.card { cursor: default; display: inline-block; padding: 12px; margin: 8px; border: 1px solid #ccc; width: 260px; }</style></head>
<body>
  <header class="top"><span class="brand">GLOBAL (mock)</span><div class="avatar" tabindex="0">TS</div></header>
  <main><h2>Applications</h2><div class="cards"></div></main>
  <script>
    document.querySelector('.avatar').addEventListener('click', () => document.body.insertAdjacentHTML('beforeend', '<div class="account-menu">My profile</div>'));
    setTimeout(async () => {
      const apps = await (await fetch('/api/apps')).json();
      const cards = document.querySelector('.cards');
      cards.innerHTML = apps.map((a) => '<div class="card sc-cSxQHt eqxAuK" id="wf-card-' + a.id + '" data-testid="card-' + a.id + '" tabindex="0"><div class="icon">' + a.icon + '</div><div class="title">' + a.name + '</div></div>').join('');
      cards.addEventListener('click', (e) => {
        const card = e.target.closest('.card');
        const app = card && apps.find((a) => 'wf-card-' + a.id === card.id);
        if (app) window.open(app.url, '_blank');
      });
    }, 500);
  </script>
</body></html>`;
const launcherApps = [
  { id: 'cdk-resource-center', icon: 'RC', name: 'CDK Resource Center', url: `http://localhost:${LAUNCHER_PORT}/help` },
  { id: 'customer-care', icon: 'CC', name: 'Customer Care', url: `http://localhost:${LAUNCHER_PORT}/help` },
  { id: 'modern-retail-crm', icon: 'CRM', name: 'Modern Retail CRM', url: `http://localhost:${DRAWER_PORT}/crm/` },
];
const launcher = http
  .createServer((req, res) => {
    const json = req.url.startsWith('/api/apps');
    res.writeHead(200, { 'content-type': json ? 'application/json' : 'text/html; charset=utf-8' });
    res.end(json ? JSON.stringify(launcherApps) : req.url.startsWith('/applications') ? launcherPage : '<h1>Help</h1>');
  })
  .listen(LAUNCHER_PORT, '127.0.0.1');
const site = { id: 'drawer', name: 'Drawer CRM (mock)', match: { hosts: [`localhost:${DRAWER_PORT}`] }, startUrl: `http://localhost:${DRAWER_PORT}/crm/`, targets: ['customers'] };

const work = mkdtempSync(join(tmpdir(), 'lead-capture-inplace-'));
const store = createConfigStore(join(work, 'crm-structures.json'));
const mocks = await startMockCrms({ vinPort: 4701, cdkPort: 4702, sugarPort: 4703, drawerPort: DRAWER_PORT });
const app = createApp({
  extractPage: async () => {
    throw new Error('no AI in this run');
  },
  model: 'none',
  log: { info() {}, error: (m) => console.log(`   backend error: ${m}`) },
  crm: { store, sites: [], jobs: { enqueueRemap: () => ({ queued: false }), status: () => ({}) }, llm: fakeLLM }, // the extension's own mapping asks the stand-in
});
const server = app.listen(PORT, '127.0.0.1');
const step = (title) => console.log(`\n=== ${title}`);
let failures = 0;
const check = (ok, what) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

let context;
try {
  step('1. Map the lists of the Drawer CRM (scripted LLM, Playwright)');
  const mapWith = async (crmSite, show) => {
    const browser = await openBrowser();
    try {
      const session = await openSession(browser, { login: null });
      return await mapCrm({
        site: crmSite,
        llm: fakeLLM,
        store: { getCrm: async () => null, saveMapping: async (s, pageTypes, opts) => store.saveMapping(s, pageTypes, opts), recordFailedAttempt: async () => {} },
        adapter: playwrightAdapter(session.page, crmSite),
        datasets: [DATASETS.customers],
        log: (line) => show.test(line) && console.log(`   agent: ${line.trim()}`),
      });
    } finally {
      await browser.close();
    }
  };
  const entry = await mapWith(site, /panel|Saved|rows/);
  const screen = entry.pageTypes.find((pt) => pt.role === 'screen');
  check(Boolean(screen?.detail?.validation.ok), `saved a screen with a drawer layout (v${entry.version})`);

  console.log('   and /crm/people, whose rows open a page only by script:');
  const peopleSite = { ...site, id: 'people', name: 'Drawer CRM people (mock)', startUrl: `http://localhost:${DRAWER_PORT}/crm/people` };
  const peopleEntry = await mapWith(peopleSite, /opens|Saved|validation/);

  console.log('   and the two lists whose pager has no address (/crm/leads, /crm/leads-classic):');
  const pagedSites = [
    { ...site, id: 'leads', name: 'Drawer CRM leads (mock)', startUrl: `http://localhost:${DRAWER_PORT}/crm/leads` },
    { ...site, id: 'classic', name: 'Drawer CRM classic leads (mock)', startUrl: `http://localhost:${DRAWER_PORT}/crm/leads-classic` },
  ];
  for (const paged of pagedSites) {
    const mapped = await mapWith(paged, /Saved/);
    check(mapped.pageTypes.some((pt) => pt.role === 'list') && mapped.pageTypes.some((pt) => pt.role === 'record'), `${paged.startUrl}: a list and a record page mapped`);
  }
  const personRules = JSON.stringify(store.getCrm('leads').pageTypes.find((pt) => pt.role === 'record').views);
  check(/iframe[^"]*>>>/.test(personRules) && personRules.includes('last_email_body') && personRules.includes('last_note'), "a person's email body and note, in frames with no address, are mapped");

  console.log('   and /crm/contacts-scroll, a list that grows as its own box is scrolled:');
  const scrollSite = { ...site, id: 'scroll', name: 'Drawer CRM scrolling contacts (mock)', startUrl: `http://localhost:${DRAWER_PORT}/crm/contacts-scroll` };
  const scrollEntry = await mapWith(scrollSite, /Saved/);
  check(scrollEntry.pageTypes.some((pt) => pt.role === 'list'), `${scrollSite.startUrl}: a list mapped`);

  step('2. Load the extension and capture the whole CRM');
  for (const channel of ['msedge', 'chromium', 'chrome']) {
    try {
      context = await chromium.launchPersistentContext(join(work, `profile-${channel}`), {
        channel,
        headless: true,
        acceptDownloads: true,
        downloadsPath: join(work, 'downloads'),
        args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      });
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 8000 }));
      console.log(`   extension loaded in ${channel}`);
      context.extensionId = new URL(worker.url()).host;
      break;
    } catch (error) {
      console.log(`   ${channel}: ${error.message.split('\n')[0]}`);
      await context?.close().catch(() => {});
      context = null;
    }
  }
  if (!context) throw new Error('Could not load the extension in any browser.');
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${context.extensionId}/options/options.html`);
  await ext.evaluate((s) => chrome.storage.local.set({ settings: s }), { backendUrl: `http://localhost:${PORT}`, capturedBy: 'inplace-e2e', captureTargets: ['customers'] });
  const send = (message) => ext.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const t0 = Date.now();
  const whole = await send({ type: 'captureCrm', crmId: 'drawer' });
  console.log(`   ${whole.ok ? `${whole.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${whole.pages} pages, ${whole.captured} captured, ${whole.saved} saved, ${whole.failed} failed, ${whole.aiFallbacks} by AI` : `ERROR ${whole.error}`}`);
  for (const line of whole.log ?? []) if (/didn't fit|Failed|skipped/.test(line)) console.log(`   log: ${line}`);

  step('3. What was saved');
  const stored = await ext.evaluate(() => chrome.storage.local.get(null));
  const rows = Object.entries(stored).filter(([k]) => /^(rows(\.customers)?|customers):/.test(k) || /^rows:/.test(k)).flatMap(([, v]) => v);
  const messages = Object.entries(stored).filter(([k]) => k.startsWith('messages:')).flatMap(([, v]) => v);
  const byEmail = new Map(rows.map((r) => [r.email ?? r.fields?.email, r]));
  check(whole.captured === customers.length && whole.aiFallbacks === 0, `${whole.captured}/${customers.length} contacts captured, none by AI`);
  check(customers.every((c) => byEmail.has(c.email)), 'every contact saved, by email');
  const cityOk = customers.every((c) => (byEmail.get(c.email)?.city ?? byEmail.get(c.email)?.fields?.city) === c.city);
  check(cityOk, 'each contact has the city only its drawer shows');
  check(messages.length === customers.reduce((n, c) => n + c.texts.length, 0), `${messages.length} text messages from the drawers' Messages tab`);
  check(mocks.drawerState.deletes === 0, 'no Delete button was ever pressed');
  if (failures) console.log(`\n   saved rows: ${JSON.stringify(rows.slice(0, 2)).slice(0, 600)}`);

  step('4. A list whose rows open a page of their own, only by script (/crm/people)');
  const peopleScreen = peopleEntry.pageTypes.find((pt) => pt.role === 'screen');
  check(Boolean(peopleScreen?.rowOpen && peopleScreen.recordPageType), `the list knows what to click (${peopleScreen?.rowOpen?.css}) to reach ${peopleScreen?.recordPageType}`);
  const t1 = Date.now();
  const people = await send({ type: 'captureCrm', crmId: 'people' });
  console.log(`   ${people.ok ? `${people.status} in ${((Date.now() - t1) / 1000).toFixed(0)}s: ${people.found} found, ${people.captured} captured, ${people.failed} failed, ${people.aiFallbacks} by AI` : `ERROR ${people.error}`}`);
  for (const line of people.log ?? []) if (/did not open|Could not|Failed|AI/.test(line)) console.log(`   log: ${line}`);
  check(people.captured === customers.length && people.aiFallbacks === 0, `${people.captured}/${customers.length} people captured from their own pages, none by AI`);
  const recent = (people.recent ?? []).map((r) => r.url);
  check(customers.every((c) => recent.includes(`http://localhost:${DRAWER_PORT}/crm/person/${c.id}`)), 'each person was read on /crm/person/<id>');

  step('5. Lists whose pager is a button: a script-driven grid, and an ASP.NET postback');
  for (const paged of pagedSites) {
    const t = Date.now();
    const run = await send({ type: 'captureCrm', crmId: paged.id });
    console.log(`   ${paged.startUrl}: ${run.ok ? `${run.status} in ${((Date.now() - t) / 1000).toFixed(0)}s: ${run.pages} pages, ${run.found} found, ${run.captured} captured, ${run.aiFallbacks} by AI` : `ERROR ${run.error}`}`);
    check(run.pages === 3 && run.captured === customers.length && run.aiFallbacks === 0, `all 3 pages walked by pressing "next", ${run.captured}/${customers.length} leads captured`);
  }
  check(mocks.drawerState.wrongNext === 0, 'the setup wizard\'s "Next" was never pressed');
  const savedRows = Object.entries(await ext.evaluate(() => chrome.storage.local.get(null)))
    .filter(([k]) => /^(rows(\.customers)?|customers):/.test(k))
    .flatMap(([, v]) => v);
  const john = savedRows.find((r) => r.email === customers[0].email && r.last_email_body);
  check(john?.last_email_body === customers[0].emails[0].body && john?.last_note === customers[0].notes[0].text, 'a captured person carries the email body and the note read from inside their frames');

  step('6. A list that grows as its own box is scrolled (/crm/contacts-scroll)');
  const t6 = Date.now();
  const scrolled = await send({ type: 'captureCrm', crmId: 'scroll' });
  console.log(`   ${scrolled.ok ? `${scrolled.status} in ${((Date.now() - t6) / 1000).toFixed(0)}s: ${scrolled.found} found, ${scrolled.captured} captured, ${scrolled.aiFallbacks} by AI` : `ERROR ${scrolled.error}`}`);
  for (const line of scrolled.log ?? []) if (/Expanded/.test(line)) console.log(`   log: ${line}`);
  check(scrolled.captured === customers.length, `the box was scrolled to its end in the background work tab: ${scrolled.captured}/${customers.length} contacts captured`);

  step('7. A launcher (CDK Unify-style), mapped by the extension: its CRM card opens the CRM in a new tab');
  const tabsBefore = await ext.evaluate(async () => (await chrome.tabs.query({})).length);
  const t7 = Date.now();
  const launched = await send({ type: 'mapCrm', startUrl: `http://localhost:${LAUNCHER_PORT}/applications`, reason: 'e2e', capture: false });
  const { mapping } = await ext.evaluate(() => chrome.storage.session.get('mapping'));
  for (const line of mapping?.log ?? []) if (/start page|after "|could not|lists reached|Saved|new tab/.test(line)) console.log(`   agent: ${line.trim()}`);
  console.log(`   ${launched.ok ? `mapped in ${((Date.now() - t7) / 1000).toFixed(0)}s: v${launched.version} ${launched.pageTypes.join(', ')}` : `ERROR ${launched.error}`}`);
  const unify = store.getCrm(`localhost-${LAUNCHER_PORT}`);
  const unifyScreen = unify?.pageTypes.find((pt) => pt.role === 'screen');
  check(/Modern Retail CRM$/.test(unifyScreen?.path?.[0]?.label ?? ''), `the "Modern Retail CRM" card was found and clicked (path: ${unifyScreen?.path?.map((s) => s.label).join(' > ') || 'none'})`);
  check(Boolean(unifyScreen?.detail?.validation.ok), "the CRM's contacts grid and its drawer were mapped behind it");
  check(unify?.match.hosts.includes(`localhost:${DRAWER_PORT}`), `the CRM's own host was added to the launcher's (${unify?.match.hosts.join(', ')})`);
  const t8 = Date.now();
  const viaLauncher = await send({ type: 'captureCrm', crmId: `localhost-${LAUNCHER_PORT}` });
  console.log(`   ${viaLauncher.ok ? `captured in ${((Date.now() - t8) / 1000).toFixed(0)}s: ${viaLauncher.captured} captured, ${viaLauncher.failed} failed, ${viaLauncher.aiFallbacks} by AI` : `ERROR ${viaLauncher.error}`}`);
  for (const line of viaLauncher.log ?? []) if (/Could not|Failed|didn't fit/.test(line)) console.log(`   log: ${line}`);
  check(viaLauncher.captured === customers.length && viaLauncher.aiFallbacks === 0, `capture replays launcher > card > CRM: ${viaLauncher.captured}/${customers.length} contacts, none by AI`);
  const tabsAfter = await ext.evaluate(async () => (await chrome.tabs.query({})).length);
  check(tabsAfter <= tabsBefore + 1, `no stray tabs left from the card's new-tab opens (${tabsBefore} before, ${tabsAfter} after; the capture window's console may stay)`);

  step('8. Crawl everything (POC): from the launcher, no layout, no AI, no filter on the kind of data');
  // The newest file the extension wrote whose first line is this header.
  const latestCsv = (header) => {
    const dir = join(work, 'downloads');
    const found = readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((p) => readFileSync(p, 'utf8').replace(/^﻿/, '').startsWith(header))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    return found ? readFileSync(found, 'utf8') : '';
  };
  const t9 = Date.now();
  const crawled = await send({ type: 'crawlSite', startUrl: `http://localhost:${LAUNCHER_PORT}/applications` });
  console.log(`   ${crawled.ok ? `${crawled.status} in ${((Date.now() - t9) / 1000).toFixed(0)}s: ${crawled.captured} pages and states read, ${crawled.saved} values saved` : `ERROR ${crawled.error}`}`);
  for (const line of crawled.log ?? []) if (/Now crawling|Could not|Failed|Stopped/.test(line)) console.log(`   log: ${line}`);
  const values = latestCsv('page_url,click_path,source,table,row,label,value');
  const pagesCsv = latestCsv('page_url,click_path,source,row,title');
  check(customers.every((c) => values.includes(c.email)), "every contact's email, from the CRM behind the launcher's card");
  check(/row panel/.test(values) && customers.every((c) => values.includes(c.city)), 'each grid row was opened and its drawer read (cities only the drawers show)');
  check(pagesCsv.includes('Modern Retail CRM'), 'the click path to the CRM is recorded');
  check(mocks.drawerState.deletes === 0, 'no Delete button was pressed while crawling');

  const t10 = Date.now();
  const classic = await send({ type: 'crawlSite', startUrl: `http://localhost:${DRAWER_PORT}/crm/leads-classic` });
  console.log(`   /crm/leads-classic: ${classic.ok ? `${classic.status} in ${((Date.now() - t10) / 1000).toFixed(0)}s: ${classic.captured} pages and states read, ${classic.saved} values saved` : `ERROR ${classic.error}`}`);
  const classicValues = latestCsv('page_url,click_path,source,table,row,label,value');
  const classicPages = latestCsv('page_url,click_path,source,row,title');
  check(customers.every((c) => classicValues.includes(`/crm/person/${c.id}`)), 'every person page linked from all 3 postback pages was crawled');
  check(classicPages.includes(customers[0].emails[0].body.slice(0, 40)), "a person page's text includes the email body from its srcdoc frame");
} catch (error) {
  failures++;
  console.log(`\nERROR ${error.stack}`);
} finally {
  await context?.close().catch(() => {});
  server.close();
  launcher.close();
  await mocks.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
