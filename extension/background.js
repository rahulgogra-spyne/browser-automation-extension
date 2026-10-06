// Service worker: "Capture whole CRM" and nothing else.
//
// The CRM layouts (where each field, tab, panel and message list lives) are
// bundled in config/crm-structures.json. A capture walks every mapped list
// of the CRM page after page, opens each record in a work tab, reads it with
// the saved rules (no AI, no server), logs every value it read and saves the
// rows to today's CSV files as it goes.
import { STANDARD_KEYS } from './lib/columns.js';
import { getSettings } from './lib/settings.js';
import { upsertRows, addMessages, listDays, getDay } from './lib/store.js';
import { toCsv, csvFileName } from './lib/csv.js';
import { normalizeValue } from './lib/normalize.js';
import { MESSAGE_COLUMNS } from './lib/messages.js';
import { buildCapture } from './lib/capture.js';
import { findCrm, findPageType, assessExtraction, describeProblems, urlKey } from './lib/crm-config.js';
import { localDateKey, localTimestamp } from './lib/dates.js';
import { detectSite } from './lib/site.js';
import { writeCsvFile } from './lib/sinks/local-downloads.js';
import { nextPageUrl, isPagedUrl } from './lib/paging.js';
import { followScriptLinks } from './lib/follow-links.js';
import { adoptOpenedTab } from './lib/opened-tabs.js';
import { DATASETS, OTHER_DATASET, datasetById, datasetOfPageType, datasetsOfCrm, rowTitle } from './lib/datasets.js';
import { referenceRows, REFERENCE_COLUMNS } from './lib/reference.js';

const MAX_MESSAGE_PAGES = 15; // per record, when messages have pages of their own
const MAX_PAGES_PER_LIST = 200;
const MAX_RECORDS_PER_RUN = 5000;
const MAX_LOG_LINES = 4000; // the log holds every value read; the CSV holds all of it anyway
const LOG_VALUE_CHARS = 300; // long bodies are cut in the log, never in the CSV

// ------------------------------------------------------------- the layouts

// The bundled CRM structure config: one entry per CRM, with its page types.
let configPromise = null;
function getCrmConfig() {
  configPromise ??= fetch(chrome.runtime.getURL('config/crm-structures.json'))
    .then((r) => r.json())
    .catch((error) => {
      configPromise = null;
      throw new Error(`The bundled CRM layouts could not be read: ${error.message}`);
    });
  return configPromise;
}

const listCrms = async () => {
  const config = await getCrmConfig();
  return Object.entries(config.crms ?? {})
    .filter(([, c]) => (c.pageTypes ?? []).length)
    .map(([id, c]) => ({ id, name: c.name, version: c.version, hosts: c.match?.hosts ?? [], datasets: datasetsOfCrm(c), lists: c.pageTypes.filter((pt) => pt.role === 'list' || pt.role === 'screen').length }));
};

// ------------------------------------------------------------- messaging

const handlers = {
  captureCrm,
  cancelCapture: async () => {
    cancelRequested = true;
    return {};
  },
  bulkStatus: async () => {
    const { bulk } = await chrome.storage.session.get('bulk');
    return { bulk: bulk ?? null };
  },
  // A finished job is cleared so the capture window returns to idle.
  clearJobs: async () => {
    const { bulk } = await chrome.storage.session.get('bulk');
    if (bulk && bulk.status !== 'running') await chrome.storage.session.remove('bulk');
    return {};
  },
  listCrms: async () => ({ crms: await listCrms() }),
  // The CRM page the user is working in (the most recently used web tab),
  // and what the layouts know about it.
  activeSite: async () => {
    const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/i.test(t.url || '') && t.url !== CONSOLE_URL);
    const tab = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (!tab) return { site: null };
    const crm = findCrm(await getCrmConfig(), tab.url);
    const page = crm && findPageType(crm.crm, tab.url);
    return {
      site: {
        tabId: tab.id,
        url: tab.url,
        host: new URL(tab.url).host,
        name: crm ? crm.crm.name : detectSite(tab.url),
        crmId: crm?.id ?? null,
        version: crm?.crm.version ?? 0,
        role: page?.pageType.role ?? null,
        lists: crm ? crm.crm.pageTypes.filter((pt) => pt.role === 'list' || pt.role === 'screen').length : 0,
        datasets: crm ? datasetsOfCrm(crm.crm) : [],
      },
    };
  },
  openConsole: async () => ({ windowId: await ensureConsoleWindow() }),
  // The list on the CRM tab the user set up (menus clicked, Search pressed):
  // its grid is learned and read page after page, in that tab.
  captureHere,
  // Whether the CRM tab shows a data grid now, for the capture window.
  tabGrid: async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !/^https?:/i.test(tab.url || '')) return { grid: null };
    const found = (await inFrames(tabId, () => {
      const rt = window.__crmRuntime;
      const t = rt?.describeTable?.();
      return t && rt.isDataGrid(t.spec) ? { headers: t.spec.headers, count: t.count } : null;
    }))
      .map((f) => f.result)
      .filter(Boolean)
      .sort((a, b) => b.count - a.count)[0];
    const loader = (await inFrames(tabId, () => window.__crmRuntime?.describeLoader?.() ?? null)).map((f) => f.result).find(Boolean) ?? null;
    return { grid: found ? { ...found, dataset: guessDataset(found.headers) } : null, loader: loader?.text ?? null };
  },
  writeDay,
  status,
  listDays: async () => ({ days: await listDays() }),
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error.message }),
  );
  return true; // keep the channel open for the async response
});

// The toolbar icon opens the capture window.
chrome.action.onClicked.addListener(() => ensureConsoleWindow().catch(() => {}));

// Row updates and file rewrites run one at a time so two quick saves can't
// interleave their read-modify-write.
let queue = Promise.resolve();
function serialized(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

const humanize = (key) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
// Show names and contact details first instead of alphabetical order.
const KEY_ORDER = new Map(STANDARD_KEYS.map((key, i) => [key, i]));
const byStandardOrder = (a, b) => (KEY_ORDER.get(a.key) ?? KEY_ORDER.size) - (KEY_ORDER.get(b.key) ?? KEY_ORDER.size);
const nonEmpty = (collections = {}) => Object.fromEntries(Object.entries(collections).filter(([, list]) => list.length));

const toRecord = (result) => ({
  fields: Object.entries(result.fields)
    .map(([key, value]) => ({ key, label: humanize(key), value: normalizeValue(key, value), check: 'verified' }))
    .sort(byStandardOrder),
  collections: nonEmpty(result.collections),
});

const matchesType = (pageType, url) => {
  try {
    return new RegExp(pageType.urlRegex).exec(urlKey(url));
  } catch {
    return null;
  }
};

// ------------------------------------------------- the whole CRM

let bulkInProgress = null;
let cancelRequested = false;

// One capture run; its stats are what the capture window shows.
function startRun({ crmId, name, phase }) {
  const stats = {
    status: 'running', crmId, name, startedAt: Date.now(),
    lists: 0, pages: 0, found: 0, total: 0, captured: 0, partial: 0, failed: 0, saved: 0, messages: 0,
    byKind: {}, byStore: {}, files: [], phase, log: [], recent: [],
  };
  const note = (line) => {
    stats.log.push(`${new Date().toLocaleTimeString()}  ${line}`);
    if (stats.log.length > MAX_LOG_LINES) stats.log.splice(0, stats.log.length - MAX_LOG_LINES);
  };
  // Data lines sit under the record's line, indented, with no time stamp.
  const data = (lines) => {
    for (const line of lines) stats.log.push(`            ${line}`);
    if (stats.log.length > MAX_LOG_LINES) stats.log.splice(0, stats.log.length - MAX_LOG_LINES);
  };
  return { stats, note, data, seen: new Set(), grids: new Set(), pending: [], publish: () => chrome.storage.session.set({ bulk: stats }) };
}

const cut = (value) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > LOG_VALUE_CHARS ? `${s.slice(0, LOG_VALUE_CHARS)}…` : s;
};

// Every value read from a record, one line each, then every message.
// fields: { key: value } or [{ key, value }]; collections: { list: [entry] }.
function describeRecord(fields, collections = {}) {
  const pairs = Array.isArray(fields) ? fields.map((f) => [f.key, f.value]) : Object.entries(fields);
  const lines = pairs.filter(([, v]) => String(v ?? '').trim()).map(([k, v]) => `${k}: ${cut(v)}`);
  for (const [list, entries] of Object.entries(collections)) {
    entries.forEach((entry, i) => {
      const head = [entry.channel, entry.timestamp || entry.date || entry.time, entry.direction, entry.sender || entry.from || entry.author].filter(Boolean).join(' · ');
      const subject = entry.subject || entry.title || '';
      const body = entry.body || entry.text || entry.message || entry.note || entry.content || '';
      lines.push(`[${list.replace(/_/g, ' ')} ${i + 1}] ${head}${subject ? ` — ${cut(subject)}` : ''}${body ? ` — ${cut(body)}` : ''}`);
    });
  }
  return lines;
}

async function flushRun(run, ctx) {
  if (!run.pending.length) return;
  const batch = run.pending;
  run.pending = [];
  const result = await save({ records: batch, meta: { site: ctx.crm.name, pageTitle: '' } });
  run.stats.saved += batch.length;
  run.stats.messages = result.messages;
  run.stats.files = [...new Set([...run.stats.files, ...(result.files ?? [])])];
  run.note(`Saved ${batch.length} record(s) → ${(result.files ?? []).join(', ')}${result.fileError ? ` (${result.fileError})` : ''}`);
  if (result.fileError) run.stats.fileError = result.fileError;
}

async function finishRun(run, ctx, error = null) {
  const { stats } = run;
  try {
    await flushRun(run, ctx);
  } catch (flushError) {
    error = error ?? flushError;
  }
  stats.status = error ? 'failed' : cancelRequested ? 'cancelled' : 'done';
  if (error) stats.error = error.message;
  stats.phase = '';
  stats.finishedAt = Date.now();
  const kinds = Object.entries(stats.byKind).map(([kind, n]) => `${n} ${kind}`).join(', ');
  run.note(error ? `Failed: ${error.message}` : `${stats.status}: ${stats.captured} captured (${kinds || 'nothing'}), ${stats.saved} saved, ${stats.messages} messages`);
  await run.publish();
  return stats;
}

// Every record behind every mapped list of a CRM, page after page, each read
// with the saved layout and saved to the day's files as it goes. Runs in the
// background; the capture window follows it through bulkStatus and can
// cancel it. startUrl: the page the user is on (a list to start from).
async function captureCrm({ crmId, startUrl = null }) {
  if (bulkInProgress) throw new Error(`Already capturing ${bulkInProgress}. Wait for it or cancel it.`);
  const settings = await getSettings();
  const config = await getCrmConfig();
  const crm = config.crms?.[crmId];
  if (!crm) throw new Error('No layout is bundled for this CRM.');
  const recordTypes = crm.pageTypes.filter((pt) => pt.role === 'record');
  const screens = crm.pageTypes.filter((pt) => pt.role === 'screen' && pt.validation?.ok !== false);
  if (!recordTypes.length && !screens.length) throw new Error('No layout is mapped for this CRM.');
  let lists = crm.pageTypes.filter((pt) => pt.role === 'list');
  // No list mapped: walk from the page the user is on, page after page,
  // taking every link into a mapped record (its items are found by shape).
  if (!lists.length && !screens.length && startUrl && recordTypes.length) lists = [{ id: 'current_page', entity: recordTypes[0].entity, recordPageType: recordTypes[0].id, items: null, samples: [startUrl] }];
  if (!lists.length && !screens.length) throw new Error('No list is mapped for this CRM. Open one of its lists (users, contacts, leads…) and capture from there.');
  bulkInProgress = crm.name;
  cancelRequested = false;
  await ensureConsoleWindow();
  const run = startRun({ crmId, name: crm.name, phase: 'Collecting records…' });
  run.note(`Capturing ${crm.name} with layout v${crm.version}: ${lists.length} list(s), ${screens.length} screen(s)`);
  await run.publish();
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  const ctx = { crmId, crm, settings };
  try {
    if (lists.length) await captureLists(run, ctx, lists, { startUrl });
    if (screens.length) await captureScreens(run, ctx, screens);
    return await finishRun(run, ctx);
  } catch (error) {
    await finishRun(run, ctx, error);
    throw error;
  } finally {
    clearInterval(keepAlive);
    bulkInProgress = null;
    await endJob();
  }
}

// Walks each list page after page and captures every record it links to.
async function captureLists(run, ctx, lists, { startUrl = null } = {}) {
  const { stats, note, seen } = run;
  stats.lists += lists.length;
  for (const list of lists) {
    if (cancelRequested) break;
    const recordType = ctx.crm.pageTypes.find((pt) => pt.id === list.recordPageType);
    if (!recordType) continue;
    const kind = datasetOfPageType(recordType, ctx.crm);
    const queue = [];
    let url = startUrl && (list.items ? matchesType(list, startUrl) : true) ? startUrl : list.samples?.[0];
    const listSeen = new Set();
    // Queues the records a page's entries link to; how many were new.
    const take = (entries) => {
      let fresh = 0;
      for (const entry of entries) {
        const match = entry.link && matchesType(recordType, entry.link);
        if (!match) continue;
        const id = `${recordType.id}:${match[1] || entry.link}`;
        if (seen.has(id)) continue;
        seen.add(id);
        fresh++;
        queue.push({ url: entry.link, title: entry.title || '', recordTypeId: recordType.id, recordId: match[1] ?? '' });
      }
      stats.found += fresh;
      return fresh;
    };
    for (let pageNo = 0; url && pageNo < MAX_PAGES_PER_LIST && !cancelRequested; pageNo++) {
      if (listSeen.has(url)) break;
      listSeen.add(url);
      stats.pages++;
      stats.phase = `Reading the ${list.entity || 'record'} list (${kind}), page ${pageNo + 1}: ${queue.length} found`;
      note(`${stats.phase} — ${url}`);
      await run.publish();
      const page = await withBackgroundTab(url, async (tab) => {
        const paged = isPagedUrl(url);
        let read = await readListPage(tab.id, list.items, { expand: !paged });
        let fresh = take(read.entries);
        // Paged by its address or by a "next" link: the next page is opened by
        // the loop around. Otherwise a "next" button (a script-driven pager, an
        // ASP.NET postback) is pressed right here, page after page.
        if (paged || read.next || !read.pager) return { ...read, fresh };
        let pages = 1;
        let total = fresh;
        while (fresh && pageNo + pages < MAX_PAGES_PER_LIST && stats.found < MAX_RECORDS_PER_RUN && !cancelRequested) {
          const before = entrySignature(read.entries);
          if (!(await pressListNext(tab.id, list.items.container))) break;
          read = await readListPage(tab.id, list.items, { expand: false });
          if (entrySignature(read.entries) === before) break; // "next" changed nothing: the last page
          pages++;
          stats.pages++;
          fresh = take(read.entries);
          total += fresh;
          stats.phase = `Reading the ${list.entity || 'record'} list (${kind}), page ${pageNo + pages} (by its "next" button): ${queue.length} found`;
          note(stats.phase);
          await run.publish();
        }
        return { ...read, fresh: total, byButton: true };
      });
      if (page.expanded) note(`Expanded the list in place (${page.expanded} rounds of "show more"/scrolling)`);
      if (page.byButton) break; // every page was read in the tab
      if (!page.fresh || stats.found >= MAX_RECORDS_PER_RUN) break; // last page reached (or repeated)
      // Next page: computed from the URL when it is paged, else the pager's link.
      url = isPagedUrl(url) ? nextPageUrl(url, { pageSizeHint: page.entries.length }) : page.next;
    }
    note(`${queue.length} ${kind} to capture from the ${list.entity || 'record'} list`);
    await captureItems(run, ctx, queue);
  }
}

// One page of a list in a tab: { entries, next (a "next" link's address),
// pager (a "next" control near the list), expanded }. expand: a list with no
// pager at all may grow in place ("Show more", infinite scroll); it is
// expanded fully first. spec null: an unmapped page offers every link on it.
async function readListPage(tabId, spec, { expand }) {
  await inject(tabId, ['content/crm-runtime.js']); // again: a postback reloads the page
  const results = await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: async (spec, expand) => {
        const rt = window.__crmRuntime;
        if (!rt) return null;
        const near = spec?.container ?? '';
        const pager = Boolean(near) && rt.hasNext({ near });
        let expanded = 0;
        if (expand && !rt.nextPageLink() && !pager) expanded = await rt.expandAll({ rows: spec ? `${spec.container} ${spec.item.replace(/^:scope\s*>?\s*/, '')}` : null });
        rt.snapshot();
        const entries = spec ? rt.readCollection(spec) : rt.pageLinks().map((l) => ({ link: l.url, title: l.text }));
        return { entries, next: rt.nextPageLink(), pager, expanded };
      },
      args: [spec, expand],
    })
    .catch(() => []);
  return results.map((r) => r.result).find((r) => r?.entries?.length) ?? results.map((r) => r.result).find(Boolean) ?? { entries: [], next: null, pager: false };
}

const entrySignature = (entries) => entries.slice(0, 3).map((e) => e.link || e.title || '').join('\n');

// Presses the "next" control near a list (near: the list's selector) and
// waits for what it started: a fetch, or a whole new page when the pager
// posts the form back. Whether there was one to press.
async function pressListNext(tabId, near) {
  const pressed = (await inFrames(tabId, (sel) => window.__crmRuntime?.pressNext?.({ near: sel }) ?? false, [near])).some((f) => f.result);
  if (!pressed) return false;
  if (!(await followScriptLinks(tabId))) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if ((await chrome.tabs.get(tabId)).status === 'loading') await waitForTabLoad(tabId).catch(() => {});
  }
  await settleTab(tabId);
  return true;
}

// Reads each record with its layout, logs every value read, and saves every
// few records so nothing is lost. A record the layout does not fully fit
// (a missing tab or required field) is still saved with whatever was read.
async function captureItems(run, ctx, items) {
  const { stats, note, data } = run;
  stats.total += items.length;
  for (const item of items) {
    if (cancelRequested) break;
    stats.phase = `Capturing ${stats.captured + stats.failed + 1} of ${stats.total}${item.title ? `: ${item.title}` : ''}`;
    await run.publish();
    const recordType = ctx.crm.pageTypes.find((pt) => pt.id === item.recordTypeId);
    const kind = datasetOfPageType(recordType, ctx.crm);
    try {
      const result = await withBackgroundTab(item.url, (tab) => captureRecord(tab.id, ctx.crm, recordType));
      const verdict = assessExtraction(recordType, result);
      if (!result || !Object.keys(result.fields).length) throw new Error(`nothing read (${describeProblems(verdict) || 'no fields'})`);
      const record = toRecord(result);
      const store = item.store ?? ctx.store ?? null;
      run.pending.push({ fields: Object.fromEntries(record.fields.map((f) => [f.key, f.value])), collections: record.collections, pageUrl: item.url, recordId: item.recordId, dataset: kind, store });
      stats.captured++;
      if (!verdict.ok) stats.partial++;
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
      if (store) stats.byStore[store] = (stats.byStore[store] ?? 0) + 1;
      const name = rowTitle(record.fields) || item.title || item.url;
      const messages = Object.values(record.collections).reduce((n, l) => n + l.length, 0);
      stats.recent.unshift({ name, kind, store, fields: record.fields.length, messages, url: item.url, partial: !verdict.ok });
      if (stats.recent.length > 60) stats.recent.pop();
      note(`Captured ${name} (${kind}${store ? `, ${store}` : ''}): ${record.fields.length} fields, ${messages} messages${verdict.ok ? '' : ` — layout did not fully fit (${describeProblems(verdict)})`} — ${item.url}`);
      data(describeRecord(record.fields, record.collections));
    } catch (error) {
      stats.failed++;
      note(`Failed ${item.title || item.url}: ${error.message}`);
    }
    if (run.pending.length >= 10) await flushRun(run, ctx);
    await run.publish();
  }
  await flushRun(run, ctx);
}

// Runs func in every frame of the tab; [{ frameId, result }].
async function inFrames(tabId, func, args = []) {
  await inject(tabId, ['content/crm-runtime.js']);
  // Framework click handlers leave no trace in the DOM: mark them from the page's world.
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/mark-handlers.js'], world: 'MAIN' }).catch(() => {});
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
    return results.map((r) => ({ frameId: r.frameId, result: r.result }));
  } catch {
    return [];
  }
}

// Waits for what a click started: twice, because the first wait may end when
// a frame is replaced by the page the click loads into it.
async function settleTab(tabId) {
  await followScriptLinks(tabId); // a javascript: link the click only marked
  for (const minMs of [1200, 300]) {
    await inFrames(tabId, (ms) => window.__crmRuntime?.waitQuiet({ quietMs: 1000, timeoutMs: 20000, minMs: ms }), [minMs]);
    // The click opened its page in a new tab (an application card): load it here instead.
    const opened = minMs === 1200 && (await adoptOpenedTab(tabId));
    if (opened) {
      await navigateTab(tabId, opened);
      await inFrames(tabId, () => window.__crmRuntime?.waitQuiet({ quietMs: 1000, timeoutMs: 20000, minMs: 600 }));
      return;
    }
  }
}

const frameWithStep = async (tabId, step) => (await inFrames(tabId, (spec) => window.__crmRuntime?.hasNav?.(spec) ?? false, [step.nav])).find((f) => f.result)?.frameId ?? null;

async function pressStepInTab(tabId, step, tries = 6) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const frameId = await frameWithStep(tabId, step);
    if (frameId !== null) {
      const [pressed] = await chrome.scripting
        .executeScript({ target: { tabId, frameIds: [frameId] }, func: (spec) => window.__crmRuntime.pressNav(spec), args: [step.nav] })
        .catch(() => []);
      if (pressed?.result) {
        await settleTab(tabId);
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

// Click by click from the start page; returns the caption of the step that
// could not be pressed, or null when the screen was reached. A step whose
// next step is already on screen is skipped (the app kept its menu open).
async function replayPathInTab(tabId, path) {
  for (const [i, step] of path.entries()) {
    const next = path[i + 1];
    if (next && (await frameWithStep(tabId, next)) !== null) continue;
    if (!(await pressStepInTab(tabId, step))) return step.label;
  }
  return null;
}

// ----------------------------------------- loading and learning a grid
//
// A screen's saved grid may read nothing: the screen shows no rows until a
// search is run, or the mapping caught the wrong table (a date picker). Then
// the Search/Find/Go button on screen is pressed, and the biggest grid with
// column headers is learned on the spot, its columns named from the headers.
// What was learned is kept (chrome.storage.local) for the next run.

// Column headers -> row keys. Common captions map to the standard keys;
// anything else becomes a slug of the caption.
const HEADER_KEYS = [
  [/^(full )?name$|^customer( name)?$|^contact( name)?$|^prospect( name)?$|^client$/i, 'full_name'],
  [/^first( name)?$/i, 'first_name'], [/^last( name)?$|^surname$/i, 'last_name'],
  [/^e-?mail( address)?$/i, 'email'],
  [/^(cell|mobile|cell phone|mobile phone)$/i, 'phone_mobile'], [/^(home|home phone)$/i, 'phone_home'], [/^(work|work phone|business phone|office)$/i, 'phone_work'], [/^(phone|phone number|telephone|tel)$/i, 'phone'],
  [/^(company|dealer|dealership|organization|organisation|account)$/i, 'company'], [/^(title|job title|position|role)$/i, 'job_title'],
  [/^(address|street|address 1)$/i, 'address'], [/^city$/i, 'city'], [/^(state|province|st)$/i, 'state'], [/^(zip|zip code|postal code|postcode)$/i, 'zip'],
  [/^(salesperson|sales person|sales rep|rep|owner|assigned to|assigned|agent|bdc)$/i, 'salesperson'],
  [/^(source|lead source)$/i, 'lead_source'], [/^(status|lead status|stage)$/i, 'lead_status'],
  [/^(year|yr|model year)$/i, 'vehicle_year'], [/^make$/i, 'vehicle_make'], [/^model$/i, 'vehicle_model'], [/^vin$/i, 'vin'], [/^(stock|stock ?#|stock no\.?|stock number)$/i, 'stock_number'],
  [/^(price|retail|retail price|list price|asking)$/i, 'price'], [/^(mileage|miles|odometer)$/i, 'mileage'],
  [/^(date|created|created on|date created|added)$/i, 'date'], [/^(notes?|comments?)$/i, 'notes'],
  [/^(login|user ?name|user id|userid)$/i, 'login'], [/^(last login|last signed in)$/i, 'last_login'], [/^(department|dept)$/i, 'department'],
];
const slugKey = (header) => header.toLowerCase().replace(/#/g, ' number ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
function columnsFromHeaders(headers) {
  const used = new Set();
  const columns = [];
  headers.forEach((header, index) => {
    const caption = String(header ?? '').trim();
    if (!caption || /^(image|photo|pic|select|actions?|)$/i.test(caption)) return;
    let key = HEADER_KEYS.find(([re]) => re.test(caption))?.[1] ?? slugKey(caption);
    if (!key) return;
    if (used.has(key)) key = `${key}_${index + 1}`;
    used.add(key);
    columns.push({ index, key });
  });
  return columns;
}

// Which kind of data a grid holds, from its headers.
function guessDataset(headers) {
  const h = headers.map((x) => String(x).toLowerCase());
  const has = (re) => h.some((x) => re.test(x));
  if (has(/^vin$|^stock|^mileage|^odometer/)) return 'vehicles';
  if (has(/login|user ?name|last login|permission/)) return 'users';
  if (has(/^(deal|opportunity|quote)|amount|close date/)) return 'deals';
  if (has(/^(appointment|appt)|^start|^end time/)) return 'appointments';
  if (has(/^(task|due|due date|priority)/)) return 'tasks';
  if (has(/e-?mail|phone|cell|mobile|^name$|customer|contact|prospect|lead/)) return 'customers';
  return 'other';
}

const learnedKey = (crmId, screenId) => `${crmId}:${screenId}`;
async function getLearnedGrid(crmId, screenId) {
  const { learnedGrids = {} } = await chrome.storage.local.get('learnedGrids');
  return learnedGrids[learnedKey(crmId, screenId)] ?? null;
}
async function saveLearnedGrid(crmId, screenId, table) {
  const { learnedGrids = {} } = await chrome.storage.local.get('learnedGrids');
  learnedGrids[learnedKey(crmId, screenId)] = { table, learnedAt: new Date().toISOString() };
  await chrome.storage.local.set({ learnedGrids });
}

// Learns the grid on screen now: the frame with the most data rows wins.
// { container, row, headers, offset, columns } or null.
async function learnGridInTab(tabId) {
  const found = (await inFrames(tabId, () => {
    const rt = window.__crmRuntime;
    const t = rt?.describeTable?.();
    return t && rt.isDataGrid(t.spec) ? { spec: t.spec, count: t.count } : null;
  }))
    .map((f) => f.result)
    .filter(Boolean)
    .sort((a, b) => b.count - a.count)[0];
  if (!found) return null;
  return { ...found.spec, columns: columnsFromHeaders(found.spec.headers) };
}

// Replays a screen's load steps (after its path): { click: { css?, text } },
// { fill: { css?, label?, value, enter? } }, { wait: ms }. The caption of a
// step that could not be done, or null.
async function replayLoadSteps(tabId, steps = []) {
  for (const step of steps) {
    if (step.wait) {
      await new Promise((r) => setTimeout(r, step.wait));
      continue;
    }
    if (step.fill) {
      const done = (await inFrames(tabId, (spec) => window.__crmRuntime?.fillField?.(spec) ?? false, [step.fill])).some((f) => f.result);
      if (!done) return `fill ${step.fill.label || step.fill.css}`;
      continue;
    }
    if (step.click) {
      const done = (await inFrames(tabId, (spec) => window.__crmRuntime?.pressNav?.(spec, { toggle: true }) ?? false, [step.click])).some((f) => f.result);
      if (!done) return `click ${step.click.text || step.click.css}`;
      await settleTab(tabId);
    }
  }
  return null;
}

// Reads the grid of a screen in a tab. The saved grid first (a learned one
// from a previous run before it); when that reads nothing, the Search button
// on screen is pressed and the grid learned afresh. Returns { table, read,
// learned, pressed } with read = { rows, signature }, or null.
async function loadGrid(tabId, ctx, screen, { note, pressFirst = false }) {
  // After a store switch the grid may still show the previous store's rows: run the search again first.
  if (pressFirst) {
    const pressed = (await inFrames(tabId, () => window.__crmRuntime?.pressLoader?.() ?? null)).map((f) => f.result).find(Boolean) ?? null;
    if (pressed) {
      note(`"${screen.entity}": pressed "${pressed.text}" to load this store's data`);
      await settleTab(tabId);
    }
  }
  const readWith = async (table) => (await inFrames(tabId, (spec) => window.__crmRuntime?.readTable?.(spec) ?? null, [table])).map((f) => f.result).find((r) => r?.rows?.length) ?? null;
  const usable = (table) => table && (table.columns?.length ?? 0) > 0 && !/datepicker|calendar/i.test(table.container || '') && !(table.headers?.length >= 5 && table.headers.every((h) => /^(su|mo|tu|we|th|fr|sa|s|m|t|w|f)$/i.test(h)));
  const learnedBefore = ctx.crmId && screen.id ? await getLearnedGrid(ctx.crmId, screen.id) : null;
  const saved = [learnedBefore?.table, screen.table].filter(usable);
  for (const table of saved) {
    const read = await readWith(table);
    if (read) return { table, read, learned: table === learnedBefore?.table, pressed: null };
  }
  if (saved.length) note(`"${screen.entity}": the grid shows no rows yet`);
  else if (screen.table) note(`"${screen.entity}": the saved grid (${(screen.table.headers ?? []).slice(0, 7).join(', ')}) is not a data grid`);
  // A data grid already on screen (the user ran the search) is learned as is;
  // otherwise Search / Find / Go / Show is pressed first, then it is learned.
  const learn = async (pressed) => {
    const table = await learnGridInTab(tabId);
    const read = table && (await readWith(table));
    if (!read) return null;
    note(`"${screen.entity}": learned the grid on screen: ${read.rows.length} rows, columns ${table.columns.map((c) => c.key).join(', ')}`);
    if (ctx.crmId && screen.id && !screen.adHoc) await saveLearnedGrid(ctx.crmId, screen.id, table);
    return { table, read, learned: true, pressed };
  };
  const onScreen = await learn(null);
  if (onScreen) return onScreen;
  const pressed = (await inFrames(tabId, () => window.__crmRuntime?.pressLoader?.() ?? null)).map((f) => f.result).find(Boolean) ?? null;
  if (!pressed) {
    note(`"${screen.entity}": no data grid and no Search button on screen`);
    return null;
  }
  note(`"${screen.entity}": pressed "${pressed.text}" to load the data`);
  await settleTab(tabId);
  for (const table of saved) {
    const read = await readWith(table);
    if (read) return { table, read, learned: false, pressed: pressed.text };
  }
  return learn(pressed.text);
}

// ----------------------------------------- records that open in place
//
// A screen's rows may hold no link: its detail layout reads the drawer or
// dialog a row click opens (readRowInPlace), or its rowOpen says what to
// click to reach the record's page, whose address is then noted and the
// list brought back (openRowPage).

const EMPTY_RESULT = (error) => ({ fields: {}, collections: {}, views: [], errors: [{ view: 'panel', error }], notes: [] });
const normalizeFields = (fields) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, normalizeValue(key, value)]));

// A shorter wait than settleTab, for a click that only closes something.
async function settleQuick(tabId) {
  await followScriptLinks(tabId);
  await inFrames(tabId, () => window.__crmRuntime?.waitQuiet({ quietMs: 500, timeoutMs: 8000, minMs: 300 }));
}

// Opens row index in place, reads it with the screen's detail layout and
// closes it again. previous: the fields read from the row before; a panel
// still showing them has not caught up with the click yet.
async function readRowInPlace(tabId, crm, screen, index, previous) {
  const { detail } = screen;
  const pressed = (await inFrames(tabId, (spec, i, open) => window.__crmRuntime?.pressRow?.(spec, i, open) ?? false, [screen.table, index, detail.open])).some((f) => f.result);
  if (!pressed) return EMPTY_RESULT('row_not_found');
  await settleTab(tabId);
  const panelType = { ...detail, inPlace: true };
  const same = (r) => Boolean(r && previous && JSON.stringify(r.fields) === JSON.stringify(previous));
  let result = await runInPage(tabId, panelType);
  if (same(result)) {
    await settleTab(tabId);
    result = await runInPage(tabId, panelType);
  }
  if (!result) result = EMPTY_RESULT('panel_not_found');
  else if (same(result)) result.errors.push({ view: 'panel', error: 'panel_not_updated' });
  else await followEntryPages(crm, detail, result);
  if (detail.close) {
    await inFrames(tabId, (spec, panel) => (window.__crmRuntime?.shown?.(panel) ? window.__crmRuntime.pressClose(spec) : false), [detail.close, detail.panel]);
    await settleQuick(tabId);
  }
  return result;
}

const tableSignature = async (tabId, table) =>
  (await inFrames(tabId, (spec) => window.__crmRuntime?.readTable?.(spec) ?? null, [table])).map((f) => f.result).find((r) => r?.rows?.length)?.signature ?? null;

// Back to page pageNo of a screen after a row navigated away: the browser's
// Back first; failing that, from the start again (address, clicks, "next").
async function returnToPage(tabId, screen, startUrl, pageNo, signature) {
  await chrome.tabs.goBack(tabId).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitForTabLoad(tabId).catch(() => {});
  await settleTab(tabId);
  if ((await tableSignature(tabId, screen.table)) === signature) return true;
  await navigateTab(tabId, startUrl);
  await settleTab(tabId);
  if (await replayPathInTab(tabId, screen.path)) return false;
  for (let i = 0; i < pageNo; i++) {
    await pressListNext(tabId, screen.table.container);
  }
  return (await tableSignature(tabId, screen.table)) === signature;
}

// Clicks row index on what opens it; the address it led to, or null.
async function openRowPage(tabId, screen, index) {
  const before = (await chrome.tabs.get(tabId)).url;
  const pressed = (await inFrames(tabId, (spec, i, open) => window.__crmRuntime?.pressRow?.(spec, i, open) ?? false, [screen.table, index, screen.rowOpen])).some((f) => f.result);
  if (!pressed) return null;
  await settleTab(tabId);
  const after = (await chrome.tabs.get(tabId)).url;
  return after !== before ? after : null;
}

// ----------------------------------------- several stores / dealers
//
// A CRM account may hold several dealerships / stores / rooftops whose data
// is separate: a switcher in the header, or a store filter beside the
// search. On every screen (and on "Capture this tab") the switcher is looked
// for; when there is one, the screen is read once per store, each store's
// rows going to their own files. crm.stores in the layout can turn this off
// (false), name the switcher ({ select: { css } } or { menu: { control } }),
// or restrict the stores ({ only: ["Store A", "Store B"] }).

const storeSlug = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// The switcher on screen in tabId: { spec, frameId, entries: [{ text, value?, nav? }] } or null.
async function findStores(tabId, ctx) {
  const config = ctx.crm.stores;
  if (config === false) return null;
  let found = null;
  if (config?.select || config?.menu) {
    const spec = config.select ? { kind: 'select', css: config.select.css } : { kind: 'menu', control: config.menu.control };
    found = { spec, frameId: 0 };
  } else {
    const hits = (await inFrames(tabId, () => window.__crmRuntime?.describeStores?.() ?? null)).filter((f) => f.result);
    const top = hits.find((f) => f.frameId === 0) ?? hits[0];
    if (!top) return null;
    found = { spec: top.result, frameId: top.frameId };
  }
  const inFrame = async (func, args = []) => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [found.frameId] }, func, args }).catch(() => []);
    return r?.result ?? null;
  };
  let entries = [];
  if (found.spec.kind === 'select') {
    if (!found.spec.options) {
      const full = await inFrame((css) => {
        const sel = document.querySelector(css);
        return sel ? [...sel.options].map((o) => ({ value: o.value, text: o.textContent.trim() })).filter((o) => o.text) : [];
      }, [found.spec.css]);
      entries = full ?? [];
    } else entries = found.spec.options;
  } else {
    if (!(await inFrame((control) => window.__crmRuntime?.openStoreMenu?.(control) ?? null, [found.spec.control]))) return null;
    await settleQuick(tabId);
    entries = (await inFrame(() => window.__crmRuntime?.storeMenuItems?.() ?? [])) ?? [];
    await inFrame(() => window.__crmRuntime?.pressClose?.({ key: 'Escape' }));
    await settleQuick(tabId);
  }
  if (Array.isArray(config?.only)) {
    const want = new Set(config.only.map((n) => n.toLowerCase()));
    entries = entries.filter((e) => want.has(e.text.toLowerCase()));
  }
  // One entry is no choice; too many is not a store switcher.
  if (entries.length < 2 || entries.length > 60) return null;
  return { ...found, entries };
}

// Switches the tab to one store. Whether the switch was made.
async function switchStore(tabId, stores, entry) {
  const inFrame = async (func, args = []) => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [stores.frameId] }, func, args }).catch(() => []);
    return r?.result ?? null;
  };
  if (stores.spec.kind === 'menu') {
    if (!(await inFrame((control) => window.__crmRuntime?.openStoreMenu?.(control) ?? null, [stores.spec.control]))) return false;
    await settleQuick(tabId);
  }
  const done = await inFrame((spec, e) => window.__crmRuntime?.selectStore?.(spec, e) ?? false, [stores.spec, { ...entry, force: true }]);
  if (!done) return false;
  await followScriptLinks(tabId);
  await new Promise((r) => setTimeout(r, 400));
  if ((await chrome.tabs.get(tabId).catch(() => null))?.status === 'loading') await waitForTabLoad(tabId).catch(() => {});
  await settleTab(tabId);
  return true;
}

// Reaches a screen in a tab (its path, then its load steps); the caption of
// a step that failed, or null.
async function reachScreen(tabId, screen, note) {
  const stuck = await replayPathInTab(tabId, screen.path ?? []);
  if (stuck) return stuck;
  const undone = await replayLoadSteps(tabId, screen.load ?? []);
  if (undone) note(`"${screen.entity}": the load step "${undone}" could not be done; reading what is on screen`);
  return null;
}

// Reads a screen for every store the tab offers (or once when it offers
// none): switch, come back to the screen, re-run its search, read.
async function walkScreenPerStore(run, ctx, screen, tabId, queue, { kind }) {
  const { note } = run;
  const stores = await findStores(tabId, ctx);
  if (!stores) return walkScreen(run, ctx, screen, tabId, queue, { kind, store: ctx.store ?? null });
  const names = stores.entries.map((e) => e.text);
  if (!run.storesNoted) {
    note(`Found ${names.length} stores/dealers (${stores.spec.kind === 'select' ? `"${stores.spec.caption || 'select'}"` : `menu "${stores.spec.caption}"`}): ${names.join(' · ')}. Each is captured to its own files.`);
    run.storesNoted = true;
  }
  for (const entry of stores.entries) {
    if (cancelRequested) break;
    run.stats.phase = `"${screen.entity}": switching to ${entry.text}`;
    await run.publish();
    if (!(await switchStore(tabId, stores, entry))) {
      note(`Could not switch to ${entry.text}; skipped`);
      continue;
    }
    // The app may have gone back to its home: reach the screen again (steps already on screen are skipped).
    const stuck = await reachScreen(tabId, screen, note);
    if (stuck) {
      note(`${entry.text}: could not get back to "${screen.entity}" ("${stuck}" not found); skipped`);
      continue;
    }
    note(`— ${entry.text} —`);
    await walkScreen(run, ctx, screen, tabId, queue, { kind, store: entry.text, pressFirst: true });
    await flushRun(run, ctx);
  }
}

// Screens of a click-driven CRM (one address for everything): each is the
// path of clicks that leads to it from the start page, optional load steps
// (fill a filter, press Search) and the grid found there. Capturing one
// replays the path in a work tab, loads the grid, reads it, presses "next"
// and reads again. A screen whose grid is the one an earlier screen already
// read (the same grid mapped under several menu detours) is skipped.
async function captureScreens(run, ctx, screens) {
  const { stats, note } = run;
  stats.lists += screens.length;
  for (const screen of screens) {
    if (cancelRequested) break;
    const kind = datasetOfPageType(screen, ctx.crm);
    const startUrl = screen.url || ctx.crm.startUrl;
    const queue = [];
    stats.phase = screen.path?.length ? `Opening "${screen.entity}" (${kind}) by clicking ${screen.path.map((s) => s.label).join(' > ')}` : `Opening "${screen.entity}" (${kind})`;
    note(stats.phase);
    await run.publish();
    try {
      await withBackgroundTab(startUrl, async (tab) => {
        const stuck = await reachScreen(tab.id, screen, note);
        if (stuck) {
          stats.failed++;
          note(`Could not reach "${screen.entity}": "${stuck}" was not found on screen`);
          return;
        }
        await walkScreenPerStore(run, ctx, screen, tab.id, queue, { kind });
      });
    } catch (error) {
      stats.failed++;
      note(`Failed on "${screen.entity}": ${error.message}`);
    }
    await flushRun(run, ctx);
    if (queue.length) {
      note(`${queue.length} ${kind} to capture from the pages the rows of "${screen.entity}" open`);
      await captureItems(run, ctx, queue);
    }
  }
}

// Reads a screen's grid in tabId page after page: each row is saved as a
// record of its kind, or queued (rows that link to a mapped record page),
// or opened in place / by click when the screen says so.
async function walkScreen(run, ctx, screen, tabId, queue, { kind = null, store = null, pressFirst = false } = {}) {
  const { stats, note, data } = run;
  const recordType = screen.recordPageType ? ctx.crm.pageTypes.find((pt) => pt.id === screen.recordPageType) : null;
  const startUrl = screen.url || ctx.crm.startUrl;
  const first = await loadGrid(tabId, ctx, screen, { note, pressFirst });
  if (!first) {
    note(`"${screen.entity}": no data grid on screen (nothing to read)`);
    return;
  }
  const { table } = first;
  if (!kind) {
    kind = guessDataset(table.headers ?? []);
    note(`"${screen.entity}": the grid looks like ${kind} (${(table.headers ?? []).filter(Boolean).slice(0, 8).join(', ')})`);
  }
  const gridId = `${store ?? ''}|${kind}|${table.container}|${(table.headers ?? []).join('|')}|${first.read.signature}`;
  if (run.grids.has(gridId)) {
    note(`"${screen.entity}": the same grid was already read under another screen; skipped`);
    return;
  }
  run.grids.add(gridId);
  const readNow = async () => (await inFrames(tabId, (spec) => window.__crmRuntime?.readTable?.(spec) ?? null, [table])).map((f) => f.result).find((r) => r?.rows?.length) ?? null;
  // A grid with no pager may grow as it is scrolled ("Show more", infinite scroll): all of it first.
  const grown = await inFrames(
    tabId,
    async (spec) => {
      const rt = window.__crmRuntime;
      if (!rt?.tableRows?.(spec) || rt.hasNext({ near: spec.container })) return 0;
      return rt.expandAll({ rows: `${spec.container} ${spec.row ? spec.row.replace(/^:scope\s*>?\s*/, '') : 'tr'}` });
    },
    [table],
  );
  const rounds = Math.max(0, ...grown.map((f) => f.result || 0));
  if (rounds > 1) note(`"${screen.entity}": expanded the grid in place (${rounds} rounds of "show more"/scrolling)`);
  let lastSignature = null;
  for (let pageNo = 0; pageNo < MAX_PAGES_PER_LIST && !cancelRequested; pageNo++) {
    const read = pageNo === 0 && rounds <= 1 ? first.read : await readNow();
    if (!read) break;
    if (read.signature === lastSignature) break; // "next" changed nothing: the last page
    lastSignature = read.signature;
    stats.pages++;
    let taken = 0;
    let previous = null; // the fields the panel showed for the row before
    const toOpen = []; // rows whose record page only a click reaches
    for (const [index, row] of read.rows.entries()) {
      if (cancelRequested) break;
      const fields = row.fields ?? {};
      if (!Object.keys(fields).length) continue;
      const match = recordType && row.link ? matchesType(recordType, row.link) : null;
      if (match) {
        // The row opens a mapped page: that page is captured (it has everything the row shows and more).
        const id = `${recordType.id}:${match[1] || row.link}`;
        if (run.seen.has(id)) continue;
        run.seen.add(id);
        queue.push({ url: row.link, title: rowTitle(fields), recordTypeId: recordType.id, recordId: match[1] ?? '', store });
        stats.found++;
        continue;
      }
      const id = `${store ?? ''}|${screen.id}:${JSON.stringify(fields)}`;
      if (run.seen.has(id)) continue;
      run.seen.add(id);
      if (recordType && screen.rowOpen) {
        toOpen.push({ index, title: rowTitle(fields) });
        continue;
      }
      let record = { fields: normalizeFields(fields), collections: {} };
      let problem = '';
      if (screen.detail) {
        stats.phase = `Reading "${screen.entity}" (${kind}), page ${pageNo + 1}: opening ${rowTitle(fields) || `row ${index + 1}`}`;
        await run.publish();
        const result = await readRowInPlace(tabId, ctx.crm, { ...screen, table }, index, previous);
        if (Object.keys(result.fields).length) previous = result.fields;
        const verdict = assessExtraction(screen.detail, result);
        record = { fields: normalizeFields({ ...fields, ...result.fields }), collections: nonEmpty(result.collections) };
        if (!verdict.ok) {
          problem = describeProblems(verdict);
          stats.partial++;
        }
      }
      run.pending.push({ fields: record.fields, collections: record.collections, pageUrl: row.link || startUrl, dataset: kind, store });
      taken++;
      stats.found++;
      stats.total++;
      stats.captured++;
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
      if (store) stats.byStore[store] = (stats.byStore[store] ?? 0) + 1;
      const name = rowTitle(record.fields) || `row ${index + 1}`;
      const messages = Object.values(record.collections).reduce((n, l) => n + l.length, 0);
      stats.recent.unshift({ name, kind, store, fields: Object.keys(record.fields).length, messages, url: row.link || startUrl, partial: Boolean(problem) });
      if (stats.recent.length > 60) stats.recent.pop();
      note(`Captured ${name} (${kind}${store ? `, ${store}` : ''}) from "${screen.entity}" page ${pageNo + 1}: ${Object.keys(record.fields).length} fields, ${messages} messages${problem ? ` — the panel did not fully fit (${problem})` : ''}`);
      data(describeRecord(record.fields, record.collections));
      if (run.pending.length >= 10) await flushRun(run, ctx);
      await run.publish();
    }
    // Rows that open their record's page by script: note each address, come back.
    let lost = false;
    for (const { index, title } of toOpen) {
      if (cancelRequested) break;
      stats.phase = `Reading "${screen.entity}" (${kind}), page ${pageNo + 1}: finding the page of ${title || `row ${index + 1}`}`;
      await run.publish();
      const url = await openRowPage(tabId, { ...screen, table }, index);
      const opened = url && matchesType(recordType, url);
      if (opened) {
        const id = `${recordType.id}:${opened[1] || url}`;
        if (!run.seen.has(id)) {
          run.seen.add(id);
          queue.push({ url, title, recordTypeId: recordType.id, recordId: opened[1] ?? '', store });
          stats.found++;
        }
      } else note(`${title || `Row ${index + 1}`}: clicking it did not open a ${recordType.entity || 'record'} page`);
      if (url && !(await returnToPage(tabId, { ...screen, table }, startUrl, pageNo, read.signature))) {
        note(`Could not get back to page ${pageNo + 1} of "${screen.entity}"; the rest of the list is skipped`);
        lost = true;
        break;
      }
    }
    if (lost) break;
    stats.phase = `Reading "${screen.entity}" (${kind}), page ${pageNo + 1}: ${taken} rows`;
    note(stats.phase);
    await run.publish();
    if (run.pending.length >= 10) await flushRun(run, ctx);
    if (!(await pressListNext(tabId, table.container))) break;
  }
}

// Captures the list shown on the CRM tab the user prepared: they clicked
// through the menus and pressed Search with the filters they want; the grid
// on screen is learned (no AI) and read page after page in that very tab.
// Rows that link into a mapped record page are captured from their pages.
async function captureHere({ tabId, dataset = null }) {
  if (bulkInProgress) throw new Error(`Already capturing ${bulkInProgress}. Wait for it or cancel it.`);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/i.test(tab.url || '')) throw new Error('Open the CRM list in a tab first.');
  const settings = await getSettings();
  const config = await getCrmConfig();
  const known = findCrm(config, tab.url);
  const host = new URL(tab.url).host;
  const crm = known?.crm ?? { name: detectSite(tab.url), match: { hosts: [host] }, pageTypes: [], startUrl: tab.url };
  const crmId = known?.id ?? host.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const kind = datasetById(dataset)?.id ?? null;
  // Rows linking to a mapped record page of this kind are read from their pages.
  const recordType = crm.pageTypes.find((pt) => pt.role === 'record' && (!kind || datasetOfPageType(pt, crm) === kind)) ?? null;
  const screen = { id: `tab:${new URL(tab.url).pathname}`, entity: tab.title || 'this tab', dataset: kind, path: [], url: tab.url, table: null, adHoc: true, recordPageType: recordType?.id };
  bulkInProgress = `${crm.name} (this tab)`;
  cancelRequested = false;
  await ensureConsoleWindow();
  const run = startRun({ crmId, name: `${crm.name} — the list on the open tab`, phase: 'Reading the grid on the tab…' });
  run.note(`Capturing the list on ${tab.url}`);
  await run.publish();
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  const ctx = { crmId, crm, settings };
  try {
    const queue = [];
    await inject(tab.id, ['content/crm-runtime.js']);
    await walkScreenPerStore(run, ctx, screen, tab.id, queue, { kind });
    await flushRun(run, ctx);
    if (queue.length) {
      run.note(`${queue.length} record(s) to capture from the pages the rows open`);
      await captureItems(run, ctx, queue);
    }
    return await finishRun(run, ctx);
  } catch (error) {
    await finishRun(run, ctx, error);
    throw error;
  } finally {
    clearInterval(keepAlive);
    bulkInProgress = null;
    await endJob();
  }
}

// The saved layout, followed in the page: fields and message lists, plus
// each message's own page when the layout knows one (an email's body).
async function captureRecord(tabId, crm, pageType) {
  const result = await extractWithConfig(tabId, pageType);
  if (!result) return null;
  await followEntryPages(crm, pageType, result);
  return result;
}

// Entries of a record's lists whose full content is on a page of their own
// (an email's body): each page is read with its layout in another work tab,
// and what it shows replaces what the list showed.
async function followEntryPages(crm, pageType, result) {
  for (const view of pageType.views ?? []) {
    for (const [name, spec] of Object.entries(view.collections ?? {})) {
      const messageType = spec.detailPageType && crm.pageTypes.find((pt) => pt.id === spec.detailPageType);
      const entries = (result.collections[name] ?? []).filter((e) => e.link);
      if (!messageType || !entries.length) continue;
      for (const entry of entries.slice(0, MAX_MESSAGE_PAGES)) {
        try {
          const detail = await withBackgroundTab(entry.link, (tab) => extractWithConfig(tab.id, messageType));
          // The message's own page is the authority (the list only showed a subject line).
          for (const [key, value] of Object.entries(detail?.fields ?? {})) if (value) entry[key] = value;
        } catch {
          // the entry keeps what the list showed
        }
      }
    }
  }
}

// ---------------------------------------------------- the capture window

// A capture runs in its own window: the extension's console page as the
// first tab (status, progress, log, what was captured) and one or two work
// tabs beside it in which the CRM pages are loaded one after another. The
// work tabs are reused for the whole job instead of opened and closed for
// every record.
const CONSOLE_URL = chrome.runtime.getURL('console/console.html');
const work = { windowId: null, tabs: [] }; // tabs: [{ id, busy }]

async function ensureConsoleWindow() {
  // By its address among all tabs: a url filter in tabs.query does not match chrome-extension:// pages.
  const existing = (await chrome.tabs.query({})).find((t) => (t.url || t.pendingUrl || '').startsWith(CONSOLE_URL));
  if (existing) {
    work.windowId = existing.windowId;
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    return existing.windowId;
  }
  const win = await chrome.windows.create({ url: CONSOLE_URL, focused: true, width: 1400, height: 900 });
  work.windowId = win.id;
  return win.id;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  work.tabs = work.tabs.filter((t) => t.id !== tabId);
});

// Loads url in a work tab (reused across calls), waits for it to render, runs
// fn(tab) and hands the tab back for the next page.
async function withBackgroundTab(url, fn) {
  let slot = work.tabs.find((t) => !t.busy);
  if (!slot) {
    const windowId = work.windowId && (await chrome.windows.get(work.windowId).catch(() => null)) ? work.windowId : undefined;
    const tab = await chrome.tabs.create({ url, active: false, ...(windowId ? { windowId } : {}) });
    slot = { id: tab.id, busy: true, url };
    work.tabs.push(slot);
    await waitForTabLoad(tab.id);
  } else {
    slot.busy = true;
    slot.url = url;
    await navigateTab(slot.id, url);
  }
  try {
    await inject(slot.id, ['content/crm-runtime.js']);
    await chrome.scripting
      .executeScript({ target: { tabId: slot.id, allFrames: true }, func: () => window.__crmRuntime?.waitQuiet({ quietMs: 1000, timeoutMs: 15000 }) })
      .catch(() => {});
    return await fn({ id: slot.id });
  } finally {
    slot.busy = false;
  }
}

// Closes the work tabs once a job is over (the console tab stays).
async function endJob() {
  const ids = work.tabs.map((t) => t.id);
  work.tabs = [];
  await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {})));
}

// Navigates an existing tab and waits for the NEW page: a tab that was
// "complete" before the navigation would otherwise look loaded at once.
async function navigateTab(tabId, url, timeoutMs = 25_000) {
  let started = false;
  const onUpdated = (id, info) => {
    if (id === tabId && (info.status === 'loading' || info.url)) started = true;
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    await chrome.tabs.update(tabId, { url });
    const t0 = Date.now();
    while (!started && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 50));
    if (started) await waitForTabLoad(tabId, timeoutMs);
    else await new Promise((r) => setTimeout(r, 1500)); // same document (a hash change): give the app time to fetch
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

function waitForTabLoad(tabId, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (id, info) => id === tabId && info.status === 'complete' && done();
    const timer = setTimeout(() => done(new Error('the page took too long to load')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(
      (tab) => tab.status === 'complete' && done(),
      () => done(new Error('the tab is gone')),
    );
  });
}

async function inject(tabId, files) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
  } catch {
    // A frame we can't script (e.g. an error page) can fail the whole call.
    await chrome.scripting.executeScript({ target: { tabId }, files });
  }
}

async function runInPage(tabId, pageType) {
  await inject(tabId, ['content/crm-runtime.js']);
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (pt) => window.__crmRuntime?.extractPage(pt) ?? null,
      args: [pageType],
    });
  } catch {
    return null;
  }
  // Only the frame holding the record answers.
  return results.map((r) => r.result).find((r) => r && r.fields) ?? null;
}

const hasLinkViews = (pageType) => (pageType.views ?? []).some((v) => v.activate?.kind === 'link');

// Reads a page type in a tab: the in-place views, then each link-tab view on
// the page its tab leads to (the tab is navigated there and back).
async function extractWithConfig(tabId, pageType) {
  const result = await runInPage(tabId, pageType);
  if (!result || !hasLinkViews(pageType)) return result;
  const recordUrl = (await chrome.tabs.get(tabId)).url;
  for (const view of pageType.views.filter((v) => v.activate?.kind === 'link')) {
    let href = null;
    try {
      const found = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: (spec) => window.__crmRuntime?.activatorHref(spec) ?? null, args: [view.activate] });
      href = found.map((r) => r.result).find(Boolean) ?? null;
    } catch {
      href = null;
    }
    if (!href) {
      result.errors.push({ view: view.name, error: 'tab_not_found' });
      continue;
    }
    await navigateTab(tabId, href);
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => window.__crmRuntime?.waitQuiet({ quietMs: 1000, timeoutMs: 15000 }) }).catch(() => {});
    const part = await runInPage(tabId, { ...pageType, frame: null, views: [{ ...view, activate: null }] });
    if (!part) result.errors.push({ view: view.name, error: 'tab_page_unreadable' });
    else {
      for (const [key, value] of Object.entries(part.fields)) if (!(key in result.fields)) result.fields[key] = value;
      for (const [name, entries] of Object.entries(part.collections)) if (!result.collections[name]?.length) result.collections[name] = entries;
      result.views.push(view.name);
      result.errors.push(...part.errors);
    }
    await navigateTab(tabId, recordUrl);
  }
  return result;
}

// ------------------------------------------------------------------- saving

// records: [{ fields: { key: value }, collections, pageUrl?, recordId?,
// dataset? }]: one row each in the file of its kind (customers by default),
// plus one message row per collection entry.
async function save({ records = [], meta = {} }) {
  const settings = await getSettings();
  const capturedAt = localTimestamp();
  const byKind = new Map();
  const newMessages = [];
  const byStore = new Map(); // store slug -> messages
  for (const record of records) {
    const wanted = record.dataset ?? meta.dataset ?? 'customers';
    const dataset = datasetById(wanted)?.id ?? OTHER_DATASET;
    const person = DATASETS[dataset]?.person ?? true;
    const store = record.store ?? meta.store ?? '';
    const recordMeta = { ...meta, pageUrl: record.pageUrl || meta.pageUrl, recordId: record.recordId ?? meta.recordId, store };
    const built = await buildCapture({ records: [record], meta: recordMeta, settings, capturedAt, dataset, person });
    if (!built.rows.length) continue;
    const slug = storeSlug(store);
    const key = slug ? `${dataset}@${slug}` : dataset;
    byKind.set(key, [...(byKind.get(key) ?? []), ...built.rows]);
    byStore.set(slug, [...(byStore.get(slug) ?? []), ...built.messages]);
  }
  if (!byKind.size) throw new Error('Nothing to save.');

  const date = localDateKey();
  return serialized(async () => {
    let added = 0;
    let updated = 0;
    for (const [key, rows] of byKind) {
      const [dataset, slug = ''] = key.split('@');
      const result = await upsertRows(date, rows, dataset, { byContact: DATASETS[dataset]?.person ?? true, store: slug });
      added += result.added;
      updated += result.updated;
    }
    let messagesTotal = 0;
    let messagesAdded = 0;
    for (const [slug, list] of byStore) {
      const { messages, added: fresh } = await addMessages(date, list, { store: slug });
      messagesTotal += messages.length;
      messagesAdded += fresh;
    }
    const files = await writeDayFiles(date, settings, { only: [...byKind.keys()] });
    return { date, messages: files.messages, added, updated, messagesAdded, saved: Object.fromEntries([...byKind].map(([k, rows]) => [k, rows.length])), ...files };
  });
}

// Rewrites a day's CSVs from storage (retry after a failed write, or re-export).
async function writeDay({ date }) {
  const settings = await getSettings();
  return serialized(async () => {
    const { count } = await dayCounts(date);
    if (!count) throw new Error(`No captures saved for ${date}.`);
    return { date, ...(await writeDayFiles(date, settings)) };
  });
}

// day.datasets is keyed "kind" or "kind@store"; day.messages by store ('' for none).
async function dayCounts(date) {
  const day = await getDay(date);
  const datasets = Object.fromEntries(Object.entries(day.datasets).map(([key, rows]) => [key, rows.length]));
  const messages = Object.values(day.messages).reduce((n, list) => n + list.length, 0);
  return { day, datasets, count: Object.values(datasets).reduce((a, b) => a + b, 0), messages };
}

// One file per kind of data and store (only: just the keys that changed),
// plus each store's messages and the reference values gathered from its rows.
async function writeDayFiles(date, settings, { only = null } = {}) {
  const { day, datasets, count, messages } = await dayCounts(date);
  const keys = Object.keys(day.datasets).filter((key) => !only || only.includes(key));
  const stores = new Set([...keys.map((k) => k.split('@')[1] ?? ''), ...(only ? only.map((k) => k.split('@')[1] ?? '') : Object.keys(day.messages))]);
  const files = [];
  const jobs = [];
  for (const key of keys) {
    const [kind, slug = ''] = key.split('@');
    const name = csvFileName(settings, date, kind, slug);
    files.push(name);
    jobs.push([name, () => toCsv(day.datasets[key])]);
  }
  let messagesFilename = null;
  for (const slug of stores) {
    const list = day.messages[slug] ?? [];
    if (list.length) {
      const name = csvFileName(settings, date, 'messages', slug);
      messagesFilename ??= name;
      files.push(name);
      jobs.push([name, () => toCsv(list, MESSAGE_COLUMNS)]);
    }
    const rows = referenceRows({ datasets: Object.fromEntries(Object.entries(day.datasets).filter(([k]) => (k.split('@')[1] ?? '') === slug).map(([k, v]) => [k.split('@')[0], v])) });
    if (rows.length) {
      const name = csvFileName(settings, date, 'reference', slug);
      files.push(name);
      jobs.push([name, () => toCsv(rows, REFERENCE_COLUMNS)]);
    }
  }
  const out = { count, datasets, messages, filename: files.filter((f) => !/_(messages|reference)(_|\.)/.test(f.split('/').pop())).join(', '), messagesFilename, files };
  try {
    for (const [name, csv] of jobs) await writeCsvFile(name, csv());
    await chrome.storage.local.remove('lastWriteError');
    if (date === localDateKey()) await showCount(count);
    return out;
  } catch (error) {
    const fileError = `Saved in the extension, but the CSV files for ${date} couldn't be updated: ${error.message}.`;
    await chrome.storage.local.set({ lastWriteError: { date, message: fileError } });
    await chrome.action.setBadgeBackgroundColor({ color: '#d1242f' });
    await chrome.action.setBadgeText({ text: '!' });
    return { ...out, fileError };
  }
}

async function status() {
  const settings = await getSettings();
  const date = localDateKey();
  const { datasets, count, messages } = await dayCounts(date);
  const { lastWriteError } = await chrome.storage.local.get('lastWriteError');
  if (!lastWriteError) await showCount(count);
  // One file per kind: "<prefix>_<kind>_<date>.csv".
  const filename = csvFileName(settings, date, 'KIND', 'STORE').replace('KIND', '<kind>').replace('_STORE', '[_<store>]');
  return { date, count, datasets, messages, filename, files: Object.keys(datasets).map((key) => csvFileName(settings, date, ...key.split('@'))), lastWriteError: lastWriteError ?? null };
}

async function showCount(count) {
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}
