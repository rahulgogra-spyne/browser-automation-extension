// VinSolutions run (proof of concept): no model, no screen reading. The signed-in VinConnect tab
// makes the same reads its own screens make, and this code keeps only what the datasets need.
//
// - The customer list: POST /CarDashboard/bff/search/customers (JSON), the Recent Opportunities call.
// - Per customer (first DETAIL_LIMIT only): the lead page, the customer page and the notes feed, all
//   GETs, parsed in the page (DOMParser) by the element ids the mapping names.
//
// Read-only by construction: while this runs, the debugger holds every request the tab makes, and
// only the reads above go through. Everything else is failed (the page's own writes included).
import { Tab, waitForSettled } from './cdp';
import { waitForSignIn } from './signin-wait';
import { toDatasets, RECENT_FROM, type CustomerRow, type Datasets, type Detail } from './vinsolutions-data';
import type { LogEntry, RunResult } from './agent';

const HOST = 'vinsolutions.app.coxautoinc.com';
/** Customers to read the detail pages for. The POC keeps this small; raise it for the full run. */
export const DETAIL_LIMIT = 5;

/** GET paths the run may read (same host only). */
const READS = new Set([
  '/CarDashboard/Pages/CRM/CustomerDashboardResources/SaleLeadView.aspx',
  '/CarDashboard/Pages/CRM/CustomerDashboard.aspx',
  '/CarDashboard/services/notesandhistory.asmx/GetNotesAndHistoryForAutoLeads',
  '/CarDashboard/bff/active-leads/leads',
]);
const SEARCH = '/CarDashboard/bff/search/customers';
/** Requests the page makes that carry data: only these are judged. Images, styles and scripts pass. */
const DATA = new Set(['XHR', 'Fetch', 'Document', 'Other', 'EventSource', 'Ping']);

export function allowed(method: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.host !== HOST) return false;
  const m = method.toUpperCase();
  if (m === 'GET') return READS.has(u.pathname);
  if (m === 'POST') return u.pathname === SEARCH;
  return false;
}

/** What the page-side code returns (the whole search and one detail per customer). */
interface PageResult {
  ok: boolean;
  status?: number;
  dealers?: string[];
  dealerIds?: number[];
  total?: number | null;
  rows?: CustomerRow[];
  details?: Record<string, Detail>;
  error?: string;
}

/**
 * Runs in the VinConnect page (through Runtime.evaluate). Plain JS only: it is serialized and sent.
 * Parses the detail pages with the element ids from the mapping; a missing part is recorded, not fatal.
 */
function pageCollect(cfg: { from: string; detailLimit: number }): Promise<PageResult> {
  const JSON_HEADERS = { 'X-Requested-With': 'XMLHttpRequest', accept: 'application/json', 'content-type': 'application/json' };
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const txt = (d: Document, sel: string): string | null => {
    const e = d.querySelector(sel);
    return e ? (e.textContent || '').replace(/\s+/g, ' ').trim() || null : null;
  };
  const getText = async (path: string): Promise<string> => {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  };
  const detail = async (row: any): Promise<Detail> => {
    const out: any = { errors: [] };
    const ids = q({ GlobalCustomerID: String(row.globalCustomerId), AutoLeadID: String(row.autoLeadId) });
    try {
      const d = new DOMParser().parseFromString(await getText(`/CarDashboard/Pages/CRM/CustomerDashboardResources/SaleLeadView.aspx?from=cd&${ids}`), 'text/html');
      out.trade_in = txt(d, "[id$='TradeIn1BasicInfo']");
      out.trade_detail = txt(d, "[id$='TradeIn1AdvInfo']");
      out.trade_value = txt(d, "[id$='TradeIn1Condition']");
    } catch (e) {
      out.errors.push(`lead page: ${(e as Error).message}`);
    }
    try {
      const d = new DOMParser().parseFromString(await getText(`/CarDashboard/Pages/CRM/CustomerDashboard.aspx?${ids}`), 'text/html');
      const note = d.querySelector("[id$='_NoteText']") as (HTMLTextAreaElement | null);
      const typed = note ? ((note.value ?? note.textContent) || '').trim() : '';
      // VinConnect shows this placeholder when there is no note.
      out.customer_note = typed && typed !== 'Click to add customer note' ? typed : null;
      out.tasks = txt(d, '#taskContent div.tasksContentDiv');
      out.appointments = [...d.querySelectorAll("[id$='_AppointmentList1_RadGrid1'] tr.rgRow, [id$='_AppointmentList1_RadGrid1'] tr.rgAltRow")].map((tr) => {
        const c = [...tr.children].map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim());
        return { subject: c[0] ?? null, recipient: c[1] ?? null, when: c[2] ?? null };
      });
    } catch (e) {
      out.errors.push(`customer page: ${(e as Error).message}`);
    }
    try {
      const r = await fetch(`/CarDashboard/services/notesandhistory.asmx/GetNotesAndHistoryForAutoLeads?${q({ dealerId: String(row.dealerId), globalCustomerId: String(row.globalCustomerId), autoLeadIds: String(row.autoLeadId) })}`, { headers: JSON_HEADERS, credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.text()).replace(/^﻿/, '').trim();
      // The feed is a JSON array, sometimes wrapped as {"d": ...} or followed by text. Take what parses.
      const candidates = [body, body.slice(body.indexOf('['), body.lastIndexOf(']') + 1), body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)];
      let list: any = undefined;
      for (const c of candidates) {
        try {
          const v = JSON.parse(c);
          list = v && v.d !== undefined ? v.d : v;
          break;
        } catch {
          /* try the next form */
        }
      }
      if (list === undefined) {
        const kind = body.startsWith('<') ? 'an HTML page (the session may have expired)' : 'an unrecognised format';
        throw new Error(`${kind}, ${body.length} characters, type ${r.headers.get('content-type') ?? 'unknown'}`);
      }
      out.notes = (Array.isArray(list) ? list : []).map((e: any) => ({ date: e.date ?? null, sender: e.ByUser ?? null, subject: e.Subject ?? null, body: e.Content ?? null }));
    } catch (e) {
      out.errors.push(`notes: ${(e as Error).message}`);
    }
    return out;
  };

  return (async () => {
    const dealersRes = await fetch('/CarDashboard/bff/active-leads/leads?userTypeId=0', { headers: JSON_HEADERS, credentials: 'same-origin' });
    if (!dealersRes.ok) return { ok: false, status: dealersRes.status };
    const dealersJson = await dealersRes.json();
    const dealers: any[] = dealersJson.dealers ?? [];
    const dealerIds = dealers.map((d) => d.dealerId);
    const search = await fetch('/CarDashboard/bff/search/customers', {
      method: 'POST',
      headers: JSON_HEADERS,
      credentials: 'same-origin',
      body: JSON.stringify({ quickFilter: 'Recent Opportunities', receivedFrom: cfg.from, receivedTo: null, dealerIds, groupIds: null, userIds: null, restrictToMyCustomers: null }),
    });
    if (!search.ok) return { ok: false, status: search.status };
    const json = await search.json();
    const rows: any[] = json.results ?? [];
    const details: Record<string, Detail> = {};
    for (const row of rows.slice(0, cfg.detailLimit)) {
      details[String(row.globalCustomerId)] = await detail(row);
    }
    return {
      ok: true,
      dealers: dealers.map((d) => d.dealerName),
      dealerIds,
      total: json.totalCount ?? null,
      rows,
      details,
    };
  })().catch((e: Error) => ({ ok: false, error: e.message }));
}

export interface CollectOptions {
  tabId: number;
  startUrl: string;
  log: (e: LogEntry) => void;
  signal: AbortSignal;
}

/** Opens the VinConnect tab, holds its data requests to the reads above, and returns the seven datasets. */
export async function collectVinSolutions(o: CollectOptions): Promise<RunResult> {
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
    await chrome.tabs.update(o.tabId, { url: o.startUrl });
    await waitForSettled(o.tabId, 800, 30_000);
    await waitForSignIn(o.tabId, o.signal, o.log);
    if (o.signal.aborted) throw o.signal.reason;

    chrome.debugger.onEvent.addListener(onEvent);
    await tab.attach();
    await tab.send('Page.enable');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

    o.log({ kind: 'info', text: `Reading the Recent Opportunities customers from ${RECENT_FROM}, and the detail pages of the first ${DETAIL_LIMIT}` });
    const { result: evaluated } = await tab.send<{ result: { value?: PageResult } }>(
      'Runtime.evaluate',
      { expression: `(${pageCollect.toString()})(${JSON.stringify({ from: RECENT_FROM, detailLimit: DETAIL_LIMIT })})`, awaitPromise: true, returnByValue: true },
      240_000,
    );
    const page = evaluated.value;
    if (!page) return result({ error: 'VinConnect returned nothing.' });
    if (!page.ok) {
      const why = page.status === 401 || page.status === 403 || page.status === 404 ? 'VinConnect is not signed in (or the account has no access).' : page.error ?? `VinConnect answered HTTP ${page.status}.`;
      return result({ error: `${why} Sign in to VinConnect in the tab that opened, then press Start again.` });
    }

    const data = toDatasets({
      rows: page.rows ?? [],
      total: page.total ?? null,
      dealers: page.dealers ?? [],
      details: page.details ?? {},
      detailLimit: DETAIL_LIMIT,
    }) as Datasets;
    if (blocked) o.log({ kind: 'blocked', text: `Held ${blocked} request(s) the run does not need` });
    o.log({ kind: 'info', text: `Read ${data.customers.length} customers, ${data.vehicles.length} vehicles, ${data.customer_notes.length} notes.` });
    return result({ data: data as unknown as Record<string, unknown>, finalText: data.notes });
  } catch (e) {
    if (o.signal.aborted) return result({ stopped: 'Stopped.' });
    return result({ error: (e as Error).message });
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await tab.detach();
  }
}
