// Client side of the SugarCRM-family mock: a script-driven main menu, and
// record pages that fetch their data and render about a second after load.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Menu items navigate from a listener: nothing in the markup says where.
  document.querySelectorAll('.sg-menu-item').forEach((item) => {
    item.addEventListener('click', () => {
      const module = item.dataset.module;
      location.href = module === 'Home' ? '/app/' : `/app/?module=${module}&action=index`;
    });
  });

  const record = window.SG_RECORD;
  if (!record) return;
  const body = document.getElementById('record-body');
  const field = (label, value, key) =>
    `<div class="of-field${label ? '' : ' of--label-empty'}">${label ? `<div class="of-field-main-label"><label class="of-field-label">${esc(label)}</label></div>` : ''}<div class="of-field-body"><div class="of-field-inner"><div class="of-field-content-text" data-key="${key}">${esc(value)}</div></div></div></div>`;
  const panel = (name, open, inner) =>
    `<div class="subpanel-outer ${name.replace(/\s/g, '')}" id="sp${Math.floor(Math.random() * 1e8)}">
      <div class="subpanel-title"><button type="button" class="subpanel-toggle" aria-expanded="${open}" aria-label="${open ? 'collapse' : 'expand'} ${esc(name)}"><h2 class="subpanel-title-label"><span class="subpanel-title-text">${esc(name)}</span></h2></button></div>
      <div class="subpanel-body"${open ? '' : ' hidden'}>${inner}</div>
    </div>`;
  const table = (headers, rows) =>
    rows.length
      ? `<div class="of-data-table"><div class="of-data-table-row of-data-table-header">${headers.map((h) => `<div class="field-value">${esc(h)}</div>`).join('')}</div>${rows.join('')}</div>`
      : '<p class="sg-muted">No results</p>';

  const render = {
    Contacts: (c) => `
      <section class="sg-card sg-fields">
        ${field('', c.firstName, 'first_name')}${field('', c.lastName, 'last_name')}${field('', c.account, 'account')}${field('', c.title, 'title')}
        ${field('Email Primary', c.email, 'email')}${field('Phone Work', c.phoneWork, 'phone_work')}${field('Phone Home', c.phoneHome, 'phone_home')}${field('Phone Mobile', c.phoneMobile, 'phone_mobile')}
        ${field('Lead Source', c.leadSource, 'lead_source')}${field('Status', c.status, 'status')}${field('Assigned to', c.owner, 'owner')}${field('Created', c.created, 'created')}
        ${field('Primary Address', `${c.address.street}\n${c.address.city}, ${c.address.state} ${c.address.zip}\nUSA`, 'address')}
      </section>
      <div class="subpanels">
        ${panel('Activities', false, table(['Subject', 'Direction', 'Date', 'Duration', 'Notes'], c.activities.map((a) => `<div class="of-data-table-row"><div class="field-value">${esc(a.subject)}</div><div class="field-value">${esc(a.direction)} call</div><div class="field-value">${esc(a.at)}</div><div class="field-value">${esc(a.duration)}</div><div class="field-value">${esc(a.notes)}</div></div>`)))}
        ${panel('History', true, table(['Subject', 'Status', 'Date', 'User'], c.history.map((h) => `<div class="of-data-table-row row-editable" data-kind="${h.kind}"><div class="field-value">${h.id ? `<a class="of-link" target="_blank" href="/app/?action=DetailView&module=Emails&record=${h.id}">${esc(h.subject)}</a>` : esc(h.subject)}</div><div class="field-value">${esc(h.status)}</div><div class="field-value">${esc(h.at)}</div><div class="field-value">${esc(h.user)}</div></div>`)))}
        ${panel('Text Messages', true, c.texts.length ? `<div class="sg-texts">${c.texts.map((t) => `<div class="sg-text sg-text--${t.direction}"><div class="sg-text-meta"><span class="sg-text-when">${esc(t.at)}</span> <span class="sg-text-who">${esc(t.from)}</span></div><div class="sg-text-body">${esc(t.body)}</div></div>`).join('')}</div>` : '<p class="sg-muted">No results</p>')}
      </div>`,
    Emails: (e) => `
      <section class="sg-card sg-fields">
        ${field('Subject', e.subject, 'subject')}${field('From', e.from, 'from')}${field('To', e.to, 'to')}${field('Date Sent', e.date, 'date')}${field('Status', e.status, 'status')}
      </section>
      <section class="sg-card"><h2>Message</h2><div class="sg-email-body">${e.body.split('\n').map((line) => `<p>${esc(line)}</p>`).join('')}</div></section>`,
  };

  const endpoint = record.module === 'Contacts' ? `/api/contacts/${record.id}` : `/api/emails/${record.id}`;
  setTimeout(async () => {
    const data = await (await fetch(endpoint, { credentials: 'same-origin' })).json();
    body.className = 'sg-record';
    body.innerHTML = render[record.module](data);
    body.querySelectorAll('.subpanel-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(open));
        btn.closest('.subpanel-outer').querySelector('.subpanel-body').hidden = !open;
      });
    });
  }, 1100);
})();
