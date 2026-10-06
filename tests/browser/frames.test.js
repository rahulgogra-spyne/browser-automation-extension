// Frames with no address of their own (an email body in a srcdoc frame, a
// note written into an about:blank frame) are read as part of their page,
// and a list that grows as its own box is scrolled is expanded fully.
// npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCrms } from '../../mock-crms/server.js';
import { customers } from '../../mock-crms/data.js';
import { openBrowser, openSession, goto } from '../../backend/src/mapper/browser.js';

let mocks;
let browser;
const BASE = 'http://localhost:4594';
const site = { id: 'drawer', match: { hosts: ['localhost:4594'] }, login: null };

before(async () => {
  mocks = await startMockCrms({ vinPort: 4591, cdkPort: 4592, sugarPort: 4593, drawerPort: 4594 });
  browser = await openBrowser();
});

after(async () => {
  await browser?.close();
  await mocks?.close();
});

test('an email body in a srcdoc frame and a note in an about:blank frame are mapped and read', async () => {
  const [john, priya] = customers;
  const { page, context } = await openSession(browser, site);
  await goto(page, `${BASE}/crm/person/${john.id}`);
  const mapped = await page.evaluate(() => {
    const rt = window.__crmRuntime;
    const snap = rt.snapshot();
    const midIn = (frameSel, sel) => Number(document.querySelector(frameSel).contentDocument.querySelector(sel).getAttribute('data-cm'));
    return {
      text: snap.text,
      email: rt.describeField(midIn('.email-frame', '.email-text')),
      note: rt.describeField(midIn('.note-frame', '.note-text')),
      pageText: rt.pageText(),
    };
  });
  assert.ok(mapped.text.includes(john.emails[0].body.slice(0, 40)), 'the snapshot shows the email body to the LLM');
  assert.ok(mapped.text.includes(john.notes[0].text.slice(0, 20)), 'and the note written by script');
  assert.equal(mapped.email.value, john.emails[0].body);
  assert.match(mapped.email.rules[0].css, /iframe.*>>>/, 'the rule steps into the frame');
  assert.equal(mapped.note.value, john.notes[0].text);
  assert.ok(mapped.pageText.includes(john.emails[0].body.slice(0, 40)));

  await goto(page, `${BASE}/crm/person/${priya.id}`);
  const pageType = { id: 'person', urlRegex: '^/crm/person/(\\d+)', views: [{ name: 'Main', activate: null, fields: { last_email_body: mapped.email.rules, last_note: mapped.note.rules }, collections: {} }] };
  const result = await page.evaluate((pt) => window.__crmRuntime.extractPage(pt), pageType);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.fields, { last_email_body: priya.emails[0].body, last_note: priya.notes[0].text });
  await context.close();
});

test('a list that grows as its own box is scrolled is expanded to the end', async () => {
  const { page, context } = await openSession(browser, site);
  await goto(page, `${BASE}/crm/contacts-scroll`);
  const spec = { container: 'div.scroll-rows', item: ':scope > div', fields: { link: [{ css: ':scope a', attr: 'href' }], title: [{ css: ':scope a' }] } };
  const before = await page.evaluate((s) => window.__crmRuntime.readCollection(s).length, spec);
  assert.equal(before, 2, 'two rows until the box is scrolled');
  const titles = await page.evaluate(async (s) => {
    await window.__crmRuntime.expandAll({ rows: 'div.scroll-rows > div' });
    return window.__crmRuntime.readCollection(s).map((e) => e.title);
  }, spec);
  assert.deepEqual(titles, customers.map((c) => `${c.first} ${c.last}`));
  await context.close();
});
