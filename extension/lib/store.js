// Captures live in chrome.storage.local, one array per day and kind of data:
// "rows:2026-09-29" (customers), "rows.users:2026-09-29", "rows.deals:…" and
// so on (see lib/mapper/datasets.js), plus "messages:2026-09-29" (message
// history). This is the source of truth; CSV files are regenerated from it,
// so a failed file write never loses a capture.
import { findDuplicateIndex, mergeRow } from './records.js';

// Customers keep the key they had before there were several kinds.
const rowsKind = (dataset) => (!dataset || dataset === 'customers' ? 'rows' : `rows.${dataset}`);
const key = (kind, date) => `${kind}:${date}`;

async function read(kind, date) {
  const stored = await chrome.storage.local.get(key(kind, date));
  return stored[key(kind, date)] ?? [];
}

export const getRows = (date, dataset = 'customers') => read(rowsKind(dataset), date);
export const getMessages = (date) => read('messages', date);

// byContact: rows are people, so a shared email or phone means the same row.
export async function upsertRows(date, newRows, dataset = 'customers', { byContact = true } = {}) {
  const rows = await getRows(date, dataset);
  let added = 0;
  let updated = 0;
  for (const row of newRows) {
    const index = findDuplicateIndex(rows, row, { byContact });
    if (index >= 0) {
      rows[index] = mergeRow(rows[index], row);
      updated++;
    } else {
      rows.push(row);
      added++;
    }
  }
  await chrome.storage.local.set({ [key(rowsKind(dataset), date)]: rows });
  return { rows, added, updated };
}

// Messages already captured (same message_id) are kept as they are.
export async function addMessages(date, newMessages) {
  const messages = await getMessages(date);
  const known = new Set(messages.map((m) => m.message_id));
  const fresh = newMessages.filter((m) => !known.has(m.message_id) && known.add(m.message_id));
  if (fresh.length) await chrome.storage.local.set({ [key('messages', date)]: [...messages, ...fresh] });
  return { messages: [...messages, ...fresh], added: fresh.length };
}

const DAY_KEY = /^(?:rows(?:\.([a-z_]+))?|(messages)):(\d{4}-\d{2}-\d{2})$/;

// Everything saved for one day: { datasets: { customers: [rows], users: [rows]… }, messages: [rows] }.
export async function getDay(date) {
  const all = await chrome.storage.local.get(null);
  const day = { datasets: {}, messages: [] };
  for (const [storageKey, list] of Object.entries(all)) {
    const match = storageKey.match(DAY_KEY);
    if (!match || match[3] !== date || !Array.isArray(list)) continue;
    if (match[2]) day.messages = list;
    else if (list.length) day.datasets[match[1] ?? 'customers'] = list;
  }
  return day;
}

// [{ date, count (rows of every kind), datasets: { kind: n }, messages }], newest first.
export async function listDays() {
  const all = await chrome.storage.local.get(null);
  const days = new Map();
  for (const [storageKey, list] of Object.entries(all)) {
    const match = storageKey.match(DAY_KEY);
    if (!match || !Array.isArray(list)) continue;
    const day = days.get(match[3]) ?? { date: match[3], count: 0, datasets: {}, messages: 0 };
    if (match[2]) day.messages = list.length;
    else if (list.length) {
      day.datasets[match[1] ?? 'customers'] = list.length;
      day.count += list.length;
    }
    days.set(match[3], day);
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
}
