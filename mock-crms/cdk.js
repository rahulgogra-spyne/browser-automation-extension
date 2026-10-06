// Mock of a CDK/eLeads-style CRM (not the real product): a login page, then a
// single-page app with hash routes whose data arrives from a JSON API after
// the page loads.
import { randomBytes } from 'node:crypto';
import { DEALER, customers, findCustomer } from './data.js';
import { esc, html, json, redirect, notFound, parseCookies, readForm } from './http-utils.js';

// Mock-only sign-in. Override with MOCK_CDK_USER / MOCK_CDK_PASSWORD.
export const MOCK_CDK_USER = process.env.MOCK_CDK_USER || 'demo.sales';
export const MOCK_CDK_PASSWORD = process.env.MOCK_CDK_PASSWORD || 'mock-crm-2026';

const loginPage = (error) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in - CDK Drive CRM (mock)</title><link rel="stylesheet" href="/assets/cdk.css"></head>
<body class="cdk-login">
  <form class="cdk-login__form" method="post" action="/login">
    <h1>CDK Drive CRM <small>(mock)</small></h1>
    ${error ? '<p class="cdk-login__error">Wrong user name or password.</p>' : ''}
    <label for="username">User name</label>
    <input id="username" name="username" autocomplete="username">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;

const appShell = (layout) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>CDK Drive CRM (mock)</title><link rel="stylesheet" href="/assets/cdk.css"></head>
<body class="cdk-app">
  <div class="cdk-topbar">
    <span class="cdk-topbar__brand">CDK Drive CRM <small>(mock)</small></span>
    <span class="cdk-topbar__store">${esc(DEALER.name)}</span>
    <nav class="cdk-mainnav">
      <a href="#/customers">Customers</a>
      <a href="#/tasks">Tasks</a>
      <a href="#/reports">Reports</a>
      <a href="/logout">Log out</a>
    </nav>
  </div>
  <main id="app-root" class="cdk-main"></main>
  <script>window.CDK_LAYOUT = ${Number(layout)};</script>
  <script src="/assets/cdk-app.js"></script>
</body>
</html>`;

// API shape: what a CRM backend might return.
const summary = (c) => ({ id: c.id, firstName: c.first, lastName: c.last, mobile: c.cell, status: c.status, assignedTo: c.salesperson });
const detail = (c) => ({
  id: c.id,
  firstName: c.first,
  lastName: c.last,
  email: c.email,
  phones: { mobile: c.cell, home: c.home, work: c.work },
  address: { street: c.street, city: c.city, state: c.state, postalCode: c.zip },
  vehicleOfInterest: c.vehicle,
  opportunity: { source: c.source, status: c.status, assignedTo: c.salesperson, created: c.created },
  communications: [
    ...c.texts.map((t) => ({ channel: 'sms', at: t.at, direction: t.dir === 'in' ? 'inbound' : 'outbound', author: t.from, text: t.body })),
    ...c.emails.map((e) => ({ channel: 'email', at: e.at, direction: e.dir === 'in' ? 'inbound' : 'outbound', author: e.from, subject: e.subject, text: e.body })),
    ...c.calls.map((k) => ({ channel: 'call', at: k.at, direction: k.dir === 'in' ? 'inbound' : 'outbound', author: k.dir === 'in' ? `${c.first} ${c.last}` : c.salesperson, text: `${k.outcome} (${k.duration})${k.notes ? `. ${k.notes}` : ''}` })),
  ],
  notes: c.notes,
});

export function createCdkHandler(state) {
  const sessions = new Set();
  const signedIn = (req) => sessions.has(parseCookies(req).cdk_session);

  return async (req, res, url) => {
    const { pathname, searchParams } = url;
    if (pathname === '/') return redirect(res, '/login');
    if (pathname === '/login' && req.method === 'GET') return html(res, loginPage(searchParams.has('error')));
    if (pathname === '/login' && req.method === 'POST') {
      const form = await readForm(req);
      if (form.username !== MOCK_CDK_USER || form.password !== MOCK_CDK_PASSWORD) return redirect(res, '/login?error=1');
      const token = randomBytes(16).toString('hex');
      sessions.add(token);
      return redirect(res, '/elead/app.html#/customers', { 'set-cookie': `cdk_session=${token}; HttpOnly; Path=/; SameSite=Lax` });
    }
    if (pathname === '/logout') {
      sessions.delete(parseCookies(req).cdk_session);
      return redirect(res, '/login', { 'set-cookie': 'cdk_session=; Path=/; Max-Age=0' });
    }
    if (pathname === '/elead/app.html') return signedIn(req) ? html(res, appShell(state.layout)) : redirect(res, '/login');
    if (pathname.startsWith('/api/')) {
      if (!signedIn(req)) return json(res, { error: 'unauthorized' }, 401);
      if (pathname === '/api/customers') return json(res, customers.map(summary));
      const match = pathname.match(/^\/api\/customers\/(\d+)$/);
      const customer = match && findCustomer(match[1]);
      return customer ? json(res, detail(customer)) : json(res, { error: 'not found' }, 404);
    }
    return notFound(res);
  };
}
