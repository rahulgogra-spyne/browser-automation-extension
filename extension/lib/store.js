// Captures live in chrome.storage.local, one array per day, kind of data and
// store: "rows:2026-09-29" (customers), "rows.users:2026-09-29",
// "rows.deals@sunrise-toyota:2026-09-29" (a store's deals) and so on (see
// lib/datasets.js), plus "messages:2026-09-29" / "messages@<store>:…"
// (message history). This is the source of truth; CSV files are regenerated
// from it, so a failed file write never loses a capture.
import { findDuplicateIndex, mergeRow } from './records.js';

// Customers keep the key they had before there were several kinds.
const rowsKind = (dataset, store = '') => `${!dataset || dataset === 'customers' ? 'rows' : `rows.${dataset}`}${store ? `@${store}` : ''}`;
const messagesKind = (store = '') => `messages${store ? `@${store}` : ''}`;
const key = (kind, date) => `${kind}:${date}`;

async function read(kind, date) {
  const stored = await chrome.storage.local.get(key(kind, date));
  return stored[key(kind, date)] ?? [];
}

export const getRows = (date, dataset = 'customers', store = '') => read(rowsKind(dataset, store), date);
export const getMessages = (date, store = '') => read(messagesKind(store), date);

// byContact: rows are people, so a shared email or phone means the same row.
// store: a store's slug; its rows are kept apart from other stores'.
export async function upsertRows(date, newRows, dataset = 'customers', { byContact = true, store = '' } = {}) {
  const rows = await getRows(date, dataset, store);
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
  await chrome.storage.local.set({ [key(rowsKind(dataset, store), date)]: rows });
  return { rows, added, updated };
}

// Messages already captured (same message_id) are kept as they are.
export async function addMessages(date, newMessages, { store = '' } = {}) {
  const messages = await getMessages(date, store);
  const known = new Set(messages.map((m) => m.message_id));
  const fresh = newMessages.filter((m) => !known.has(m.message_id) && known.add(m.message_id));
  if (fresh.length) await chrome.storage.local.set({ [key(messagesKind(store), date)]: [...messages, ...fresh] });
  return { messages: [...messages, ...fresh], added: fresh.length };
}

const DAY_KEY = /^(?:rows(?:\.([a-z_]+))?|(messages))(?:@([a-z0-9-]+))?:(\d{4}-\d{2}-\d{2})$/;

// Everything saved for one day: { datasets: { "customers": [rows],
// "users@store-a": [rows]… }, messages: { "": [rows], "store-a": [rows] } }.
export async function getDay(date) {
  const all = await chrome.storage.local.get(null);
  const day = { datasets: {}, messages: {} };
  for (const [storageKey, list] of Object.entries(all)) {
    const match = storageKey.match(DAY_KEY);
    if (!match || match[4] !== date || !Array.isArray(list)) continue;
    const store = match[3] ?? '';
    if (match[2]) day.messages[store] = list;
    else if (list.length) day.datasets[`${match[1] ?? 'customers'}${store ? `@${store}` : ''}`] = list;
  }
  return day;
}

// [{ date, count (rows of every kind), datasets: { "kind[@store]": n }, messages }], newest first.
export async function listDays() {
  const all = await chrome.storage.local.get(null);
  const days = new Map();
  for (const [storageKey, list] of Object.entries(all)) {
    const match = storageKey.match(DAY_KEY);
    if (!match || !Array.isArray(list)) continue;
    const day = days.get(match[4]) ?? { date: match[4], count: 0, datasets: {}, messages: 0 };
    const store = match[3] ?? '';
    if (match[2]) day.messages += list.length;
    else if (list.length) {
      day.datasets[`${match[1] ?? 'customers'}${store ? `@${store}` : ''}`] = list.length;
      day.count += list.length;
    }
    days.set(match[4], day);
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
}
