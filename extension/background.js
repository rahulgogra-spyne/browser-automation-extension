// Service worker: reads the page, stores rows and rewrites the day's CSVs.
// The popup and options pages talk to it with chrome.runtime.sendMessage.
//
// Reading a page:
//   1. If the CRM structure config (built by the backend's mapping agent) has
//      this CRM and page type, follow its rules in the page: click each tab
//      or expander, read fields and message lists, open each message's own
//      page for its body. No AI involved.
//   2. On a mapped list of people, offer to capture every record it links to
//      (each is opened in a background tab and read the same way).
//   3. If the rules no longer fit (missing fields, tab gone), report the page
//      so the agent re-maps it, and use AI extraction this time.
//   4. Pages the config doesn't know use AI extraction.
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
import { mapCrm as runMapper, explore, mapListType, listPagesAmong, hostAllowed, UNSAFE_LINK, UNSAFE_CLICK } from './lib/mapper/agent.js';
import { nextPageUrl, isPagedUrl } from './lib/paging.js';
import { chromeAdapter } from './lib/mapper/chrome-adapter.js';
import { followScriptLinks } from './lib/follow-links.js';
import { adoptOpenedTab } from './lib/opened-tabs.js';
import { remoteLLM, remoteStore } from './lib/mapper/remote.js';
import { DATASETS, OTHER_DATASET, datasetById, datasetsFrom, datasetOfPageType, datasetsOfCrm, rowTitle } from './lib/mapper/datasets.js';
import { referenceRows, REFERENCE_COLUMNS } from './lib/reference.js';

const CONFIG_MAX_AGE_MS = 10 * 60_000;
const MAX_LIST_CAPTURE = 50;
const MAX_MESSAGE_PAGES = 15; // per record, when messages have pages of their own

const handlers = {
  extract,
  captureList,
  // A mapping the user asks for also captures: each kind of data is read and
  // saved as soon as its layout is ready, while the next kind is being mapped.
  mapCrm: (message) => mapFromBrowser({ ...message, fromUser: true, capture: message.capture !== false }),
  openConsole: async () => ({ windowId: await ensureConsoleWindow() }),
  // Proof of concept: every page of the site, everything on it, no layout and no AI.
  crawlSite,
  // Finished jobs are cleared so the UIs return to idle (running ones stay).
  clearJobs: async () => {
    const { bulk, mapping } = await chrome.storage.session.get(['bulk', 'mapping']);
    const remove = [];
    if (bulk && bulk.status !== 'running') remove.push('bulk');
    if (mapping && mapping.status !== 'running') remove.push('mapping');
    if (remove.length) await chrome.storage.session.remove(remove);
    return { cleared: remove };
  },
  // The CRM page the user is working in (the most recently used web tab),
  // and what the config knows about it, for the capture window.
  activeSite: async () => {
    const settings = await getSettings();
    const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/i.test(t.url || '') && t.url !== CONSOLE_URL);
    const tab = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (!tab) return { site: null };
    const config = await getCrmConfig(settings);
    const crm = config && findCrm(config, tab.url);
    const page = crm && findPageType(crm.crm, tab.url);
    return {
      site: {
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
  health: async () => {
    const settings = await getSettings();
    const base = settings.backendUrl.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      // The mapping endpoints exist on current servers only.
      const probe = await fetch(`${base}/api/mapper/status`, { headers: { 'x-api-key': settings.apiKey }, signal: AbortSignal.timeout(4000) });
      return { backend: base, ok: res.ok, model: data.model, keyOk: probe.status !== 401, current: probe.status !== 404 };
    } catch (error) {
      return { backend: base, ok: false, error: error.message };
    }
  },
  captureCrm,
  cancelCapture: async () => {
    cancelRequested = true;
    return {};
  },
  bulkStatus: async () => {
    const { bulk } = await chrome.storage.session.get('bulk');
    return { bulk: bulk ?? null };
  },
  mapStatus: async () => {
    const { mapping } = await chrome.storage.session.get('mapping');
    return { mapping: mapping ?? null };
  },
  save,
  writeDay,
  status,
  listDays: async () => ({ days: await listDays() }),
  crmStatus: async () => backend(await getSettings(), 'GET', '/api/mapper/status'),
  crmRemap: async ({ crmId }) => backend(await getSettings(), 'POST', '/api/mapper/run', { crmId }),
  refreshCrmConfig: async () => {
    const config = await getCrmConfig(await getSettings(), { force: true });
    return { crms: Object.entries(config?.crms ?? {}).map(([id, c]) => ({ id, name: c.name, version: c.version })) };
  },
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

// Row updates and file rewrites run one at a time so two quick saves can't
// interleave their read-modify-write.
let queue = Promise.resolve();
function serialized(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

const humanize = (key) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
// Extension messaging hands objects back with sorted keys; show names and
// contact details first instead of alphabetical order.
const KEY_ORDER = new Map(STANDARD_KEYS.map((key, i) => [key, i]));
const byStandardOrder = (a, b) => (KEY_ORDER.get(a.key) ?? KEY_ORDER.size) - (KEY_ORDER.get(b.key) ?? KEY_ORDER.size);
const nonEmpty = (collections = {}) => Object.fromEntries(Object.entries(collections).filter(([, list]) => list.length));

// ------------------------------------------------------------------ reading

async function extract({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || '')) {
    throw new Error("This page can't be read (browser pages and local files are off-limits).");
  }
  const settings = await getSettings();
  const site = detectSite(tab.url);
  const config = await getCrmConfig(settings);
  const crm = config && findCrm(config, tab.url);
  let page = crm && findPageType(crm.crm, tab.url);
  // A page of a mapped CRM that isn't a record itself (a dashboard, search
  // results, a related list): offer the records it links to.
  if (crm && (!page || page.pageType.role === 'message')) {
    const linked = await linkedRecords(tab, crm.crm);
    page = linked ? { pageType: { role: 'linked' }, recordId: '', linked } : null;
  }
  if (!page) {
    const ai = await aiExtract(tab, settings); // carries the dataset the AI named
    // A CRM mapped as screens (it navigates by clicks) has no page to match
    // by address: AI reads what is on screen, and its whole capture is offered.
    const screens = crm?.crm.pageTypes?.filter((pt) => pt.role === 'screen') ?? [];
    if (screens.length) return { ...ai, site: crm.crm.name, mode: 'ai', mapped: true, crmId: crm.id, configVersion: crm.crm.version, lists: screens.map((pt) => ({ id: pt.id, entity: pt.entity })) };
    return { ...ai, site, mode: 'ai' };
  }

  const about = {
    site: crm.crm.name,
    crmId: crm.id,
    configVersion: crm.crm.version,
    recordId: page.recordId,
    lists: crm.crm.pageTypes.filter((pt) => pt.role === 'list').map((pt) => ({ id: pt.id, entity: pt.entity })),
  };
  if (page.pageType.role === 'list') return { ...about, ...(await readList(tab, crm.crm, page.pageType)) };
  if (page.pageType.role === 'linked') return { ...about, ...page.linked };

  await setProgress({ phase: 'Reading the record' });
  let result;
  try {
    // Tabs that are pages of their own are read in a work tab, so the user's
    // tab never navigates away from the record.
    result = hasLinkViews(page.pageType)
      ? await withBackgroundTab(tab.url, (t) => captureRecord(t.id, crm.crm, page.pageType))
      : await captureRecord(tabId, crm.crm, page.pageType);
  } finally {
    await setProgress(null);
    if (!bulkInProgress && !mappingInProgress) await endJob();
  }
  const verdict = assessExtraction(page.pageType, result);
  const dataset = datasetOfPageType(page.pageType, crm.crm);
  if (verdict.ok) {
    const record = toRecord(result);
    // Read by rules (no AI): saved straight away; the popup just confirms.
    const saved = await autoSave([record], { pageUrl: tab.url, pageTitle: tab.title || '', site: crm.crm.name, recordId: page.recordId, dataset });
    return { ...about, dataset, mode: 'config', pageType: page.pageType.description || 'Record', records: [record], saved };
  }

  const problems = describeProblems(verdict);
  const queued = await reportFailure(settings, {
    crmId: crm.id,
    pageTypeId: page.pageType.id,
    url: tab.url,
    missing: [...verdict.missing, ...verdict.invalid.map((k) => `${k} (invalid)`)],
    errors: verdict.errors,
  });
  const ai = await aiExtract(tab, settings);
  // Keep the message lists the mapped rules could still read.
  if (result && ai.records[0]) ai.records[0].collections = nonEmpty(result.collections);
  return {
    ...ai,
    ...about,
    dataset, // the page's mapped kind, whatever the AI called it
    mode: 'ai-fallback',
    notice: `The saved ${crm.crm.name} layout didn't fit this page (${problems}). ${queued ? 'Re-mapping it now; ' : ''}AI read the page this time.`,
  };
}

// Saves records read by rules without a review step; returns what save() reports.
async function autoSave(records, meta) {
  const payload = records.map((r) => ({ fields: Object.fromEntries(r.fields.map((f) => [f.key, f.value])), collections: r.collections, pageUrl: r.pageUrl, recordId: r.recordId, dataset: r.dataset }));
  try {
    return await save({ records: payload, meta });
  } catch (error) {
    return { error: error.message };
  }
}

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

// A mapped list of people: which records it links to, so the popup can
// offer to capture them all.
async function readList(tab, crm, pageType) {
  await inject(tab.id, ['content/crm-runtime.js']);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (spec) => window.__crmRuntime?.readCollection(spec) ?? [],
    args: [pageType.items],
  });
  const entries = results.map((r) => r.result).find((list) => list?.length) ?? [];
  const recordType = crm.pageTypes.find((pt) => pt.id === pageType.recordPageType);
  const items = entries.filter((e) => e.link && recordType && matchesType(recordType, e.link)).map((e) => ({ url: e.link, title: e.title || e.link }));
  return { mode: 'list', entity: pageType.entity || 'record', recordPageType: pageType.recordPageType, count: items.length, items: items.slice(0, MAX_LIST_CAPTURE) };
}

// Links on this page that lead to mapped records: the same shape as readList,
// so the popup can offer to capture them all. Null when there are none.
async function linkedRecords(tab, crm) {
  const recordTypes = crm.pageTypes.filter((pt) => pt.role === 'record' && pt.validation?.ok !== false);
  if (!recordTypes.length) return null;
  await inject(tab.id, ['content/crm-runtime.js']);
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const rt = window.__crmRuntime;
        if (!rt) return [];
        rt.snapshot();
        return rt.pageLinks().map(({ url, text }) => ({ url, text }));
      },
    });
  } catch {
    return null;
  }
  const links = results.flatMap((r) => r.result ?? []);
  let best = null;
  for (const recordType of recordTypes) {
    const seen = new Map();
    for (const link of links) {
      const match = matchesType(recordType, link.url);
      if (!match) continue;
      const id = match[1] || link.url;
      if (!seen.has(id) || (!seen.get(id).title && link.text)) seen.set(id, { url: link.url, title: link.text || link.url });
    }
    if (seen.size && (!best || seen.size > best.items.length)) best = { recordType, items: [...seen.values()] };
  }
  if (!best) return null;
  return {
    mode: 'list',
    source: 'links',
    entity: best.recordType.entity || 'record',
    recordPageType: best.recordType.id,
    count: best.items.length,
    items: best.items.slice(0, MAX_LIST_CAPTURE),
  };
}

// Opens every record of a mapped list in a background tab, one at a time,
// and reads each with the saved layout. urls come from readList.
async function captureList({ crmId, recordPageType, urls = [] }) {
  await ensureConsoleWindow();
  const settings = await getSettings();
  const config = await getCrmConfig(settings);
  const crm = config?.crms?.[crmId];
  const pageType = crm?.pageTypes.find((pt) => pt.id === recordPageType);
  if (!pageType) throw new Error('The saved layout for these records is gone. Re-scan the page.');
  const records = [];
  const failed = [];
  const list = urls.slice(0, MAX_LIST_CAPTURE);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    for (const [i, url] of list.entries()) {
      await setProgress({ phase: `Capturing ${i + 1} of ${list.length}`, done: i, total: list.length });
      try {
        const result = await withBackgroundTab(url, (tab) => captureRecord(tab.id, crm, pageType));
        const verdict = assessExtraction(pageType, result);
        if (!verdict.ok) {
          failed.push({ url, problems: describeProblems(verdict) });
          continue;
        }
        records.push({ ...toRecord(result), pageUrl: url, recordId: matchesType(pageType, url)?.[1] ?? '' });
      } catch (error) {
        failed.push({ url, problems: error.message });
      }
    }
  } finally {
    clearInterval(keepAlive);
    await setProgress(null);
  }
  await endJob();
  if (failed.length && !records.length) {
    await reportFailure(settings, { crmId, pageTypeId: pageType.id, url: failed[0].url, missing: [], errors: [{ view: 'page', error: failed[0].problems }] });
  }
  const dataset = datasetOfPageType(pageType, crm);
  const saved = records.length ? await autoSave(records, { pageUrl: urls[0], pageTitle: '', site: crm.name, dataset }) : null;
  return { mode: 'config', site: crm.name, crmId, configVersion: crm.version, dataset, pageType: `${records.length} ${dataset} from the list`, records, failed, saved };
}

// ------------------------------------------------- the whole CRM

const MAX_PAGES_PER_LIST = 200;
const MAX_RECORDS_PER_RUN = 5000;
let bulkInProgress = null;
let cancelRequested = false;

const setBulk = (patch) =>
  chrome.storage.session.get('bulk').then(({ bulk }) => chrome.storage.session.set({ bulk: { ...(bulk ?? {}), ...patch } }));

// One capture run: a whole-CRM capture, or the capture that accompanies a
// first mapping (layouts arrive one kind at a time while the agent is still
// mapping the next). Its stats are what the popup and the capture window show.
function startRun({ crmId, name, phase, withMapping = false }) {
  const stats = {
    status: 'running', crmId, name, startedAt: Date.now(), withMapping,
    lists: 0, pages: 0, found: 0, total: 0, captured: 0, failed: 0, aiFallbacks: 0, remapped: 0, saved: 0, messages: 0,
    byKind: {}, files: [], phase, log: [], recent: [],
  };
  const note = (line) => {
    stats.log.push(`${new Date().toLocaleTimeString()}  ${line}`);
    if (stats.log.length > 80) stats.log.shift();
  };
  return { stats, note, seen: new Set(), pending: [], healed: false, publish: () => chrome.storage.session.set({ bulk: stats }) };
}

async function flushRun(run, ctx) {
  if (!run.pending.length) return;
  const batch = run.pending;
  run.pending = [];
  const result = await save({ records: batch, meta: { site: ctx.crm.name, pageTitle: '' } });
  run.stats.saved += batch.length;
  run.stats.messages = result.messages;
  run.stats.files = [...new Set([...run.stats.files, ...(result.files ?? [])])];
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
  run.note(error ? `Failed: ${error.message}` : `${stats.status}: ${stats.captured} captured (${kinds || 'nothing'}), ${stats.saved} saved`);
  await run.publish();
  return stats;
}

// ctx: { crmId, crm (its pageTypes may grow while a mapping runs), settings,
// heal (re-map a layout that stops fitting) }.
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
      note(stats.phase);
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

// Records known by URL only (a kind whose list page was not found).
async function captureUrls(run, ctx, recordType, urls) {
  const items = [];
  for (const url of urls) {
    const match = matchesType(recordType, url);
    const id = `${recordType.id}:${match?.[1] || url}`;
    if (!match || run.seen.has(id)) continue;
    run.seen.add(id);
    items.push({ url, title: '', recordTypeId: recordType.id, recordId: match[1] ?? '' });
  }
  run.stats.found += items.length;
  if (items.length) run.note(`No list of ${datasetOfPageType(recordType, ctx.crm)} was found: capturing the ${items.length} record(s) seen while mapping`);
  await captureItems(run, ctx, items);
}

// Reads each record with its layout; saves every few records so nothing is
// lost. A layout that stops fitting is re-mapped once (AI, from this
// browser) when ctx.heal allows; records that still fail are read by AI.
async function captureItems(run, ctx, items) {
  const { stats, note } = run;
  stats.total += items.length;
  for (const item of items) {
    if (cancelRequested) break;
    stats.phase = `Capturing ${stats.captured + stats.failed + 1} of ${stats.total}${item.title ? `: ${item.title}` : ''}`;
    await run.publish();
    let recordType = ctx.crm.pageTypes.find((pt) => pt.id === item.recordTypeId);
    const kind = datasetOfPageType(recordType, ctx.crm);
    try {
      let result = await withBackgroundTab(item.url, (tab) => captureRecord(tab.id, ctx.crm, recordType));
      let verdict = assessExtraction(recordType, result);
      if (!verdict.ok && ctx.heal && !run.healed && !mappingInProgress) {
        run.healed = true;
        stats.phase = `The saved layout didn't fit ${item.title || 'a record'} (${describeProblems(verdict)}); re-mapping it…`;
        note(stats.phase);
        await run.publish();
        try {
          await mapFromBrowser({ site: siteOf(ctx.crmId, ctx.crm), onlyUrl: item.url, reason: `whole-CRM capture failed (${describeProblems(verdict)})` });
          const config = await getCrmConfig(ctx.settings, { force: true });
          ctx.crm = config?.crms?.[ctx.crmId] ?? ctx.crm;
          stats.remapped++;
          recordType = ctx.crm.pageTypes.find((pt) => pt.id === item.recordTypeId) ?? recordType;
          result = await withBackgroundTab(item.url, (tab) => captureRecord(tab.id, ctx.crm, recordType));
          verdict = assessExtraction(recordType, result);
        } catch {
          // keep going with the old layout and AI
        }
      }
      let record;
      if (verdict.ok) {
        record = toRecord(result);
      } else {
        const ai = await withBackgroundTab(item.url, (tab) => chrome.tabs.get(tab.id).then((t) => aiExtract(t, ctx.settings)));
        if (!ai.records[0]) throw new Error('nothing read');
        record = { fields: ai.records[0].fields, collections: nonEmpty(result?.collections) };
        stats.aiFallbacks++;
      }
      run.pending.push({ fields: Object.fromEntries(record.fields.map((f) => [f.key, f.value])), collections: record.collections, pageUrl: item.url, recordId: item.recordId, dataset: kind });
      stats.captured++;
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
      const name = rowTitle(record.fields) || item.title || item.url;
      const messages = Object.values(record.collections).reduce((n, l) => n + l.length, 0);
      stats.recent.unshift({ name, kind, fields: record.fields.length, messages, url: item.url });
      if (stats.recent.length > 60) stats.recent.pop();
      note(verdict.ok ? `Captured ${name} (${kind}): ${record.fields.length} fields, ${messages} messages` : `Read ${name} (${kind}) with AI: the rules did not fit (${describeProblems(verdict)})`);
    } catch (error) {
      stats.failed++;
      note(`Failed ${item.title || item.url}: ${error.message}`);
    }
    if (run.pending.length >= 10) await flushRun(run, ctx);
  }
  await flushRun(run, ctx);
}

// ----------------------------------------- screens reached by clicking
//
// A CRM with one address for everything has no page to open by URL: its
// lists are "screens" (role 'screen'), each the path of clicks that leads to
// it from the start page plus the grid found there. Capturing one replays
// the path in a work tab, reads the grid, presses "next" and reads again.

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

async function captureScreens(run, ctx, screens) {
  const { stats, note } = run;
  stats.lists += screens.length;
  for (const screen of screens) {
    if (cancelRequested) break;
    const kind = datasetOfPageType(screen, ctx.crm);
    const recordType = screen.recordPageType ? ctx.crm.pageTypes.find((pt) => pt.id === screen.recordPageType) : null;
    const startUrl = screen.url || ctx.crm.startUrl;
    const queue = [];
    stats.phase = screen.path.length ? `Opening "${screen.entity}" (${kind}) by clicking ${screen.path.map((s) => s.label).join(' > ')}` : `Opening "${screen.entity}" (${kind})`;
    note(stats.phase);
    await run.publish();
    try {
      await withBackgroundTab(startUrl, async (tab) => {
        const stuck = await replayPathInTab(tab.id, screen.path);
        if (stuck) {
          stats.failed++;
          note(`Could not reach "${screen.entity}": "${stuck}" was not found on screen`);
          return;
        }
        let lastSignature = null;
        // A grid with no pager may grow as it is scrolled ("Show more", infinite scroll): all of it first.
        const grown = await inFrames(
          tab.id,
          async (spec) => {
            const rt = window.__crmRuntime;
            if (!rt?.tableRows?.(spec) || rt.hasNext({ near: spec.container })) return 0;
            return rt.expandAll({ rows: `${spec.container} ${spec.row ? spec.row.replace(/^:scope\s*>?\s*/, '') : 'tr'}` });
          },
          [screen.table],
        );
        const rounds = Math.max(0, ...grown.map((f) => f.result || 0));
        if (rounds > 1) note(`"${screen.entity}": expanded the grid in place (${rounds} rounds of "show more"/scrolling)`);
        for (let pageNo = 0; pageNo < MAX_PAGES_PER_LIST && !cancelRequested; pageNo++) {
          const read = (await inFrames(tab.id, (spec) => window.__crmRuntime?.readTable?.(spec) ?? null, [screen.table])).map((f) => f.result).find((r) => r?.rows?.length);
          if (!read) {
            if (pageNo === 0) {
              // The grid's rules read nothing: let AI read what is on screen this once.
              const ai = await chrome.tabs.get(tab.id).then((t) => aiExtract(t, ctx.settings)).catch(() => null);
              for (const record of ai?.records ?? []) {
                run.pending.push({ fields: Object.fromEntries(record.fields.map((f) => [f.key, f.value])), collections: {}, pageUrl: startUrl, dataset: kind });
                stats.found++;
                stats.total++;
                stats.captured++;
                stats.aiFallbacks++;
                stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
              }
              note(ai?.records?.length ? `"${screen.entity}": the grid's layout did not fit; AI read ${ai.records.length} rows from the screen` : `"${screen.entity}": no rows on screen`);
            }
            break;
          }
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
              queue.push({ url: row.link, title: rowTitle(fields), recordTypeId: recordType.id, recordId: match[1] ?? '' });
              stats.found++;
              continue;
            }
            const id = `${screen.id}:${JSON.stringify(fields)}`;
            if (run.seen.has(id)) continue;
            run.seen.add(id);
            if (recordType && screen.rowOpen) {
              toOpen.push({ index, title: rowTitle(fields) });
              continue;
            }
            let record = { fields, collections: {} };
            if (screen.detail) {
              stats.phase = `Reading "${screen.entity}" (${kind}), page ${pageNo + 1}: opening ${rowTitle(fields) || `row ${index + 1}`}`;
              await run.publish();
              const result = await readRowInPlace(tab.id, ctx.crm, screen, index, previous);
              if (Object.keys(result.fields).length) previous = result.fields;
              const verdict = assessExtraction(screen.detail, result);
              if (verdict.ok) record = { fields: normalizeFields({ ...fields, ...result.fields }), collections: nonEmpty(result.collections) };
              else note(`${rowTitle(fields) || `Row ${index + 1}`}: the ${screen.entity} panel didn't fit (${describeProblems(verdict)}); saved the row's columns only`);
            }
            run.pending.push({ fields: record.fields, collections: record.collections, pageUrl: startUrl, dataset: kind });
            taken++;
            stats.found++;
            stats.total++;
            stats.captured++;
            stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
            const messages = Object.values(record.collections).reduce((n, l) => n + l.length, 0);
            stats.recent.unshift({ name: rowTitle(record.fields) || '(row)', kind, fields: Object.keys(record.fields).length, messages, url: startUrl });
            if (stats.recent.length > 60) stats.recent.pop();
            if (run.pending.length >= 10) await flushRun(run, ctx);
          }
          // Rows that open their record's page by script: note each address, come back.
          let lost = false;
          for (const { index, title } of toOpen) {
            if (cancelRequested) break;
            stats.phase = `Reading "${screen.entity}" (${kind}), page ${pageNo + 1}: finding the page of ${title || `row ${index + 1}`}`;
            await run.publish();
            const url = await openRowPage(tab.id, screen, index);
            const opened = url && matchesType(recordType, url);
            if (opened) {
              const id = `${recordType.id}:${opened[1] || url}`;
              if (!run.seen.has(id)) {
                run.seen.add(id);
                queue.push({ url, title, recordTypeId: recordType.id, recordId: opened[1] ?? '' });
                stats.found++;
              }
            } else note(`${title || `Row ${index + 1}`}: clicking it did not open a ${recordType.entity || 'record'} page`);
            if (url && !(await returnToPage(tab.id, screen, startUrl, pageNo, read.signature))) {
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
          if (!(await pressListNext(tab.id, screen.table.container))) break;
        }
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

// Every record behind every mapped list of a CRM (or of the lists named in
// listIds), whatever its kind, page after page, each read with the saved
// layout and saved to the day's files as it goes. Runs in the background;
// the popup and the capture window follow it through bulkStatus and can
// cancel it.
async function captureCrm({ crmId, listIds = null, startUrl = null }) {
  if (bulkInProgress) throw new Error(`Already capturing ${bulkInProgress}. Wait for it or cancel it.`);
  const settings = await getSettings();
  let config = await getCrmConfig(settings);
  let crm = config?.crms?.[crmId];
  if (!crm) throw new Error('This CRM is not mapped.');
  const recordTypes = crm.pageTypes.filter((pt) => pt.role === 'record');
  if (!recordTypes.length && !crm.pageTypes.some((pt) => pt.role === 'screen')) throw new Error('No layout is mapped for this CRM yet.');
  let lists = crm.pageTypes.filter((pt) => pt.role === 'list' && (!listIds || listIds.includes(pt.id)));
  // Lists of a click-driven CRM: reached by a path of clicks, not by address.
  const screens = crm.pageTypes.filter((pt) => pt.role === 'screen' && pt.validation?.ok !== false && (!listIds || listIds.includes(pt.id)));
  bulkInProgress = crm.name;
  cancelRequested = false;
  if (!mappingInProgress) await chrome.storage.session.remove('mapping'); // a finished mapping's panel makes way
  await ensureConsoleWindow();
  const run = startRun({ crmId, name: crm.name, phase: 'Collecting records…' });
  await run.publish();
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  const ctx = { crmId, crm, settings, heal: true };
  try {
    // No list was mapped yet: find the CRM's list pages now (no AI needed:
    // their rows are the pages linking into the mapped record types), learn
    // them and save them to the layout; then walk them.
    if (!lists.length && recordTypes.some((rt) => !screens.some((s) => s.recordPageType === rt.id))) {
      run.stats.phase = 'Looking for the lists in this CRM…';
      await run.publish();
      lists = await discoverLists(crmId, crm, startUrl, settings);
      config = await getCrmConfig(settings, { force: true });
      ctx.crm = crm = config?.crms?.[crmId] ?? crm;
    }
    // Still none: walk from the page the user is on, page after page, taking
    // every link into a mapped record (its items are found by shape).
    if (!lists.length && !screens.length && startUrl && recordTypes.length) lists = [{ id: 'current_page', entity: recordTypes[0].entity, recordPageType: recordTypes[0].id, items: null, samples: [startUrl] }];
    if (!lists.length && !screens.length) throw new Error('No list was found in this CRM. Open one of its lists (users, contacts, leads…) and capture from there.');
    if (lists.length) await captureLists(run, ctx, lists, { startUrl });
    if (screens.length) await captureScreens(run, ctx, screens);
    return await finishRun(run, ctx);
  } catch (error) {
    await finishRun(run, ctx, error);
    throw error;
  } finally {
    clearInterval(keepAlive);
    bulkInProgress = null;
    await setProgress(null);
    await endJob();
  }
}

// Finds and learns the CRM's list pages without AI: explores from startUrl
// (and the CRM's own start page), keeps the pages whose rows link into a
// mapped record type, learns each one's rows, and adds them to the layout.
async function discoverLists(crmId, crm, startUrl, settings) {
  const recordTypes = crm.pageTypes.filter((pt) => pt.role === 'record');
  const site = { ...siteOf(crmId, crm), startUrl: startUrl || crm.startUrl };
  const adapter = chromeAdapter(site, { windowId: work.windowId });
  const call = (method, path, body) => backend(settings, method, path, body);
  const store = remoteStore(call, (opts) => getCrmConfig(settings, opts));
  const log = (line) => setBulk({ phase: line });
  const page = await adapter.open(site.startUrl);
  try {
    const pages = await explore(adapter, page, site, { maxPages: 18, perPattern: 2, log, datasets: datasetsFrom(datasetsOfCrm(crm)) });
    const found = [];
    for (const candidate of listPagesAmong(pages, recordTypes)) {
      const lt = await mapListType(adapter, page, null, { id: `${candidate.recordType.entity || 'record'}_list${found.length ? `_${found.length + 1}` : ''}`, entity: candidate.recordType.entity, url: candidate.urls?.[0] ?? candidate.url, recordTypes }, { log });
      if (lt) found.push(lt);
    }
    if (found.length) await store.saveMapping(site, found, { reason: 'lists found during a whole-CRM capture', mappedBy: 'extension (no AI)', replaceAll: false });
    return found;
  } finally {
    await adapter.close(page);
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
      const toRead = entries.slice(0, MAX_MESSAGE_PAGES);
      for (const [i, entry] of toRead.entries()) {
        await setProgress({ phase: `Reading ${name.replace(/_/g, ' ')} ${i + 1} of ${toRead.length}`, done: i, total: toRead.length });
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

// ------------------------------------- crawl everything (proof of concept)
//
// Not the mapped capture: from the page the user is on, it goes through the
// whole CRM the way a person browsing it would and saves everything each
// page shows, with no layout, no AI and no filter on the kind of data:
//   - every link within the CRM's hosts is opened
//   - safe menus, tabs and cards are clicked; a screen with no address of
//     its own is reached again by replaying its clicks, and a card that opens
//     the CRM in a new tab (on a host of its own) continues in the work tab
//   - every grid row with no link is opened (its drawer or dialog read and
//     closed again), and grids are paged with their "next" control
//   - nothing that adds, edits, deletes, sends, exports or signs out is pressed
// It writes two files as it goes: crawl_values_<date>.csv (one value per
// line: page, click path, source, table, row, label, value) and
// crawl_pages_<date>.csv (one line per page or state read, with its text).

const CRAWL = { maxStates: 400, clicksPerPage: 20, rowsPerGrid: 40, pagesPerGrid: 20, maxClickDepth: 6, textChars: 8000 };
// More than the mapper's guard: a crawl presses many more things.
const CRAWL_UNSAFE =
  /^(approve|reject|decline|accept|confirm|assign|reassign|merge|convert|archive|restore|reset|clear|dial|call|e-?mail|text|sms|message|reply|forward|disable|deactivate|activate|enable|mark|complete|book|schedule|cancel|pay|purchase|order|apply|transfer|move|copy|duplicate|share|publish|post|sync|update|upgrade|install|refresh|delete|remove|close)\b/i;
const PAGER_CAPTION = /^(next|prev|previous|first|last|more|‹|›|«|»|<|>|\d+)$/i;
// Clicks in these areas (menus, headers) lead to the same place from every page: clicked once.
const GLOBAL_AREAS = new Set(['nav', 'aside', 'header', 'navigation', 'menu', 'menubar', 'tree']);
const VALUE_COLUMNS = ['page_url', 'click_path', 'source', 'table', 'row', 'label', 'value'];
const PAGE_COLUMNS = ['page_url', 'click_path', 'source', 'row', 'title', 'frames', 'fields', 'table_rows', 'text'];
const hashOf = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
};
const describeStep = (step) => step.label;

async function crawlSite({ startUrl }) {
  if (bulkInProgress) throw new Error(`Already capturing ${bulkInProgress}. Wait for it or cancel it.`);
  if (!/^https?:/i.test(startUrl || '')) throw new Error('Open a page of the CRM first.');
  const settings = await getSettings();
  const hosts = [new URL(startUrl).host];
  bulkInProgress = `a crawl of ${hosts[0]}`;
  cancelRequested = false;
  if (!mappingInProgress) await chrome.storage.session.remove('mapping');
  await ensureConsoleWindow();
  const run = startRun({ crmId: null, name: `Crawl of ${hosts[0]}`, phase: 'Starting…' });
  const { stats, note } = run;
  await run.publish();
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  const date = localDateKey();
  const files = { values: csvFileName(settings, date, 'crawl_values'), pages: csvFileName(settings, date, 'crawl_pages') };
  const crawl = {
    out: { values: [], pages: [] },
    queue: [{ url: startUrl, path: [] }],
    queuedUrls: new Set([urlKey(startUrl)]),
    seenContent: new Set(),
    clicked: new Set(),
    hosts,
    stats,
  };
  const inHosts = (url) => {
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) && hostAllowed(u.host, hosts);
    } catch {
      return false;
    }
  };
  crawl.enqueueUrl = (url) => {
    if (!inHosts(url) || UNSAFE_LINK.test(url) || crawl.queuedUrls.has(urlKey(url))) return;
    crawl.queuedUrls.add(urlKey(url));
    crawl.queue.push({ url, path: [] });
    stats.found++;
  };
  const writeFiles = async () => {
    try {
      await writeCsvFile(files.values, toCsv(crawl.out.values, VALUE_COLUMNS));
      await writeCsvFile(files.pages, toCsv(crawl.out.pages, PAGE_COLUMNS));
      stats.saved = crawl.out.values.length;
      stats.files = [files.values, files.pages];
      delete stats.fileError;
    } catch (error) {
      stats.fileError = `Could not write the crawl files: ${error.message}`;
    }
  };
  stats.found = 1;
  try {
    await withBackgroundTab(startUrl, async (tab) => {
      while (crawl.queue.length && stats.captured < CRAWL.maxStates && !cancelRequested) {
        const state = crawl.queue.shift();
        const where = [state.url, ...state.path.map(describeStep)].join(' > ');
        stats.phase = `Reading ${where} (${crawl.queue.length} waiting)`;
        await run.publish();
        if (!(await openCrawlState(tab.id, state))) {
          note(`Could not get to ${where}`);
          continue;
        }
        const here = (await chrome.tabs.get(tab.id)).url;
        // A card that opened the CRM on a host of its own: that host is crawled too.
        if (state.path.length && /^https?:/i.test(here) && !inHosts(here)) {
          hosts.push(new URL(here).host);
          note(`Now crawling ${new URL(here).host} too (reached by clicking ${state.path.map(describeStep).join(' > ')})`);
        }
        if (!inHosts(here)) continue;
        crawl.queuedUrls.add(urlKey(here));
        // Where the clicks found on this state start from: its own address
        // when it has one of its own, else the clicks that led here.
        const base = urlKey(here) === urlKey(state.url) ? state : { url: here, path: [] };
        const read = await readCrawlState(tab.id, crawl, { here, path: base.path, source: 'page' });
        if (!read) continue; // the same content as a state already read
        for (const link of read.links) crawl.enqueueUrl(link);
        const moved = await crawlGrid(tab.id, crawl, { base, here });
        if (base.path.length < CRAWL.maxClickDepth && !cancelRequested) {
          if (moved && !(await openCrawlState(tab.id, base))) continue; // back from the grid's later pages and rows
          await queueCrawlClicks(tab.id, crawl, base);
        }
        if (stats.captured % 10 === 0) await writeFiles();
      }
    });
    await writeFiles();
    if (crawl.queue.length && !cancelRequested) note(`Stopped at ${CRAWL.maxStates} pages; ${crawl.queue.length} were still waiting`);
    return await finishRun(run, { crm: { name: `Crawl of ${hosts[0]}` } });
  } catch (error) {
    await writeFiles();
    await finishRun(run, { crm: { name: `Crawl of ${hosts[0]}` } }, error);
    throw error;
  } finally {
    clearInterval(keepAlive);
    bulkInProgress = null;
    await setProgress(null);
    await endJob();
  }
}

// Loads a state in the tab: its address, then the clicks that lead to it.
async function openCrawlState(tabId, state, { pages = 0, table = null } = {}) {
  await navigateTab(tabId, state.url).catch(() => {});
  await settleTab(tabId);
  if (state.path.length && (await replayPathInTab(tabId, state.path))) return false;
  for (let i = 0; i < pages; i++) if (!(await pressListNext(tabId, table.container))) return false;
  return true;
}

// Reads what the tab shows (or the panel root names) into the crawl's files.
// Null when it showed exactly what an earlier state did.
async function readCrawlState(tabId, crawl, { here, path, source, row = '', root = '' }) {
  const results = (
    await inFrames(tabId, (rootSel) => (window.__crmRuntime?.inlineFrame ? null : window.__crmRuntime?.scrapePage?.({ root: rootSel }) ?? null), [root])
  )
    .map((f) => f.result)
    .filter(Boolean);
  if (!results.length) return null;
  const text = results.map((r) => r.text).join('\n');
  const key = hashOf(`${text}\n${results.map((r) => JSON.stringify(r.fields)).join('')}`);
  if (crawl.seenContent.has(key)) return null;
  crawl.seenContent.add(key);
  const { stats } = crawl;
  const line = { page_url: here, click_path: path.map(describeStep).join(' > ') };
  let fields = 0;
  let tableRows = 0;
  for (const r of results) {
    for (const f of r.fields) crawl.out.values.push({ ...line, source: source === 'page' ? 'field' : source, table: '', row, label: f.label, value: f.value });
    fields += r.fields.length;
    for (const t of r.tables) {
      t.rows.forEach((entry, i) => {
        for (const [label, value] of Object.entries(entry)) crawl.out.values.push({ ...line, source: source === 'page' ? 'table' : source, table: t.name, row: row || String(i + 1), label, value });
      });
      tableRows += t.rows.length;
    }
  }
  crawl.out.pages.push({ ...line, source, row, title: results[0].title, frames: results.length, fields, table_rows: tableRows, text: text.slice(0, CRAWL.textChars) });
  stats.captured++;
  stats.pages++;
  stats.byKind = { 'pages and states': stats.captured };
  stats.recent.unshift({ name: `${row || results[0].title || here}${line.click_path ? ` (${line.click_path})` : ''}`, kind: source, fields: fields + tableRows, messages: 0, url: here });
  if (stats.recent.length > 60) stats.recent.pop();
  return { links: results.flatMap((r) => r.links) };
}

// The page's main grid: each of its pages (by its "next" control) and each
// row with no link, opened in place (its drawer read and closed) or, when
// it opens a page of its own, that page queued. Whether it pressed anything
// (the tab no longer shows the state as it was).
async function crawlGrid(tabId, crawl, { base, here }) {
  const found = (await inFrames(tabId, () => (window.__crmRuntime?.inlineFrame ? null : window.__crmRuntime?.describeTable?.() ?? null))).map((f) => f.result).find(Boolean);
  if (!found) return false;
  let moved = false;
  const table = found.spec;
  let open = null; // what opens a row, once known; false: the rows open nothing
  for (let pageNo = 0; pageNo < CRAWL.pagesPerGrid && !cancelRequested; pageNo++) {
    if (pageNo) {
      const read = await readCrawlState(tabId, crawl, { here, path: base.path, source: `grid page ${pageNo + 1}` });
      if (!read) break; // "next" showed nothing new
      for (const link of read.links) crawl.enqueueUrl(link);
    }
    const rows = (await inFrames(tabId, (spec) => window.__crmRuntime?.readTable?.(spec) ?? null, [table])).map((f) => f.result).find((r) => r?.rows?.length)?.rows ?? [];
    for (const [i, row] of rows.slice(0, CRAWL.rowsPerGrid).entries()) {
      if (open === false || cancelRequested || row.link) continue; // rows with a link are crawled by their address
      const title = row.cells.find(Boolean) ?? `row ${i + 1}`;
      crawl.stats.phase = `Opening ${title} (${crawl.queue.length} waiting)`;
      await chrome.storage.session.set({ bulk: crawl.stats });
      const openers = open ? [open] : (await inFrames(tabId, (spec, idx) => window.__crmRuntime?.rowOpeners?.(spec, idx) ?? [], [table, i])).flatMap((f) => f.result ?? []);
      let outcome = null;
      for (const candidate of openers) {
        await inFrames(tabId, () => window.__crmRuntime?.markVisible?.());
        const pressed = (await inFrames(tabId, (spec, idx, o) => window.__crmRuntime?.pressRow?.(spec, idx, o) ?? false, [table, i, candidate])).some((f) => f.result);
        if (!pressed) continue;
        moved = true;
        await settleTab(tabId);
        const now = (await chrome.tabs.get(tabId)).url;
        if (urlKey(now) !== urlKey(here)) {
          crawl.enqueueUrl(now);
          outcome = 'page';
        } else {
          const panel = (await inFrames(tabId, (ex) => window.__crmRuntime?.openedPanel?.({ exclude: ex }) ?? null, [table.container]))
            .map((f) => f.result)
            .filter(Boolean)
            .sort((a, b) => b.length - a.length)[0];
          if (panel) {
            outcome = 'panel';
            await readCrawlState(tabId, crawl, { here, path: base.path, source: 'row panel', row: title, root: panel.selector });
            const close = (await inFrames(tabId, (sel) => (window.__crmRuntime?.shown?.(sel) ? window.__crmRuntime.describeClose(sel) : null), [panel.selector])).map((f) => f.result).find(Boolean);
            if (close) {
              await inFrames(tabId, (spec, sel) => (window.__crmRuntime?.shown?.(sel) ? window.__crmRuntime.pressClose(spec) : false), [close, panel.selector]);
              await settleQuick(tabId);
            }
          }
        }
        if (outcome) {
          open = candidate;
          break;
        }
      }
      if (!outcome && !open) open = false; // the first row opened nothing: the others will not either
      // A row that led away: back to this page of the grid.
      if (outcome === 'page' && !(await openCrawlState(tabId, base, { pages: pageNo, table }))) return true;
    }
    if (!(await pressListNext(tabId, table.container))) break;
    moved = true;
  }
  return moved;
}

// The safe things to click on this state, queued as states of their own.
async function queueCrawlClicks(tabId, crawl, base) {
  const frames = await inFrames(tabId, () => (window.__crmRuntime?.inlineFrame ? null : window.__crmRuntime?.clickables?.() ?? null));
  let taken = 0;
  for (const { frameId, result } of frames) {
    for (const c of result ?? []) {
      if (taken >= CRAWL.clicksPerPage) return;
      if (c.link || c.selected || c.area === 'table' || c.area === 'grid') continue; // links go by address; grid cells are rows
      if (UNSAFE_CLICK.test(c.text) || CRAWL_UNSAFE.test(c.text) || PAGER_CAPTION.test(c.text)) continue;
      const key = GLOBAL_AREAS.has(c.area) ? `${c.area}|${c.text}` : `${urlKey(base.url)}|${base.path.map(describeStep).join('>')}|${c.text}`;
      if (crawl.clicked.has(key)) continue;
      const [described] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: (id) => window.__crmRuntime?.describeNav?.(id) ?? null, args: [c.id] }).catch(() => []);
      if (!described?.result) continue;
      crawl.clicked.add(key);
      taken++;
      crawl.queue.push({ url: base.url, path: [...base.path, { label: c.text, nav: described.result }] });
      crawl.stats.found++;
    }
  }
}

// The popup shows this while a capture runs.
async function setProgress(progress) {
  await chrome.storage.session.set({ progress });
}

// ---------------------------------------------------- the capture window

// Long jobs run in their own window: the extension's console page as the
// first tab (status, progress, log, what was captured) and one or two work
// tabs beside it in which the CRM pages are loaded one after another. The
// work tabs are reused for the whole job instead of opened and closed for
// every record.
const CONSOLE_URL = chrome.runtime.getURL('console/console.html');
const work = { windowId: null, tabs: [] }; // tabs: [{ id, busy }]

async function ensureConsoleWindow() {
  // By its address among all tabs: a url filter in tabs.query does not match chrome-extension:// pages.
  const existing = (await chrome.tabs.query({})).find((t) => (t.url || t.pendingUrl || "").startsWith(CONSOLE_URL));
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

async function aiExtract(tab, settings) {
  const frames = await snapshotFrames(tab.id);
  if (!frames.length) throw new Error('No readable content found on this page.');
  const data = await backend(settings, 'POST', '/api/extract', {
    url: tab.url,
    title: tab.title || '',
    targets: settings.captureTargets,
    selection: frames.map((f) => f.selection).filter(Boolean).join('\n').slice(0, 5000),
    frames: frames.map(({ url, isTop, text, phones, emails }) => ({ url, isTop, text, phones, emails })),
  });
  return {
    pageType: data.pageType,
    dataset: datasetById(data.dataset)?.id ?? OTHER_DATASET,
    records: data.records.map((record) => ({
      fields: record.fields.map((field) => ({ ...field, value: normalizeValue(field.key, field.value) })),
    })),
  };
}

async function snapshotFrames(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/snapshot.js'] });
  } catch {
    results = await chrome.scripting.executeScript({ target: { tabId }, files: ['content/snapshot.js'] });
  }
  const seen = new Set();
  const frames = [];
  for (const { result } of results) {
    if (!result || !(result.text || result.phones.length || result.emails.length || result.selection)) continue;
    if (seen.has(result.text)) continue; // same content mounted twice
    seen.add(result.text);
    frames.push(result);
  }
  return frames.sort((a, b) => Number(b.isTop) - Number(a.isTop));
}

// ------------------------------------------------------------------ backend

async function backend(settings, method, path, body) {
  const base = settings.backendUrl.replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': settings.apiKey },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(150_000), // big tables can take the model a while
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('The extraction server took too long to answer. Try again.');
    throw new Error(`Can't reach the extraction server at ${base}. Check it's running and the URL in Settings is right.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Extraction server error (${response.status}).`);
  return data;
}

// The config is cached for a few minutes and revalidated with its ETag; if
// the server is unreachable the last copy keeps working.
async function getCrmConfig(settings, { force = false } = {}) {
  const { crmConfig: cached } = await chrome.storage.local.get('crmConfig');
  if (!force && cached && Date.now() - cached.fetchedAt < CONFIG_MAX_AGE_MS) return cached.data;
  try {
    const response = await fetch(`${settings.backendUrl.replace(/\/+$/, '')}/api/config`, {
      headers: { 'x-api-key': settings.apiKey, ...(cached?.etag ? { 'if-none-match': cached.etag } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 304 && cached) {
      await chrome.storage.local.set({ crmConfig: { ...cached, fetchedAt: Date.now() } });
      return cached.data;
    }
    if (response.ok) {
      const data = await response.json();
      await chrome.storage.local.set({ crmConfig: { data, etag: response.headers.get('etag'), fetchedAt: Date.now() } });
      return data;
    }
  } catch {
    // offline: use the cached copy
  }
  return cached?.data ?? null;
}

// Tells the backend which page the rules failed on (URL and field names
// only) and makes the next extraction re-check the config. A CRM that was
// mapped from this browser is re-mapped from this browser.
async function reportFailure(settings, report) {
  const { crmConfig } = await chrome.storage.local.get('crmConfig');
  if (crmConfig) await chrome.storage.local.set({ crmConfig: { ...crmConfig, fetchedAt: 0 } });
  try {
    const result = await backend(settings, 'POST', '/api/extraction-failures', report);
    if (result.extension) {
      const crm = crmConfig?.data?.crms?.[report.crmId];
      if (crm && !mappingInProgress) {
        mapFromBrowser({ site: siteOf(report.crmId, crm), onlyUrl: report.url, reason: `extraction failed (${report.missing.join(', ') || report.errors.map((e) => e.error).join(', ')})` }).catch(() => {});
      }
      return true;
    }
    return Boolean(result.queued || result.jobId);
  } catch {
    return false;
  }
}

// ------------------------------------------------- mapping from the browser

// The mapping agent, run here so the user's signed-in session does the
// browsing: the server only answers the LLM questions and keeps the config.
let mappingInProgress = null;

const siteOf = (id, crm) => ({ id, name: crm.name, match: crm.match, startUrl: crm.startUrl, targets: datasetsOfCrm(crm) });

// site: { id, name, match: { hosts }, startUrl }; or startUrl alone to make
// one from the page's host.
// capture: read and save each kind of data as soon as its layout is ready,
// while the agent maps the next kind (a first mapping asked for by the user).
async function mapFromBrowser({ site, startUrl, onlyUrl = null, reason = 'requested from the extension', fromUser = false, capture = false }) {
  if (mappingInProgress) throw new Error(`Already mapping ${mappingInProgress}. Wait for it to finish.`);
  if (!site) {
    const { host } = new URL(startUrl);
    site = { id: host.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase(), name: detectSite(startUrl), match: { hosts: [host] }, startUrl };
  }
  const settings = await getSettings();
  const call = (method, path, body) => backend(settings, method, path, body);
  // A mapping the user asks for follows the "What to capture" setting (so
  // changing it and re-mapping switches a CRM over); automatic ones (daily
  // refresh, healing one page) keep the kinds the CRM was mapped for.
  const datasets = datasetsFrom(fromUser && !onlyUrl ? settings.captureTargets : site.targets?.length ? site.targets : settings.captureTargets);
  if (!datasets.length) throw new Error('Nothing to capture is selected. Tick at least one kind of data in Settings.');
  site = { ...site, targets: datasets.map((d) => d.id) };
  // More kinds to find means more of the CRM to look at.
  const crawl = { maxPages: onlyUrl ? 16 : Math.min(32, 12 + 4 * datasets.length), perPattern: 2 };
  const startedAt = Date.now();
  // What the popup shows: the stage list, the current detail, and an estimate.
  const state = {
    crmId: site.id, name: site.name, startedAt, status: 'running', onlyUrl, targets: site.targets, targetLabel: datasets.map((d) => d.plural).join(', '),
    stage: 'explore', detail: 'Starting…', current: 0, total: crawl.maxPages,
    llmCalls: 0, avgLlmMs: LLM_CALL_MS, plan: null, estimateMs: onlyUrl ? 60_000 : 180_000, log: [],
  };
  let llmStarted = 0;
  const publish = () => chrome.storage.session.set({ mapping: { ...state, log: state.log.slice(-40) } });
  const record = (line) => {
    state.log.push(line);
    publish();
  };
  const progress = (event) => {
    if (llmStarted) {
      // The previous event marked an LLM call; this one ends it.
      state.avgLlmMs = Math.max(12_000, Math.round((state.avgLlmMs * state.llmCalls + (Date.now() - llmStarted)) / (state.llmCalls + 1)));
      state.llmCalls++;
      llmStarted = 0;
    }
    if (event.llmCall) llmStarted = Date.now();
    if (event.stage) state.stage = event.stage;
    if (event.stage === 'record' && event.current === 1) state.recordsStarted = (state.recordsStarted ?? 0) + 1;
    if (event.detail) state.detail = event.detail;
    state.current = event.current ?? (event.stage ? 0 : state.current);
    state.total = event.total ?? (event.stage ? 0 : state.total);
    if (event.plan) state.plan = event.plan;
    state.estimateMs = estimateMapping(state, startedAt);
    publish();
  };
  mappingInProgress = site.name;
  if (!bulkInProgress) await chrome.storage.session.remove('bulk'); // a finished capture's panel makes way
  const windowId = await ensureConsoleWindow();
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000); // keeps the worker alive during minutes of work

  // The capture lane: layouts arrive one kind at a time (onReady) and are
  // captured one after another in work tabs, while the agent keeps mapping
  // in its own tab. It outlives the mapping when there is a lot to read.
  const draft = { name: site.name, match: site.match, startUrl: site.startUrl, targets: site.targets, pageTypes: [] };
  const ctx = { crmId: site.id, crm: draft, settings, heal: false };
  let run = null;
  let lane = Promise.resolve();
  let laneKeepAlive = null;
  if (capture && !onlyUrl && !bulkInProgress) {
    bulkInProgress = site.name;
    cancelRequested = false;
    run = startRun({ crmId: site.id, name: site.name, phase: 'Capturing starts as soon as the first layout is ready…', withMapping: true });
    await run.publish();
    laneKeepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  }
  const onReady = async (fresh) => {
    draft.pageTypes.push(...fresh);
    if (!run) return;
    const lists = fresh.filter((pt) => pt.role === 'list');
    const screens = fresh.filter((pt) => pt.role === 'screen');
    const listless = fresh.filter((pt) => pt.role === 'record' && !lists.some((l) => l.recordPageType === pt.id) && !draft.pageTypes.some((s) => s.role === 'screen' && s.recordPageType === pt.id));
    record(`Layout ready: ${fresh.map((pt) => `${pt.id} (${pt.role})`).join(', ')}; capturing it now`);
    lane = lane
      .then(async () => {
        if (lists.length) await captureLists(run, ctx, lists);
        if (screens.length) await captureScreens(run, ctx, screens);
        for (const recordType of listless) await captureUrls(run, ctx, recordType, recordType.samples ?? []);
      })
      .catch((error) => run.note(`Capture problem: ${error.message}`));
  };
  // Ends the run once everything handed over has been captured.
  const closeLane = () => {
    if (!run) return;
    lane
      .then(() => finishRun(run, ctx))
      .catch(() => {})
      .finally(async () => {
        clearInterval(laneKeepAlive);
        bulkInProgress = null;
        if (!run.stats.found) await chrome.storage.session.remove('bulk'); // nothing to show
        await setProgress(null);
        if (!mappingInProgress) await endJob();
      });
  };
  await chrome.action.setBadgeBackgroundColor({ color: '#8a5d00' });
  await chrome.action.setBadgeText({ text: 'MAP' });
  try {
    record(`Mapping ${site.name} from this browser…`);
    const entry = await runMapper({
      site: { ...site, crawl },
      llm: remoteLLM(call),
      store: remoteStore(call, (opts) => getCrmConfig(settings, opts)),
      adapter: chromeAdapter(site, { windowId }),
      log: record,
      progress,
      onlyUrl,
      reason,
      mappedBy: 'extension',
      datasets,
      onReady,
    });
    await getCrmConfig(settings, { force: true });
    Object.assign(state, { status: 'done', stage: 'save', detail: `Layout v${entry.version} saved`, version: entry.version, pageTypes: entry.pageTypes, finishedAt: Date.now() });
    await publish();
    return { crmId: site.id, version: entry.version, pageTypes: entry.pageTypes, capturing: Boolean(run) };
  } catch (error) {
    Object.assign(state, { status: 'failed', error: error.message, finishedAt: Date.now() });
    await publish();
    throw error;
  } finally {
    clearInterval(keepAlive);
    mappingInProgress = null;
    if (!run) await setProgress(null);
    await showCount((await dayCounts(localDateKey())).count);
    closeLane();
  }
}

// A rough duration for the whole mapping: exploring is a few seconds per
// page; every LLM call is the slow part (~20 s each; measured as they go);
// each record costs about three of them (the record, one section, its
// message page) plus its validation, each list a few seconds.
const LLM_CALL_MS = 20_000;
const PAGE_MS = 2_500;
function estimateMapping(state, startedAt) {
  const elapsed = Date.now() - startedAt;
  const llm = state.avgLlmMs;
  if (state.onlyUrl) return Math.max(elapsed + 15_000, 3 * llm + 30_000);
  // Exploring by clicking: about half of the click budget gets used.
  if (state.plan?.clicks && state.stage === 'explore') return elapsed + Math.max(2, (state.plan.clicks - (state.current || 0)) * 0.5) * (Math.min(llm, 15_000) + 4_000);
  if (state.plan?.clicks) return elapsed + 2 * llm + 20_000;
  if (!state.plan) {
    const exploreLeft = Math.max(0, (state.total || 16) - (state.current || 0)) * PAGE_MS;
    return elapsed + exploreLeft + llm + 3 * llm + 40_000; // assume one record type
  }
  const perRecord = 3 * llm + 25_000;
  // Records not started yet, plus the unfinished part of the current one
  // (its sections and message page still ahead while its record is mapped).
  const started = state.recordsStarted ?? 0;
  const partLeft = { record: 0.65, validate: 0.4, message: 0.25 }[state.stage] ?? 0;
  const remainingRecords = Math.max(0, state.plan.records - started) + (started ? partLeft : 0);
  const listsLeft = ['list', 'save'].includes(state.stage) ? 0 : state.plan.lists;
  const rest = state.stage === 'save' ? 0 : remainingRecords * perRecord + listsLeft * 8_000 + 5_000;
  return elapsed + rest;
}

// Daily re-map of the CRMs this browser mapped, while it is open and signed in.
chrome.alarms.create('remap-daily', { periodInMinutes: 24 * 60 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'remap-daily' || mappingInProgress) return;
  const settings = await getSettings();
  const config = await getCrmConfig(settings, { force: true });
  for (const [id, crm] of Object.entries(config?.crms ?? {})) {
    if (!crm.mappedBy?.startsWith('extension') || !crm.startUrl) continue;
    if (Date.now() - Date.parse(crm.mappedAt ?? 0) < 23 * 3_600_000) continue;
    await mapFromBrowser({ site: siteOf(id, crm), reason: 'daily refresh' }).catch(() => {});
  }
});

// ------------------------------------------------------------------- saving

// records: [{ fields: { key: value }, unverified: [key], collections,
// pageUrl?, recordId?, dataset? }]: one row each in the file of its kind
// (meta.dataset when the record names none; customers by default), plus one
// message row per collection entry. Records captured from a list carry
// their own page URL.
async function save({ records = [], meta = {} }) {
  const settings = await getSettings();
  const capturedAt = localTimestamp();
  const byKind = new Map();
  const newMessages = [];
  for (const record of records) {
    const wanted = record.dataset ?? meta.dataset ?? 'customers';
    const dataset = datasetById(wanted)?.id ?? OTHER_DATASET;
    const person = DATASETS[dataset]?.person ?? true;
    const recordMeta = { ...meta, pageUrl: record.pageUrl || meta.pageUrl, recordId: record.recordId ?? meta.recordId };
    const built = await buildCapture({ records: [record], meta: recordMeta, settings, capturedAt, dataset, person });
    if (!built.rows.length) continue;
    byKind.set(dataset, [...(byKind.get(dataset) ?? []), ...built.rows]);
    newMessages.push(...built.messages);
  }
  if (!byKind.size) throw new Error('Nothing to save. Add at least one value.');

  const date = localDateKey();
  return serialized(async () => {
    let added = 0;
    let updated = 0;
    for (const [dataset, rows] of byKind) {
      const result = await upsertRows(date, rows, dataset, { byContact: DATASETS[dataset]?.person ?? true });
      added += result.added;
      updated += result.updated;
    }
    const { messages, added: messagesAdded } = await addMessages(date, newMessages);
    const files = await writeDayFiles(date, settings, { only: [...byKind.keys()] });
    return { date, messages: messages.length, added, updated, messagesAdded, saved: Object.fromEntries([...byKind].map(([k, rows]) => [k, rows.length])), ...files };
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

async function dayCounts(date) {
  const day = await getDay(date);
  const datasets = Object.fromEntries(Object.entries(day.datasets).map(([kind, rows]) => [kind, rows.length]));
  return { day, datasets, count: Object.values(datasets).reduce((a, b) => a + b, 0), messages: day.messages.length };
}

// One file per kind of data (only: just the kinds that changed), plus the
// day's messages and the reference values gathered from every row.
async function writeDayFiles(date, settings, { only = null } = {}) {
  const { day, datasets, count } = await dayCounts(date);
  const kinds = Object.keys(day.datasets).filter((kind) => !only || only.includes(kind));
  const names = kinds.map((kind) => csvFileName(settings, date, kind));
  const messagesFilename = day.messages.length ? csvFileName(settings, date, 'messages') : null;
  const reference = referenceRows(day);
  const referenceFilename = reference.length ? csvFileName(settings, date, 'reference') : null;
  const out = { count, datasets, filename: names.join(', '), messagesFilename, referenceFilename, files: [...names, messagesFilename, referenceFilename].filter(Boolean) };
  try {
    for (const [i, kind] of kinds.entries()) await writeCsvFile(names[i], toCsv(day.datasets[kind]));
    if (messagesFilename) await writeCsvFile(messagesFilename, toCsv(day.messages, MESSAGE_COLUMNS));
    if (referenceFilename) await writeCsvFile(referenceFilename, toCsv(reference, REFERENCE_COLUMNS));
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
  const filename = csvFileName(settings, date, 'KIND').replace('KIND', '<kind>');
  return { date, count, datasets, messages, filename, files: Object.keys(datasets).map((kind) => csvFileName(settings, date, kind)), lastWriteError: lastWriteError ?? null };
}

async function showCount(count) {
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}
