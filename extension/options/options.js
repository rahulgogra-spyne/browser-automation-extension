import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../lib/settings.js';
import { csvFileName } from '../lib/csv.js';
import { localDateKey } from '../lib/dates.js';
import { DATASETS, datasetsFrom } from '../lib/mapper/datasets.js';

// One checkbox per kind of data.
const targetBox = document.getElementById('captureTargets');
for (const dataset of Object.values(DATASETS)) {
  const label = document.createElement('label');
  label.className = 'check';
  const input = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'captureTargets', value: dataset.id });
  label.append(input, ` ${dataset.label}`);
  targetBox.append(label);
}
const checkedTargets = () => [...targetBox.querySelectorAll('input:checked')].map((input) => input.value);

const form = document.getElementById('settings-form');
const keys = Object.keys(DEFAULT_SETTINGS).filter((key) => key !== 'captureTargets');

const readValues = () => ({ ...Object.fromEntries(keys.map((key) => [key, form.elements[key].value.trim()])), captureTargets: checkedTargets() });

function showExample() {
  document.getElementById('file-example').textContent =
    `Today's files: Downloads/${csvFileName(readValues(), localDateKey(), 'KIND').replace('KIND', '<kind>')} (${[...checkedTargets(), 'messages', 'reference'].join(', ')})`;
}

async function loadSettings() {
  const settings = await getSettings();
  for (const key of keys) form.elements[key].value = settings[key];
  const wanted = new Set(datasetsFrom(settings.captureTargets).map((d) => d.id));
  for (const input of targetBox.querySelectorAll('input')) input.checked = wanted.has(input.value);
  showExample();
}

form.addEventListener('input', showExample);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = readValues();
  const msg = document.getElementById('saved-msg');
  if (!values.captureTargets.length) {
    msg.textContent = 'Tick at least one kind of data to capture.';
    return;
  }
  values.backendUrl = values.backendUrl.replace(/\/+$/, '');
  await saveSettings(values);
  msg.textContent = 'Saved';
  setTimeout(() => (msg.textContent = ''), 2000);
});

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Something went wrong.');
  return response;
}

function emptyRow(body, columns, text) {
  const cell = body.insertRow().insertCell();
  cell.colSpan = columns;
  cell.className = 'muted';
  cell.textContent = text;
}

const since = (iso) => {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

async function loadCrms() {
  const body = document.querySelector('#crms tbody');
  const msg = document.getElementById('crms-msg');
  body.replaceChildren();
  let status;
  try {
    status = await send({ type: 'crmStatus' });
    await send({ type: 'refreshCrmConfig' });
  } catch (error) {
    emptyRow(body, 5, error.message);
    return;
  }
  const jobs = [status.jobs.running, ...status.jobs.queued].filter(Boolean);
  for (const crm of status.crms) {
    const row = body.insertRow();
    row.insertCell().textContent = crm.name;
    row.insertCell().textContent = crm.version ? (crm.targets ?? []).join(', ') || '—' : '—';
    const layout = row.insertCell();
    const describe = (pt) => {
      if (pt.role === 'list') return `${pt.entity || 'record'} list`;
      if (pt.role === 'screen') return `"${pt.entity}" grid (${pt.dataset || 'records'}, reached by clicking)`;
      if (pt.role === 'message') return `message page (${pt.id})`;
      return `${pt.entity || 'person'} record: ${pt.views.join(', ')}`;
    };
    layout.textContent = crm.version ? `v${crm.version} · ${crm.pageTypes.map(describe).join(' · ')}` : 'not mapped yet';
    const job = jobs.find((j) => j.crmId === crm.id);
    const lastFailed = crm.lastAttempt && !crm.lastAttempt.ok ? ` · last attempt failed: ${crm.lastAttempt.error}` : '';
    row.insertCell().textContent = job ? `${job.status === 'running' ? 'mapping now' : 'queued'} (${job.reason})` : `${since(crm.mappedAt)}${lastFailed}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Re-map now';
    button.disabled = Boolean(job);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await send({ type: 'crmRemap', crmId: crm.id });
        if (result.extension) {
          // Mapped from this browser: re-map from this browser.
          msg.className = 'status';
          msg.textContent = `${crm.name}: re-mapping from this browser (2–4 minutes)…`;
          const { crmConfig } = await chrome.storage.local.get('crmConfig');
          const entry = crmConfig?.data?.crms?.[crm.id];
          const done = await send({ type: 'mapCrm', site: { id: crm.id, name: entry.name, match: entry.match, startUrl: entry.startUrl }, reason: 'requested from settings' });
          msg.className = 'status success';
          msg.textContent = `${crm.name}: layout v${done.version} saved (${done.pageTypes.join(', ')}).`;
        } else {
          msg.className = 'status success';
          msg.textContent = result.queued ? `${crm.name}: mapping started on the server. This takes a couple of minutes.` : `${crm.name}: ${result.reason}.`;
        }
      } catch (error) {
        msg.className = 'status error';
        msg.textContent = error.message;
      }
      setTimeout(loadCrms, 1000);
    });
    row.insertCell().append(button);
  }
  if (!status.crms.length) emptyRow(body, 5, 'No CRMs are set up on the server (backend/config/crm-sites.json).');
  // Keep the table live while a mapping runs.
  if (jobs.length) setTimeout(loadCrms, 5000);
}

async function loadDays() {
  const { days } = await send({ type: 'listDays' });
  const body = document.querySelector('#days tbody');
  body.replaceChildren();
  if (!days.length) return emptyRow(body, 4, 'Nothing captured yet.');
  for (const { date, count, datasets = {}, messages } of days) {
    const row = body.insertRow();
    row.insertCell().textContent = date;
    const kinds = Object.entries(datasets).map(([kind, n]) => `${n} ${kind}`).join(', ');
    row.insertCell().textContent = kinds ? `${count} (${kinds})` : count;
    row.insertCell().textContent = messages;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Write CSV';
    button.addEventListener('click', () => writeDay(date, button));
    row.insertCell().append(button);
  }
}

async function writeDay(date, button) {
  const msg = document.getElementById('days-msg');
  button.disabled = true;
  try {
    const result = await send({ type: 'writeDay', date });
    msg.className = result.fileError ? 'status error' : 'status success';
    msg.textContent =
      result.fileError || `Wrote ${(result.files ?? [result.filename]).length} files to Downloads: ${(result.files ?? [result.filename]).join(', ')}`;
  } catch (error) {
    msg.className = 'status error';
    msg.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

document.getElementById('open-folder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
document.getElementById('refresh-crms').addEventListener('click', loadCrms);

loadSettings();
loadCrms();
loadDays();
