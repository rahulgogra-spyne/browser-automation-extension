// The capture window: follows the running job (mapping or whole-CRM
// capture) from session storage, lists what was captured, and can start
// jobs itself so the popup never has to be reopened.
const $ = (id) => document.getElementById(id);
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const MAP_STAGES = [
  ['explore', 'Exploring the CRM'],
  ['classify', 'Working out which pages show people'],
  ['record', 'Mapping a record and its sections'],
  ['message', 'Mapping message pages'],
  ['list', 'Mapping lists'],
  ['validate', 'Checking on a second record'],
  ['save', 'Saving the layout'],
];
const STAGE_RANK = { explore: 0, classify: 1, record: 2, validate: 2, message: 3, list: 4, save: 6 };

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Something went wrong.');
  return response;
}

let crms = [];
let failedWriteDate = null;
let activeSite = null;
let busy = false;

async function loadCrms() {
  try {
    ({ crms } = await send({ type: 'refreshCrmConfig' }));
  } catch {
    crms = [];
  }
  const select = $('crm-select');
  const current = select.value;
  select.replaceChildren(...crms.map((c) => Object.assign(el('option', '', `${c.name} (layout v${c.version})`), { value: c.id })));
  if (crms.some((c) => c.id === current)) select.value = current;
  $('capture-crm').disabled = !crms.length;
  if (!crms.length) select.replaceChildren(el('option', '', 'No CRM mapped yet'));
}

const kindCounts = (byKind = {}) => Object.entries(byKind).map(([kind, n]) => `${n} ${kind}`).join(', ');

function renderCounts(bulk) {
  const counts = [
    ['found', bulk.found ?? 0],
    ['captured', `${bulk.captured}${kindCounts(bulk.byKind) ? ` (${kindCounts(bulk.byKind)})` : ''}`],
    ['saved', bulk.saved],
    ['failed', bulk.failed],
    ['read by AI', bulk.aiFallbacks ?? 0],
    ['layout re-mapped', bulk.remapped ?? 0],
    ['pages walked', bulk.pages],
  ];
  $('now-counts').replaceChildren(...counts.map(([label, value]) => Object.assign(el('span'), { innerHTML: `<b>${value}</b> ${label}` })));
}

function renderRecent(bulk) {
  const body = document.querySelector('#recent tbody');
  body.replaceChildren(
    ...(bulk?.recent ?? []).map((r) => {
      const tr = el('tr');
      tr.append(el('td', '', r.name || '(no name)'), el('td', '', r.kind || ''), el('td', '', String(r.fields)), el('td', '', String(r.messages)));
      const link = Object.assign(el('a', '', 'open'), { href: r.url, target: '_blank' });
      const td = el('td');
      td.append(link);
      tr.append(td);
      return tr;
    }),
  );
  $('recent-empty').hidden = Boolean(bulk?.recent?.length);
}

function renderBulk(bulk) {
  const running = bulk.status === 'running';
  $('now-title').textContent = running ? `Capturing ${bulk.name}…` : `${bulk.name}: capture ${bulk.status}`;
  const end = running ? Date.now() : bulk.finishedAt ?? Date.now();
  $('now-time').textContent = `${fmtTime(end - bulk.startedAt)} elapsed${running && bulk.total && bulk.captured ? ` · about ${fmtTime(((end - bulk.startedAt) / bulk.captured) * (bulk.total - bulk.captured - bulk.failed))} left` : ''}`;
  const fraction = bulk.total ? (bulk.captured + bulk.failed) / bulk.total : 0;
  $('now-bar').style.width = `${Math.round((bulk.status === 'done' ? 1 : fraction) * 100)}%`;
  $('now-phase').textContent = bulk.phase || (bulk.error ? bulk.error : '');
  renderCounts(bulk);
  $('map-stages').hidden = true;
  $('cancel').hidden = !running;
  $('now-note').textContent = bulk.fileError ?? '';
  $('log').textContent = (bulk.log ?? []).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  renderRecent(bulk);
}

// capture: the capture running beside this mapping (each kind of data is
// read as soon as its layout is ready), shown in the same card.
function renderMapping(mapping, capture = null) {
  const running = mapping.status === 'running';
  $('now-title').textContent = running ? `Mapping ${mapping.name}${capture ? ' and capturing as layouts get ready' : ''}…` : mapping.status === 'done' ? `${mapping.name} mapped (layout v${mapping.version})` : `Mapping ${mapping.name} failed`;
  const end = running ? Date.now() : mapping.finishedAt ?? Date.now();
  const elapsed = end - mapping.startedAt;
  const remaining = Math.max(0, (mapping.estimateMs ?? 0) - elapsed);
  const left = remaining < 20_000 ? 'a few seconds left' : remaining < 60_000 ? 'under a minute left' : `about ${Math.ceil(remaining / 60_000)} min left`;
  $('now-time').textContent = running ? `${fmtTime(elapsed)} elapsed · ${left}` : fmtTime(elapsed);
  $('now-bar').style.width = `${Math.round((mapping.status === 'done' ? 1 : Math.min(0.97, elapsed / Math.max(1, mapping.estimateMs ?? 1))) * 100)}%`;
  let detail = mapping.detail || '';
  if (running && mapping.stage === 'explore' && mapping.total) detail = `Page ${mapping.current} of up to ${mapping.total}: ${detail}`;
  if (running && mapping.stage === 'record' && mapping.total > 1) detail = `Section ${mapping.current} of ${mapping.total}: ${detail}`;
  if (mapping.status === 'failed') detail = mapping.error;
  if (mapping.status === 'done') detail = `Saved: ${(mapping.pageTypes ?? []).join(', ')}`;
  if (running && mapping.targetLabel) detail = `${detail}  ·  looking for ${mapping.targetLabel}`;
  if (capture?.phase) detail = `${detail}  ·  ${capture.phase}`;
  $('now-phase').textContent = detail;
  if (capture) renderCounts(capture);
  else $('now-counts').replaceChildren();
  const rank = mapping.status === 'done' ? 7 : (STAGE_RANK[mapping.stage] ?? 0);
  const stages = $('map-stages');
  stages.hidden = false;
  stages.replaceChildren(
    ...MAP_STAGES.map(([, label], i) => {
      const li = el('li', i < rank ? 'done' : i === rank && running ? 'current' : '');
      li.append(el('span', 'mark', i < rank ? '✓' : i === rank && running ? '▶' : '·'), el('span', '', label));
      return li;
    }),
  );
  $('cancel').hidden = true;
  $('log').textContent = [...(mapping.log ?? []), ...(capture?.log?.length ? ['', '— captured so far —', ...capture.log] : [])].join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  if (capture) renderRecent(capture);
}

// The CRM tab the user is working in: what the config knows, and the action that fits.
async function refreshSite() {
  const { site } = await send({ type: 'activeSite' }).catch(() => ({ site: null }));
  activeSite = site;
  if (!site) {
    $('site-name').textContent = 'No CRM tab open';
    $('site-text').textContent = 'Open a CRM in another tab; this window follows the tab you are using.';
    $('site-map').hidden = true;
    $('site-capture').hidden = true;
    return;
  }
  $('site-name').textContent = site.name;
  if (site.crmId) {
    $('site-text').textContent = `Mapped for ${(site.datasets ?? []).join(', ') || 'records'} (layout v${site.version}${site.lists ? `, ${site.lists} list${site.lists > 1 ? 's' : ''}` : ', no list yet: it will be looked for'}). ${site.role === 'record' ? 'The open tab shows a record.' : site.role === 'list' ? 'The open tab shows a list.' : ''}`;
    $('site-map').hidden = true;
    $('site-capture').hidden = busy;
    const select = $('crm-select');
    if (crms.some((c) => c.id === site.crmId)) select.value = site.crmId;
  } else {
    $('site-text').textContent = 'Not mapped yet. Map it from this browser (you are signed in): a few minutes, AI used once. Each kind of data is captured and saved as soon as its layout is ready.';
    $('site-map').hidden = busy;
    $('site-capture').hidden = true;
  }
  if (!$('map-url').value || $('map-url').dataset.auto === '1') {
    $('map-url').value = site.url;
    $('map-url').dataset.auto = '1';
  }
}

async function tick() {
  const [{ bulk }, { mapping }] = await Promise.all([send({ type: 'bulkStatus' }).catch(() => ({})), send({ type: 'mapStatus' }).catch(() => ({}))]);
  const bulkRunning = bulk?.status === 'running';
  const mapRunning = mapping?.status === 'running';
  busy = bulkRunning || mapRunning;
  $('clear').hidden = busy || (!bulk && !mapping);
  // The running job wins; otherwise the most recent one.
  if (mapRunning) renderMapping(mapping, bulk?.withMapping && bulk.crmId === mapping.crmId ? bulk : null);
  else if (mapping && !bulk) renderMapping(mapping);
  else if (bulk && (bulkRunning || !mapping || (bulk.finishedAt ?? bulk.startedAt) >= (mapping.finishedAt ?? mapping.startedAt) || (bulk.withMapping && bulk.found))) renderBulk(bulk);
  else if (mapping) renderMapping(mapping);
  else {
    $('now-title').textContent = 'Idle';
    $('now-time').textContent = '';
    $('now-bar').style.width = '0';
    $('now-phase').textContent = 'Use the buttons for the CRM tab you are on, pick a mapped CRM above, or map a new one below.';
    $('now-counts').replaceChildren();
    $('map-stages').hidden = true;
    $('log').textContent = '';
    document.querySelector('#recent tbody').replaceChildren();
    $('recent-empty').hidden = false;
  }
  $('capture-crm').disabled = bulkRunning || mapRunning || !crms.length;
  $('map-crm').disabled = bulkRunning || mapRunning;
}

async function refreshToday() {
  try {
    const result = await send({ type: 'status' });
    const kinds = kindCounts(result.datasets);
    $('today').textContent = `${result.count} records${kinds ? ` (${kinds})` : ''}, ${result.messages} messages → Downloads/${result.filename}`;
    failedWriteDate = result.lastWriteError?.date ?? null;
    $('retry').hidden = !failedWriteDate;
    if (result.lastWriteError) $('now-note').textContent = result.lastWriteError.message;
  } catch (error) {
    $('today').textContent = error.message;
  }
}

$('capture-crm').addEventListener('click', async () => {
  const crmId = $('crm-select').value;
  const crm = crms.find((c) => c.id === crmId);
  if (!crm) return;
  if (!confirm(`Capture every record of ${crm.name}? Each is opened in the tab next to this one and saved to today's CSV as it goes.`)) return;
  send({ type: 'captureCrm', crmId }).catch((error) => ($('now-note').textContent = error.message));
});
$('cancel').addEventListener('click', () => send({ type: 'cancelCapture' }).catch(() => {}));
$('clear').addEventListener('click', () => send({ type: 'clearJobs' }).then(tick).catch(() => {}));
$('site-capture').addEventListener('click', () => {
  if (!activeSite?.crmId) return;
  send({ type: 'captureCrm', crmId: activeSite.crmId, startUrl: activeSite.url }).catch((error) => ($('now-note').textContent = error.message));
});
$('site-map').addEventListener('click', async () => {
  if (!activeSite) return;
  $('now-note').textContent = '';
  try {
    await send({ type: 'mapCrm', startUrl: activeSite.url, reason: 'requested from the capture window' });
    await loadCrms();
    await refreshSite();
  } catch (error) {
    $('now-note').textContent = error.message;
  }
});
$('map-url').addEventListener('input', () => ($('map-url').dataset.auto = '0'));
$('map-crm').addEventListener('click', async () => {
  const startUrl = $('map-url').value.trim();
  if (!/^https?:\/\//.test(startUrl)) return ($('now-note').textContent = 'Enter the address of a page of the CRM.');
  $('now-note').textContent = '';
  try {
    await send({ type: 'mapCrm', startUrl, reason: 'requested from the capture window' });
    $('map-url').value = '';
    $('map-url').dataset.auto = '1';
    await loadCrms();
    await refreshSite();
  } catch (error) {
    $('now-note').textContent = error.message;
  }
});
$('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('open-folder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
$('retry').addEventListener('click', async () => {
  try {
    await send({ type: 'writeDay', date: failedWriteDate });
    $('now-note').textContent = '';
  } catch (error) {
    $('now-note').textContent = error.message;
  }
  refreshToday();
});

async function checkHealth() {
  const h = await send({ type: 'health' }).catch((e) => ({ ok: false, error: e.message }));
  const node = $('health');
  if (!h.ok) {
    node.textContent = `Server not reachable at ${h.backend ?? 'the configured address'} (${h.error ?? 'no answer'}). Start it with "npm start" in backend/ or fix the address in Settings.`;
    node.className = 'status error';
  } else if (!h.current) {
    node.textContent = `Server at ${h.backend} is an older version: restart it ("npm start" in backend/) so mapping works.`;
    node.className = 'status error';
  } else if (!h.keyOk) {
    node.textContent = `Server at ${h.backend} rejects the API key: set the same key in Settings as EXTENSION_API_KEY on the server.`;
    node.className = 'status error';
  } else {
    node.textContent = `Server OK at ${h.backend} (model ${h.model}).`;
    node.className = 'muted';
  }
}

loadCrms().then(refreshSite);
setInterval(refreshSite, 2000);
checkHealth();
setInterval(checkHealth, 15_000);
refreshToday();
tick();
setInterval(tick, 1000);
setInterval(refreshToday, 5000);
setInterval(loadCrms, 30_000);
