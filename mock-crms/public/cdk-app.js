// Client side of the mock CDK-style CRM: a hash-routed single-page app that
// fetches each customer from the API and renders after a short delay.
(function () {
  // Layout 2 simulates a CRM release: new class names, no data-field
  // attributes, a data-dir attribute instead of data-direction, new labels.
  const LAYOUTS = {
    1: {
      field: 'cdk-field', label: 'cdk-field__label', value: 'cdk-field__value', dataAttr: 'data-field',
      feed: 'cdk-timeline', item: 'cdk-timeline__item', itemMod: 'cdk-timeline__item--', dirAttr: 'data-direction',
      meta: 'cdk-timeline__meta', time: 'cdk-timeline__time', author: 'cdk-timeline__author', subject: 'cdk-timeline__subject', text: 'cdk-timeline__text',
      labels: { email: 'Primary Email', mobile: 'Mobile Phone', home: 'Home Phone', work: 'Work Phone' },
      tabs: { profile: 'Profile', communications: 'Communications', notes: 'Notes' },
    },
    2: {
      field: 'ds-field', label: 'ds-field-label', value: 'ds-field-value', dataAttr: null,
      feed: 'activity-feed', item: 'activity', itemMod: 'activity--', dirAttr: 'data-dir',
      meta: 'activity-head', time: 'activity-when', author: 'activity-who', subject: 'activity-title', text: 'activity-body',
      labels: { email: 'Email', mobile: 'Cell', home: 'Home', work: 'Business' },
      tabs: { profile: 'Details', communications: 'Messages & Calls', notes: 'Notes' },
    },
  };
  const L = LAYOUTS[window.CDK_LAYOUT] || LAYOUTS[1];
  const root = document.getElementById('app-root');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // "09/21/2026 10:14 AM" -> "Sep 21, 2026 10:14 AM"
  const prettyDate = (s) => {
    const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/);
    return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}, ${m[3]}${m[4]}` : s;
  };
  const sortKey = (s) => {
    const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s*(AM|PM)?/);
    if (!m) return s;
    const hour = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0);
    return `${m[3]}${m[1]}${m[2]}${String(hour).padStart(2, '0')}${m[5]}`;
  };

  async function api(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('signed out');
    }
    return res.json();
  }

  const field = (label, key, value) =>
    `<div class="${L.field}"><div class="${L.label}">${esc(label)}</div><div class="${L.value}"${L.dataAttr ? ` ${L.dataAttr}="${key}"` : ''}>${esc(value)}</div></div>`;
  const card = (title, body) => `<section class="cdk-card"><h2 class="cdk-card__title">${esc(title)}</h2>${body}</section>`;

  function header(c, tab) {
    const counts = { communications: c.communications.length, notes: c.notes.length };
    const tabs = Object.entries(L.tabs)
      .map(
        ([id, label]) =>
          `<a role="tab" class="cdk-tab${id === tab ? ' cdk-tab--active' : ''}" aria-selected="${id === tab}" href="#/customer/${c.id}/${id}">${esc(label)}${counts[id] !== undefined ? ` <span class="cdk-tab__count">${counts[id]}</span>` : ''}</a>`,
      )
      .join('');
    return `<header class="cdk-customer-header">
        <h1 class="cdk-customer-header__name">${esc(c.firstName)} ${esc(c.lastName)}</h1>
        <span class="cdk-badge">${esc(c.opportunity.status)}</span>
        <span class="cdk-customer-header__id">ID ${c.id}</span>
      </header>
      <nav class="cdk-tabs" role="tablist">${tabs}</nav>`;
  }

  const views = {
    profile: (c) =>
      card(
        'Contact',
        field('First Name', 'firstName', c.firstName) +
          field('Last Name', 'lastName', c.lastName) +
          field(L.labels.email, 'email', c.email) +
          field(L.labels.mobile, 'mobilePhone', c.phones.mobile) +
          field(L.labels.home, 'homePhone', c.phones.home) +
          field(L.labels.work, 'workPhone', c.phones.work) +
          field('Street', 'street', c.address.street) +
          field('City', 'city', c.address.city) +
          field('State', 'state', c.address.state) +
          field('Postal Code', 'postalCode', c.address.postalCode),
      ) +
      card(
        'Vehicle Interest',
        field('Year', 'year', c.vehicleOfInterest.year) +
          field('Make', 'make', c.vehicleOfInterest.make) +
          field('Model', 'model', c.vehicleOfInterest.model) +
          field('VIN', 'vin', c.vehicleOfInterest.vin) +
          field('Stock Number', 'stock', c.vehicleOfInterest.stock),
      ) +
      card(
        'Opportunity',
        field('Source', 'source', c.opportunity.source) +
          field('Status', 'status', c.opportunity.status) +
          field('Assigned To', 'assignedTo', c.opportunity.assignedTo) +
          field('Created', 'created', c.opportunity.created),
      ),

    communications: (c) => {
      const items = [...c.communications].sort((a, b) => (sortKey(a.at) < sortKey(b.at) ? 1 : -1));
      if (!items.length) return card('Communications', '<p class="cdk-empty">No communications yet.</p>');
      return card(
        'Communications',
        `<ol class="${L.feed}">${items
          .map(
            (m) => `<li class="${L.item} ${L.itemMod}${m.channel}" ${L.dirAttr}="${m.direction}">
              <div class="${L.meta}"><time class="${L.time}">${esc(prettyDate(m.at))}</time> · <span class="${L.author}">${esc(m.author)}</span></div>
              ${m.subject ? `<div class="${L.subject}">${esc(m.subject)}</div>` : ''}
              <p class="${L.text}">${esc(m.text)}</p>
            </li>`,
          )
          .join('')}</ol>`,
      );
    },

    notes: (c) =>
      card(
        'Notes',
        c.notes.length
          ? `<ul class="cdk-notes">${c.notes
              .map(
                (n) => `<li class="cdk-note"><span class="cdk-note__author">${esc(n.author)}</span> <time class="cdk-note__date">${esc(prettyDate(n.at))}</time><p class="cdk-note__text">${esc(n.text)}</p></li>`,
              )
              .join('')}</ul>`
          : '<p class="cdk-empty">No notes.</p>',
      ),
  };

  async function showCustomer(id, tab) {
    root.innerHTML = '<div class="cdk-loading">Loading customer…</div>';
    const c = await api(`/api/customers/${id}`);
    await delay(250);
    if (location.hash !== `#/customer/${id}/${tab}`) return; // user moved on
    root.innerHTML = header(c, tab) + views[tab](c);
  }

  async function showList() {
    root.innerHTML = '<div class="cdk-loading">Loading customers…</div>';
    const list = await api('/api/customers');
    root.innerHTML = card(
      'Customers',
      `<table class="cdk-table"><thead><tr><th>Name</th><th>Mobile</th><th>Status</th><th>Assigned To</th></tr></thead><tbody>${list
        .map(
          (c) => `<tr><td><a href="#/customer/${c.id}/profile">${esc(c.lastName)}, ${esc(c.firstName)}</a></td><td>${esc(c.mobile)}</td><td>${esc(c.status)}</td><td>${esc(c.assignedTo)}</td></tr>`,
        )
        .join('')}</tbody></table>`,
    );
  }

  function route() {
    const hash = location.hash || '#/customers';
    const customer = hash.match(/^#\/customer\/(\d+)\/(profile|communications|notes)$/);
    if (customer) return showCustomer(customer[1], customer[2]);
    if (hash === '#/customers') return showList();
    if (hash === '#/tasks') return (root.innerHTML = card('Tasks', '<p class="cdk-empty">No open tasks in the mock.</p>'));
    if (hash === '#/reports') return (root.innerHTML = card('Reports', '<p class="cdk-empty">No reports in the mock.</p>'));
    root.innerHTML = card('Not found', '<p class="cdk-empty">Unknown page.</p>');
  }

  window.addEventListener('hashchange', route);
  route();
})();
