// The explorer and the list/link parts of the runtime, in a real headless
// browser against the SugarCRM-family mock (auto sign-in, one-time
// interstitial, script-driven menu, div-grid list, slow record page with
// expanders, message rows linking to their own pages). No LLM involved.
// npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCrms } from '../../mock-crms/server.js';
import { recordId, emailId } from '../../mock-crms/sugar.js';
import { customers } from '../../mock-crms/data.js';
import { openBrowser, openSession, goto, playwrightAdapter } from '../../backend/src/mapper/browser.js';
import { explore, rowLinkGroups } from '../../extension/lib/mapper/agent.js';
import { looseUrlPattern, matchUrl } from '../../backend/src/crm/url-pattern.js';

let mocks;
let browser;
const SUGAR = 'http://localhost:4293';
const site = {
  id: 'sugar',
  name: 'SugarLike (mock)',
  match: { hosts: ['localhost:4293'] },
  startUrl: `${SUGAR}/app/`,
  login: { url: `${SUGAR}/app/`, steps: [{ click: "button:has-text('Save')", optional: true }], successUrlIncludes: '/app/' },
};
const john = customers[0];
const RECORD_RE = '^/app/\\?action=DetailView&module=Contacts&record=([^/?&#]+)(?=$|[?&#])';

before(async () => {
  mocks = await startMockCrms({ vinPort: 4291, cdkPort: 4292, sugarPort: 4293, drawerPort: 4294 });
  browser = await openBrowser();
});

after(async () => {
  await browser?.close();
  await mocks?.close();
});

test('an optional login step gets past a one-time interstitial after auto sign-in', async () => {
  const { page, context } = await openSession(browser, site);
  await goto(page, `${SUGAR}/app/?module=Contacts&action=index`);
  assert.match(await page.title(), /Contacts/);
  assert.equal(await page.locator('.of-data-table-row .of-link').count(), 3);
  await context.close();
});

test('the explorer dives from list rows and onclick rows into records, and ignores unsafe and external links', async () => {
  const { page, context } = await openSession(browser, site);
  const pages = await explore(playwrightAdapter(page, site), page, site, { maxPages: 12, perPattern: 2 });
  const urls = pages.map((p) => p.url);
  const records = urls.filter((u) => /module=Contacts&record=/.test(u));
  assert.ok(records.length >= 2, `expected contact records, got ${urls.join('\n')}`);
  assert.ok(urls.some((u) => /module=Emails&record=/.test(u)), 'email pages reached from the inbox rows');
  assert.ok(!urls.some((u) => /EditView|example\.com|sort=/.test(u)), 'no edit, external or sorting links');
  const home = pages.find((p) => p.url === `${SUGAR}/app/`);
  assert.ok(home.rowGroups.some((g) => /module=Contacts/.test(g.shape) && g.urls.length >= 3), 'the dashboard rows form a group of contact links');
  assert.ok(home.rowGroups.some((g) => g.urls.length === 3 && /Contacts/.test(g.shape) && g.text.includes(',')), 'onclick rows count as links too');
  await context.close();
});

test('rowLinkGroups groups same-shaped links that share a row structure', () => {
  const link = (n, ancestry = 'a.of-link>div.field-value>div.of-data-table-row>div.of-data-table') => ({
    url: `${SUGAR}/app/?action=DetailView&module=Contacts&record=${recordId(1000 + n)}`,
    text: `Person ${n}`,
    newTab: false,
    ancestry,
  });
  const groups = rowLinkGroups([link(1), link(2), link(3), link(4, 'a.sg-back>div.sg-record-head>main'), { url: `${SUGAR}/app/?module=Home`, text: 'Home', newTab: false, ancestry: 'a>div' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].urls.length, 3);
});

test('describeList learns the row and link of a div-grid list, tolerant of paging', async () => {
  const { page, context } = await openSession(browser, site);
  await goto(page, `${SUGAR}/app/?module=Contacts&action=index&list_offset=4&list_limit=3`);
  const found = await page.evaluate((re) => {
    const rt = window.__crmRuntime;
    rt.snapshot();
    const mids = rt
      .pageLinks()
      .filter((l) => new RegExp(re).test(new URL(l.url).pathname + new URL(l.url).search))
      .slice(0, 3)
      .map((l) => l.mid);
    return rt.describeList(mids);
  }, RECORD_RE);
  assert.equal(found.count, 2, 'the last page holds two contacts');
  assert.equal(found.spec.container, '#contacts-table');
  assert.deepEqual(found.spec.fields.link[0], { css: ':scope a.of-link', attr: 'href' });
  assert.equal(found.examples[0].title, `${customers[3].first} ${customers[3].last}`);
  assert.match(found.examples[0].link, /^http:\/\/localhost:4293\/app\/\?action=DetailView&module=Contacts&record=/);
  const listRe = looseUrlPattern(page.url());
  assert.ok(matchUrl(listRe, `${SUGAR}/app/?module=Contacts&action=index`), 'the first page matches the list pattern too');
  await context.close();
});

test('pageLinks reports new-tab and onclick navigations with absolute URLs', async () => {
  const { page, context } = await openSession(browser, site);
  await goto(page, `${SUGAR}/app/`);
  const links = await page.evaluate(() => {
    window.__crmRuntime.snapshot();
    return window.__crmRuntime.pageLinks();
  });
  const newTab = links.filter((l) => l.newTab);
  assert.ok(newTab.length >= 3 && newTab.every((l) => l.url.startsWith('https://www.example.com/')), 'target=_blank links are flagged');
  const recent = links.filter((l) => l.text.includes(',') && /module=Contacts&record=/.test(l.url));
  assert.equal(recent.length, 3, 'rows navigating from onclick are links');
  assert.ok(recent.every((l) => l.mid > 0));
  await context.close();
});

test('extractPage opens a collapsed panel, leaves an open one alone, and reads message links', async () => {
  const pageType = {
    id: 'contact',
    role: 'record',
    urlRegex: RECORD_RE,
    frame: null,
    views: [
      {
        name: 'Main',
        activate: null,
        waitFor: null,
        fields: {
          first_name: [{ css: '[data-key="first_name"]' }],
          email: [{ label: 'Email Primary' }],
          phone_mobile: [{ label: 'Phone Mobile' }],
        },
        collections: {
          history: {
            container: 'div.subpanel-outer.History',
            item: ':scope div.of-data-table-row:not(.of-data-table-header)',
            fields: { subject: [{ css: ':scope div.field-value:nth-of-type(1)' }], status: [{ css: ':scope div.field-value:nth-of-type(2)' }], link: [{ css: ':scope a.of-link', attr: 'href' }] },
            detailPageType: 'contact_history_entry',
          },
        },
      },
      {
        name: 'History again',
        activate: { css: 'button.subpanel-toggle', text: 'History', kind: 'expander' },
        waitFor: 'div.subpanel-outer.History div.of-data-table',
        fields: {},
        collections: {},
      },
      {
        name: 'Activities',
        activate: { css: 'button.subpanel-toggle', text: 'Activities', kind: 'expander' },
        waitFor: 'div.subpanel-outer.Activities div.of-data-table',
        fields: {},
        collections: {
          calls: {
            container: 'div.subpanel-outer.Activities',
            item: ':scope div.of-data-table-row:not(.of-data-table-header)',
            fields: { outcome: [{ css: ':scope div.field-value:nth-of-type(1)' }], direction: [{ css: ':scope div.field-value:nth-of-type(2)' }] },
          },
        },
      },
    ],
  };
  const { page, context } = await openSession(browser, site);
  await goto(page, `${SUGAR}/app/?action=DetailView&module=Contacts&record=${recordId(john.id)}`);
  const result = await page.evaluate((pt) => window.__crmRuntime.extractPage(pt), pageType);
  assert.deepEqual(result.errors, []);
  assert.equal(result.fields.first_name, 'John');
  assert.equal(result.fields.email, john.email);
  assert.equal(result.collections.history.length, john.emails.length + john.notes.length);
  assert.equal(result.collections.history[0].link, `${SUGAR}/app/?action=DetailView&module=Emails&record=${emailId(john, 0)}`);
  assert.equal(result.collections.history.at(-1).link, undefined, 'notes have no page of their own');
  assert.equal(result.collections.calls.length, john.calls.length, 'the collapsed panel was opened');
  assert.equal(await page.locator('.subpanel-outer.History .subpanel-toggle').getAttribute('aria-expanded'), 'true', 'the open panel was not toggled shut');
  await context.close();
});
