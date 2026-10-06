// Mock of a SugarCRM-family CRM (1CRM, SuiteCRM...; not the real products):
//   - "Preparing sign-in…" auto login, then a one-time "confirm your time
//     zone" screen that blocks every page until its Save button is pressed
//   - a main menu driven by script (no hrefs to crawl)
//   - a dashboard whose widgets link to records, one of them via onclick rows
//   - a paged, div-based contacts list whose names link to the records
//   - a record page that renders ~1s after load, with labelled fields and
//     panels below it: Activities (collapsed), History (emails whose
//     subject links, in a new tab, to the email's own page) and Texts
import { DEALER, customers, findCustomer, employees, findEmployee } from './data.js';
import { esc, html, json, redirect, notFound, parseCookies } from './http-utils.js';

// uuid-looking ids, like most SugarCRM-family systems use
export const recordId = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const emailId = (customer, i) => `e0000000-0000-4000-8000-${String(customer.id * 10 + i).padStart(12, '0')}`;
export const userId = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const dealId = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const numericId = (uuid) => Number(uuid?.split('-').pop());

const layout = (title, body, extra = '') => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="/assets/sugar.css">${extra}</head>
<body class="sg-app">
  <div class="sg-appbar">
    <span class="sg-brand">SugarLike CRM <small>(mock)</small></span>
    <div class="sg-menu" id="main-menu">
      ${['Home', 'Contacts', 'Accounts', 'Opportunities', 'Calendar', 'Reports', 'Users'].map((m) => `<div class="sg-menu-item" data-module="${m}">${m}</div>`).join('')}
    </div>
    <span class="sg-user">admin</span>
  </div>
  <main id="app-content">${body}</main>
  <footer class="sg-footer">${esc(DEALER.name)} · <a href="https://www.example.com/vendor" target="_blank">Vendor site</a></footer>
  <script src="/assets/sugar-app.js"></script>
</body>
</html>`;

const signingIn = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Login | SugarLike</title><link rel="stylesheet" href="/assets/sugar.css"></head>
<body class="sg-login"><div class="sg-login-box"><h1>Log In</h1><p>Preparing sign-in…</p></div>
<script>fetch('/auth/demo', { method: 'POST' }).then(() => location.reload());</script></body></html>`;

const timezonePage = (returnTo) =>
  layout(
    'SugarLike',
    `<div class="sg-card sg-timezone">
      <p>Before continuing, please confirm your time zone from the list of time zones shown below.</p>
      <label for="tz">Select Your Timezone</label>
      <form method="post" action="/app/timezone">
        <select id="tz" name="tz"><option>America/Chicago (GMT-6:00)</option><option>America/New_York (GMT-5:00)</option></select>
        <input type="hidden" name="return" value="${esc(returnTo)}">
        <button type="submit" class="sg-btn">Save</button>
      </form>
    </div>`,
  );

const home = () => {
  const inbox = customers.map((c) => ({ customer: c, email: c.emails[0] })).filter((x) => x.email);
  return layout(
    'SugarLike: Home Dashboard',
    `<h1 class="sg-title">Home Dashboard</h1>
    <section class="sg-card">
      <h2>My Inbox: Unread Emails</h2>
      <div class="of-data-table">
        <div class="of-data-table-row of-data-table-header"><div class="field-value">Subject</div><div class="field-value">Contact</div><div class="field-value">Date</div></div>
        ${inbox
          .map(
            ({ customer, email }, i) => `<div class="of-data-table-row">
          <div class="field-value"><a class="of-link" href="/app/?action=DetailView&module=Emails&record=${emailId(customer, 0)}">${esc(email.subject)}</a></div>
          <div class="field-value"><a class="of-link" href="/app/?action=DetailView&module=Contacts&record=${recordId(customer.id)}">${esc(customer.first)} ${esc(customer.last)}</a></div>
          <div class="field-value">${esc(email.at)}</div>
        </div>`,
          )
          .join('')}
      </div>
    </section>
    <section class="sg-card">
      <h2>Recently Viewed</h2>
      <ul class="sg-recent">
        ${customers
          .slice(0, 3)
          .map((c) => `<li class="sg-recent-item" onclick="location.href='/app/?action=DetailView&module=Contacts&record=${recordId(c.id)}'">${esc(c.last)}, ${esc(c.first)} <span class="sg-muted">${esc(c.status)}</span></li>`)
          .join('')}
      </ul>
    </section>
    <section class="sg-card">
      <h2>My Open Opportunities</h2>
      <ul class="sg-team">
        ${customers
          .slice(0, 3)
          .map((c) => `<li class="sg-team-item"><a class="of-link" href="/app/?action=DetailView&module=Opportunities&record=${dealId(c.id)}">${esc(dealOf(c).name)}</a> <span class="sg-muted">${esc(dealOf(c).stage)}</span></li>`)
          .join('')}
      </ul>
    </section>
    <section class="sg-card">
      <h2>Team Activity</h2>
      <ul class="sg-team">
        ${employees
          .filter((e) => e.status === 'Active')
          .slice(0, 3)
          .map((e) => `<li class="sg-team-item"><a class="of-link" href="/app/?action=DetailView&module=Users&record=${userId(e.id)}">${esc(e.first)} ${esc(e.last)}</a> <span class="sg-muted">last login ${esc(e.lastLogin)}</span></li>`)
          .join('')}
      </ul>
    </section>
    <section class="sg-card">
      <h2>News</h2>
      <ul>${['Release 9.1', 'Docker install guide', 'Newsletter editor'].map((t) => `<li>${t} <a href="https://www.example.com/news/${encodeURIComponent(t)}" target="_blank">view</a></li>`).join('')}</ul>
    </section>`,
  );
};

const PAGE_SIZE = 3;
const contactsList = (offset) => {
  const page = customers.slice(offset - 1, offset - 1 + PAGE_SIZE);
  const pager = (o, label) =>
    o >= 1 && o <= customers.length ? `<a class="sg-pager" href="/app/?module=Contacts&action=index&list_offset=${o}&list_limit=${PAGE_SIZE}">${label}</a>` : `<span class="sg-pager sg-disabled">${label}</span>`;
  return layout(
    'SugarLike: Contacts',
    `<h1 class="sg-title">Contacts</h1>
    <div class="sg-toolbar">
      <span>Selected: 0 of ${customers.length}</span>
      ${pager(offset - PAGE_SIZE, '‹ Prev')} ${pager(offset + PAGE_SIZE, 'Next ›')}
      <a class="sg-btn-link" href="/app/?module=Contacts&action=EditView">Create</a>
      <a class="sg-btn-link" href="/app/?module=Contacts&action=index&sort=last_name&dir=asc&list_offset=${offset}&list_limit=${PAGE_SIZE}">Sort by name</a>
    </div>
    <div class="of-data-table" id="contacts-table">
      <div class="of-data-table-row of-data-table-header"><div class="field-value">Name</div><div class="field-value">Account Name</div><div class="field-value">Email and Phone</div><div class="field-value">User</div></div>
      ${page
        .map(
          (c, i) => `<div class="of-data-table-row${i % 2 ? ' odd' : ''} row-editable">
        <div class="field-value"><div class="add-fields"><a class="of-link" href="/app/?action=DetailView&module=Contacts&record=${recordId(c.id)}">${esc(c.first)} ${esc(c.last)}</a><div class="sg-sub">${esc(c.source)}</div></div></div>
        <div class="field-value">${esc(DEALER.name)}</div>
        <div class="field-value">${esc(c.email)}<br>${esc(c.cell)}</div>
        <div class="field-value">${esc(c.salesperson)}</div>
      </div>`,
        )
        .join('')}
    </div>`,
  );
};

// Sales opportunities: one per customer, the vehicle they are after. A
// table whose names link to the opportunity's page (label/value rows).
const STAGES = { 'Active - Working': 'Negotiation', 'Appointment Set': 'Appointment', 'Sold': 'Closed Won', 'Lost': 'Closed Lost' };
function dealOf(c) {
  const v = c.vehicle ?? {};
  return {
    name: `${v.year ?? ''} ${v.make ?? ''} ${v.model ?? 'Vehicle'} - ${c.last}`.replace(/\s+/g, ' ').trim(),
    customer: `${c.first} ${c.last}`,
    stage: STAGES[c.status] ?? 'Prospecting',
    amount: `$${(24000 + (c.id % 7) * 3150).toLocaleString('en-US')}.00`,
    source: c.source,
    type: v.year >= 2025 ? 'New Vehicle' : 'Used Vehicle',
    owner: c.salesperson,
    close: c.created.replace(/^09/, '10'),
    created: c.created,
    vehicle: [v.year, v.make, v.model].filter(Boolean).join(' '),
    vin: v.vin ?? '',
    stock: v.stock ?? '',
  };
}
const dealsList = () =>
  layout(
    'SugarLike: Opportunities',
    `<h1 class="sg-title">Opportunities</h1>
    <div class="sg-toolbar"><span>${customers.length} opportunities</span> <a class="sg-btn-link" href="/app/?module=Opportunities&action=EditView">Create</a></div>
    <table class="sg-table" id="deals-table">
      <thead><tr><th>Opportunity</th><th>Customer</th><th>Sales Stage</th><th>Amount</th><th>Assigned to</th></tr></thead>
      <tbody>
      ${customers
        .map((c, i) => {
          const d = dealOf(c);
          return `<tr class="${i % 2 ? 'odd' : 'even'}">
        <td><a class="of-link" href="/app/?action=DetailView&module=Opportunities&record=${dealId(c.id)}">${esc(d.name)}</a></td>
        <td>${esc(d.customer)}</td><td>${esc(d.stage)}</td><td>${esc(d.amount)}</td><td>${esc(d.owner)}</td>
      </tr>`;
        })
        .join('')}
      </tbody>
    </table>`,
  );
const dealDetail = (c) => {
  const d = dealOf(c);
  return layout(
    `${d.name} | SugarLike: Opportunities`,
    `<div class="sg-record-head"><a class="sg-back" href="/app/?module=Opportunities&action=index">Return to List</a> <span class="sg-crumb">Opportunities — <b>${esc(d.name)}</b></span>
      <a class="sg-btn-link" href="/app/?module=Opportunities&action=EditView&record=${dealId(c.id)}">Edit</a></div>
    <section class="sg-card">
      <table class="sg-user-card">
        ${userRow('Opportunity Name', d.name, 'deal_name')}
        ${userRow('Customer', d.customer, 'customer_name')}
        ${userRow('Sales Stage', d.stage, 'stage')}
        ${userRow('Amount', d.amount, 'amount')}
        ${userRow('Lead Source', d.source, 'lead_source')}
        ${userRow('Type', d.type, 'lead_type')}
        ${userRow('Expected Close Date', d.close, 'close_date')}
        ${userRow('Assigned to', d.owner, 'salesperson')}
        ${userRow('Vehicle of Interest', d.vehicle, 'vehicle')}
        ${userRow('VIN', d.vin, 'vin')}
        ${userRow('Stock #', d.stock, 'stock_number')}
        ${userRow('Date Created', d.created, 'created_date')}
      </table>
    </section>`,
  );
};

// The CRM's own users (Dolibarr-style user cards): a paged table whose
// logins link to the user's card, with an "Access rights" page as a tab.
const USERS_PAGE = 3;
const usersList = (offset) => {
  const page = employees.slice(offset - 1, offset - 1 + USERS_PAGE);
  const pager = (o, label) =>
    o >= 1 && o <= employees.length ? `<a class="sg-pager" href="/app/?module=Users&action=index&list_offset=${o}&list_limit=${USERS_PAGE}">${label}</a>` : `<span class="sg-pager sg-disabled">${label}</span>`;
  return layout(
    'SugarLike: Users',
    `<h1 class="sg-title">Users</h1>
    <div class="sg-toolbar">
      <span>${employees.length} users</span>
      ${pager(offset - USERS_PAGE, '‹ Prev')} ${pager(offset + USERS_PAGE, 'Next ›')}
      <a class="sg-btn-link" href="/app/?module=Users&action=EditView">Create</a>
    </div>
    <table class="sg-table" id="users-table">
      <thead><tr><th>Login</th><th>Name</th><th>Email</th><th>Phone</th><th>Group</th><th>Status</th><th>Last login</th></tr></thead>
      <tbody>
      ${page
        .map(
          (e, i) => `<tr class="${i % 2 ? 'odd' : 'even'}">
        <td><a class="of-link" href="/app/?action=DetailView&module=Users&record=${userId(e.id)}">${esc(e.login)}</a></td>
        <td>${esc(e.first)} ${esc(e.last)}</td>
        <td>${esc(e.email)}</td>
        <td>${esc(e.phone)}</td>
        <td>${esc(e.group)}</td>
        <td><span class="sg-badge sg-badge--${e.status.toLowerCase()}">${esc(e.status)}</span></td>
        <td>${esc(e.lastLogin)}</td>
      </tr>`,
        )
        .join('')}
      </tbody>
    </table>`,
  );
};

const userTabs = (e, current) =>
  `<div class="sg-tabs">
    <a class="sg-tab${current === 'card' ? ' sg-tab--current' : ''}" href="/app/?action=DetailView&module=Users&record=${userId(e.id)}">User card</a>
    <a class="sg-tab${current === 'rights' ? ' sg-tab--current' : ''}" href="/app/?action=Rights&module=Users&record=${userId(e.id)}">Access rights</a>
  </div>`;
const userRow = (label, value, key) =>
  `<tr class="sg-user-row"><td class="sg-user-label">${esc(label)}</td><td class="sg-user-value" data-key="${key}">${esc(value)}</td></tr>`;
const userHead = (e, tab) =>
  `<div class="sg-record-head"><a class="sg-back" href="/app/?module=Users&action=index">Back to list</a> <span class="sg-crumb">Users — <b>${esc(e.login)}</b></span>
    <a class="sg-btn-link" href="/app/?module=Users&action=EditView&record=${userId(e.id)}">Modify</a></div>
  ${userTabs(e, tab)}`;
const userDetail = (e) =>
  layout(
    `${e.login} | SugarLike: Users`,
    `${userHead(e, 'card')}
    <section class="sg-card">
      <table class="sg-user-card">
        ${userRow('Login', e.login, 'login')}
        ${userRow('Last name', e.last, 'last_name')}
        ${userRow('First name', e.first, 'first_name')}
        ${userRow('Job position', e.title, 'job_title')}
        ${userRow('Email', e.email, 'email')}
        ${userRow('Phone (pro)', e.phone, 'phone_work')}
        ${userRow('Mobile', e.mobile, 'phone_mobile')}
        ${userRow('Department', e.department, 'department')}
        ${userRow('Hierarchical responsible', e.supervisor, 'supervisor')}
        ${userRow('Status', e.status, 'status')}
        ${userRow('Date employment start', e.hired, 'hire_date')}
        ${userRow('Previous connection', e.lastLogin, 'last_login')}
      </table>
    </section>`,
  );
const userRights = (e) =>
  layout(
    `${e.login} - Access rights | SugarLike: Users`,
    `${userHead(e, 'rights')}
    <section class="sg-card">
      <table class="sg-user-card">
        ${userRow('User group', e.group, 'role')}
        ${userRow('Administrator', e.group === 'Administrators' ? 'Yes' : 'No', 'is_admin')}
        ${userRow('Can export', e.group === 'Administrators' || e.group === 'Finance' ? 'Yes' : 'No', 'can_export')}
      </table>
    </section>`,
  );

// Tabs that are pages of their own (Dolibarr-style): the record and its Addresses page.
const recordTabs = (customer, current) =>
  `<div class="sg-tabs">
    <a class="sg-tab${current === 'detail' ? ' sg-tab--current' : ''}" href="/app/?action=DetailView&module=Contacts&record=${recordId(customer.id)}">Details</a>
    <a class="sg-tab${current === 'addresses' ? ' sg-tab--current' : ''}" href="/app/?action=Addresses&module=Contacts&record=${recordId(customer.id)}">Addresses</a>
  </div>`;

// The record page is a shell; sugar-app.js fetches the data and renders it.
const contactDetail = (customer) =>
  layout(
    `${customer.first} ${customer.last} | SugarLike: Contacts`,
    `<div class="sg-record-head"><a class="sg-back" href="/app/?module=Contacts&action=index">Return to List</a> <span class="sg-crumb">Contacts — <b id="record-name">${esc(customer.first)} ${esc(customer.last)}</b></span>
      <a class="sg-btn-link" href="/app/?module=Contacts&action=EditView&record=${recordId(customer.id)}">Edit</a></div>
    ${recordTabs(customer, 'detail')}
    <div id="record-body" class="sg-loading">Loading…</div>`,
    `<script>window.SG_RECORD = { module: 'Contacts', id: ${JSON.stringify(recordId(customer.id))} };</script>`,
  );

// A tab of the record that is a page of its own.
const contactAddresses = (customer) =>
  layout(
    `${customer.first} ${customer.last} - Addresses | SugarLike: Contacts`,
    `<div class="sg-record-head"><a class="sg-back" href="/app/?module=Contacts&action=index">Return to List</a> <span class="sg-crumb">Contacts — <b id="record-name">${esc(customer.first)} ${esc(customer.last)}</b></span></div>
    ${recordTabs(customer, 'addresses')}
    <section class="sg-card sg-fields">
      <div class="of-field"><div class="of-field-main-label"><label class="of-field-label">Mailing Street</label></div><div class="of-field-body"><div class="of-field-inner"><div class="of-field-content-text" data-key="mailing_street">${esc(customer.street)}</div></div></div></div>
      <div class="of-field"><div class="of-field-main-label"><label class="of-field-label">Mailing City</label></div><div class="of-field-body"><div class="of-field-inner"><div class="of-field-content-text" data-key="mailing_city">${esc(customer.city)}</div></div></div></div>
      <div class="of-field"><div class="of-field-main-label"><label class="of-field-label">Mailing Postal Code</label></div><div class="of-field-body"><div class="of-field-inner"><div class="of-field-content-text" data-key="mailing_zip">${esc(customer.zip)}</div></div></div></div>
      <div class="of-field"><div class="of-field-main-label"><label class="of-field-label">Country</label></div><div class="of-field-body"><div class="of-field-inner"><div class="of-field-content-text" data-key="country">USA</div></div></div></div>
    </section>`,
  );

const emailDetail = (customer, i) =>
  layout(
    `${customer.emails[i].subject} | SugarLike: Emails`,
    `<div class="sg-record-head"><span class="sg-crumb">Emails — <b>${esc(customer.emails[i].subject)}</b></span></div>
    <div id="record-body" class="sg-loading">Loading…</div>`,
    `<script>window.SG_RECORD = { module: 'Emails', id: ${JSON.stringify(emailId(customer, i))} };</script>`,
  );

// API shape behind the record pages.
const contactApi = (c) => ({
  firstName: c.first,
  lastName: c.last,
  account: DEALER.name,
  title: c.source === 'Walk-in' ? 'Owner' : 'Buyer',
  email: c.email,
  phoneWork: c.work,
  phoneHome: c.home,
  phoneMobile: c.cell,
  owner: c.salesperson,
  created: c.created,
  leadSource: c.source,
  status: c.status,
  address: { street: c.street, city: c.city, state: c.state, zip: c.zip },
  activities: c.calls.map((k) => ({ subject: k.outcome, at: k.at, direction: k.dir === 'in' ? 'Inbound' : 'Outbound', duration: k.duration, notes: k.notes })),
  history: [
    ...c.emails.map((e, i) => ({ kind: 'email', id: emailId(c, i), subject: e.subject, status: e.dir === 'in' ? 'Received' : 'Sent', at: e.at, user: e.from })),
    ...c.notes.map((n) => ({ kind: 'note', id: null, subject: n.text, status: 'Note', at: n.at, user: n.author })),
  ],
  texts: c.texts.map((t) => ({ at: t.at, direction: t.dir === 'in' ? 'inbound' : 'outbound', from: t.from, body: t.body })),
});
const emailApi = (c, i) => {
  const e = c.emails[i];
  const inbound = e.dir === 'in';
  return {
    subject: e.subject,
    from: inbound ? `${c.first} ${c.last} <${c.email}>` : `${e.from} <${DEALER.email}>`,
    to: inbound ? `${e.from} <${DEALER.email}>` : `${c.first} ${c.last} <${c.email}>`,
    date: e.at,
    status: inbound ? 'Received' : 'Sent',
    body: `${e.body}\n\nRegards,\n${inbound ? `${c.first} ${c.last}` : e.from}`,
  };
};

export function createSugarHandler() {
  return (req, res, url) => {
    const { pathname, searchParams } = url;
    const cookies = parseCookies(req);
    if (pathname === '/auth/demo' && req.method === 'POST') {
      res.writeHead(204, { 'set-cookie': 'sg_session=demo; Path=/; SameSite=Lax' });
      return res.end();
    }
    if (pathname === '/app/timezone' && req.method === 'POST') {
      return redirect(res, '/app/', { 'set-cookie': 'sg_tz=ok; Path=/; SameSite=Lax' });
    }
    if (pathname.startsWith('/api/')) {
      if (cookies.sg_session !== 'demo') return json(res, { error: 'unauthorized' }, 401);
      const contact = pathname.match(/^\/api\/contacts\/([^/]+)$/);
      if (contact) {
        const c = findCustomer(numericId(contact[1]));
        return c ? json(res, contactApi(c)) : json(res, { error: 'not found' }, 404);
      }
      const email = pathname.match(/^\/api\/emails\/([^/]+)$/);
      if (email) {
        const n = numericId(email[1]);
        const c = findCustomer(Math.floor(n / 10));
        return c?.emails[n % 10] ? json(res, emailApi(c, n % 10)) : json(res, { error: 'not found' }, 404);
      }
      return json(res, { error: 'not found' }, 404);
    }
    if (pathname === '/') return redirect(res, '/app/');
    if (pathname !== '/app/') return notFound(res);
    if (cookies.sg_session !== 'demo') return html(res, signingIn());
    if (cookies.sg_tz !== 'ok') return html(res, timezonePage(url.pathname + url.search));

    const module = searchParams.get('module') || 'Home';
    const action = searchParams.get('action') || 'index';
    if (module === 'Home') return html(res, home());
    if (module === 'Contacts' && action === 'index') return html(res, contactsList(Number(searchParams.get('list_offset') || 1)));
    if (module === 'Contacts' && action === 'DetailView') {
      const c = findCustomer(numericId(searchParams.get('record')));
      return c ? html(res, contactDetail(c)) : notFound(res);
    }
    if (module === 'Opportunities' && action === 'index') return html(res, dealsList());
    if (module === 'Opportunities' && action === 'DetailView') {
      const c = findCustomer(numericId(searchParams.get('record')));
      return c ? html(res, dealDetail(c)) : notFound(res);
    }
    if (module === 'Users' && action === 'index') return html(res, usersList(Number(searchParams.get('list_offset') || 1)));
    if (module === 'Users' && (action === 'DetailView' || action === 'Rights')) {
      const e = findEmployee(numericId(searchParams.get('record')));
      return e ? html(res, action === 'Rights' ? userRights(e) : userDetail(e)) : notFound(res);
    }
    if (module === 'Contacts' && action === 'Addresses') {
      const c = findCustomer(numericId(searchParams.get('record')));
      return c ? html(res, contactAddresses(c)) : notFound(res);
    }
    if (module === 'Emails' && action === 'DetailView') {
      const n = numericId(searchParams.get('record'));
      const c = findCustomer(Math.floor(n / 10));
      return c?.emails[n % 10] ? html(res, emailDetail(c, n % 10)) : notFound(res);
    }
    if (action === 'EditView') return html(res, layout('SugarLike: Edit', '<p class="sg-muted">Editing is disabled in the mock.</p>'));
    return html(res, layout(`SugarLike: ${module}`, `<h1 class="sg-title">${esc(module)}</h1><p class="sg-muted">Nothing to show in the mock.</p>`));
  };
}
