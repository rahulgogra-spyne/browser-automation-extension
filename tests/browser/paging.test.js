// Lists whose pager has no address for the next page: a script-driven "next"
// button, and an ASP.NET-style "Next >" that posts the page back. Only a
// control near the list is pressed, never another "Next" on the page.
// npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCrms } from '../../mock-crms/server.js';
import { customers } from '../../mock-crms/data.js';
import { openBrowser, openSession, goto, settle } from '../../backend/src/mapper/browser.js';

let mocks;
let browser;
const BASE = 'http://localhost:4494';
const site = { id: 'drawer', match: { hosts: ['localhost:4494'] }, login: null };
const LINKS = { container: '#leads-grid > tbody', item: ':scope > tr', fields: { link: [{ css: ':scope a', attr: 'href' }], title: [{ css: ':scope a' }] } };

before(async () => {
  mocks = await startMockCrms({ vinPort: 4491, cdkPort: 4492, sugarPort: 4493, drawerPort: 4494 });
  browser = await openBrowser();
});

after(async () => {
  await browser?.close();
  await mocks?.close();
});

const names = (entries) => entries.map((e) => e.title);
const everyone = customers.map((c) => `${c.first} ${c.last}`);

test('a script-driven pager is pressed near its list, never the setup wizard\'s "Next"', async () => {
  const { page, context } = await openSession(browser, site);
  await goto(page, `${BASE}/crm/leads`);
  // Without a list to stay near, the first "Next" on the page is the wizard's.
  await page.evaluate(() => window.__crmRuntime.pressNext());
  await settle(page);
  assert.equal(mocks.drawerState.wrongNext, 1, 'a page-wide search presses the wrong "Next"');
  mocks.drawerState.wrongNext = 0;

  const seen = [];
  for (let i = 0; i < 6; i++) {
    seen.push(...names(await page.evaluate((spec) => window.__crmRuntime.readCollection(spec), LINKS)));
    const pressed = await page.evaluate((near) => window.__crmRuntime.pressNext({ near }), '#leads-grid');
    if (!pressed) break;
    await settle(page);
  }
  assert.deepEqual(seen, everyone, 'all three pages, in order');
  assert.equal(mocks.drawerState.wrongNext, 0, 'the wizard\'s "Next" was never pressed');
  assert.equal(await page.evaluate((near) => window.__crmRuntime.hasNext({ near }), '#leads-grid'), false, 'the last page\'s "next" is disabled');
  await context.close();
});

test('an ASP.NET "Next >" postback link pages the list, reloading it each time', async () => {
  const { page, context } = await openSession(browser, site);
  await goto(page, `${BASE}/crm/leads-classic`);
  const spec = { ...LINKS, container: '#gvLeads > tbody' };
  const seen = [];
  for (let i = 0; i < 6; i++) {
    seen.push(...names(await page.evaluate((s) => window.__crmRuntime.readCollection(s), spec)).filter((n) => n !== 'Next >'));
    const [pressed] = await Promise.all([
      page.evaluate((near) => window.__crmRuntime.pressNext({ near }), '#gvLeads'),
      page.waitForLoadState('domcontentloaded').catch(() => {}),
    ]);
    if (!pressed) break;
    await page.waitForLoadState('load');
    await settle(page);
  }
  assert.deepEqual(seen, everyone);
  assert.equal(await page.evaluate(() => window.__crmRuntime.nextPageLink()), null, 'a javascript: link is no address to open');
  await context.close();
});
