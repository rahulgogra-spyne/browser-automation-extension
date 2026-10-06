// Client side of the mock VinSolutions customer dashboard: renders a tab's
// panel only when that tab is clicked, like the real app's partial postbacks.
(function () {
  const D = window.VS_DATA;
  const L = window.VS_LAYOUT;
  const P = L.P;
  const S = L.sms;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const row = (label, valueHtml) => `<tr><td class="label">${esc(label)}</td><td class="data">${valueHtml}</td></tr>`;
  const span = (id, value) => `<span id="${P}${id}">${esc(value)}</span>`;
  const panel = (title, body) => `<div class="panel"><h3 class="panel-title">${esc(title)}</h3>${body}</div>`;
  const empty = (what) => `<p class="empty">No ${what}.</p>`;

  const tabs = {
    general: () =>
      panel(
        'Customer Information',
        `<table class="infoTable">
          ${row(L.labels.name, span('lblCustomerName', `${D.last.toUpperCase()}, ${D.first.toUpperCase()}`))}
          ${row(L.labels.cell, span('lblCellPhone', D.cell))}
          ${row(L.labels.home, span('lblHomePhone', D.home))}
          ${row(L.labels.work, span('lblWorkPhone', D.work))}
          ${row(L.labels.email, `<a id="${P}lnkEmail" href="mailto:${esc(D.email)}">${esc(D.email)}</a>`)}
          ${row('Address:', `${span('lblAddress1', D.street)}<br>${span('lblCityStateZip', `${D.city}, ${D.state} ${D.zip}`)}`)}
        </table>`,
      ) +
      panel(
        'Vehicle of Interest',
        `<table class="infoTable">
          ${row('Vehicle:', span('lblVehicle', `${D.vehicle.year} ${D.vehicle.make} ${D.vehicle.model}`))}
          ${row('VIN:', span('lblVin', D.vehicle.vin))}
          ${row('Stock #:', span('lblStock', D.vehicle.stock))}
        </table>`,
      ) +
      panel(
        'Lead Information',
        `<table class="infoTable">
          ${row('Lead Source:', span('lblSource', D.source))}
          ${row('Lead Status:', span('lblStatus', D.status))}
          ${row('Sales Rep:', span('lblSalesRep', D.salesperson))}
          ${row('Created:', span('lblCreated', D.created))}
        </table>`,
      ),

    texting: () =>
      panel(
        'Text Messages',
        D.texts.length
          ? `<div class="${S.thread}" id="${P}divSmsThread">${D.texts
              .map(
                (t) => `<div class="${S.bubble} ${t.dir === 'in' ? S.in : S.out}">
                  <div class="${S.meta}"><span class="${S.time}">${esc(t.at)}</span> <span class="${S.sender}">${esc(t.from)}</span></div>
                  <div class="${S.text}">${esc(t.body)}</div>
                </div>`,
              )
              .join('')}</div>`
          : empty('text messages'),
      ),

    email: () =>
      panel(
        'Email History',
        D.emails.length
          ? `<table class="rgMasterTable" id="${P}gridEmails">
              <thead><tr><th>Date</th><th>Direction</th><th>From</th><th>Subject</th><th>Message</th></tr></thead>
              <tbody>${D.emails
                .map(
                  (e, i) => `<tr class="${i % 2 ? 'rgAltRow' : 'rgRow'}"><td>${esc(e.at)}</td><td>${e.dir === 'in' ? 'Inbound' : 'Outbound'}</td><td>${esc(e.from)}</td><td>${esc(e.subject)}</td><td>${esc(e.body)}</td></tr>`,
                )
                .join('')}</tbody>
            </table>`
          : empty('emails'),
      ),

    calls: () =>
      panel(
        'Call Log',
        D.calls.length
          ? `<ul class="call-log">${D.calls
              .map(
                (c) => `<li class="call-entry">
                  <span class="call-date">${esc(c.at)}</span>
                  <span class="call-dir">${c.dir === 'in' ? 'Inbound call' : 'Outbound call'}</span>
                  <span class="call-duration">${esc(c.duration)}</span>
                  <span class="call-result">${esc(c.outcome)}</span>
                  <div class="call-notes">${esc(c.notes)}</div>
                </li>`,
              )
              .join('')}</ul>`
          : empty('calls'),
      ),

    notes: () =>
      panel(
        'Notes',
        D.notes.length
          ? `<div class="notes-list">${D.notes
              .map(
                (n) => `<div class="note">
                  <div class="note-hdr"><b class="note-author">${esc(n.author)}</b> - <span class="note-date">${esc(n.at)}</span></div>
                  <p class="note-body">${esc(n.text)}</p>
                </div>`,
              )
              .join('')}</div>`
          : empty('notes'),
      ),
  };

  window.VS = {
    showTab(name, link) {
      document.querySelectorAll('.rtsLink').forEach((a) => a.classList.toggle('rtsSelected', a === link));
      document.getElementById(`${P}pnlTabContent`).innerHTML = tabs[name]();
    },
  };
  window.VS.showTab('general', document.querySelector('.rtsLink'));
})();
