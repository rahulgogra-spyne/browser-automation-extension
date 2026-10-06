// Mock of a CRM whose records never get an address of their own (not a real
// product): one page, a contacts grid whose rows have no links, and a drawer
// that slides in with the contact's details when a row is clicked. The drawer
// loads its data from a JSON API, has tabs of its own (Overview, Messages)
// and a close button. The grid pages with a "Next" button (no URL), three
// rows at a time, and every row has a Delete button that must never be
// pressed (state.deletes counts the presses). /crm/people is a list whose
// rows open a page of their own, but only by script.
import { DEALER, customers, findCustomer } from './data.js';
import { esc, html, json, notFound, readForm } from './http-utils.js';

const PAGE_SIZE = 3;
const API_DELAY_MS = 300;

const shell = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Contacts - Drawer CRM (mock)</title>
<style>
  body { font-family: sans-serif; margin: 0; }
  .app-tabs { display: flex; gap: 8px; padding: 8px; background: #234; }
  .app-tabs button { color: #fff; background: none; border: 0; }
  table { border-collapse: collapse; margin: 16px; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; }
  tr.grid-row { cursor: pointer; }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 420px; background: #fff; box-shadow: -4px 0 12px #0003; padding: 16px; }
  .drawer[hidden] { display: none; }
  .drawer-tabs button[aria-selected="true"] { font-weight: bold; }
</style></head>
<body>
  <header class="app-header">
    <span class="brand">Drawer CRM <small>(mock)</small> · ${esc(DEALER.name)}</span>
    <nav class="app-tabs" role="tablist">
      <button role="tab" aria-selected="true">Contacts</button>
      <button role="tab" aria-selected="false" class="app-tab-messages">Messages</button>
    </nav>
  </header>
  <main>
    <h1>Contacts</h1>
    <table id="contacts-grid">
      <thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody></tbody>
    </table>
    <div class="pager"><button class="pager-prev" aria-label="Previous page">‹ Prev</button> <span class="pager-info"></span> <button class="pager-next" aria-label="Next page">Next ›</button></div>
  </main>
  <aside class="drawer" role="dialog" aria-label="Contact details" hidden>
    <div class="drawer-header"><h2 class="drawer-title"></h2><button class="drawer-close" aria-label="Close">×</button></div>
    <div class="drawer-tabs" role="tablist">
      <button role="tab" aria-selected="true" data-pane="overview">Overview</button>
      <button role="tab" aria-selected="false" data-pane="messages">Messages</button>
    </div>
    <div class="drawer-body"></div>
  </aside>
  <script>
    const tbody = document.querySelector('#contacts-grid tbody');
    const drawer = document.querySelector('.drawer');
    const body = drawer.querySelector('.drawer-body');
    let page = 0, total = 0, current = null, pane = 'overview';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

    async function loadPage() {
      const data = await (await fetch('/crm/api/contacts?page=' + page)).json();
      total = data.total;
      tbody.innerHTML = data.rows.map((r) =>
        '<tr class="grid-row" data-row="' + r.id + '"><td><a class="person-link" href="javascript:void(0)">' + esc(r.last + ', ' + r.first) + '</a></td>' +
        '<td><a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a></td><td>' + esc(r.mobile) + '</td><td>' + esc(r.status) + '</td>' +
        '<td><button class="row-action">Delete</button></td></tr>').join('');
      document.querySelector('.pager-info').textContent = 'Page ' + (page + 1) + ' of ' + Math.ceil(total / ${PAGE_SIZE});
      document.querySelector('.pager-next').disabled = (page + 1) * ${PAGE_SIZE} >= total;
      document.querySelector('.pager-prev').disabled = page === 0;
    }

    function renderDrawer() {
      if (!current) return;
      drawer.querySelector('.drawer-title').textContent = current.first + ' ' + current.last;
      drawer.querySelectorAll('.drawer-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pane === pane)));
      body.innerHTML = pane === 'overview'
        ? '<dl class="details">' +
          '<dt>First Name</dt><dd>' + esc(current.first) + '</dd>' +
          '<dt>Last Name</dt><dd>' + esc(current.last) + '</dd>' +
          '<dt>Email</dt><dd>' + esc(current.email) + '</dd>' +
          '<dt>Mobile</dt><dd>' + esc(current.mobile) + '</dd>' +
          '<dt>City</dt><dd>' + esc(current.city) + '</dd>' +
          '<dt>Vehicle</dt><dd>' + esc(current.vehicle) + '</dd></dl>'
        : '<ul class="msg-list">' + current.messages.map((m) =>
            '<li class="msg" data-direction="' + m.direction + '"><span class="msg-time">' + esc(m.at) + '</span><p class="msg-body">' + esc(m.body) + '</p></li>').join('') + '</ul>';
    }

    async function openContact(id) {
      drawer.hidden = false;
      pane = 'overview';
      body.innerHTML = '<div class="loading">Loading…</div>';
      current = await (await fetch('/crm/api/contacts/' + id)).json();
      renderDrawer();
    }

    tbody.addEventListener('click', (event) => {
      if (event.target.closest('.row-action')) {
        event.stopPropagation();
        fetch('/crm/api/delete', { method: 'POST' });
        return;
      }
      const row = event.target.closest('tr.grid-row');
      if (row) openContact(row.dataset.row);
    });
    drawer.querySelector('.drawer-close').addEventListener('click', () => { drawer.hidden = true; current = null; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { drawer.hidden = true; current = null; } });
    drawer.querySelectorAll('.drawer-tabs button').forEach((b) => b.addEventListener('click', () => { pane = b.dataset.pane; setTimeout(renderDrawer, 80); }));
    document.querySelector('.pager-next').addEventListener('click', () => { page++; loadPage(); });
    document.querySelector('.pager-prev').addEventListener('click', () => { page = Math.max(0, page - 1); loadPage(); });
    loadPage();
  </script>
</body>
</html>`;

const row = (c) => ({ id: c.id, first: c.first, last: c.last, email: c.email, mobile: c.cell, status: c.status });
const contact = (c) => ({
  ...row(c),
  city: c.city,
  vehicle: `${c.vehicle.year} ${c.vehicle.make} ${c.vehicle.model}`,
  messages: c.texts.map((t) => ({ at: t.at, direction: t.dir === 'in' ? 'inbound' : 'outbound', body: t.body })),
});

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A second list, /crm/people, whose rows open a page of their own, but only
// by script (no link in the row): /crm/person/<id>.
const peopleList = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>People - Drawer CRM (mock)</title></head>
<body>
  <h1>People</h1>
  <table id="people-grid">
    <thead><tr><th>Name</th><th>Mobile</th><th>Status</th></tr></thead>
    <tbody>${customers.map((c) => `<tr class="person-row" data-id="${c.id}"><td>${esc(`${c.first} ${c.last}`)}</td><td>${esc(c.cell)}</td><td>${esc(c.status)}</td></tr>`).join('')}</tbody>
  </table>
  <script>
    document.querySelector('#people-grid tbody').addEventListener('click', (e) => {
      const row = e.target.closest('tr.person-row');
      if (row) location.href = '/crm/person/' + row.dataset.id;
    });
  </script>
</body></html>`;

const personPage = (c) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(`${c.first} ${c.last}`)} - Drawer CRM (mock)</title></head>
<body>
  <h1 class="person-name">${esc(`${c.first} ${c.last}`)}</h1>
  <dl class="person-details">
    <dt>First Name</dt><dd>${esc(c.first)}</dd>
    <dt>Last Name</dt><dd>${esc(c.last)}</dd>
    <dt>Email</dt><dd>${esc(c.email)}</dd>
    <dt>Mobile</dt><dd>${esc(c.cell)}</dd>
    <dt>City</dt><dd>${esc(c.city)}</dd>
  </dl>
  <section class="latest-email">
    <h2>Latest email</h2>
    <iframe class="email-frame" title="Email body" srcdoc="${esc(`<!doctype html><body><div class="email-text">${esc(c.emails[0]?.body ?? '')}</div></body>`)}"></iframe>
  </section>
  <section class="last-note">
    <h2>Last note</h2>
    <iframe class="note-frame" title="Note"></iframe>
  </section>
  <script>
    // Written into an about:blank frame by script, a moment after load.
    setTimeout(() => {
      const doc = document.querySelector('.note-frame').contentDocument;
      doc.open();
      doc.write('<!doctype html><body><div class="note-text">' + ${JSON.stringify(esc(c.notes?.[0]?.text ?? ''))} + '</div></body>');
      doc.close();
    }, 200);
  </script>
</body></html>`;

// A list that grows as its own box (not the page) is scrolled: two rows at a
// time, the next two fetched when the box reaches its end.
const scrollPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Contacts (scrolling) - Drawer CRM (mock)</title>
<style>.scroll-box { height: 80px; overflow-y: auto; border: 1px solid #ccc; } .scroll-row { height: 50px; }</style></head>
<body>
  <h1>Contacts</h1>
  <div class="scroll-box"><div class="scroll-rows"></div><div class="scroll-loading" hidden>Loading…</div></div>
  <script>
    const box = document.querySelector('.scroll-box');
    const list = document.querySelector('.scroll-rows');
    let shown = 0, busy = false;
    async function more() {
      if (busy || shown >= ${customers.length}) return;
      busy = true;
      const rows = await (await fetch('/crm/api/scroll-rows?from=' + shown)).json();
      list.insertAdjacentHTML('beforeend', rows.map((r) => '<div class="scroll-row"><a href="/crm/person/' + r.id + '">' + r.name + '</a></div>').join(''));
      shown += rows.length;
      busy = false;
    }
    box.addEventListener('scroll', () => { if (box.scrollTop + box.clientHeight >= box.scrollHeight - 10) more(); });
    more();
  </script>
</body></html>`;

// Two lists of leads, two per page, whose rows link to /crm/person/<id> but
// whose pager has no address for the next page:
//   /crm/leads          a script-driven grid with a "Next" button; a setup
//                       wizard elsewhere on the page has a "Next" button too
//                       (state.wrongNext counts its presses)
//   /crm/leads-classic  an ASP.NET-style form whose "Next >" link posts the
//                       page back (javascript:__doPostBack), reloading it
const LEADS_PER_PAGE = 2;
const pageCount = Math.ceil(customers.length / LEADS_PER_PAGE);
const leadsOn = (page) => customers.slice(page * LEADS_PER_PAGE, (page + 1) * LEADS_PER_PAGE);
const leadRow = (c) => `<tr><td><a href="/crm/person/${c.id}">${esc(`${c.first} ${c.last}`)}</a></td><td>${esc(c.source)}</td><td>${esc(c.status)}</td></tr>`;

const leadsPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Leads - Drawer CRM (mock)</title></head>
<body>
  <main>
    <aside class="setup-tips"><p>Finish setting up your store.</p><button class="wizard-next">Next</button></aside>
    <section class="leads">
      <h1>Leads</h1>
      <table id="leads-grid"><thead><tr><th>Name</th><th>Source</th><th>Status</th></tr></thead><tbody></tbody></table>
      <div class="grid-footer"><button class="grid-prev" aria-label="Previous">‹</button> <span class="grid-info"></span> <button class="grid-next" aria-label="Next">›</button></div>
    </section>
  </main>
  <script>
    let page = 0;
    const rows = ${JSON.stringify(customers.map((c) => leadRow(c)))};
    function render() {
      document.querySelector('#leads-grid tbody').innerHTML = rows.slice(page * ${LEADS_PER_PAGE}, (page + 1) * ${LEADS_PER_PAGE}).join('');
      document.querySelector('.grid-info').textContent = 'Page ' + (page + 1) + ' of ${pageCount}';
      document.querySelector('.grid-next').disabled = page + 1 >= ${pageCount};
      document.querySelector('.grid-prev').disabled = page === 0;
    }
    document.querySelector('.grid-next').addEventListener('click', () => { page++; setTimeout(render, 150); });
    document.querySelector('.grid-prev').addEventListener('click', () => { page--; setTimeout(render, 150); });
    document.querySelector('.wizard-next').addEventListener('click', () => fetch('/crm/api/wizard-next', { method: 'POST' }));
    render();
  </script>
</body></html>`;

const classicPage = (page) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Leads (classic) - Drawer CRM (mock)</title></head>
<body>
  <form id="form1" method="post" action="/crm/leads-classic">
    <input type="hidden" name="__EVENTTARGET" value="">
    <input type="hidden" name="page" value="${page}">
    <h1>Leads</h1>
    <table id="gvLeads"><tr><th>Name</th><th>Source</th><th>Status</th></tr>${leadsOn(page).map(leadRow).join('')}
      <tr class="grid-footer"><td colspan="3">Page ${page + 1} of ${pageCount}
        ${page + 1 < pageCount ? `<a id="lnkNext" href="javascript:__doPostBack('lnkNext','')">Next &gt;</a>` : '<a id="lnkNext" class="aspNetDisabled">Next &gt;</a>'}</td></tr>
    </table>
  </form>
  <script>
    function __doPostBack(target) {
      const form = document.getElementById('form1');
      form.__EVENTTARGET.value = target;
      if (target === 'lnkNext') form.page.value = String(Number(form.page.value) + 1);
      form.submit();
    }
  </script>
</body></html>`;

export function createDrawerHandler(state = {}) {
  state.deletes = 0;
  state.wrongNext = 0;
  return async (req, res, url) => {
    if (url.pathname === '/crm/leads') return html(res, leadsPage());
    if (url.pathname === '/crm/contacts-scroll') return html(res, scrollPage());
    if (url.pathname === '/crm/api/scroll-rows') {
      const from = Number(url.searchParams.get('from') || 0);
      await later(API_DELAY_MS);
      return json(res, customers.slice(from, from + 2).map((c) => ({ id: c.id, name: `${c.first} ${c.last}` })));
    }
    if (url.pathname === '/crm/leads-classic') {
      const form = req.method === 'POST' ? await readForm(req) : {};
      const page = Math.min(Math.max(Number(form.page) || 0, 0), pageCount - 1);
      return html(res, classicPage(page));
    }
    if (url.pathname === '/crm/api/wizard-next' && req.method === 'POST') {
      state.wrongNext++;
      return json(res, { ok: true });
    }
    if (url.pathname === '/' || url.pathname === '/crm') return html(res, '', 302, { location: '/crm/' });
    if (url.pathname === '/crm/') return html(res, shell());
    if (url.pathname === '/crm/people') return html(res, peopleList());
    const person = url.pathname.match(/^\/crm\/person\/(\d+)$/);
    if (person) {
      const c = findCustomer(person[1]);
      return c ? html(res, personPage(c)) : notFound(res);
    }
    if (url.pathname === '/crm/api/contacts') {
      const page = Number(url.searchParams.get('page') || 0);
      await later(API_DELAY_MS);
      return json(res, { total: customers.length, rows: customers.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row) });
    }
    const one = url.pathname.match(/^\/crm\/api\/contacts\/(\d+)$/);
    if (one) {
      const c = findCustomer(one[1]);
      if (!c) return notFound(res);
      await later(API_DELAY_MS);
      return json(res, contact(c));
    }
    if (url.pathname === '/crm/api/delete' && req.method === 'POST') {
      state.deletes++;
      return json(res, { ok: true });
    }
    return notFound(res);
  };
}
