// Mock of a VinSolutions-style CRM (not the real product): a shell page with
// the working area in an iframe, ASP.NET-style element ids, a Telerik-like
// tab strip, and tab panels rendered by script only when clicked.
import { DEALER, customers, findCustomer } from './data.js';
import { esc, html, redirect, notFound } from './http-utils.js';

// Layout 2 simulates a CRM release: new element ids, class names, labels and
// tab names. Configs mapped against layout 1 break on it.
const LAYOUTS = {
  1: {
    P: 'ctl00_ContentPlaceHolder1_',
    labels: { name: 'Name:', cell: 'Cell Phone:', home: 'Home Phone:', work: 'Work Phone:', email: 'E-Mail:' },
    sms: { thread: 'sms-thread', bubble: 'sms-bubble', in: 'sms-inbound', out: 'sms-outbound', meta: 'sms-meta', time: 'sms-time', sender: 'sms-sender', text: 'sms-text' },
    tabs: { general: 'General', texting: 'Texting', email: 'Email', calls: 'Calls', notes: 'Notes' },
  },
  2: {
    P: 'ctl00_MainContent_ucCustomerInfo_',
    labels: { name: 'Customer:', cell: 'Mobile:', home: 'Home #:', work: 'Business:', email: 'Email Address:' },
    sms: { thread: 'conv-list', bubble: 'conv-msg', in: 'conv-msg--in', out: 'conv-msg--out', meta: 'conv-head', time: 'conv-when', sender: 'conv-who', text: 'conv-body' },
    tabs: { general: 'Overview', texting: 'Text Messages', email: 'Emails', calls: 'Phone Calls', notes: 'Notes' },
  },
};

const shell = (title, frameSrc) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(title)} - VinConnect (mock)</title><link rel="stylesheet" href="/assets/vs.css"></head>
<body class="vc-shell">
  <div id="vc-header">
    <span class="vc-logo">VinConnect <small>(mock)</small></span>
    <span class="vc-dealer">${esc(DEALER.name)}</span>
    <span class="vc-user">Signed in as Mike Ross</span>
  </div>
  <div id="vc-nav">
    <a href="/vinconnect/">Leads</a>
    <a href="/vinconnect/?view=desking">Desking</a>
    <a href="/vinconnect/?view=reports">Reports</a>
  </div>
  <iframe id="cardashboardframe" name="cardashboardframe" src="${esc(frameSrc)}"></iframe>
</body>
</html>`;

const framePage = (title, body) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="/assets/vs.css"></head>
<body class="vc-frame">${body}</body>
</html>`;

const leadsList = () =>
  framePage(
    'Active Leads',
    `<h2 class="page-title">Active Leads</h2>
    <table class="rgMasterTable" id="ctl00_ContentPlaceHolder1_gridLeads">
      <thead><tr><th>Customer</th><th>Phone</th><th>Source</th><th>Status</th><th>Sales Rep</th><th>Created</th></tr></thead>
      <tbody>${customers
        .map(
          (c, i) => `<tr class="${i % 2 ? 'rgAltRow' : 'rgRow'}">
          <td><a target="_top" href="/vinconnect/customer?GlobalCustomerID=${c.id}">${esc(c.last.toUpperCase())}, ${esc(c.first.toUpperCase())}</a></td>
          <td>${esc(c.cell)}</td><td>${esc(c.source)}</td><td>${esc(c.status)}</td><td>${esc(c.salesperson)}</td><td>${esc(c.created)}</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table>`,
  );

function dashboard(customer, layout) {
  const L = LAYOUTS[layout];
  const count = { texting: customer.texts.length, email: customer.emails.length, calls: customer.calls.length, notes: customer.notes.length };
  const tabs = Object.entries(L.tabs)
    .map(
      ([id, label], i) => `<li class="rtsLI"><a class="rtsLink${i === 0 ? ' rtsSelected' : ''}" href="javascript:void(0)" onclick="VS.showTab('${id}', this)"><span class="rtsTxt">${esc(label)}${count[id] !== undefined ? ` (${count[id]})` : ''}</span></a></li>`,
    )
    .join('');
  return framePage(
    'Customer Dashboard',
    `<div id="custHeader" class="cust-header">
      <span class="cust-name" id="${L.P}lblHeaderName">${esc(customer.first)} ${esc(customer.last)}</span>
      <span class="cust-meta">Customer #${customer.id} · ${esc(DEALER.name)}</span>
    </div>
    <div class="RadTabStrip" id="${L.P}tabStrip"><ul class="rtsUL">${tabs}</ul></div>
    <div id="${L.P}pnlTabContent" class="tab-content"></div>
    <script>window.VS_DATA = ${JSON.stringify(customer).replace(/</g, '\\u003c')}; window.VS_LAYOUT = ${JSON.stringify(L)};</script>
    <script src="/assets/vs-dashboard.js"></script>`,
  );
}

const placeholder = (title) => framePage(title, `<h2 class="page-title">${esc(title)}</h2><p>Nothing to show in the mock.</p>`);

export function createVinSolutionsHandler(state) {
  return (req, res, url) => {
    const { pathname, searchParams } = url;
    if (pathname === '/') return redirect(res, '/vinconnect/');
    if (pathname === '/vinconnect/') {
      const view = searchParams.get('view');
      const src =
        view === 'desking'
          ? '/CarDashboard/Pages/Desking/Desk.aspx'
          : view === 'reports'
            ? '/CarDashboard/Pages/Reports/Reports.aspx'
            : '/CarDashboard/Pages/LeadManagement/ActiveLeads.aspx';
      return html(res, shell('Leads', src));
    }
    if (pathname === '/vinconnect/customer') {
      const id = searchParams.get('GlobalCustomerID');
      if (!findCustomer(id)) return notFound(res);
      return html(res, shell('Customer', `/CarDashboard/Pages/CRM/CustomerDashboard.aspx?GlobalCustomerID=${encodeURIComponent(id)}`));
    }
    if (pathname === '/CarDashboard/Pages/LeadManagement/ActiveLeads.aspx') return html(res, leadsList());
    if (pathname === '/CarDashboard/Pages/Desking/Desk.aspx') return html(res, placeholder('Desking'));
    if (pathname === '/CarDashboard/Pages/Reports/Reports.aspx') return html(res, placeholder('Reports'));
    if (pathname === '/CarDashboard/Pages/CRM/CustomerDashboard.aspx') {
      const customer = findCustomer(searchParams.get('GlobalCustomerID'));
      if (!customer) return notFound(res);
      return html(res, dashboard(customer, state.layout));
    }
    return notFound(res);
  };
}
