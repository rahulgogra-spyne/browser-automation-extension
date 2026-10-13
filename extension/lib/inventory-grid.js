// Vehicle inventory from an ASP.NET grid page, fetched instead of clicked:
// VinSolutions' Browse Inventory (ploader.aspx?TargetControl=Inventory/autosp.ascx).
// The page shows 20 vehicles a page under a filter ("All Vehicles", "New
// Vehicles", …); posting its form back with the filter and a page size of 250
// answers with every vehicle in one grid. The page keeps the filter and page
// size in the user's session (a later visit shows them), so the ones the user
// had are posted back again at the end.
//
// The spec is the CRM's api.inventory block in config/crm-structures.json:
//   inventory: {
//     dataset: "vehicles",
//     pagePath: "/CarDashboard/ploader.aspx?…",
//     gridId: "…_SearchGrid",
//     postback: { pageSize: { name, value }, filter: { name, value } },
//     columns: { "Stock #": "stock_number", … },   // caption -> key
//     skipColumns: ["Photos", "Desk", …],
//     rowLink: { selector, param: "AutoID", key: "vehicle_id" },
//   }

import { execScript } from './exec.js';
import { columnsFromHeaders } from './columns.js';

// Runs in the CRM tab's MAIN world. Reads the grid with the given filter and
// page size, then sets the page back to what it showed before. Returns plain
// data: { headers, rows: [{ cells, linkId }], was: { filter, pageSize } } or
// { error } (with restoreError when the read worked but the restore did not).
function gridInPage(pageUrl, spec, timeoutMs) {
  return (async () => {
    const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
    const request = (init = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || 60_000);
      return fetch(pageUrl, { credentials: 'include', ...init, signal: controller.signal })
        .then(async (res) => {
          const doc = parse(await res.text());
          if (!res.ok || !doc.forms[0]) throw new Error(`the inventory page did not load (HTTP ${res.status}${/signin/i.test(res.url) ? ', asked for a sign-in' : ''})`);
          return doc;
        })
        .finally(() => clearTimeout(timer));
    };
    const field = (doc, name) => doc.querySelector(`[name="${name}"]`);
    // Posts the form back as if `name` had been changed to `value` (more fields in `also`).
    const postBack = (doc, name, value, also = {}) => {
      const body = new URLSearchParams(new FormData(doc.forms[0]));
      for (const [k, v] of Object.entries({ ...also, [name]: value })) body.set(k, v);
      body.set('__EVENTTARGET', name);
      body.set('__EVENTARGUMENT', '');
      return request({ method: 'POST', body });
    };
    const { filter, pageSize } = spec.postback;
    try {
      let doc = await request();
      if (!field(doc, filter.name) || !field(doc, pageSize.name)) return { error: 'the inventory page has no filter / page size controls (has it changed?)' };
      const was = { filter: field(doc, filter.name).value, pageSize: field(doc, pageSize.name).value };
      if (was.filter !== filter.value) doc = await postBack(doc, filter.name, filter.value);
      if (field(doc, pageSize.name)?.value !== pageSize.value) doc = await postBack(doc, pageSize.name, pageSize.value);
      const grid = doc.getElementById(spec.gridId);
      const result = { was, headers: [], rows: [] };
      if (grid) {
        const headerRow = [...grid.rows].find((r) => r.querySelector('th')) ?? grid.rows[0];
        result.headers = [...headerRow.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
        const re = new RegExp(`[?&]${spec.rowLink?.param || 'AutoID'}=(\\d+)`, 'i');
        result.rows = [...grid.rows]
          .filter((r) => r !== headerRow && r.cells.length >= result.headers.length - 1)
          .map((r) => ({
            cells: [...r.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
            linkId: (r.querySelector(spec.rowLink?.selector || 'a[href*="AutoID="]')?.getAttribute('href') || '').match(re)?.[1] ?? null,
          }));
      } else if (!/no (vehicles|records|results)/i.test(doc.body.textContent)) {
        result.error = 'the inventory grid was not in the answer';
      }
      // Back to what the user had.
      try {
        if (field(doc, filter.name)?.value !== was.filter) doc = await postBack(doc, filter.name, was.filter);
        if (field(doc, pageSize.name)?.value !== was.pageSize) doc = await postBack(doc, pageSize.name, was.pageSize);
      } catch (e) {
        result.restoreError = String((e && e.message) || e);
      }
      return result;
    } catch (e) {
      return { error: e && e.name === 'AbortError' ? `no answer within ${Math.round((timeoutMs || 60_000) / 1000)}s` : String((e && e.message) || e) };
    }
  })();
}

// The read makes up to five page loads of FETCH_MS each; the call into the
// page is bounded too and made once more when it got no answer.
const FETCH_MS = 60_000;
async function inPage(where, func, args) {
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const results = await execScript({ target: where, world: 'MAIN', func, args }, { timeoutMs: 5 * FETCH_MS + 15_000 })
      .catch((e) => [{ result: { error: e.message, noAnswer: true } }]);
    result = results?.[0]?.result ?? { error: 'no answer from the CRM tab (is it open and loaded?)', noAnswer: true };
    if (!result?.noAnswer || /cancelled/.test(result.error || '')) break;
  }
  return result;
}

// One grid row -> { key: value } by the grid's captions; the row's link gives the vehicle's id.
export function mapGridRow(row, headers, spec = {}) {
  const skip = new Set((spec.skipColumns ?? []).map((c) => c.toLowerCase()));
  const kept = headers.map((h) => (skip.has(h.toLowerCase()) ? '' : h));
  const fields = {};
  for (const { index, key } of columnsFromHeaders(kept, spec.columns ?? {})) {
    const value = String(row.cells?.[index] ?? '').trim();
    if (value) fields[key] = value;
  }
  if (row.linkId && spec.rowLink?.key) fields[spec.rowLink.key] = row.linkId;
  return fields;
}

// Captures the inventory of the dealer the session is on. hooks: onNote,
// onData(fields), onRecord({ record }), isCancelled. Returns { found,
// captured, failed, failedStores } like the other captures.
export async function captureInventoryGrid({ tabId, frameId = null, origin, api, hooks = {} }) {
  const { onNote = () => {}, onData = () => {}, onRecord = async () => {}, isCancelled = () => false } = hooks;
  const where = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  const spec = api.inventory;
  // The page lists the dealer the session is on: named only when the user has just one.
  const store = spec.store ?? (api.stores?.length === 1 ? api.stores[0] : {});
  const tag = store.name || (store.companyId != null ? String(store.companyId) : '');
  const pageUrl = `${origin.replace(/\/+$/, '')}${spec.pagePath}`;
  const stats = { found: 0, captured: 0, failed: 0, failedStores: [] };

  const res = await inPage(where, gridInPage, [pageUrl, spec, FETCH_MS]);
  if (res.error) {
    onNote(`${tag ? `[${tag}] ` : ''}Inventory could not be read (${res.error}).`);
    stats.failedStores.push({ ...store, name: tag, reason: res.error });
    return stats;
  }
  for (const row of res.rows) {
    if (isCancelled()) break;
    stats.found++;
    const fields = mapGridRow(row, res.headers, spec);
    const recordId = fields.vin || fields.stock_number || fields.vehicle_id || '';
    if (!recordId) {
      stats.failed++;
      continue;
    }
    const pageOf = spec.rowLink?.detailPage && fields.vehicle_id ? `${origin}${spec.rowLink.detailPage.replace('{id}', fields.vehicle_id)}` : pageUrl;
    onData(fields);
    await onRecord({ record: { fields, collections: {}, pageUrl: pageOf, recordId, dataset: spec.dataset || 'vehicles', store: tag || null } });
    stats.captured++;
  }
  onNote(`${tag ? `[${tag}] ` : ''}Vehicles: ${stats.captured} read from ${spec.entity || 'the inventory'} ("${spec.postback.filter.value}").`);
  onNote(res.restoreError
    ? `Could not set the inventory page back to "${res.was.filter}", ${res.was.pageSize} per page (${res.restoreError}); set it again on the page.`
    : `The inventory page is back to "${res.was.filter}", ${res.was.pageSize} per page.`);
  return stats;
}
