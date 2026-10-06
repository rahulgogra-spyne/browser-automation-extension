import { toKey } from '../lib/columns.js';

const FLAG_HELP = {
  not_on_page: 'Not found on the page. Check this value before saving.',
  bad_format: 'Found on the page, but the format looks wrong (e.g. an invalid VIN or phone).',
};
const TITLE_KEYS = ['full_name', 'name', 'title', 'product_name', 'company', 'email', 'phone_mobile', 'phone'];

const LIST_NAMES = {
  text_messages: 'Text messages', emails: 'Emails', calls: 'Calls', notes: 'Notes',
  chat_messages: 'Chat messages', communications: 'Communications', activities: 'Activities',
};
const listName = (key) => LIST_NAMES[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const $ = (id) => document.getElementById(id);
// [{ selected, open, fields: [{ key, label, value, check, edited }], collections, pageUrl?, recordId?, metaEl }]
let records = [];
// What the save needs to know about the page: its URL and title, the site or
// CRM name, and the CRM's record id when the config found one.
let page = { url: '', title: '', site: '', recordId: '', dataset: '' };
// A mapped list of people: what "Capture all" will open.
let list = null;
// An unmapped site the user could map from this browser.
let mappable = null;
// The mapped CRM of the current page, when it has lists to walk.
let wholeCrm = null;
let bulkTimer = null;
let mapTimer = null;
let mappingRunning = false;
let savedAsRead = false; // the shown records were auto-saved; Save re-arms on an edit

const MAP_STAGES = [
  ['explore', 'Exploring the CRM'],
  ['classify', 'Working out which pages show people'],
  ['record', 'Mapping a record and its sections'],
  ['message', 'Mapping message pages'],
  ['list', 'Mapping lists'],
  ['validate', 'Checking on a second record'],
  ['save', 'Saving the layout'],
];
// Stages come in this order, but "validate" happens inside record/message
// mapping too; the bar reflects the estimate, the list the furthest stage.
const STAGE_RANK = { explore: 0, classify: 1, record: 2, validate: 2, message: 3, list: 4, save: 6 };
const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
let failedWriteDate = null;
let fieldIds = 0;
let progressTimer = null;

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('open-console').addEventListener('click', () => send({ type: 'openConsole' }).then(() => window.close()).catch(() => {}));
$('rescan').addEventListener('click', scan);
$('save').addEventListener('click', save);
$('capture-all').addEventListener('click', captureAll);
$('map-crm').addEventListener('click', mapThisCrm);
$('capture-crm').addEventListener('click', captureWholeCrm);
$('crawl-all').addEventListener('click', crawlEverything);
$('bulk-cancel').addEventListener('click', () => send({ type: 'cancelCapture' }).catch(() => {}));
$('bulk-dismiss').addEventListener('click', () => send({ type: 'clearJobs' }).then(() => ($('bulk-panel').hidden = true)).catch(() => {}));
$('bulk-window').addEventListener('click', () => send({ type: 'openConsole' }).then(() => window.close()).catch(() => {}));
$('retry').addEventListener('click', retryWrite);
$('select-all').addEventListener('change', (event) => {
  for (const record of records) record.selected = event.target.checked;
  render();
});
refreshToday();
watchBulk();
watchMapping();
scan();

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Something went wrong.');
  return response;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const newRecord = (fields, open, collections = {}, extra = {}) => ({
  selected: true,
  open,
  fields: fields.map((f) => ({ key: f.key, label: f.label, value: f.value, check: f.check, edited: false })),
  collections,
  ...extra,
});

const fromResult = (result) =>
  result.records.map((r) => newRecord(r.fields, result.records.length === 1, r.collections, { pageUrl: r.pageUrl, recordId: r.recordId }));

const flagOf = (field) => (field.value.trim() && !field.edited && FLAG_HELP[field.check] ? field.check : '');
const filled = (record) => record.fields.filter((f) => f.value.trim());

async function scan() {
  savedAsRead = false;
  $('save').textContent = 'Save to CSV';
  setBusy(true);
  setStatus('Reading this page…');
  watchProgress();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    page = { url: tab?.url || '', title: tab?.title || '', site: '', recordId: '', dataset: '' };
    const result = await send({ type: 'extract', tabId: tab.id });
    page.site = result.site || '';
    page.recordId = result.recordId || '';
    page.dataset = result.dataset || ''; // the kind of data: decides the file
    list = result.mode === 'list' ? result : null;
    wholeCrm = result.crmId && (result.mode !== 'ai' || result.mapped) ? { crmId: result.crmId, site: result.site, lists: result.lists ?? [] } : null;
    // AI read an unmapped site: offer to map it from this browser.
    mappable = result.mode === 'ai' && !result.mapped && /^https?:/.test(page.url) ? { startUrl: page.url, site: result.site } : null;
    if (list) {
      records = [];
      const noun = list.count === 1 ? list.entity : `${list.entity}s`;
      const verb = list.source === 'links' ? 'links to' : 'lists';
      setStatus(`${result.site} · this page ${verb} ${list.count} ${noun} · saved layout v${result.configVersion}`);
      return;
    }
    records = fromResult(result);
    if (!records.length) {
      records = [newRecord([], true)];
      setStatus('Nothing to capture found. Highlight what you want on the page and Re-scan, or add fields below.', 'warn');
    } else if (result.mode === 'ai-fallback') {
      setStatus(result.notice, 'warn');
    } else if (result.saved) {
      showSaved(result.saved, records);
    } else {
      const fieldCount = records.reduce((n, r) => n + r.fields.length, 0);
      const entries = records.reduce((n, r) => n + Object.values(r.collections).reduce((m, list) => m + list.length, 0), 0);
      const parts =
        result.mode === 'config'
          ? [`${result.site} · saved layout v${result.configVersion}, no AI`, `${fieldCount} fields`, entries && `${entries} messages & notes`]
          : [result.pageType || result.site, `${records.length} ${records.length === 1 ? 'record' : 'records'}`, `${fieldCount} fields`];
      setStatus(parts.filter(Boolean).join(' · '));
    }
  } catch (error) {
    list = null;
    records = [newRecord([], true)];
    setStatus(error.message, 'error');
  } finally {
    stopProgress();
    render();
    setBusy(false);
  }
}

function render() {
  $('list').hidden = !list;
  $('capture-all').hidden = !list;
  $('save').hidden = Boolean(list);
  $('map-offer').hidden = !mappable || mappingRunning;
  $('map-crm').hidden = !mappable || mappingRunning;
  $('capture-crm').hidden = !wholeCrm;
  $('capture-crm').classList.toggle('primary', Boolean(wholeCrm));
  $('capture-all').classList.toggle('primary', !wholeCrm);
  if (wholeCrm) {
    const what = wholeCrm.lists.length ? `every ${wholeCrm.lists.map((l) => `${l.entity || 'record'}`).join(' and ')} in ${wholeCrm.site}` : `every record this listing links to, page after page`;
    $('capture-crm').title = `Capture ${what}: each record is read with the saved layout (no AI) and saved to today's CSV as it goes`;
  }
  if (mappable) {
    $('map-text').textContent = `${mappable.site} isn't mapped yet. Map it from this browser (you're already signed in): it explores the CRM, learns where names, contacts and message history live, and saves the layout for AI-free captures. Takes 2–4 minutes.`;
  }
  if (list) {
    const noun = list.count === 1 ? list.entity : `${list.entity}s`;
    const where = list.source === 'links' ? 'linked from this page' : 'listed here';
    $('list-text').textContent = `${list.count} ${noun} ${where}. Capture whole CRM takes every page of the CRM's ${list.entity} lists; This page only takes just these ${list.count}. Each record is read with the saved layout, including its message history, and saved as it goes.`;
    $('capture-all').textContent = `This page only (${list.count})`;
    $('list-items').replaceChildren(...list.items.map((item) => el('li', '', item.title)));
    $('records').replaceChildren();
    $('bulk').hidden = true;
    return;
  }
  const single = records.length === 1;
  $('records').className = single ? 'single' : '';
  $('records').replaceChildren(...records.map((record, i) => (single ? renderBody(record) : renderCard(record, i))));
  $('bulk').hidden = single;
  updateCounts();
}

// A capture that was saved as it was read: confirm it and let the user
// save again only if they change something.
function showSaved(saved, saved_records) {
  if (saved.error) {
    setStatus(`Read with the saved layout, but not saved: ${saved.error}`, 'error');
    return;
  }
  renderToday(saved);
  const who = saved_records.length === 1 ? recordTitle(saved_records[0], 0) : `${saved_records.length} records`;
  const parts = [saved.updated && !saved.added ? `Updated ${who}` : `Saved ${who}`, saved.messagesAdded && `${saved.messagesAdded} messages`, `→ ${saved.filename}`];
  setStatus(parts.filter(Boolean).join(' · '), 'success');
  if (saved.fileError) showBanner(saved.fileError, saved.date);
  savedAsRead = true;
  $('save').textContent = 'Saved ✓';
  $('save').disabled = true;
}

// Every record of the list, read in the background.
async function captureAll() {
  if (!list) return;
  const { crmId, recordPageType, items } = list;
  setBusy(true);
  watchProgress();
  try {
    const result = await send({ type: 'captureList', crmId, recordPageType, urls: items.map((i) => i.url) });
    list = null;
    records = fromResult(result);
    for (const record of records) record.open = false;
    const failed = result.failed?.length ? ` · ${result.failed.length} could not be read` : '';
    if (!records.length) setStatus(`Nothing could be read${failed}`, 'error');
    else if (result.saved) {
      render();
      showSaved(result.saved, records);
      if (failed) setStatus(`${$('status').textContent}${failed}`, 'warn');
      return;
    } else setStatus(`${result.site} · captured ${records.length} records with the saved layout, no AI${failed}`);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    stopProgress();
    render();
    setBusy(false);
  }
}

// Every record of every mapped list of this CRM, saved as it goes.
async function captureWholeCrm() {
  if (!wholeCrm) return;
  const what = wholeCrm.lists.length ? `every one of the ${wholeCrm.lists.map((l) => `${l.entity || 'record'}s`).join(' and ')} in ${wholeCrm.site}` : `every record reachable from this listing, page after page`;
  if (!confirm(`Capture ${what}? Each record is opened in the background and saved to today's CSV. This can take a while; you can close this popup and check back.`)) return;
  send({ type: 'captureCrm', crmId: wholeCrm.crmId, startUrl: page.url }).catch((error) => setStatus(error.message, 'error'));
  // The capture window opens and follows the job from here on.
  setTimeout(() => window.close(), 800);
}

// Proof of concept: every page of the site this tab is on, everything on
// each page, no layout and no AI. Runs in the capture window.
async function crawlEverything() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/i.test(tab?.url || '')) return setStatus('Open a page of the CRM first.', 'error');
  const host = new URL(tab.url).host;
  if (!confirm(`Crawl everything on ${host}, starting from this page? Every link, menu, tab and grid row is opened in the background (never anything that adds, edits, deletes, sends or signs out) and everything they show is saved to crawl_values and crawl_pages CSVs. Up to 400 pages; you can cancel it from the capture window.`)) return;
  send({ type: 'crawlSite', startUrl: tab.url }).catch((error) => setStatus(error.message, 'error'));
  setTimeout(() => window.close(), 800);
}

// Shows a running whole-CRM capture (also when the popup is reopened).
async function watchBulk() {
  clearInterval(bulkTimer);
  const tick = async () => {
    const { bulk } = await send({ type: 'bulkStatus' }).catch(() => ({}));
    const panel = $('bulk-panel');
    const done = bulk && bulk.status !== 'running';
    if (!bulk || (done && Date.now() - (bulk.finishedAt ?? 0) > 2 * 60_000)) {
      panel.hidden = true;
      if (bulk) clearInterval(bulkTimer);
      return;
    }
    panel.hidden = false;
    $('bulk-cancel').hidden = done;
    $('bulk-dismiss').hidden = !done;
    const extras = [bulk.failed && `${bulk.failed} failed`, bulk.remapped && 'layout re-mapped', bulk.aiFallbacks && `${bulk.aiFallbacks} read by AI`, bulk.messages && `${bulk.messages} messages today`].filter(Boolean);
    const kinds = Object.entries(bulk.byKind ?? {}).map(([kind, n]) => `${n} ${kind}`).join(', ');
    const parts = [`${bulk.name}: ${bulk.withMapping && !done ? 'capturing while mapping' : bulk.status}`, bulk.phase, `${bulk.found ?? 0} found, ${bulk.captured} captured${kinds ? ` (${kinds})` : ''}, ${bulk.saved} saved${extras.length ? ', ' + extras.join(', ') : ''}`, bulk.error, bulk.fileError];
    $('bulk-text').textContent = parts.filter(Boolean).join(' · ');
    if (done) {
      clearInterval(bulkTimer);
      refreshToday();
    }
  };
  await tick();
  bulkTimer = setInterval(tick, 1000);
}

// Runs the mapping agent from this browser on the current site.
async function mapThisCrm() {
  if (!mappable) return;
  const { startUrl } = mappable;
  setBusy(true);
  $('map-offer').hidden = true;
  watchMapping();
  try {
    watchBulk(); // each kind of data is captured as soon as its layout is ready
    const result = await send({ type: 'mapCrm', startUrl, reason: 'requested from the popup' });
    setStatus(`Mapped ${mappable.site} (layout v${result.version}: ${result.pageTypes.join(', ')}).${result.capturing ? ' Its data is being captured into today\'s files.' : ''} Re-scanning…`, 'success');
    mappable = null;
    await scan();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    setBusy(false);
    render();
  }
}

// Shows a running mapping: stages, what it is doing now, elapsed time and
// how long is left. Also when the popup is reopened during a mapping.
async function watchMapping() {
  clearInterval(mapTimer);
  let lastRendered = null;
  const tick = async () => {
    const { mapping } = await chrome.storage.session.get('mapping').catch(() => ({}));
    const panel = $('map-progress');
    if (!mapping || (mapping.status !== 'running' && Date.now() - (mapping.finishedAt ?? 0) > 60_000)) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const running = mapping.status === 'running';
    const elapsed = (running ? Date.now() : mapping.finishedAt) - mapping.startedAt;
    const remaining = Math.max(0, (mapping.estimateMs ?? 0) - elapsed);
    $('map-title').textContent = running ? `Mapping ${mapping.name}${mapping.targetLabel ? ` (${mapping.targetLabel.toLowerCase()})` : ''}…` : mapping.status === 'done' ? `${mapping.name} mapped` : `Mapping ${mapping.name} failed`;
    const left = remaining < 20_000 ? 'a few seconds left' : remaining < 60_000 ? 'under a minute left' : `about ${Math.ceil(remaining / 60_000)} min left`;
    $('map-time').textContent = running ? `${fmtTime(elapsed)} elapsed · ${left}` : fmtTime(elapsed);
    mappingRunning = running;
    $('map-offer').hidden = !mappable || running;
    $('map-crm').hidden = !mappable || running;
    const fraction = mapping.status === 'done' ? 1 : Math.min(0.97, elapsed / Math.max(1, mapping.estimateMs ?? 1));
    $('map-bar-fill').style.width = `${Math.round(fraction * 100)}%`;
    const rank = mapping.status === 'done' ? 7 : (STAGE_RANK[mapping.stage] ?? 0);
    if (lastRendered !== `${rank}:${mapping.status}`) {
      lastRendered = `${rank}:${mapping.status}`;
      $('map-stages').replaceChildren(
        ...MAP_STAGES.map(([id, label], i) => {
          const li = el('li', i < rank ? 'done' : i === rank && running ? 'current' : '');
          li.append(el('span', 'mark', i < rank ? '✓' : i === rank && running ? '▶' : '·'), el('span', '', label));
          return li;
        }),
      );
    }
    let detail = mapping.detail || '';
    if (running && mapping.stage === 'explore' && mapping.total) detail = `Page ${mapping.current} of up to ${mapping.total}: ${detail}`;
    if (running && mapping.stage === 'record' && mapping.total > 1) detail = `Section ${mapping.current} of ${mapping.total}: ${detail}`;
    if (mapping.status === 'failed') detail = mapping.error;
    if (mapping.status === 'done') detail = `Layout v${mapping.version} saved: ${(mapping.pageTypes ?? []).join(', ')}`;
    $('map-detail').textContent = detail;
    $('map-log').textContent = (mapping.log ?? []).join(String.fromCharCode(10));
    if (!running) clearInterval(mapTimer);
  };
  await tick();
  mapTimer = setInterval(tick, 700);
}

// Shows what the background is doing during a long capture.
function watchProgress() {
  stopProgress();
  progressTimer = setInterval(async () => {
    try {
      const { progress } = await chrome.storage.session.get('progress');
      if (progress?.phase) setStatus(`${progress.phase}…`);
    } catch {
      // session storage unavailable: no progress shown
    }
  }, 400);
}

function stopProgress() {
  clearInterval(progressTimer);
  progressTimer = null;
}

function renderCard(record, index) {
  const card = el('details', 'record');
  card.open = record.open;
  card.addEventListener('toggle', () => (record.open = card.open));
  const summary = el('summary');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = record.selected;
  box.title = 'Include in the CSV';
  box.addEventListener('change', () => {
    record.selected = box.checked;
    updateCounts();
  });
  record.metaEl = el('span', 'record-meta');
  summary.append(box, el('span', 'record-title', recordTitle(record, index)), record.metaEl);
  card.append(summary, renderBody(record));
  return card;
}

function renderBody(record) {
  const body = el('div', 'record-body');
  const grid = el('div', 'grid');
  for (const field of record.fields) grid.append(renderField(record, field));
  body.append(grid, ...renderLists(record), renderAddField(record));
  return body;
}

// Message history read by the saved layout: one collapsible list per kind.
function renderLists(record) {
  return Object.entries(record.collections ?? {}).map(([key, entries]) => {
    const list = el('details', 'history');
    list.append(el('summary', '', `${listName(key)} (${entries.length})`));
    const items = el('ol');
    for (const entry of entries.slice(0, 25)) {
      const item = el('li');
      const direction = /out/i.test(entry.direction ?? '') ? '→' : /in/i.test(entry.direction ?? '') ? '←' : '';
      const meta = [entry.timestamp || entry.date, direction, entry.sender || entry.author, entry.subject].filter(Boolean).join(' · ');
      item.append(el('span', 'history-meta', meta), el('span', 'history-body', entry.body || entry.text || entry.outcome || ''));
      items.append(item);
    }
    if (entries.length > 25) items.append(el('li', 'history-meta', `…and ${entries.length - 25} more (all go in the CSV)`));
    list.append(items);
    return list;
  });
}

function renderField(record, field) {
  const wrap = el('div', 'field');
  if (field.value.length > 30 || field.label.length > 24) wrap.classList.add('wide');
  const id = `f-${++fieldIds}`;
  const label = el('label', '', field.label);
  label.htmlFor = id;
  label.title = `${field.label} (column: ${field.key})`;
  const remove = el('button', 'remove', '×');
  remove.type = 'button';
  remove.title = 'Leave this field out';
  remove.addEventListener('click', () => {
    record.fields = record.fields.filter((f) => f !== field);
    render();
  });
  const head = el('div', 'field-head');
  head.append(label, remove);

  const input = el(field.value.length > 80 ? 'textarea' : 'input');
  input.id = id;
  input.value = field.value;
  if (input.tagName === 'TEXTAREA') input.rows = 3;
  input.addEventListener('input', () => {
    field.value = input.value;
    field.edited = true;
    setFlag(wrap, '');
    updateCounts();
    if (savedAsRead) {
      savedAsRead = false;
      $('save').textContent = 'Save changes';
      $('save').disabled = false;
    }
  });
  setFlag(wrap, flagOf(field));
  wrap.append(head, input);
  return wrap;
}

function renderAddField(record) {
  const row = el('div', 'add-field');
  const name = el('input');
  name.placeholder = 'New field name';
  const value = el('input');
  value.placeholder = 'Value';
  const add = el('button', '', 'Add');
  add.type = 'button';
  const commit = () => {
    const key = toKey(name.value);
    if (!key || !value.value.trim()) return (key ? value : name).focus();
    const existing = record.fields.find((f) => f.key === key);
    if (existing) Object.assign(existing, { value: value.value, edited: true });
    else record.fields.push({ key, label: name.value.trim(), value: value.value, check: 'user', edited: true });
    render();
  };
  add.addEventListener('click', commit);
  value.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit();
  });
  row.append(name, value, add);
  return row;
}

function recordTitle(record, index) {
  const get = (key) => record.fields.find((f) => f.key === key)?.value.trim();
  const person = [get('first_name'), get('last_name')].filter(Boolean).join(' ');
  const title = get('full_name') || person || TITLE_KEYS?.map(get).find(Boolean) || filled(record)[0]?.value;
  return (title || `Record ${index + 1}`).slice(0, 60);
}

function setFlag(wrap, flag) {
  wrap.classList.remove('flag-not_on_page', 'flag-bad_format');
  if (flag) wrap.classList.add(`flag-${flag}`);
  wrap.title = FLAG_HELP[flag] ?? '';
}

// Record summaries, select-all state, the legend and the Save label.
function updateCounts() {
  let flaggedTotal = 0;
  for (const record of records) {
    const flagged = record.fields.filter(flagOf).length;
    flaggedTotal += flagged;
    if (record.metaEl) {
      record.metaEl.textContent = `${filled(record).length} fields${flagged ? ` · ${flagged} to check` : ''}`;
      record.metaEl.classList.toggle('flagged', flagged > 0);
    }
  }
  $('legend').hidden = !flaggedTotal;
  const selected = records.filter((r) => r.selected).length;
  if (records.length > 1) {
    $('selected-count').textContent = `${selected} of ${records.length} selected`;
    $('select-all').checked = selected === records.length;
    $('select-all').indeterminate = selected > 0 && selected < records.length;
    $('save').textContent = selected ? `Save ${selected} to CSV` : 'Save to CSV';
  } else {
    $('save').textContent = 'Save to CSV';
  }
}

function setStatus(text, tone = '') {
  $('status').textContent = text;
  $('status').className = `status ${tone}`;
}

function setBusy(busy) {
  $('save').disabled = busy || savedAsRead;
  $('capture-all').disabled = busy;
  $('map-crm').disabled = busy;
  $('rescan').disabled = busy;
}

async function save() {
  const chosen = records.length === 1 ? records : records.filter((r) => r.selected);
  const payload = chosen
    .map((record) => ({
      fields: Object.fromEntries(filled(record).map((f) => [f.key, f.value])),
      unverified: record.fields.filter(flagOf).map((f) => f.key),
      collections: record.collections,
      pageUrl: record.pageUrl,
      recordId: record.recordId,
    }))
    .filter((record) => Object.keys(record.fields).length);
  if (!payload.length) {
    setStatus('Nothing to save. Select a record or add a field.', 'error');
    return;
  }

  setBusy(true);
  try {
    const meta = { pageUrl: page.url, pageTitle: page.title, site: page.site, recordId: page.recordId, dataset: page.dataset || undefined };
    const result = await send({ type: 'save', records: payload, meta });
    renderToday(result);
    if (result.fileError) {
      showBanner(result.fileError, result.date);
      setStatus('Saved in the extension. The CSV file needs another write (see above).', 'warn');
    } else {
      hideBanner();
      const parts = [
        result.added && `${result.added} new`,
        result.updated && `${result.updated} updated`,
        result.messagesAdded && `${result.messagesAdded} messages to ${result.messagesFilename}`,
      ].filter(Boolean);
      setStatus(`Saved ${parts.join(', ')} · ${result.filename}`, 'success');
    }
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshToday() {
  try {
    const result = await send({ type: 'status' });
    renderToday(result);
    if (result.lastWriteError) showBanner(result.lastWriteError.message, result.lastWriteError.date);
  } catch (error) {
    $('today').textContent = error.message;
  }
}

function renderToday({ count, datasets = {}, messages, filename }) {
  const kinds = Object.entries(datasets).map(([kind, n]) => `${n} ${kind}`).join(', ');
  $('today').textContent = `Today: ${count} saved${kinds ? ` (${kinds})` : ''}${messages ? `, ${messages} messages` : ''} → Downloads/${filename}`;
}

function showBanner(message, date) {
  failedWriteDate = date;
  $('banner-text').textContent = message;
  $('banner').hidden = false;
}

function hideBanner() {
  failedWriteDate = null;
  $('banner').hidden = true;
}

async function retryWrite() {
  $('retry').disabled = true;
  try {
    const result = await send({ type: 'writeDay', date: failedWriteDate });
    if (result.fileError) {
      showBanner(result.fileError, result.date);
    } else {
      hideBanner();
      setStatus(`Wrote ${result.filename}`, 'success');
    }
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    $('retry').disabled = false;
  }
}
