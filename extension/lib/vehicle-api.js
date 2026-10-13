// Vehicle inventory through CDK Unify's (eLead v45) Vehicle Search, fetched
// instead of clicked. Vehicle Search has no JSON API: pressing Search posts
// the page's ASP.NET form back (__EVENTTARGET=btnSearch) and the server
// answers with the whole page, every vehicle already in #tblSearchResults
// (no paging). Each row carries the vehicle as attributes (vehicleid, vin,
// stock, year, make, model, trim, vehicletype, mileage, status) and its
// cells add colours, transmission, engine, prices, location, DMS status.
//
// So, in the CRM tab's own world (its session cookies), for each store:
//   1) switch the CRM to it (GET admin/SwitchCompany1.asp?ID=<companyId>),
//   2) GET Vehicle Search and take its form fields (view state included),
//   3) POST them back as Search and read the rows out of the answer.
// The page names its store (companyid=<id> in its scripts), which confirms
// each switch, even for a store with no vehicles. Vehicle Search only lists
// the store the session is switched to, and the switch also moves the user's
// own CRM tabs, so the store the session was on is switched back at the end.
//
// The spec is the CRM's api.vehicles block in config/crm-structures.json:
//   vehicles: {
//     dataset: "vehicles",
//     searchPath: "/…/Desking/InventorySearch.aspx?shared=true",
//     switchPath: "/…/admin/SwitchCompany1.asp?ID={companyId}",
//     attributes: { vin: "vin", stock: "stock_number", … },  // row attribute -> key
//     columns: { "Age": "age_days", … },                      // caption overrides
//     stores: [ … ]                     // optional; else api.stores (the session's dealer list)
//   }

import { execScript } from './exec.js';
import { columnsFromHeaders } from './columns.js';

// Runs in the CRM tab's MAIN world. switchUrl (optional) is loaded first;
// with search false only the page's store is read (no Search is posted).
// Returns plain data: { companyId, headers, rows: [{ attrs, cells }], matching }
// or { error }.
function inventoryInPage(searchUrl, switchUrl, search, timeoutMs) {
  return (async () => {
    const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
    // Each request is given up after timeoutMs, so a CRM that never answers can't hold the run.
    const fetch = (url, init = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || 60_000);
      return window.fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
    };
    // The store the page was drawn for: the companyid its scripts name most.
    const storeOf = (html) => {
      const seen = {};
      for (const m of html.matchAll(/company_?id["'\s]*[=:]\s*["']?(\d{3,})/gi)) seen[m[1]] = (seen[m[1]] || 0) + 1;
      return Object.entries(seen).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const signedOut = (res) => /\/login\.asp|\/login\/|logout=1/i.test(res.url);
    try {
      if (switchUrl) {
        const sw = await fetch(switchUrl, { credentials: 'include' });
        if (!sw.ok) return { error: `the store switch answered HTTP ${sw.status}` };
        if (signedOut(sw)) return { error: 'the CRM asked for a sign-in (open it and sign in, then run again)' };
      }
      const get = await fetch(searchUrl, { credentials: 'include' });
      const getHtml = await get.text();
      if (signedOut(get)) return { error: 'the CRM asked for a sign-in (open it and sign in, then run again)' };
      const form = parse(getHtml).forms[0];
      if (!get.ok || !form || !form.querySelector('[name="__VIEWSTATE"]')) return { error: `Vehicle Search did not load (HTTP ${get.status}, ${form ? 'no view state' : 'no form'})` };
      if (!search) return { companyId: storeOf(getHtml) };

      const body = new URLSearchParams(new FormData(form));
      body.set('__EVENTTARGET', 'btnSearch');
      body.set('__EVENTARGUMENT', '');
      body.set('hdnTab', 'liSearch');
      const post = await fetch(searchUrl, { method: 'POST', credentials: 'include', body });
      const html = await post.text();
      const doc = parse(html);
      const table = doc.querySelector('#tblSearchResults');
      if (!post.ok || !table) return { error: `the Search answer had no results table (HTTP ${post.status})` };
      const headerRow = [...table.querySelectorAll('tr')].find((tr) => tr.querySelector('th'));
      const headers = headerRow ? [...headerRow.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()) : [];
      const rows = [...table.querySelectorAll('tr.resultRow')].map((tr) => ({
        attrs: Object.fromEntries([...tr.attributes].map((a) => [a.name, a.value])),
        cells: [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
      }));
      const matching = (doc.body?.textContent.match(/Matching Vehicles\s*\[(\d+)\]/i) || [])[1];
      return { companyId: storeOf(html), headers, rows, matching: matching ? Number(matching) : null };
    } catch (e) {
      return { error: e && e.name === 'AbortError' ? `no answer within ${Math.round((timeoutMs || 60_000) / 1000)}s` : String((e && e.message) || e) };
    }
  })();
}

// Just the store switch, for switching back at the end.
function switchInPage(switchUrl) {
  return fetch(switchUrl, { credentials: 'include' }).then((r) => r.ok, () => false);
}

// A store's call makes up to three requests of FETCH_MS each; the call into
// the page is bounded too (a tab that reloads mid-call never answers) and
// made once more when it got no answer.
const FETCH_MS = 60_000;
async function inPage(where, func, args) {
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const results = await execScript({ target: where, world: 'MAIN', func, args }, { timeoutMs: 3 * FETCH_MS + 15_000 })
      .catch((e) => [{ result: { error: e.message, noAnswer: true } }]);
    result = results?.[0]?.result ?? { error: 'no answer from the CRM tab (is it open and loaded?)', noAnswer: true };
    if (!result?.noAnswer || /cancelled/.test(result.error || '')) break;
  }
  return result;
}

const absolute = (origin, path) => (/^https?:\/\//i.test(path) ? path : `${origin.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`);

// One result row -> { key: value }: the row's attributes first (clean, full
// values), then the cells for whatever the attributes did not give.
export function mapInventoryRow(row, headers, spec = {}) {
  const fields = {};
  for (const [attr, key] of Object.entries(spec.attributes ?? {})) {
    const value = String(row.attrs?.[attr] ?? '').trim();
    if (value) fields[key] = value;
  }
  for (const { index, key } of columnsFromHeaders(headers, spec.columns ?? {})) {
    const value = String(row.cells?.[index] ?? '').trim();
    if (value && fields[key] == null) fields[key] = value;
  }
  return fields;
}

// Captures every store's vehicles. hooks: onNote, onData(fields),
// onRecord({ record }), isCancelled. Returns { found, captured, failed,
// failedStores: [{ name, companyId, reason }] }; a failed store is one whose
// vehicles could not be read (or whose switch could not be confirmed), so the
// caller can read it another way.
export async function captureVehiclesViaSearch({ tabId, frameId = null, origin, api, hooks = {} }) {
  // The page the requests run in: the tab, or the CRM's frame inside it.
  const where = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  const { onNote = () => {}, onData = () => {}, onRecord = async () => {}, isCancelled = () => false } = hooks;
  const spec = api.vehicles;
  let stores = spec.stores ?? api.stores ?? [];
  const searchUrl = absolute(origin, spec.searchPath);
  const switchUrl = (companyId) => absolute(origin, spec.switchPath.replace('{companyId}', encodeURIComponent(companyId)));
  const stats = { found: 0, captured: 0, failed: 0, failedStores: [] };

  const start = await inPage(where, inventoryInPage, [searchUrl, null, false, FETCH_MS]);
  if (start.error) {
    onNote(`Vehicle Search could not be read (${start.error}).`);
    stats.failedStores = stores.map((s) => ({ ...s, reason: start.error }));
    return stats;
  }
  const original = start.companyId;
  let onStore = original;
  // No dealer list: the store the CRM is on.
  if (!stores.length && original) stores = [{ name: '', companyId: original }];
  onNote(`Vehicle Search: the CRM is on store ${original ?? '?'}; ${stores.length} store(s) to read.`);

  try {
    for (const store of stores) {
      if (isCancelled()) break;
      const tag = store.name || String(store.companyId);
      const id = String(store.companyId);
      const switching = onStore !== id;
      const res = await inPage(where, inventoryInPage, [searchUrl, switching ? switchUrl(id) : null, true, FETCH_MS]);
      if (res.companyId) onStore = res.companyId;
      const reason = res.error
        ? res.error
        : res.companyId !== id
          ? `the CRM did not switch to it (Vehicle Search shows store ${res.companyId ?? '?'})`
          : null;
      if (reason) {
        stats.failedStores.push({ ...store, reason });
        onNote(`[${tag}] Vehicles: not read: ${reason}.`);
        continue;
      }
      let captured = 0;
      for (const row of res.rows) {
        if (isCancelled()) break;
        stats.found++;
        const fields = mapInventoryRow(row, res.headers, spec);
        const recordId = fields.vin || fields.stock_number || fields.vehicle_id || '';
        if (!recordId) {
          stats.failed++;
          continue;
        }
        const record = { fields, collections: {}, pageUrl: searchUrl, recordId, dataset: spec.dataset || 'vehicles', store: tag };
        onData(fields);
        await onRecord({ record });
        captured++;
      }
      stats.captured += captured;
      onNote(`[${tag}] Vehicles: ${captured} read${res.matching != null && res.matching !== res.rows.length ? ` (the page said ${res.matching})` : ''}${switching ? ' after switching the CRM to it' : ''}.`);
    }
  } finally {
    if (original && onStore !== original) {
      const back = await inPage(where, switchInPage, [switchUrl(original)]);
      onNote(back === true ? `Switched the CRM back to store ${original}.` : `Could not switch the CRM back to store ${original}; switch it in the CRM's dealer box.`);
    }
  }
  return stats;
}
