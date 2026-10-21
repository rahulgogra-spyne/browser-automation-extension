// Dealr.cloud run (proof of concept): no model, no screen reading. The signed-in Dealr.cloud tab makes
// the same JSON calls its own screens make, one store at a time (x-dealer-id header), and this keeps
// only what the datasets need.
//
// - Stores: GET /api/settings/usable/ (the stores this user can see).
// - Leads: GET /api/leads, newest first, paged until a lead older than the window.
// - Lead detail (first DETAIL_LIMIT leads): GET /api/leads/{id}, which carries phones, emails, address,
//   activities (notes), appointments, tasks and trades.
// - Vehicles: GET /api/inventory/ (the Current tab, the Inventory screen's default).
//
// Read-only: while this runs, the debugger holds every request the tab makes, and only those reads pass.
import { Tab, waitForSettled } from './cdp';
import { waitForSignIn } from './signin-wait';
import { toDatasets, type Datasets, type InventoryRow, type LeadDetail, type LeadRow } from './dealr-data';
import type { LogEntry, RunResult } from './agent';

const HOST = 'manage.dealr.cloud';
const HOME = '/';
/** Leads and vehicles to list per store. The POC keeps this small. */
export const LEAD_CAP = 100;
/** Leads to read the detail for, across all stores: every lead the run lists. */
export const DETAIL_LIMIT = LEAD_CAP;
export const VEHICLE_CAP = 100;
/** Days back the leads cover (creation time). */
export const WINDOW_DAYS = 7;

/** GETs the run may make (same host only). Everything else is failed. */
export function allowed(method: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.host !== HOST || method.toUpperCase() !== 'GET') return false;
  return u.pathname === '/api/settings/usable/' || u.pathname === '/api/leads' || /^\/api\/leads\/\d+$/.test(u.pathname) || u.pathname === '/api/inventory/';
}

/** Requests that carry data: only these are judged. Images, styles and scripts pass. */
const DATA = new Set(['XHR', 'Fetch', 'Document', 'Other', 'EventSource', 'Ping']);

interface PageResult {
  ok: boolean;
  status?: number;
  error?: string;
  stores?: { id: number; name: string }[];
  leads?: { lead: LeadRow; store: string; detail?: LeadDetail; errors?: string[] }[];
  vehicles?: { store: string; rows: InventoryRow[] }[];
  total?: number | null;
}

/**
 * Runs in the Dealr.cloud page (through Runtime.evaluate). Plain JS only: it is serialized and sent.
 */
function pageCollect(cfg: { days: number; detailLimit: number; leadCap: number; vehicleCap: number }): Promise<PageResult> {
  const getJson = async (path: string, params: Record<string, string>, dealer?: number): Promise<any> => {
    const q = new URLSearchParams(params);
    const url = q.toString() ? `${path}?${q.toString()}` : path;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (dealer != null) headers['x-dealer-id'] = String(dealer);
    const r = await fetch(url, { headers, credentials: 'same-origin' });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return r.json();
  };

  return (async () => {
    const usable = await getJson('/api/settings/usable/', {});
    const stores = (usable.usable_dealers ?? []).filter((d: any) => d.access).map((d: any) => ({ id: d.id, name: d.name }));
    if (!stores.length) return { ok: false, error: 'Dealr.cloud shows no store for this user.' };

    const cutoff = Date.now() / 1000 - cfg.days * 86400;
    const leads: any[] = [];
    let total = 0;
    for (const store of stores) {
      let page = 1;
      let done = false;
      while (!done && leads.length < cfg.leadCap) {
        const j = await getJson('/api/leads', { count: '100', page: String(page), 'sorting[age]': 'desc' }, store.id);
        if (page === 1) total += Number(j.count) || 0;
        const rows: any[] = j.response ?? [];
        if (!rows.length) break;
        for (const row of rows) {
          if (row.creation_time < cutoff) {
            done = true;
            break;
          }
          if (leads.length >= cfg.leadCap) {
            done = true;
            break;
          }
          leads.push({ lead: row, store: store.name, storeId: store.id });
        }
        page++;
      }
    }

    for (const item of leads.slice(0, cfg.detailLimit)) {
      try {
        item.detail = await getJson(`/api/leads/${item.lead.id}`, {}, item.storeId);
      } catch (e) {
        item.errors = [`lead detail: ${(e as Error).message}`];
      }
    }

    const vehicles: any[] = [];
    for (const store of stores) {
      const j = await getJson('/api/inventory/', { count: '100', page: '1' }, store.id);
      vehicles.push({ store: store.name, rows: (j.response ?? []).slice(0, cfg.vehicleCap) });
    }

    return {
      ok: true,
      stores: stores.map((s: any) => ({ id: s.id, name: s.name })),
      leads: leads.map(({ lead, store, detail, errors }) => ({ lead, store, detail, errors })),
      vehicles,
      total,
    };
  })().catch((e: Error & { status?: number }) => ({ ok: false, status: e.status, error: e.message }));
}

export interface CollectOptions {
  tabId: number;
  log: (e: LogEntry) => void;
  signal: AbortSignal;
}

/** Opens Dealr.cloud, holds the tab's requests to the reads above, and returns the seven datasets. */
export async function collectDealr(o: CollectOptions): Promise<RunResult> {
  const tab = new Tab(o.tabId);
  const result = (extra: Partial<RunResult>): RunResult => ({ tabId: o.tabId, openCalls: [], finalText: '', tokens: { input: 0, output: 0 }, ...extra });
  let blocked = 0;

  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== o.tabId) return;
    if (method === 'Page.javascriptDialogOpening') {
      chrome.debugger.sendCommand(source, 'Page.handleJavaScriptDialog', { accept: false }, () => void chrome.runtime.lastError);
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    const p = params as { requestId: string; request: { url: string; method: string }; resourceType?: string };
    const judged = !p.resourceType || DATA.has(p.resourceType);
    if (!judged || allowed(p.request.method, p.request.url)) {
      chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: p.requestId }, () => void chrome.runtime.lastError);
      return;
    }
    blocked++;
    chrome.debugger.sendCommand(source, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, () => void chrome.runtime.lastError);
  };

  try {
    // Home is under /u/<userId>/; the page's own URL is what the signed-in session is on.
    await chrome.tabs.update(o.tabId, { url: `https://${HOST}${HOME}` });
    await waitForSettled(o.tabId, 800, 30_000);
    await waitForSignIn(o.tabId, o.signal, o.log);
    if (o.signal.aborted) throw o.signal.reason;

    chrome.debugger.onEvent.addListener(onEvent);
    await tab.attach();
    await tab.send('Page.enable');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

    o.log({ kind: 'info', text: `Reading the leads of the last ${WINDOW_DAYS} days in every store this user can see, and the detail of the first ${DETAIL_LIMIT}` });
    const { result: evaluated } = await tab.send<{ result: { value?: PageResult } }>(
      'Runtime.evaluate',
      {
        expression: `(${pageCollect.toString()})(${JSON.stringify({ days: WINDOW_DAYS, detailLimit: DETAIL_LIMIT, leadCap: LEAD_CAP, vehicleCap: VEHICLE_CAP })})`,
        awaitPromise: true,
        returnByValue: true,
      },
      240_000,
    );
    const page = evaluated.value;
    if (!page) return result({ error: 'Dealr.cloud returned nothing.' });
    if (!page.ok) {
      const why = page.status === 401 || page.status === 403 ? 'Dealr.cloud is not signed in.' : page.error ?? `Dealr.cloud answered HTTP ${page.status}.`;
      return result({ error: `${why} Sign in to Dealr.cloud in the tab that opened, then press Start again.` });
    }

    const data: Datasets = toDatasets({
      leads: (page.leads ?? []).map((l) => ({ lead: l.lead, store: l.store, detail: l.detail, errors: l.errors })),
      vehicles: page.vehicles ?? [],
      stores: (page.stores ?? []).map((s) => s.name),
      total: page.total ?? null,
      detailLimit: DETAIL_LIMIT,
      days: WINDOW_DAYS,
    });
    if (blocked) o.log({ kind: 'blocked', text: `Held ${blocked} request(s) the run does not need` });
    o.log({ kind: 'info', text: `Read ${data.leads.length} leads, ${data.vehicles.length} vehicles, ${data.customer_notes.length} notes, ${data.tasks.length} tasks, ${data.appointments.length} appointments.` });
    return result({ data: data as unknown as Record<string, unknown>, finalText: data.notes });
  } catch (e) {
    if (o.signal.aborted) return result({ stopped: 'Stopped.' });
    return result({ error: (e as Error).message });
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await tab.detach();
  }
}
