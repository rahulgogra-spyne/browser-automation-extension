// Tekion run (proof of concept): no model, no screen reading. The signed-in Tekion tab makes the same
// JSON calls its own screens make, with the header set Tekion needs (read from the page's own storage),
// and this keeps the first rows of each dataset.
//
// Datasets (mapped in ~/Downloads/extension/extension/config/crm-structures.json, tekion-arc):
//   customers, vehicles, services, technicians_advisors, working_hours, transportation,
//   repair_orders, appointments.
// Not wired yet: notes (per record, the body is not pinned) and technicians (the dispatch roster).
//
// Read-only: while this runs, the debugger holds every request the tab makes, and only those reads pass.
import { Tab, waitForSettled } from './cdp';
import { waitForSignIn } from './signin-wait';
import type { LogEntry, RunResult } from './agent';

const HOST = 'app.tekioncloud.com';
const HOME = '/home';
/** Rows to keep per dataset. The POC keeps one page; the totals are reported as well. */
export const ROWS = 50;

/** Requests the run may make (same host only). Everything else is failed. */
export function allowed(method: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.host !== HOST) return false;
  const m = method.toUpperCase();
  if (m === 'GET') return u.pathname === '/api/scheduling/u/settings/serviceShop' || u.pathname === '/api/employeeteamservice/u/teams/getall/service';
  if (m !== 'POST') return false;
  return [
    '/api/crm-customer/u/list/search',
    '/api/api-vi/u/v1.0.0/inventory/tenant/v2/search',
    '/api/service-module/u/opcode/search',
    '/api/scheduling/u/settings/serviceAdvisor/list',
    '/api/service-module/u/scheduling/aggregated-settings/fetch',
    '/api/service-module/u/ro/v2/search',
    '/api/scheduling/u/appointment/search',
    '/api/crmlead/u/lead-list/search',
    '/api/crmtask/u/search',
    '/api/crmlead/u/notes/fetch/bulk',
  ].includes(u.pathname);
}

const DATA = new Set(['XHR', 'Fetch', 'Document', 'Other', 'EventSource', 'Ping']);

/** A value that carries data: not null, not an empty string, array or object. */
export function hasValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/**
 * Keeps what the records actually carry: only the fields that have a value in some row (at most
 * `maxFields`), and only the rows where at least one of those fields has a value. Tekion's records have
 * ~90 fields, most of them null, so this is what makes a dataset readable and what "data found" means.
 */
export function usefulRows(rows: unknown[], maxFields = 25): Record<string, unknown>[] {
  const objs = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  const keys = [...new Set(objs.flatMap((r) => Object.keys(r)))].filter((k) => objs.some((r) => hasValue(r[k]))).slice(0, maxFields);
  return objs.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]))).filter((r) => keys.some((k) => hasValue(r[k])));
}

interface PageResult {
  ok: boolean;
  status?: number;
  error?: string;
  dealer?: string | null;
  datasets?: Record<string, { rows: unknown[]; total: number | null }>;
  failed?: string[];
  notesRaw?: any;
  teamsRaw?: any;
}

/**
 * Runs in the Tekion page (through Runtime.evaluate). Plain JS only: it is serialized and sent.
 * The header set comes from the page's own storage (t_token and the t_user blob), as the mapping says.
 */
function pageCollect(cfg: { rows: number }): Promise<PageResult> {
  return (async () => {
    const token = localStorage.getItem('t_token');
    const user = JSON.parse(localStorage.getItem('t_user') || 'null');
    if (!token || !user) return { ok: false, status: 401 };
    const s = (v: unknown) => String(v ?? '');
    const headers: Record<string, string> = {
      'tekion-api-token': token,
      roleId: s(user.roleId),
      userId: s(user.id),
      tenantname: s(user.tenantName),
      dealerId: s(user.dealerId),
      'tek-siteId': s(user.tekSiteId),
      'original-userid': s(user.originalUserId),
      'original-tenantid': s(user.originalTenantId),
      clientId: 'WEB',
      locale: 'en_US',
      program: s(user.programId),
      applicationId: s(user.applicationId),
      subApplicationId: s(user.subApplicationId),
      productIds: s(user.productIds),
      'content-type': 'application/json',
      accept: 'application/json',
    };
    const call = async (method: string, path: string, body?: unknown): Promise<any> => {
      const r = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      return r.json();
    };
    const page = { start: 0, rows: cfg.rows };
    const datasets: Record<string, { rows: unknown[]; total: number | null }> = {};
    const failed: string[] = [];
    const take = async (name: string, fn: () => Promise<{ rows: unknown[]; total: number | null }>) => {
      try {
        datasets[name] = await fn();
      } catch (e) {
        failed.push(`${name}: ${(e as Error).message}`);
      }
    };

    await take('customers', async () => {
      const j = await call('POST', '/api/crm-customer/u/list/search', { sort: [], pageInfo: page, searchText: '', filters: [] });
      return { rows: j.data.hits, total: j.data.count };
    });
    await take('vehicles', async () => {
      const j = await call('POST', '/api/api-vi/u/v1.0.0/inventory/tenant/v2/search?langParam=en_US', { sort: [], searchText: '', filters: [], pageInfo: page });
      return { rows: j.data.hits, total: j.data.count };
    });
    await take('services', async () => {
      const j = await call('POST', '/api/service-module/u/opcode/search', { sort: [], pageInfo: page, searchText: '', filters: [] });
      return { rows: j.data.hits, total: j.data.count };
    });
    await take('technicians_advisors', async () => {
      const j = await call('POST', '/api/scheduling/u/settings/serviceAdvisor/list', [1735689600000, 1798761600000]);
      return { rows: j.data.slice(0, cfg.rows), total: j.data.length };
    });
    await take('working_hours', async () => {
      const j = await call('GET', '/api/scheduling/u/settings/serviceShop');
      return { rows: j.data.slice(0, cfg.rows), total: j.data.length };
    });
    await take('transportation', async () => {
      const j = await call('POST', '/api/service-module/u/scheduling/aggregated-settings/fetch', { requestOptions: ['TRANSPORTATION_SETTINGS_SUMMARY'] });
      return { rows: j.data.slice(0, cfg.rows), total: j.data.length };
    });
    await take('repair_orders', async () => {
      const j = await call('POST', '/api/service-module/u/ro/v2/search', {
        tableRequest: {
          pageInfo: page,
          sort: [{ order: 'DESC', field: 'createdTime' }],
          searchText: null,
          filters: [{ operator: 'IN', values: [false], field: 'migrated' }],
          searchFields: ['CUSTOMER', 'VEHICLE', 'RO_NO', 'TAG_NO', 'PHONE', 'FLEET_NO'],
          requestOptions: ['LABEL'],
          includeFields: ['id', 'roNo', 'status', 'serviceAdvisorId', 'assignedTechIds', 'transportType', 'promiseTime', 'createdTime', 'customerId', 'vehicleId', 'serviceMode', 'appointmentId', 'departmentId', 'jobCount', 'nonVoidedJobCount', 'closedTime', 'tagNo'],
        },
      });
      return { rows: j.data.tableRequest.hits, total: j.data.tableRequest.count };
    });
    await take('appointments', async () => {
      const j = await call('POST', '/api/scheduling/u/appointment/search', { sort: [], pageInfo: page, searchText: '', filters: [] });
      return { rows: j.data.data, total: j.data.count };
    });

    await take('leads', async () => {
      const j = await call('POST', '/api/crmlead/u/lead-list/search', { sort: [], pageInfo: page, searchText: '', filters: [] });
      return { rows: j.data.hits, total: j.data.count };
    });
    await take('tasks', async () => {
      const j = await call('POST', '/api/crmtask/u/search', { sort: [], pageInfo: page, searchText: '', filters: [] });
      return { rows: j.data.hits, total: j.data.count };
    });
    let notesRaw: any = null;
    try {
      const leadIds = (datasets.leads?.rows ?? []).map((l: any) => l.leadId).filter(Boolean);
      notesRaw = (await call('POST', '/api/crmlead/u/notes/fetch/bulk', { leadIds })).data ?? null;
    } catch (e) {
      failed.push(`notes: ${(e as Error).message}`);
    }
    let teamsRaw: any = null;
    try {
      const teams = await call('GET', '/api/employeeteamservice/u/teams/getall/service');
      teamsRaw = Array.isArray(teams) ? teams : teams.data ?? null;
    } catch (e) {
      failed.push(`technicians: ${(e as Error).message}`);
    }

    return { ok: true, dealer: user.dealerName ?? user.tenantName ?? null, datasets, failed, notesRaw, teamsRaw };
  })().catch((e: Error & { status?: number }) => ({ ok: false, status: e.status, error: e.message }));
}

/** Trade-ins: the vehicles a lead owns (the trade), one row each. */
export function tradeRows(leads: any[]): Record<string, unknown>[] {
  return leads.flatMap((lead) =>
    (Array.isArray(lead.ownedVehicles) ? lead.ownedVehicles : []).map((v: any) => ({
      leadId: lead.leadId ?? null,
      ownedVehicleId: v.ownedVehicleId ?? null,
      make: v.make ?? null,
      model: v.model ?? null,
      odometer: v.odometer ?? v.mileage ?? null,
      tradeIn: v.tradeIn ?? null,
      tradeAllowance: v.tradeAllowance ?? null,
      price: v.price ?? null,
      certified: v.certified ?? null,
    })),
  );
}

/** Notes: the lead notes from the bulk notes request, keyed by lead. */
export function noteRows(bulk: Record<string, { noteList?: any[] }> | null): Record<string, unknown>[] {
  return Object.entries(bulk ?? {}).flatMap(([leadId, group]) =>
    (group?.noteList ?? []).map((n: any) => ({
      leadId,
      title: n.title ?? null,
      text: n.text ?? null,
      userName: n.userName ?? null,
      createdTime: typeof n.createdTime === 'number' ? new Date(n.createdTime).toISOString() : (n.createdTime ?? null),
      assetType: n.assetType ?? null,
    })),
  );
}

/** Technicians: the members of the service teams (IDs; names are not resolved yet). */
export function technicianRows(teams: any[] | null): Record<string, unknown>[] {
  return (teams ?? []).flatMap((t) => (t.memberIds ?? []).map((id: string) => ({ team: t.name ?? null, teamId: t.teamId ?? null, technicianId: id, dispatchType: t.dispatchType ?? null })));
}

export interface CollectOptions {
  tabId: number;
  log: (e: LogEntry) => void;
  signal: AbortSignal;
}

/** Opens Tekion, holds the tab's requests to the reads above, and returns the datasets. */
export async function collectTekion(o: CollectOptions): Promise<RunResult> {
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
    await chrome.tabs.update(o.tabId, { url: `https://${HOST}${HOME}` });
    await waitForSettled(o.tabId, 800, 30_000);
    await waitForSignIn(o.tabId, o.signal, o.log);
    if (o.signal.aborted) throw o.signal.reason;

    chrome.debugger.onEvent.addListener(onEvent);
    await tab.attach();
    await tab.send('Page.enable');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

    o.log({ kind: 'info', text: `Reading the Tekion datasets: customers, vehicles, services, advisors, working hours, transportation, repair orders and appointments (first ${ROWS} of each)` });
    const { result: evaluated } = await tab.send<{ result: { value?: PageResult } }>(
      'Runtime.evaluate',
      { expression: `(${pageCollect.toString()})(${JSON.stringify({ rows: ROWS })})`, awaitPromise: true, returnByValue: true },
      240_000,
    );
    const page = evaluated.value;
    if (!page) return result({ error: 'Tekion returned nothing.' });
    if (!page.ok) {
      const why = page.status === 401 || page.status === 403 ? 'Tekion is not signed in.' : page.error ?? `Tekion answered HTTP ${page.status}.`;
      return result({ error: `${why} Sign in to Tekion in the tab that opened, then press Start again.` });
    }

    const data: Record<string, unknown> = { dealership: page.dealer ?? null };
    const unavailable: string[] = [];
    for (const [name, value] of Object.entries(page.datasets ?? {})) {
      const rows = usefulRows(value.rows);
      data[name] = rows;
      data[`${name}_total`] = value.total;
      if (!rows.length) unavailable.push(`${name}: no values came back`);
    }
    data.trade_vehicles = usefulRows(tradeRows(page.datasets?.leads?.rows ?? []));
    if (!(data.trade_vehicles as unknown[]).length) unavailable.push('trade_vehicles: no lead has a trade-in');
    data.notes = usefulRows(noteRows(page.notesRaw ?? null));
    if (!(data.notes as unknown[]).length) unavailable.push('notes: no lead notes came back');
    data.technicians = usefulRows(technicianRows(page.teamsRaw ?? null));
    if (!(data.technicians as unknown[]).length) unavailable.push('technicians: no service team members came back');
    for (const f of page.failed ?? []) unavailable.push(f);
    data.unavailable = unavailable;
    data.summary = `Read the first ${ROWS} of each list. Totals are in *_total. Technicians are team member IDs for now; their names are not resolved yet.`;
    if (blocked) o.log({ kind: 'blocked', text: `Held ${blocked} request(s) the run does not need` });
    o.log({ kind: 'info', text: `Read ${Object.keys(page.datasets ?? {}).length} Tekion datasets.` });
    return result({ data, finalText: String(data.summary) });
  } catch (e) {
    if (o.signal.aborted) return result({ stopped: 'Stopped.' });
    return result({ error: (e as Error).message });
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await tab.detach();
  }
}
