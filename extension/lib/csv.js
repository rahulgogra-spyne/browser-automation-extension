import { csvColumns } from './columns.js';

// RFC 4180 CSV with CRLF line endings. The UTF-8 BOM that makes Excel read
// accented names correctly is added by the sink when the file is written.
export function toCsv(rows, columns = csvColumns(rows)) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns?.map((c) => escapeCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function escapeCell(value) {
  let s = value == null ? '' : String(value);
  // Page content must never become a live spreadsheet formula (CSV injection).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// One file per kind of data, store and day, relative to Downloads:
// "SpyneLeads/leads_customers_2026-09-29.csv", "…/leads_users_…",
// "…/leads_customers_sunrise-toyota_2026-09-29.csv" (a store's rows),
// "…/leads_messages_…", "…/leads_reference_…".
export function csvFileName({ downloadFolder = '', filePrefix = '' }, date, kind = '', store = '') {
  const safe = (s) => String(s).replace(/[<>:"\\|?*\x00-\x1f]/g, '').trim();
  const folder = String(downloadFolder)
    .split(/[\\/]+/)
    ?.map(safe)
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  const prefix = safe(filePrefix).replace(/\//g, '') || 'leads';
  const slug = safe(store).replace(/[^a-z0-9-]/gi, '-').replace(/^-+|-+$/g, '');
  const name = `${prefix}${kind ? `_${kind}` : ''}${slug ? `_${slug}` : ''}_${date}.csv`;
  return folder ? `${folder}/${name}` : name;
}
