// The in-page runtime on a web-component CRM (Salesforce Lightning-style):
// fields, tabs, message lists and people lists that all live inside nested
// shadow roots. The pages are served by Playwright itself. No LLM involved.
// npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser, openSession, settle } from '../../backend/src/mapper/browser.js';

const ORIGIN = 'http://shadow-crm.test';
const people = {
  1001: { first: 'John', last: 'Doe', email: 'john.doe@example.com', phone: '(214) 555-0147', notes: ['Asked about the Camry XSE', 'Booked a test drive'] },
  1002: { first: 'Priya', last: 'Shah', email: 'priya.shah@example.com', phone: '(469) 555-0123', notes: ['Wants a trade-in quote', 'Prefers texts', 'Called back'] },
};

// Components: <crm-field> (label + value in its own shadow root), <crm-tabs>
// (buttons in a shadow root, switching slotted panels), <crm-timeline> (a
// list in a shadow root), <crm-record> (the record page, a shadow root of its
// own holding all of the above) and <crm-list> (a list of people).
const COMPONENTS = `
customElements.define('crm-field', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<div class="form-element"><span class="form-label">' + this.getAttribute('label') + '</span>' +
      '<span class="form-value">' + this.getAttribute('value') + '</span></div>';
  }
});
customElements.define('crm-tabs', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    const names = [...this.children].map((c) => c.getAttribute('name'));
    root.innerHTML = '<div class="tab-bar" role="tablist">' +
      names.map((n) => '<button class="tab-link" role="tab">' + n + '</button>').join('') + '</div><slot></slot>';
    const show = (i) => [...this.children].forEach((c, j) => (c.hidden = i !== j));
    root.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => setTimeout(() => show(i), 50)));
    show(0);
  }
});
customElements.define('crm-timeline', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const notes = JSON.parse(this.getAttribute('notes'));
    this.attachShadow({ mode: 'open' }).innerHTML = '<ul class="timeline">' +
      notes.map((n, i) => '<li class="timeline-item"><p class="note-body">' + n + '</p><a href="/note/' + (this.getAttribute('rid') * 10 + i) + '">open</a></li>').join('') + '</ul>';
  }
});
customElements.define('crm-record', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const p = JSON.parse(this.getAttribute('person'));
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<h1 class="record-title">' + p.first + ' ' + p.last + '</h1>' +
      '<crm-tabs>' +
        '<section name="Details">' +
          '<crm-field data-field="first" label="First Name" value="' + p.first + '"></crm-field>' +
          '<crm-field data-field="last" label="Last Name" value="' + p.last + '"></crm-field>' +
          '<crm-field data-field="email" label="Email" value="' + p.email + '"></crm-field>' +
          '<crm-field data-field="phone" label="Mobile" value="' + p.phone + '"></crm-field>' +
        '</section>' +
        '<section name="Activity"><crm-timeline rid="' + p.id + '" notes=\\'' + JSON.stringify(p.notes) + '\\'></crm-timeline></section>' +
      '</crm-tabs>';
  }
});
customElements.define('crm-list', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const rows = JSON.parse(this.getAttribute('rows'));
    this.attachShadow({ mode: 'open' }).innerHTML = '<div class="list-body">' +
      rows.map((r) => '<div class="list-row"><a class="row-link" href="/record/' + r.id + '">' + r.name + '</a><span>' + r.email + '</span></div>').join('') + '</div>';
  }
});`;

const page = (body) => `<!doctype html><html><head><title>Shadow CRM</title></head><body>${body}<script>${COMPONENTS}</script></body></html>`;
const attr = (value) => JSON.stringify(value).replace(/'/g, '&#39;');

function serve(route) {
  const { pathname } = new URL(route.request().url());
  const record = pathname.match(/^\/record\/(\d+)$/);
  if (record && people[record[1]]) {
    const person = { id: Number(record[1]), ...people[record[1]] };
    return route.fulfill({ contentType: 'text/html', body: page(`<crm-record person='${attr(person)}'></crm-record>`) });
  }
  if (pathname === '/people') {
    const rows = Object.entries(people).map(([id, p]) => ({ id, name: `${p.first} ${p.last}`, email: p.email }));
    rows.push({ id: 1003, name: 'Carlos Ruiz', email: 'carlos@example.com' });
    return route.fulfill({ contentType: 'text/html', body: page(`<crm-list rows='${attr(rows)}'></crm-list>`) });
  }
  return route.fulfill({ status: 404, body: 'not found' });
}

let browser;
before(async () => {
  browser = await openBrowser();
});
after(async () => {
  await browser?.close();
});

async function open(url) {
  const session = await openSession(browser, { login: null });
  await session.context.route(`${ORIGIN}/**`, serve);
  await session.page.goto(url, { waitUntil: 'domcontentloaded' });
  await settle(session.page);
  return session;
}

// Finds an element through a path of [selector, selector, ...], each one
// looked up inside the previous one's shadow root (test-side helper).
const MID_OF = `(path) => {
  let scope = document;
  let el = null;
  for (const sel of path) {
    el = scope.querySelector(sel);
    scope = el.shadowRoot || el;
  }
  return Number(el.getAttribute('data-cm'));
}`;

test('snapshot, field rules and label rules reach into nested shadow roots', async () => {
  const { page: p, context } = await open(`${ORIGIN}/record/1001`);
  const result = await p.evaluate((midOf) => {
    const rt = window.__crmRuntime;
    const mid = eval(midOf);
    const snap = rt.snapshot();
    const emailMid = mid(['crm-record', 'crm-field[data-field="email"]', '.form-value']);
    const labelMid = mid(['crm-record', 'crm-field[data-field="phone"]', '.form-label']);
    return {
      sees: snap.text.includes('john.doe@example.com'),
      email: rt.describeField(emailMid),
      phone: rt.describeField(labelMid, { valueSlot: true }),
      byLabel: rt.evalRule({ label: 'Email' }),
      text: rt.pageText(),
    };
  }, MID_OF);
  assert.ok(result.sees, 'the snapshot shows shadow content to the LLM');
  assert.equal(result.email.value, 'john.doe@example.com');
  assert.match(result.email.rules[0].css, />>>/, 'the rule steps into the shadow roots');
  assert.deepEqual(result.email.rules[1], { label: 'Email' }, 'a label rule inside the shadow root is kept');
  assert.equal(result.phone.value, '(214) 555-0147', 'a pick on the label reads the value beside it');
  assert.equal(result.byLabel, 'john.doe@example.com');
  assert.match(result.text, /John Doe/, 'page text includes shadow content');
  await context.close();
});

test('tabs, timelines and their links inside shadow roots are learned and replayed on another record', async () => {
  const learned = await open(`${ORIGIN}/record/1001`);
  const spec = await learned.page.evaluate(async (midOf) => {
    const rt = window.__crmRuntime;
    const mid = eval(midOf);
    rt.snapshot();
    const fields = {};
    for (const key of ['first', 'last', 'email']) {
      fields[key] = rt.describeField(mid(['crm-record', `crm-field[data-field="${key}"]`, '.form-value'])).rules;
    }
    const tabMid = (name) => {
      const tabs = document.querySelector('crm-record').shadowRoot.querySelector('crm-tabs').shadowRoot;
      return Number([...tabs.querySelectorAll('button')].find((b) => b.textContent === name).getAttribute('data-cm'));
    };
    const details = rt.describeActivator(tabMid('Details'));
    const activity = rt.describeActivator(tabMid('Activity'));
    rt.activate(activity);
    await rt.waitQuiet({ quietMs: 300, timeoutMs: 3000, minMs: 100 });
    rt.snapshot();
    const timeline = document.querySelector('crm-record').shadowRoot.querySelector('crm-timeline').shadowRoot;
    const ul = timeline.querySelector('ul');
    const items = [...ul.children];
    const midOfEl = (el) => Number(el.getAttribute('data-cm'));
    const notes = rt.describeCollection(midOfEl(ul), items.map(midOfEl), [{ key: 'body', mid: midOfEl(items[0].querySelector('.note-body')) }]);
    return { fields, details, activity, notes };
  }, MID_OF);
  await learned.context.close();

  assert.match(spec.activity.css, /button/);
  assert.equal(spec.notes.count, 2);
  assert.ok(spec.notes.spec.fields.link, 'the entries link to their own pages');
  assert.ok(spec.notes.examples[0].link.endsWith('/note/10010'));

  const pageType = {
    id: 'person',
    urlRegex: '^/record/(\\d+)',
    views: [
      { name: 'Details', activate: spec.details, waitFor: null, fields: spec.fields, collections: {} },
      { name: 'Activity', activate: spec.activity, waitFor: spec.notes.spec.container, fields: {}, collections: { notes: spec.notes.spec } },
    ],
  };
  const other = await open(`${ORIGIN}/record/1002`);
  const result = await other.page.evaluate((pt) => window.__crmRuntime.extractPage(pt), pageType);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.fields, { first: 'Priya', last: 'Shah', email: 'priya.shah@example.com' });
  assert.deepEqual(result.collections.notes.map((n) => n.body), people[1002].notes);
  await other.context.close();
});

test('a people list inside a shadow root is found by its links and read back', async () => {
  const { page: p, context } = await open(`${ORIGIN}/people`);
  const result = await p.evaluate(() => {
    const rt = window.__crmRuntime;
    rt.snapshot();
    const links = rt.pageLinks().filter((l) => /\/record\/\d+$/.test(l.url));
    const list = rt.describeList(links.slice(0, 2).map((l) => l.mid));
    return { links: links.length, list, reread: rt.readCollection(list.spec) };
  });
  assert.equal(result.links, 3, 'links inside the shadow root are seen');
  assert.equal(result.list.count, 3);
  assert.deepEqual(result.reread.map((r) => r.title), ['John Doe', 'Priya Shah', 'Carlos Ruiz']);
  assert.ok(result.reread[2].link.endsWith('/record/1003'));
  await context.close();
});
