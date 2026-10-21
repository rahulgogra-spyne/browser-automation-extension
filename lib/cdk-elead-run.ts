// CDK eLead run (proof of concept): no model, no screen reading. The signed-in eLead tab makes the
// same requests its own Prospects screen makes, and this keeps only what the datasets need.
//
// - The prospect list: POST /evo2/api/ProspectData/GetProspectList (the Active screen's own call,
//   same body, 7-day window, the signed-in user, no department filter).
// - Per prospect (first DETAIL_LIMIT only): the eLead history page, whose two tables give the
//   notes (gvOpptyHistory) and the tasks and appointments (gvScheduled).
//
// Read-only: while this runs, the debugger holds every request the tab makes, and only those reads
// pass. The store is whichever one is selected in eLead when the run starts.
import { Tab, waitForSettled } from './cdp';
import { waitForSignIn } from './signin-wait';
import { toDatasets, type Datasets, type ProspectDetail, type ProspectRow } from './cdk-elead-data';
import type { LogEntry, RunResult } from './agent';

const HOST = 'crm.connectcdk.com';
const DASHBOARD = '/evo2/fresh/elead-v45/elead_track/index.aspx';
const LIST = '/evo2/api/ProspectData/GetProspectList';
const HISTORY = '/evo2/fresh/elead-v45/elead_track/newprospects/history.aspx';
/** Prospects to read the history for: all of the window (the list is read in one call). */
export const DETAIL_LIMIT = 500;
/** Days back the list covers, the same as the screen's "7 Days" default. */
export const WINDOW_DAYS = 7;

/** Requests the run may make (same host only). Anything else the page makes is failed. */
export function allowed(method: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.host !== HOST) return false;
  const m = method.toUpperCase();
  if (m === 'POST') return u.pathname === LIST;
  if (m === 'GET') return u.pathname === HISTORY;
  return false;
}

/** Requests that carry data: only these are judged. Images, styles and scripts pass. */
const DATA = new Set(['XHR', 'Fetch', 'Document', 'Other', 'EventSource', 'Ping']);

/** What the page-side code returns. */
interface PageResult {
  ok: boolean;
  status?: number;
  error?: string;
  store?: number | null;
  total?: number | null;
  rows?: ProspectRow[];
  details?: Record<string, ProspectDetail>;
}

/**
 * Runs in the eLead page (through Runtime.evaluate). Plain JS only: it is serialized and sent.
 * Reads the store and user the dashboard exposes, then the list and the history of the first prospects.
 */
function pageCollect(cfg: { days: number; detailLimit: number; listPath: string; historyPath: string }): Promise<PageResult> {
  const JSON_H = { 'content-type': 'application/json', accept: 'application/json' };
  const cells = (tr: Element, n?: number) => [...tr.children].slice(0, n).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim());
  const pad = (n: number) => String(n).padStart(2, '0');
  /** A date at local midnight, in the form the screen sends (with the browser's offset). */
  const stamp = (d: Date) => {
    const off = -d.getTimezoneOffset();
    const a = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  };
  const prospectDetail = async (personId: number): Promise<ProspectDetail> => {
    const out: any = { errors: [] };
    try {
      const r = await fetch(`${cfg.historyPath}?${new URLSearchParams({ tab: 'liContacts', lPID: String(personId) }).toString()}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const history = doc.getElementById('gvOpptyHistory');
      const records = (t: Element | null) => (t ? [...t.querySelectorAll('tr.even, tr.odd')].filter((tr) => tr.querySelectorAll(':scope > td').length > 1) : []);
      out.completed = records(history).map((tr) => cells(tr).slice(1));
      const scheduled = doc.getElementById('gvScheduled');
      out.scheduled = records(scheduled).map((tr) => cells(tr, 4));
    } catch (e) {
      out.errors.push(`history: ${(e as Error).message}`);
    }
    return out;
  };

  return (async () => {
    // The dashboard the run opened has the store and user as page globals (no request needed).
    const w = window as any;
    const companyId = w.PublicCompanyId ?? null;
    const userId = w.userid ?? null;
    if (!companyId || !userId) return { ok: false, error: 'eLead did not show the store and user (not signed in?).' };

    const end = new Date();
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - cfg.days);
    const body = {
      CompanyId: companyId,
      ChildCompanyId: companyId,
      ImportListId: null,
      StartDate: stamp(start),
      EndDate: stamp(new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)),
      SelectedUserDeptId: userId,
      ProspectsType: 0,
      UpType: null,
      SourceId: null,
      SourceDetail: '',
      SubStatusIds: [],
      EmployeeId: userId,
      IsSpecialist: false,
      IsManager: true,
      IsWebSpecialist: false,
      DepartmentIds: null,
      IncludeHighPriorityActivities: true,
      SelectedType: 'user',
    };
    const list = await fetch(cfg.listPath, { method: 'POST', headers: JSON_H, credentials: 'same-origin', body: JSON.stringify(body) });
    if (!list.ok) return { ok: false, status: list.status };
    const rows: any[] = await list.json();
    const details: Record<string, ProspectDetail> = {};
    for (const row of rows.slice(0, cfg.detailLimit)) {
      details[String(row.PersonId)] = await prospectDetail(row.PersonId);
    }
    return { ok: true, store: companyId, total: rows.length, rows, details };
  })().catch((e: Error) => ({ ok: false, error: e.message }));
}

export interface CollectOptions {
  tabId: number;
  log: (e: LogEntry) => void;
  signal: AbortSignal;
}

/** Opens the eLead dashboard, holds the tab's requests to the reads above, and returns the seven datasets. */
export async function collectCdkElead(o: CollectOptions): Promise<RunResult> {
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
    await chrome.tabs.update(o.tabId, { url: `https://${HOST}${DASHBOARD}` });
    await waitForSettled(o.tabId, 800, 30_000);
    await waitForSignIn(o.tabId, o.signal, o.log);
    if (o.signal.aborted) throw o.signal.reason;

    chrome.debugger.onEvent.addListener(onEvent);
    await tab.attach();
    await tab.send('Page.enable');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

    o.log({ kind: 'info', text: `Reading the eLead prospects of the selected store for the last ${WINDOW_DAYS} days, and the history of the first ${DETAIL_LIMIT}` });
    const { result: evaluated } = await tab.send<{ result: { value?: PageResult } }>(
      'Runtime.evaluate',
      {
        expression: `(${pageCollect.toString()})(${JSON.stringify({ days: WINDOW_DAYS, detailLimit: DETAIL_LIMIT, listPath: LIST, historyPath: HISTORY })})`,
        awaitPromise: true,
        returnByValue: true,
      },
      240_000,
    );
    const page = evaluated.value;
    if (!page) return result({ error: 'eLead returned nothing.' });
    if (!page.ok) {
      const why = page.status === 401 || page.status === 403 ? 'eLead is not signed in.' : page.error ?? `eLead answered HTTP ${page.status}.`;
      return result({ error: `${why} Sign in to eLead in the tab that opened, then press Start again.` });
    }

    const data: Datasets = toDatasets({
      rows: page.rows ?? [],
      total: page.total ?? null,
      store: page.store != null ? `eLead store ${page.store}` : null,
      details: page.details ?? {},
      detailLimit: DETAIL_LIMIT,
      from: 'the last ' + WINDOW_DAYS + ' days',
    });
    if (blocked) o.log({ kind: 'blocked', text: `Held ${blocked} request(s) the run does not need` });
    o.log({ kind: 'info', text: `Read ${data.leads.length} prospects, ${data.customer_notes.length} notes, ${data.tasks.length} tasks, ${data.appointments.length} appointments.` });
    return result({ data: data as unknown as Record<string, unknown>, finalText: data.notes });
  } catch (e) {
    if (o.signal.aborted) return result({ stopped: 'Stopped.' });
    return result({ error: (e as Error).message });
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await tab.detach();
  }
}
