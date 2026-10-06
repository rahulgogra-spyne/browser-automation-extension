// Records with no address of their own: rows of a grid that open a drawer
// (the Drawer CRM mock), and rows that open a page only by script. The
// runtime finds what a row click opened, reads it and closes it again; the
// agent maps the drawer with a scripted stand-in for the LLM.
// npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCrms } from '../../mock-crms/server.js';
import { customers } from '../../mock-crms/data.js';
import { openBrowser, openSession, goto, settle, playwrightAdapter } from '../../backend/src/mapper/browser.js';
import { mapRowDetail, mapCrm } from '../../extension/lib/mapper/agent.js';
import { DATASETS } from '../../extension/lib/mapper/datasets.js';
import { fakeLLM } from '../fixtures/drawer-llm.js';

let mocks;
let browser;
const DRAWER = 'http://localhost:4394';
const site = { id: 'drawer', name: 'Drawer CRM (mock)', match: { hosts: ['localhost:4394'] }, startUrl: `${DRAWER}/crm/`, login: null };
const GRID = { container: '#contacts-grid', row: ':scope tbody > tr', headers: ['Name', 'Email', 'Mobile', 'Status', 'Actions'], offset: 0 };

const memoryStore = () => {
  const saved = [];
  return {
    saved,
    getCrm: async () => null,
    saveMapping: async (s, pageTypes) => (saved.push(pageTypes), { version: saved.length, pageTypes }),
    recordFailedAttempt: async () => {},
  };
};

before(async () => {
  mocks = await startMockCrms({ vinPort: 4391, cdkPort: 4392, sugarPort: 4393, drawerPort: 4394 });
  browser = await openBrowser();
});

after(async () => {
  await browser?.close();
  await mocks?.close();
});

test('a row click opens a drawer: it is found, and its close button puts it away', async () => {
  const { page, context } = await openSession(browser, site);
  await goto(page, `${DRAWER}/crm/`);
  const openers = await page.evaluate((grid) => window.__crmRuntime.rowOpeners(grid, 0), GRID);
  assert.deepEqual(openers[0], { css: ':scope a.person-link' }, 'the name link comes first; mailto links and Delete never');
  assert.ok(!openers.some((o) => /button|row-action|mailto/.test(o.css)));

  await page.evaluate(([grid, open]) => {
    window.__crmRuntime.markVisible();
    return window.__crmRuntime.pressRow(grid, 1, open);
  }, [GRID, openers[0]]);
  await settle(page);
  const panel = await page.evaluate((grid) => window.__crmRuntime.openedPanel({ exclude: grid.container }), GRID);
  assert.ok(panel, 'something opened');
  assert.match(panel.selector, /aside/);
  assert.ok(panel.dialog);
  assert.match(panel.text, /Priya Shah/);

  const close = await page.evaluate((sel) => window.__crmRuntime.describeClose(sel), panel.selector);
  assert.equal(close.kind, 'nav');
  assert.equal(close.text, '×');
  await page.evaluate((spec) => window.__crmRuntime.pressClose(spec), close);
  await settle(page);
  assert.equal(await page.evaluate((sel) => window.__crmRuntime.shown(sel), panel.selector), false, 'the drawer is closed');
  assert.equal(mocks.drawerState.deletes, 0, 'no Delete button was pressed');
  await context.close();
});

test('mapRowDetail maps the drawer a row opens: its tabs, its message list, how to close it', async () => {
  const { page, context } = await openSession(browser, site);
  await goto(page, `${DRAWER}/crm/`);
  const adapter = playwrightAdapter(page, site);
  const lines = [];
  const found = await mapRowDetail(adapter, page, fakeLLM, { id: 'contact_panel', entity: 'contact', dataset: DATASETS.customers, table: GRID, backToList: async () => true }, { log: (l) => lines.push(l) });
  assert.equal(found?.kind, 'panel', lines.join('\n'));
  const { detail } = found;
  assert.ok(detail.validation.ok, lines.join('\n'));
  assert.deepEqual(detail.open, { css: ':scope a.person-link' });
  assert.equal(detail.close.text, '×');
  assert.deepEqual(detail.views.map((v) => v.name), ['Overview', 'Messages']);
  assert.ok(detail.required.includes('first_name') && detail.required.includes('last_name'));
  assert.ok(detail.expectOneOf.includes('email'));
  // The panel's tab is found inside the drawer, not the app's own "Messages" tab.
  assert.equal(detail.views[1].activate.text, 'Messages');
  assert.equal(mocks.drawerState.deletes, 0);
  await context.close();
});

test('mapCrm maps a list whose rows have no links as a screen with a drawer detail', async () => {
  const { page, context } = await openSession(browser, site);
  const adapter = playwrightAdapter(page, site);
  const store = memoryStore();
  const lines = [];
  const entry = await mapCrm({ site, llm: fakeLLM, store, adapter, datasets: [DATASETS.customers], log: (l) => lines.push(l) });
  const screen = entry.pageTypes.find((pt) => pt.role === 'screen');
  assert.ok(screen, lines.join('\n'));
  assert.equal(screen.url, `${DRAWER}/crm/`);
  assert.deepEqual(screen.path, []);
  assert.ok(screen.detail?.validation.ok, lines.join('\n'));
  assert.equal(mocks.drawerState.deletes, 0);
  await context.close();
});

test('the saved drawer layout reads every contact, page after page, with no AI', async () => {
  const { page, context } = await openSession(browser, site);
  const adapter = playwrightAdapter(page, site);
  const found = await (async () => {
    await goto(page, `${DRAWER}/crm/`);
    return mapRowDetail(adapter, page, fakeLLM, { id: 'contact_panel', entity: 'contact', dataset: DATASETS.customers, table: GRID, backToList: async () => true }, {});
  })();
  const { detail } = found;
  await goto(page, `${DRAWER}/crm/`);
  const read = [];
  for (let pageNo = 0; pageNo < 5; pageNo++) {
    const rows = await page.evaluate((grid) => window.__crmRuntime.tableRows(grid), GRID);
    for (let i = 0; i < rows; i++) {
      await page.evaluate(([grid, idx, open]) => window.__crmRuntime.pressRow(grid, idx, open), [GRID, i, detail.open]);
      await settle(page);
      const result = await page.evaluate((pt) => window.__crmRuntime.extractPage(pt), { ...detail, inPlace: true });
      assert.deepEqual(result.errors, []);
      read.push(result);
      await page.evaluate((spec) => window.__crmRuntime.pressClose(spec), detail.close);
      await settle(page);
    }
    const moved = await page.evaluate(() => window.__crmRuntime.pressNext());
    if (!moved) break;
    await settle(page);
  }
  assert.deepEqual(read.map((r) => r.fields.email), customers.map((c) => c.email));
  assert.deepEqual(read.map((r) => r.fields.city), customers.map((c) => c.city));
  assert.deepEqual(read.map((r) => r.collections.text_messages.length), customers.map((c) => c.texts.length));
  assert.equal(read[0].collections.text_messages[0].body, customers[0].texts[0].body);
  assert.equal(mocks.drawerState.deletes, 0);
  await context.close();
});

test('rows that open a page only by script are found and their pages collected', async () => {
  const NAV = 'http://nav-crm.test';
  const navSite = { id: 'nav', name: 'Nav CRM', match: { hosts: ['nav-crm.test'] }, startUrl: `${NAV}/people`, login: null };
  const people = { 1001: 'John Doe', 1002: 'Priya Shah', 1003: 'Carlos Mendez' };
  const list = `<!doctype html><title>People</title><table id="people"><thead><tr><th>Name</th><th>City</th></tr></thead><tbody>${Object.entries(people)
    .map(([id, name]) => `<tr data-id="${id}"><td>${name}</td><td>Plano</td></tr>`)
    .join('')}</tbody></table><script>document.querySelector('tbody').addEventListener('click', (e) => { location.href = '/people/' + e.target.closest('tr').dataset.id; });</script>`;
  const { page, context } = await openSession(browser, navSite);
  await context.route(`${NAV}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const one = pathname.match(/^\/people\/(\d+)$/);
    if (one) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>${people[one[1]]}</title><dl><dt>Name</dt><dd>${people[one[1]]}</dd></dl>` });
    return route.fulfill({ contentType: 'text/html', body: list });
  });
  await goto(page, `${NAV}/people`);
  const adapter = playwrightAdapter(page, navSite);
  const table = { container: '#people', row: ':scope tbody > tr', headers: ['Name', 'City'], offset: 0 };
  const backToList = async () => {
    await goto(page, `${NAV}/people`);
    return true;
  };
  const found = await mapRowDetail(adapter, page, fakeLLM, { id: 'p', entity: 'person', dataset: DATASETS.customers, table, backToList }, {});
  assert.equal(found.kind, 'navigates');
  assert.deepEqual(found.urls, [`${NAV}/people/1001`, `${NAV}/people/1002`]);
  await context.close();
});
