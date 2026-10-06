// Runs extension/content/crm-runtime.js in a real (headless) Chrome/Edge
// against the mock CRMs, with hand-written page types: no LLM involved.
// npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCrms } from '../../mock-crms/server.js';
import { openBrowser, openSession, goto, settle } from '../../backend/src/mapper/browser.js';

let mocks;
let browser;
const VIN = 'http://localhost:4191';
const CDK = 'http://localhost:4192';
const vinSite = { id: 'vinsolutions', match: { hosts: ['localhost:4191'] }, startUrl: `${VIN}/vinconnect/`, login: null };
const cdkSite = {
  id: 'cdk',
  match: { hosts: ['localhost:4192'] },
  startUrl: `${CDK}/elead/app.html#/customers`,
  login: {
    url: `${CDK}/login`,
    steps: [{ fill: '#username', default: 'demo.sales' }, { fill: '#password', default: 'mock-crm-2026' }, { click: 'button[type=submit]' }],
    successUrlIncludes: '/elead/',
  },
};

const P = 'ctl00_ContentPlaceHolder1_';
const vinPageType = {
  id: 'customer_record',
  urlRegex: '^/vinconnect/customer\\?GlobalCustomerID=([^/?&#]+)(?=$|[?&#])',
  frame: { urlRegex: '^/CarDashboard/Pages/CRM/CustomerDashboard\\.aspx\\?GlobalCustomerID=([^/?&#]+)(?=$|[?&#])' },
  views: [
    {
      name: 'General',
      activate: { css: 'a.rtsLink', text: 'General' },
      waitFor: `#${P}lblCellPhone`,
      fields: {
        last_name: [{ css: `#${P}lblCustomerName`, regex: '^([^,]+),' }],
        first_name: [{ css: `#${P}lblCustomerName`, regex: ',\\s*(.+)$' }],
        phone_mobile: [{ css: `#${P}lblCellPhone` }, { label: 'Cell Phone' }],
        email: [{ css: `#${P}lnkEmail` }, { label: 'E-Mail' }],
        city: [{ css: `#${P}lblCityStateZip`, regex: '^([^,]+),' }],
      },
      collections: {},
    },
    {
      name: 'Texting',
      activate: { css: 'a.rtsLink', text: 'Texting' },
      waitFor: 'div.sms-thread',
      fields: {},
      collections: {
        text_messages: {
          container: 'div.sms-thread',
          item: ':scope > div.sms-bubble',
          fields: {
            timestamp: [{ css: ':scope span.sms-time' }],
            direction: [{ css: ':scope', attr: 'class' }],
            body: [{ css: ':scope div.sms-text' }],
          },
        },
      },
    },
  ],
};

const cdkPageType = {
  id: 'customer_record',
  urlRegex: '^/elead/app\\.html#/customer/([^/?&#]+)/',
  frame: null,
  views: [
    {
      name: 'Profile',
      activate: { css: 'a[role="tab"]', text: 'Profile' },
      waitFor: 'div.cdk-field__value[data-field="email"]',
      fields: {
        first_name: [{ css: 'div.cdk-field__value[data-field="firstName"]' }],
        email: [{ label: 'Primary Email' }],
      },
      collections: {},
    },
    {
      name: 'Communications',
      activate: { css: 'a[role="tab"]', text: 'Communications' },
      waitFor: 'ol.cdk-timeline',
      fields: {},
      collections: {
        communications: {
          container: 'ol.cdk-timeline',
          item: ':scope > li.cdk-timeline__item',
          fields: {
            channel: [{ css: ':scope', attr: 'class' }],
            direction: [{ css: ':scope', attr: 'data-direction' }],
            body: [{ css: ':scope p.cdk-timeline__text' }],
          },
        },
      },
    },
  ],
};

const dashboardFrame = (page) => page.frames().find((f) => f.url().includes('CustomerDashboard.aspx'));
const run = (frame, fn, arg) => frame.evaluate(fn, arg);

before(async () => {
  mocks = await startMockCrms({ vinPort: 4191, cdkPort: 4192, sugarPort: 4193, drawerPort: 4194 });
  browser = await openBrowser();
});

after(async () => {
  await browser?.close();
  await mocks?.close();
});

test('describeField builds id and label rules, and regex rules split combined text', async () => {
  const { page, context } = await openSession(browser, vinSite);
  await goto(page, `${VIN}/vinconnect/customer?GlobalCustomerID=1001`);
  const frame = dashboardFrame(page);
  const result = await run(frame, (P) => {
    const rt = window.__crmRuntime;
    rt.snapshot();
    const mid = (id) => Number(document.getElementById(P + id).getAttribute('data-cm'));
    return {
      email: rt.describeField(mid('lnkEmail')),
      city: rt.describeField(mid('lblCityStateZip'), { regex: '^([^,]+),' }),
    };
  }, P);
  assert.deepEqual(result.email.rules, [{ css: `#${P}lnkEmail` }, { label: 'E-Mail' }]);
  assert.equal(result.email.value, 'john.doe@example.com');
  assert.equal(result.city.value, 'Plano');
  assert.deepEqual(result.city.rules[0], { css: `#${P}lblCityStateZip`, regex: '^([^,]+),' });
  await context.close();
});

test('describeCollection and describeActivator generalise across entries and tabs', async () => {
  const { page, context } = await openSession(browser, vinSite);
  await goto(page, `${VIN}/vinconnect/customer?GlobalCustomerID=1001`);
  const frame = dashboardFrame(page);
  const result = await run(frame, async () => {
    const rt = window.__crmRuntime;
    rt.snapshot();
    const tab = [...document.querySelectorAll('.rtsTxt')].find((s) => s.textContent.startsWith('Texting'));
    const activator = rt.describeActivator(Number(tab.getAttribute('data-cm')));
    rt.activate(activator);
    rt.snapshot();
    const mid = (el) => Number(el.getAttribute('data-cm'));
    const thread = document.querySelector('.sms-thread');
    const bubbles = [...thread.children];
    const list = rt.describeCollection(mid(thread), bubbles.slice(0, 2).map(mid), [
      { key: 'body', mid: mid(bubbles[0].querySelector('.sms-text')) },
      { key: 'direction', mid: mid(bubbles[0]), attr: 'class' },
    ]);
    return { activator, list };
  });
  assert.deepEqual(result.activator, { css: 'a.rtsLink', text: 'Texting' });
  assert.equal(result.list.spec.item, ':scope > div', 'every child is a message, so no class is needed');
  assert.equal(result.list.count, 4);
  assert.equal(result.list.examples[0].body, 'Hi, is the Camry XSE on your site still available?');
  assert.match(result.list.examples[1].direction, /sms-outbound/);
  await context.close();
});

test('extractPage reads another customer through tabs inside an iframe', async () => {
  const { page, context } = await openSession(browser, vinSite);
  await goto(page, `${VIN}/vinconnect/customer?GlobalCustomerID=1002`);
  const [top, frame] = [page.mainFrame(), dashboardFrame(page)];
  assert.equal(await run(top, (pt) => window.__crmRuntime.extractPage(pt), vinPageType), null, 'top frame is not the record frame');
  const result = await run(frame, (pt) => window.__crmRuntime.extractPage(pt), vinPageType);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.fields, { last_name: 'SHAH', first_name: 'PRIYA', phone_mobile: '(469) 555-0123', email: 'priya.shah@example.com', city: 'Frisco' });
  assert.equal(result.collections.text_messages.length, 3);
  assert.match(result.collections.text_messages[0].direction, /sms-inbound/);
  await context.close();
});

test('extractPage follows hash-routed tabs whose content loads late (after login)', async () => {
  const { page, context } = await openSession(browser, cdkSite);
  await goto(page, `${CDK}/elead/app.html#/customer/1001/profile`);
  const result = await run(page.mainFrame(), (pt) => window.__crmRuntime.extractPage(pt), cdkPageType);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.fields, { first_name: 'John', email: 'john.doe@example.com' });
  const channels = result.collections.communications.map((m) => m.channel.split('--')[1]);
  assert.deepEqual(channels.sort(), ['call', 'email', 'email', 'sms', 'sms', 'sms', 'sms']);
  await settle(page);
  assert.match(page.url(), /#\/customer\/1001\/profile$/, 'returns to the first tab');
  await context.close();
});

test('a tab with no entries is not an error', async () => {
  const { page, context } = await openSession(browser, vinSite);
  await goto(page, `${VIN}/vinconnect/customer?GlobalCustomerID=1005`); // Marcus: no emails
  const emailsOnly = {
    ...vinPageType,
    views: [
      vinPageType.views[0],
      {
        name: 'Email',
        activate: { css: 'a.rtsLink', text: 'Email' },
        waitFor: `#${P}gridEmails`,
        fields: {},
        collections: { emails: { container: `#${P}gridEmails`, item: ':scope tr', fields: { subject: [{ css: ':scope td:nth-of-type(4)' }] } } },
      },
    ],
  };
  const result = await run(dashboardFrame(page), (pt) => window.__crmRuntime.extractPage(pt), emailsOnly);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.notes, [{ view: 'Email', note: 'marker_missing' }]);
  assert.deepEqual(result.collections.emails, []);
  assert.equal(result.fields.first_name, 'MARCUS');
  await context.close();
});

test('an empty value next to its label reads as empty, not as the next row', async () => {
  const { page, context } = await openSession(browser, vinSite);
  await goto(page, `${VIN}/vinconnect/customer?GlobalCustomerID=1004`); // Emily: no home or work phone
  const values = await run(dashboardFrame(page), () => ({
    home: window.__crmRuntime.evalRule({ label: 'Home Phone' }),
    cell: window.__crmRuntime.evalRule({ label: 'Cell Phone' }),
  }));
  assert.deepEqual(values, { home: '', cell: '(214) 555-0132' });
  await context.close();
});

test('an empty value inside a label/value wrapper reads as empty too', async () => {
  const { page, context } = await openSession(browser, cdkSite);
  await goto(page, `${CDK}/elead/app.html#/customer/1004/profile`); // Emily: no home or work phone
  const values = await run(page.mainFrame(), () => ({
    home: window.__crmRuntime.evalRule({ label: 'Home Phone' }),
    mobile: window.__crmRuntime.evalRule({ label: 'Mobile Phone' }),
  }));
  assert.deepEqual(values, { home: '', mobile: '(214) 555-0132' });
  await context.close();
});

test('a field picked on its label is described by the value beside it', async () => {
  const { page, context } = await openSession(browser, cdkSite);
  await goto(page, `${CDK}/elead/app.html#/customer/1003/profile`);
  const found = await run(page.mainFrame(), () => {
    const rt = window.__crmRuntime;
    rt.snapshot();
    const label = [...document.querySelectorAll('.cdk-field__label')].find((el) => el.textContent === 'Postal Code');
    return rt.describeField(Number(label.getAttribute('data-cm')), { valueSlot: true });
  });
  assert.equal(found.value, '75002');
  assert.deepEqual(found.rules[0], { css: 'div[data-field="postalCode"]' });
  await context.close();
});

test('a list learned from a one-row example still reads zebra-striped rows', async () => {
  const { page, context } = await openSession(browser, vinSite);
  await goto(page, `${VIN}/vinconnect/customer?GlobalCustomerID=1003`); // Carlos: one email
  let frame = dashboardFrame(page);
  const spec = await run(frame, (P) => {
    const rt = window.__crmRuntime;
    rt.activate({ css: 'a.rtsLink', text: 'Email' });
    rt.snapshot();
    const mid = (el) => Number(el.getAttribute('data-cm'));
    const grid = document.getElementById(`${P}gridEmails`);
    const row = grid.querySelector('tbody tr');
    return rt.describeCollection(mid(grid), [mid(row)], [{ key: 'subject', mid: mid(row.children[3]) }]).spec;
  }, P);
  assert.equal(spec.item, ':scope tbody > tr');
  await goto(page, `${VIN}/vinconnect/customer?GlobalCustomerID=1001`); // John: two emails, rgRow + rgAltRow
  frame = dashboardFrame(page);
  const subjects = await run(frame, async (spec) => {
    const rt = window.__crmRuntime;
    rt.activate({ css: 'a.rtsLink', text: 'Email' });
    return rt.readCollection(spec).map((e) => e.subject);
  }, spec);
  assert.deepEqual(subjects, ['Your Camry XSE quote', 'RE: Your Camry XSE quote']);
  await context.close();
});

test('a CRM layout change makes the old rules report errors', async () => {
  mocks.setLayout('vinsolutions', 2);
  try {
    const { page, context } = await openSession(browser, vinSite);
    await goto(page, `${VIN}/vinconnect/customer?GlobalCustomerID=1001`);
    const result = await run(dashboardFrame(page), (pt) => window.__crmRuntime.extractPage(pt), vinPageType);
    assert.deepEqual(result.errors.map((e) => e.error), ['tab_not_found', 'tab_not_found']);
    assert.equal(result.fields.phone_mobile, undefined);
    await context.close();
  } finally {
    mocks.setLayout('vinsolutions', 1);
  }
});
