// Duplicate handling: capturing the same person or item twice in a day updates
// its row instead of adding another one.
import { META_KEYS, isPhoneKey, isEmailKey } from './columns.js';

function tenDigits(value) {
  const withoutExt = String(value || '').split(/\s*(?:ext\.?|extension|x)\s*\d/i)[0];
  const digits = withoutExt.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return local.length === 10 ? local : '';
}

// Emails and phone numbers found in any email-like or phone-like column.
export function contactIds(row) {
  const emails = new Set();
  const phones = new Set();
  for (const [key, value] of Object.entries(row)) {
    if (!value) continue;
    if (isEmailKey(key)) emails.add(String(value).toLowerCase());
    else if (isPhoneKey(key) && tenDigits(value)) phones.add(tenDigits(value));
  }
  return { emails, phones };
}

const sameOrUnknown = (a = '', b = '') => !a || !b || a.toLowerCase() === b.toLowerCase();

// Same site and dealer (or unknown), plus the same CRM record id or a shared
// email or phone, is the same person. Rows with no contact details match on
// record_id (identical values). Rows that are not people (deals, tasks,
// appointments, vehicles: byContact false) never match on a shared email or
// phone: two deals of one customer are two rows.
export function findDuplicateIndex(rows, row, { byContact = true } = {}) {
  const ids = byContact ? contactIds(row) : { emails: new Set(), phones: new Set() };
  const hasContact = ids.emails.size > 0 || ids.phones.size > 0;
  return rows.findIndex((existing) => {
    if (!sameOrUnknown(existing.site, row.site) || !sameOrUnknown(existing.dealer_name, row.dealer_name)) return false;
    if (row.crm_record_id && existing.crm_record_id) return row.crm_record_id === existing.crm_record_id;
    if (!hasContact) return existing.record_id === row.record_id;
    const other = contactIds(existing);
    for (const email of ids.emails) if (other.emails.has(email)) return true;
    for (const phone of ids.phones) if (other.phones.has(phone)) return true;
    return false;
  });
}

// New non-empty values win; the row keeps its original record_id.
export function mergeRow(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== '' && value != null) merged[key] = value;
  }
  merged.record_id = existing.record_id;
  return merged;
}

// 16 hex chars of SHA-256.
export async function shortHash(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Stable short id, handy for joining files later: based on the CRM's own
// record id, else the first email or phone, else all the row's values.
export async function buildRecordId(row, { byContact = true } = {}) {
  const { emails, phones } = byContact ? contactIds(row) : { emails: new Set(), phones: new Set() };
  const contact = row.crm_record_id ? `crm:${row.crm_record_id}` : [...emails][0] || [...phones][0];
  const identity = contact
    ? [contact]
    : Object.keys(row)
        .filter((key) => !META_KEYS.has(key))
        .sort()
        .map((key) => `${key}=${row[key]}`);
  return shortHash([row.site, row.store, row.dealer_name, ...identity].map((p) => String(p || '').toLowerCase().trim()).join('|'));
}
