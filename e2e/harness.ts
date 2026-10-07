// Shared e2e harness: launches Chromium with the built extension, serves fixture pages from a
// local web server (a stand-in for VinSolutions), and opens the side panel as a normal page with
// ?startUrl= so Start runs the flow against a fixture. Mocked runs load the `--mode e2e` build,
// which talks to the fake relay below; live runs load the production build and the real relay
// (server/relay.ts, started by playwright.config.ts).
import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', '.output');
// A real server, not page.route(): the flow's tab is opened by the extension and starts loading
// before Playwright could intercept it, so a routed fake host would load Chrome's error page.
export const ORIGIN = 'http://127.0.0.1:8799';

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;

export const PAGES: Record<string, string> = {
  // Signed out: what a dealer sees before signing in.
  '/app': page('Dealer CRM', `<h1 style="margin:40px 100px">Dealer CRM</h1>
<p style="margin:0 100px">You're signed out. <a href="/login">Sign in</a> to continue.</p>`),
  '/login': page('Sign in', `<h1 style="margin:40px 100px">Sign in</h1>
<input id="user" placeholder="Username" style="position:absolute;left:100px;top:120px;width:300px;height:40px">`),
  // Signed in, with one area this user isn't allowed to see.
  '/dashboard': page('Dealer CRM - Home', `<h1 style="margin:40px 100px">Dealer CRM</h1>
<div style="margin:0 100px;line-height:2">Signed in as Dana Reyes<br>Dealership: Lakeside Honda
<select style="margin-left:8px"><option>Lakeside Honda</option><option>Lakeside Toyota</option><option>Lakeside Kia</option></select><br>
Reports: You don't have permission to view reports.</div>`),
  // The reference front end, served from an origin the extension accepts.
  '/fe': readFileSync(path.resolve(import.meta.dirname, '..', 'fe', 'index.html'), 'utf8'),
  // Tekion-style DMS: the repair-order list sends a signed-out dealer to sign-in (as the real one
  // does), and comes back once they're in (signIn() below). This role can't see RO totals.
  '/tekion/login': page('Tekion ARC Login', `<div style="margin:120px auto;width:300px"><h2>TEKION</h2>
<label>Username <input id="email" placeholder="Type Here" style="display:block;width:100%;height:36px"></label>
<button style="margin-top:12px;width:100%;height:36px">Next</button></div>`),
  '/tekion/ro-list': page('Repair Orders | Tekion', `<div style="padding:16px 24px">
<div style="color:#666">Lakeside Toyota · Service</div>
<h1 style="margin:4px 0">Repair Orders</h1>
<div style="margin-bottom:8px">Showing 6 of 6 · Some columns are hidden for your role.</div>
<table style="border-collapse:collapse;font-size:13px" cellpadding="6" border="1">
<tr><th>RO #</th><th>Status</th><th>Customer</th><th>Vehicle</th><th>VIN</th><th>Advisor</th><th>Opened</th><th>Promised</th></tr>
${[
  ['7314021', 'Open', 'Maria Lopez', '2021 Toyota Camry SE', '4T1G11AK5MU512345', 'J. Patel', '10/02/2026 8:12 AM', '10/02/2026 4:00 PM'],
  ['7314022', 'In Progress', 'Kevin Brooks', '2019 Toyota RAV4 XLE', '2T3P1RFV8KW123456', 'J. Patel', '10/02/2026 8:40 AM', '10/02/2026 2:30 PM'],
  ['7314023', 'Waiting Parts', 'Aisha Khan', '2023 Toyota Tacoma TRD', '3TMCZ5AN1PM654321', 'L. Chen', '10/01/2026 3:05 PM', '10/03/2026 12:00 PM'],
  ['7314024', 'Ready', 'Tom Nguyen', '2020 Toyota Highlander', '5TDGZRBH7LS987654', 'L. Chen', '10/01/2026 9:15 AM', '10/01/2026 5:00 PM'],
  ['7314025', 'Open', 'Priya Shah', '2022 Toyota Corolla LE', 'JTDEPMAE2NJ246810', 'R. Diaz', '10/02/2026 9:02 AM', '10/02/2026 1:00 PM'],
  ['7314026', 'Closed', 'Sam Carter', '2018 Toyota Tundra', '5TFDY5F17JX135791', 'R. Diaz', '09/30/2026 10:20 AM', '09/30/2026 3:00 PM'],
]
  .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
  .join('')}
</table></div>`),
  // Things a read-only run must not do: type, Save, tick a box, accept a confirm, leave the DMS.
  '/guard': page('RO 7314021', `<label style="position:absolute;left:100px;top:100px">Notes <input id="q" style="width:220px;height:40px;box-sizing:border-box"></label>
<button id="save" style="position:absolute;left:420px;top:100px;width:80px;height:40px" onclick="out.textContent='saved'">Save</button>
<label style="position:absolute;left:100px;top:180px"><input id="cb" type="checkbox" style="width:20px;height:20px;margin:0"> Notify customer</label>
<button id="view" style="position:absolute;left:100px;top:235px;width:140px;height:40px" onclick="out.textContent = confirm('Delete this RO?') ? 'deleted' : 'kept'">Next page</button>
<a id="ext" href="https://example.com/" style="position:absolute;left:100px;top:300px">Help center</a>
<button id="details" style="position:absolute;left:100px;top:340px;width:140px;height:40px" onclick="out.textContent='details'">View details</button>
<div id="sh" style="position:absolute;left:300px;top:235px"></div>
<input id="num" type="number" value="3" style="position:absolute;left:520px;top:180px;width:80px;height:30px">
<a id="js" href="javascript:out.textContent='js-ran'" style="position:absolute;left:520px;top:240px">Details</a>
<form id="roform" onsubmit="event.preventDefault();out.textContent='submitted'"></form>
<button id="assoc" form="roform" style="position:absolute;left:520px;top:290px;width:90px;height:30px">Next</button>
<button id="icon" style="position:absolute;left:640px;top:290px;width:30px;height:30px" onclick="out.textContent='icon'"><svg class="trash" width="12" height="12"></svg></button>
<script>document.getElementById('sh').attachShadow({ mode: 'open' }).innerHTML = '<button style="width:100px;height:40px" onclick="out.textContent=\\'shadow-deleted\\'">Delete</button>';</script>
<div id="out" style="position:absolute;left:100px;top:420px"></div>`),
  // Network firewall: the page loads its RO list with a POST by itself; then paging buttons send a
  // search POST it never made while loading, the list POST again, an update POST, and a PUT.
  // Second row: the list POST again for page 2 (same request), the same address with a delete in
  // its body, and a GraphQL mutation to the endpoint the page loaded its list from.
  '/net': page('RO list', `<div id="out" style="position:absolute;left:100px;top:40px"></div>
<div class="pagination">
<button style="position:absolute;left:100px;top:100px;width:140px;height:40px" onclick="fetch('/api/ro/search',{method:'POST',body:'{}'})">Next</button>
<button style="position:absolute;left:260px;top:100px;width:140px;height:40px" onclick="fetch('/api/ro/feed',{method:'POST',body:JSON.stringify({op:'list',page:2})})">Previous</button>
<button style="position:absolute;left:420px;top:100px;width:140px;height:40px" onclick="fetch('/api/ro/7314021/update',{method:'POST',body:'{}'}).then((r)=>out.textContent=r.ok?'updated':'update refused '+r.status,()=>out.textContent='update failed')">2</button>
<button style="position:absolute;left:580px;top:100px;width:140px;height:40px" onclick="fetch('/api/ro/7314021',{method:'PUT',body:'{}'}).then((r)=>out.textContent=r.ok?'put':'put refused '+r.status,()=>out.textContent='put failed')">Load more</button>
<button style="position:absolute;left:100px;top:160px;width:140px;height:40px" onclick="fetch('/api/ro/feed',{method:'POST',body:JSON.stringify({op:'delete',id:7314021})})">3</button>
<button style="position:absolute;left:260px;top:160px;width:140px;height:40px" onclick="fetch('/api/graphql',{method:'POST',body:JSON.stringify({query:'# &quot;\\nmutation Close { closeRo(id: 7314021) { id } }\\n# &quot;'})})">4</button>
</div>
<script>fetch('/api/ro/feed',{method:'POST',body:JSON.stringify({op:'list',page:1})});
fetch('/api/graphql',{method:'POST',body:JSON.stringify({query:'query ROs { repairOrders { id } }',operationName:'ROs'})})</script>`),
  // Click allowlist edge cases: "Next" slotted into a shadow link that closes an RO, an RO number
  // outside any pager, a pager button whose only label is a delete icon, and an Ant Design-style
  // pager item ("Next Page" on the item, an unnamed icon button inside) that really pages.
  '/guard2': page('RO list', `<div id="out" style="position:absolute;left:100px;top:40px">kept</div>
<ds-link style="position:absolute;left:100px;top:100px;display:block"><span style="display:inline-block;width:120px;height:40px">Next</span></ds-link>
<button style="position:absolute;left:260px;top:100px;width:120px;height:40px" onclick="out.textContent='opened RO'">4521</button>
<div class="table-pagination" style="position:absolute;left:420px;top:100px"><button style="width:60px;height:40px" onclick="out.textContent='deleted'"><span role="img" aria-label="delete" style="display:inline-block;width:12px;height:12px"></span></button></div>
<ul class="ant-pagination" style="position:absolute;left:520px;top:100px;margin:0;padding:0;list-style:none"><li title="Next Page" class="ant-pagination-next"><button style="width:60px;height:40px" onclick="out.textContent='paged'"><span role="img" aria-label="right"></span></button></li></ul>
<script>customElements.define('ds-link', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<a href="/ro/12/close"><slot></slot></a>'; } });</script>`),
  // A paging control whose handler goes to an RO's own page instead, which writes as it loads.
  '/net/nav': page('RO list', `<button style="position:absolute;left:100px;top:100px;width:140px;height:40px" onclick="location.href='/net/detail'">Next</button>`),
  '/net/detail': page('RO 7314021', `<p>RO 7314021</p><script>fetch('/api/detail/lock',{method:'POST',body:'{}'})</script>`),
  // Requests from an out-of-process frame (another site: localhost, not 127.0.0.1) and from a
  // worker. Both load something by themselves; after the click, both try to write.
  '/net/frames': page('RO list', `<button style="position:absolute;left:100px;top:100px;width:140px;height:40px" onclick="w.postMessage('go');f.contentWindow.postMessage('go','*')">Next</button>
<iframe id="f" src="http://localhost:8799/net/frame" style="position:absolute;left:100px;top:200px;width:300px;height:100px"></iframe>
<script>const w=new Worker('/net/worker.js');</script>`),
  '/net/frame': page('Frame', `<p>Frame</p><script>fetch('/api/frame/load',{method:'POST',body:'{}'});
addEventListener('message',()=>fetch('/api/frame/write',{method:'POST',body:'{"op":"write"}'}))</script>`),
  // A page to act on.
  '/form': page('Form', `<form id="f" style="position:absolute;left:100px;top:100px">
  <label>Message <input id="q" style="width:300px;height:40px;box-sizing:border-box"></label>
  <button id="send" style="height:40px">Send</button>
</form>
<div id="out" style="position:absolute;left:100px;top:260px"></div>
<script>document.getElementById('f').onsubmit=(e)=>{e.preventDefault();document.getElementById('out').textContent='submitted:'+document.getElementById('q').value}</script>`),
};

export interface Session {
  context: BrowserContext;
  worker: Worker;
  extId: string;
  panel: Page;
  requests: any[];
  /** Each model turn as the panel's socket saw it: sent at (epoch ms), round trip, request size. */
  turns: { at: number; ms: number; kb: number }[];
  /** Queue of replies to `response.create`; a function can inspect the request or hang. */
  replies: (object | ((body: any) => Promise<object | { status: number; body: object }>))[];
}

// Fake relay for mocked runs: answers each `response.create` with the session's next scripted
// reply, as the WebSocket-mode events the real API sends (`response.completed` or `error`).
let current: Session | undefined;
let fake: WebSocketServer | undefined;
function fakeRelay() {
  fake ??= new WebSocketServer({ host: '127.0.0.1', port: 8798 }).on('connection', (ws) =>
    ws.on('message', async (data) => {
      const s = current!;
      const { type: _, ...body } = JSON.parse(String(data));
      s.requests.push(body);
      const next = s.replies.shift();
      if (!next) return ws.send(JSON.stringify({ type: 'error', status: 500, error: { message: 'no scripted reply' } }));
      const out: any = typeof next === 'function' ? await next(body) : next;
      if (out && typeof out.status === 'number' && 'body' in out) {
        return ws.send(JSON.stringify({ type: 'error', status: out.status, error: out.body.error }));
      }
      ws.send(JSON.stringify({ type: 'response.completed', response: out }));
    }),
  );
}

/** Scripts the fixture pages load. */
const SCRIPTS: Record<string, string> = {
  '/net/worker.js': `fetch('/api/worker/load',{method:'POST',body:'{}'});
onmessage=()=>fetch('/api/worker/write',{method:'POST',body:'{"op":"write"}'});`,
};

/** Every /api/* request that reached the fixture server, as "METHOD /path". The firewall test reads it. */
export const apiHits: string[] = [];

let site: Server | undefined;
function fixtureSite() {
  site ??= createServer((req, res) => {
    const path = new URL(req.url ?? '/', ORIGIN).pathname;
    if (path.startsWith('/api/')) {
      apiHits.push(`${req.method} ${path}`);
      return res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end('{"ok":true}');
    }
    if (SCRIPTS[path]) return res.writeHead(200, { 'content-type': 'text/javascript' }).end(SCRIPTS[path]);
    // Tekion: signed out, the list sends you to sign-in; signing in sets the session and returns.
    const signedIn = /(^|;\s*)tekion=1/.test(req.headers.cookie ?? '');
    if (path === '/tekion/ro-list' && !signedIn) return res.writeHead(302, { location: '/tekion/login?redirectTo=/tekion/ro-list' }).end();
    if (path === '/tekion/signin') return res.writeHead(302, { 'set-cookie': 'tekion=1; Path=/', location: '/tekion/ro-list' }).end();
    const body = PAGES[path];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }).end(body ?? 'nope');
  }).listen(8799, '127.0.0.1');
}

/** Launch with the panel aimed at `startPath` on the fixture site; `panel: false` leaves it to the FE to open. */
export async function launch(
  opts: { mockOpenAI?: boolean; startPath?: string; startUrl?: string; panel?: boolean; args?: string[]; passwordManager?: boolean; signedIn?: boolean } = {},
): Promise<Session> {
  // passwordManager: also load a fake one that puts its own iframe into pages, like 1Password does.
  const EXT = [path.join(OUT, opts.mockOpenAI === false ? 'chrome-mv3' : 'chrome-mv3-e2e')];
  if (opts.passwordManager) EXT.push(path.resolve(import.meta.dirname, 'fixtures', 'fake-pm'));
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(process.env.CLAUDE_SCRATCH ?? tmpdir(), 'vin-flow-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${EXT.join(',')}`, `--load-extension=${EXT.join(',')}`, ...(opts.args ?? [])],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extId = new URL(worker.url()).host;

  fixtureSite();
  if (opts.signedIn) await context.addCookies([{ name: 'tekion', value: '1', url: ORIGIN }]);

  const s = { context, worker, extId, requests: [], replies: [], turns: [] } as unknown as Session;
  if (opts.mockOpenAI !== false) {
    fakeRelay();
    current = s;
  }

  s.panel = await context.newPage();
  s.panel.on('websocket', (ws) => {
    let at = 0;
    let kb = 0;
    ws.on('framesent', (f) => {
      const p = String(f.payload);
      if (p.startsWith('{"type":"response.create"')) [at, kb] = [Date.now(), Math.round(p.length / 1024)];
    });
    ws.on('framereceived', (f) => {
      const p = String(f.payload);
      if (!/"type":"(response\.(completed|incomplete|failed)|error)"/.test(p)) return;
      if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(JSON.parse(p).type)) {
        s.turns.push({ at, ms: Date.now() - at, kb });
      }
    });
  });
  const startUrl = opts.startUrl ?? `${ORIGIN}${opts.startPath ?? '/dashboard'}`;
  if (opts.panel !== false) await s.panel.goto(`chrome-extension://${extId}/sidepanel.html?startUrl=${encodeURIComponent(startUrl)}`);
  return s;
}

/** Press Start (or Run again). */
export async function start(s: Session) {
  await s.panel.getByRole('button', { name: /^(Start|Run again)$/ }).click();
}

/** The tab the flow opened (the first fixture tab that isn't the front end). */
export function flowTab(s: Session): Page {
  const tab = s.context.pages().find((p) => p.url().startsWith(ORIGIN) && !p.url().startsWith(`${ORIGIN}/fe`));
  if (!tab) throw new Error('the flow tab is not open');
  return tab;
}

/** The dealer signs in to (fixture) Tekion in the flow's tab; Tekion returns them to the RO list. */
export async function signIn(s: Session) {
  await flowTab(s).goto(`${ORIGIN}/tekion/signin`);
}

/** Wait for a run to start and then finish. */
export async function finished(s: Session, timeout = 180_000) {
  await expect(s.panel.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(s.panel.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout });
}

/**
 * Is the extension still holding the debugger on any tab whose url starts with `url`?
 * getTargets().attached also counts Playwright's own CDP session, so instead we try to attach
 * from the service worker: Chrome refuses a second attach from the same extension.
 */
export async function debuggerAttached(s: Session, url = ORIGIN): Promise<boolean> {
  return s.worker.evaluate(async (u) => {
    const tabs = (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(u));
    for (const t of tabs) {
      const held = await new Promise<boolean>((res) =>
        chrome.debugger.attach({ tabId: t.id! }, '1.3', () => {
          // Refused because someone holds it = held. (Refused over another extension's frame is not.)
          const err = chrome.runtime.lastError?.message;
          if (err) return res(/already attached/i.test(err));
          chrome.debugger.detach({ tabId: t.id! }, () => res(false));
        }),
      );
      if (held) return true;
    }
    return false;
  }, url);
}

let n = 0;
const usage = { input_tokens: 100, output_tokens: 20 };
export const call = (actions: object[]) => ({
  id: `resp_${++n}`,
  status: 'completed',
  usage,
  output: [{ type: 'computer_call', id: `cu_${n}`, call_id: `call_${n}`, status: 'completed', actions }],
});
export const fn = (name: string, args: object) => ({
  id: `resp_${++n}`,
  status: 'completed',
  usage,
  output: [{ type: 'function_call', id: `fc_${n}`, call_id: `fcall_${n}`, name, arguments: JSON.stringify(args) }],
});
export const say = (text: string) => ({
  id: `resp_${++n}`,
  status: 'completed',
  usage,
  output: [{ type: 'message', id: `msg_${n}`, content: [{ type: 'output_text', text }] }],
});

/** A complete, schema-shaped result for the Tekion repair-order flow. */
export const RO_RESULT = {
  dealership: 'Lakeside Toyota',
  total_in_list: 6,
  repair_orders: [
    { ro_number: '7314021', status: 'Open', customer: 'Maria Lopez', vehicle: '2021 Toyota Camry SE', vin: '4T1G11AK5MU512345', advisor: 'J. Patel', opened: '10/02/2026 8:12 AM', promised: '10/02/2026 4:00 PM', total: null },
    { ro_number: '7314022', status: 'In Progress', customer: 'Kevin Brooks', vehicle: '2019 Toyota RAV4 XLE', vin: '2T3P1RFV8KW123456', advisor: 'J. Patel', opened: '10/02/2026 8:40 AM', promised: '10/02/2026 2:30 PM', total: null },
  ],
  unavailable: ['Total'],
  notes: '',
};

/** A complete, schema-shaped result for the VinSolutions account flow. */
export const RESULT = {
  signed_in: true,
  user_name: 'Dana Reyes',
  dealership: 'Lakeside Honda',
  other_dealerships: ['Lakeside Toyota', 'Lakeside Kia'],
  unavailable: ['Reports'],
  notes: '',
};

/** The tab group the flow's tab sits in: its label and colour show the run's state in the tab strip. */
export async function tabGroup(s: Session): Promise<{ title?: string; color?: string } | null> {
  return s.worker.evaluate(async (origin) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(origin) && !t.url.startsWith(origin + '/fe'));
    if (!tab || tab.groupId === -1) return null;
    const g = await chrome.tabGroups.get(tab.groupId);
    return { title: g.title, color: g.color };
  }, ORIGIN);
}
