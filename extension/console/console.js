// The capture window: starts a whole-CRM capture, follows it from session
// storage (status, counts, every value read), and lists today's files.
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

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Something went wrong.');
  return response;
}

let crms = [];
let failedWriteDate = null;
let activeSite = null;
let busy = false;
let lastLog = '';
let lastBulk = null;

async function loadCrms() {
  try {
    ({ crms } = await send({ type: 'listCrms' }));
  } catch {
    crms = [];
  }
  const select = $('crm-select');
  const current = select.value;
  select.replaceChildren(...crms.map((c) => Object.assign(el('option', '', `${c.name} (layout v${c.version})`), { value: c.id })));
  if (crms.some((c) => c.id === current)) select.value = current;
  $('capture-crm').disabled = busy || !crms.length;
  if (!crms.length) select.replaceChildren(el('option', '', 'No CRM layout bundled'));
}

const kindCounts = (byKind = {}) => Object.entries(byKind).map(([kind, n]) => `${n} ${kind}`).join(', ');

function renderCounts(bulk) {
  const counts = [
    ['found', bulk.found ?? 0],
    ['captured', `${bulk.captured}${kindCounts(bulk.byKind) ? ` (${kindCounts(bulk.byKind)})` : ''}`],
    ['saved', bulk.saved],
    ['messages', bulk.messages ?? 0],
    ['layout partly fit', bulk.partial ?? 0],
    ['failed', bulk.failed],
    ['pages walked', bulk.pages],
  ];
  const stores = Object.entries(bulk.byStore ?? {});
  if (stores.length) counts.push(['stores: ' + stores.map(([name, n]) => `${name} ${n}`).join(', '), stores.length]);
  $('now-counts').replaceChildren(...counts.map(([label, value]) => Object.assign(el('span'), { innerHTML: `<b>${value}</b> ${label}` })));
}

function renderRecent(bulk) {
  const body = document.querySelector('#recent tbody');
  body.replaceChildren(
    ...(bulk?.recent ?? []).map((r) => {
      const tr = el('tr');
      tr.append(el('td', r.partial ? 'partial' : '', r.name || '(no name)'), el('td', '', r.store ? `${r.kind} · ${r.store}` : r.kind || ''), el('td', '', String(r.fields)), el('td', '', String(r.messages)));
      const link = Object.assign(el('a', '', 'open'), { href: r.url, target: '_blank' });
      const td = el('td');
      td.append(link);
      tr.append(td);
      return tr;
    }),
  );
  $('recent-empty').hidden = Boolean(bulk?.recent?.length);
}

function renderLog(lines) {
  const text = [...lines, ...(diagnostic.length ? ['', '— Describe this tab —', ...diagnostic] : [])].join('\n');
  if (text === lastLog) return;
  lastLog = text;
  $('log').textContent = text;
  if ($('follow').checked) $('log').scrollTop = $('log').scrollHeight;
}

function renderBulk(bulk) {
  lastBulk = bulk;
  const running = bulk.status === 'running';
  $('now-title').textContent = running ? `Capturing ${bulk.name}…` : `${bulk.name}: capture ${bulk.status}`;
  const end = running ? Date.now() : bulk.finishedAt ?? Date.now();
  $('now-time').textContent = `${fmtTime(end - bulk.startedAt)} elapsed${running && bulk.total && bulk.captured ? ` · about ${fmtTime(((end - bulk.startedAt) / bulk.captured) * (bulk.total - bulk.captured - bulk.failed))} left` : ''}`;
  const fraction = bulk.total ? (bulk.captured + bulk.failed) / bulk.total : 0;
  $('now-bar').style.width = `${Math.round((bulk.status === 'done' ? 1 : fraction) * 100)}%`;
  $('now-phase').textContent = bulk.phase || (bulk.error ? bulk.error : '');
  renderCounts(bulk);
  $('cancel').hidden = !running;
  $('now-note').textContent = bulk.fileError ?? '';
  renderLog(bulk.log ?? []);
  renderRecent(bulk);
}

function renderIdle() {
  lastBulk = null;
  $('now-title').textContent = 'Idle';
  $('now-time').textContent = '';
  $('now-bar').style.width = '0';
  $('now-phase').textContent = 'Pick a CRM above, or use the button for the CRM tab you are on.';
  $('now-counts').replaceChildren();
  $('cancel').hidden = true;
  renderLog([]);
  renderRecent(null);
}

// The CRM tab the user is working in: what the layouts know, and the action that fits.
async function refreshSite() {
  const { site } = await send({ type: 'activeSite' }).catch(() => ({ site: null }));
  activeSite = site;
  if (!site) {
    $('site-name').textContent = 'No CRM tab open';
    $('site-text').textContent = 'Open a CRM in another tab; this window follows the tab you are using.';
    $('site-capture').hidden = true;
    return;
  }
  $('site-name').textContent = site.name;
  $('here-capture').hidden = busy;
  $('here-kind').hidden = busy;
  if (site.crmId) {
    $('site-text').textContent = `Layout v${site.version} bundled for ${(site.datasets ?? []).join(', ') || 'records'}${site.lists ? ` (${site.lists} list${site.lists > 1 ? 's' : ''})` : ' (no list mapped: the capture walks on from the page you are on)'}. ${site.role === 'record' ? 'The open tab shows a record.' : site.role === 'list' ? 'The open tab shows a list.' : ''}`;
    $('site-capture').hidden = busy;
    const select = $('crm-select');
    if (crms.some((c) => c.id === site.crmId)) select.value = site.crmId;
  } else {
    $('site-text').textContent = `No layout is bundled for ${site.host}: open its list in the tab (press Search if it needs one) and use Capture this tab.`;
    $('site-capture').hidden = true;
  }
}

// What the CRM tab shows right now: a data grid (and its size), a Search button.
let gridProbe = { key: null, at: 0 };
async function refreshTabGrid() {
  if (!activeSite || busy) return ($('site-grid').textContent = '');
  const key = `${activeSite.tabId}|${activeSite.url}`;
  if (gridProbe.key === key && Date.now() - gridProbe.at < 10_000) return;
  gridProbe = { key, at: Date.now() };
  const { grid, loader } = await send({ type: 'tabGrid', tabId: activeSite.tabId }).catch(() => ({ grid: null, loader: null }));
  if (gridProbe.key !== key) return;
  if (grid) $('site-grid').textContent = `On this tab: a grid with ${grid.count} row${grid.count === 1 ? '' : 's'} (looks like ${grid.dataset}: ${grid.headers.filter(Boolean).slice(0, 8).join(', ')}${grid.headers.length > 8 ? '…' : ''}).`;
  else if (loader) $('site-grid').textContent = `On this tab: no data grid yet, but a "${loader}" button. Press it in the CRM (with the filters you want), then Capture this tab.`;
  else $('site-grid').textContent = 'On this tab: no data grid found. Open a list screen in the CRM first.';
}

let diagnostic = [];
async function tick() {
  const status = await send({ type: 'bulkStatus' }).catch(() => ({ bulk: null, diagnostic: [] }));
  const { bulk } = status;
  diagnostic = status.diagnostic ?? [];
  busy = bulk?.status === 'running';
  $('clear').hidden = busy || (!bulk && !diagnostic.length);
  if (bulk) renderBulk(bulk);
  else renderIdle();
  $('capture-crm').disabled = busy || !crms.length;
}

async function refreshToday() {
  try {
    const result = await send({ type: 'status' });
    const kinds = kindCounts(result.datasets);
    $('today').textContent = `${result.count} records${kinds ? ` (${kinds.replace(/@/g, ' · ')})` : ''}, ${result.messages} messages → Downloads/${result.filename}`;
    failedWriteDate = result.lastWriteError?.date ?? null;
    $('retry').hidden = !failedWriteDate;
    if (result.lastWriteError) $('now-note').textContent = result.lastWriteError.message;
  } catch (error) {
    $('today').textContent = error.message;
  }
}

function start(crmId, startUrl = null) {
  const crm = crms.find((c) => c.id === crmId);
  if (!crm) return;
  if (!confirm(`Capture every record of ${crm.name}? Its pages load in a tab next to this one (same tab group), which stays in front while it runs; the toolbar badge counts the records, and this page comes back when it is done. Every store/dealer the CRM offers is captured to its own files.`)) return;
  $('now-note').textContent = '';
  send({ type: 'captureCrm', crmId, startUrl }).catch((error) => ($('now-note').textContent = error.message));
}

$('capture-crm').addEventListener('click', () => start($('crm-select').value));
$('site-capture').addEventListener('click', () => activeSite?.crmId && start(activeSite.crmId, activeSite.url));
$('describe-tab').addEventListener('click', async () => {
  if (!activeSite) return;
  $('now-note').textContent = '';
  try {
    await send({ type: 'describeTab', tabId: activeSite.tabId });
    await tick();
  } catch (error) {
    $('now-note').textContent = error.message;
  }
});
$('here-capture').addEventListener('click', () => {
  if (!activeSite) return;
  if (!confirm(`Capture the list shown on ${activeSite.host}? It is read page after page in that tab, for the dealer/store the tab is on (don't use the tab meanwhile), and saved to today's CSV as it goes.`)) return;
  $('now-note').textContent = '';
  send({ type: 'captureHere', tabId: activeSite.tabId, dataset: $('here-kind').value || null }).catch((error) => ($('now-note').textContent = error.message));
});
$('cancel').addEventListener('click', () => send({ type: 'cancelCapture' }).catch(() => {}));
$('clear').addEventListener('click', () => send({ type: 'clearJobs' }).then(tick).catch(() => {}));
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
// The log as shown, as a text file in Downloads.
$('save-log').addEventListener('click', () => {
  const name = `capture_log_${(lastBulk?.name || 'crm').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  const url = URL.createObjectURL(new Blob([$('log').textContent], { type: 'text/plain' }));
  chrome.downloads.download({ url, filename: name, saveAs: true }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 60_000));
});

loadCrms().then(refreshSite).then(refreshTabGrid);
setInterval(() => refreshSite().then(refreshTabGrid), 2000);
refreshToday();
tick();
setInterval(tick, 1000);
setInterval(refreshToday, 5000);
