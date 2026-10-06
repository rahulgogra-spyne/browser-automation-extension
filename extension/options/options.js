import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../lib/settings.js';
import { csvFileName } from '../lib/csv.js';
import { localDateKey } from '../lib/dates.js';

const form = document.getElementById('settings-form');
const keys = Object.keys(DEFAULT_SETTINGS);

const readValues = () => Object.fromEntries(keys.map((key) => [key, form.elements[key].value.trim()]));

function showExample() {
  document.getElementById('file-example').textContent = `Today's files: Downloads/${csvFileName(readValues(), localDateKey(), 'KIND').replace('KIND', '<kind>')} (one per kind of data, plus messages and reference)`;
}

async function loadSettings() {
  const settings = await getSettings();
  for (const key of keys) form.elements[key].value = settings[key];
  showExample();
}

form.addEventListener('input', showExample);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveSettings(readValues());
  const msg = document.getElementById('saved-msg');
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

async function loadCrms() {
  const body = document.querySelector('#crms tbody');
  body.replaceChildren();
  let crms;
  try {
    ({ crms } = await send({ type: 'listCrms' }));
  } catch (error) {
    return emptyRow(body, 4, error.message);
  }
  if (!crms.length) return emptyRow(body, 4, 'No CRM layouts are bundled.');
  for (const crm of crms) {
    const row = body.insertRow();
    row.insertCell().textContent = crm.name;
    row.insertCell().textContent = crm.hosts.join(', ');
    row.insertCell().textContent = crm.datasets.join(', ') || '—';
    row.insertCell().textContent = `v${crm.version} · ${crm.lists} list${crm.lists === 1 ? '' : 's'}`;
  }
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
    msg.textContent = result.fileError || `Wrote ${result.files.length} files to Downloads: ${result.files.join(', ')}`;
  } catch (error) {
    msg.className = 'status error';
    msg.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

document.getElementById('open-folder').addEventListener('click', () => chrome.downloads.showDefaultFolder());

loadSettings();
loadCrms();
loadDays();
