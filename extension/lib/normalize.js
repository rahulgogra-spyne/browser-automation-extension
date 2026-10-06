// Puts values from the LLM (or typed by the user) into one format, so CSV rows
// look the same whichever site they came from. The key decides the format.
import { toKey, isPhoneKey, isEmailKey } from './columns.js';

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATES)?.map(([code, name]) => [name.toLowerCase(), code]));
const PERSON_NAME_KEYS = new Set(['first_name', 'last_name', 'middle_name', 'full_name', 'salesperson', 'contact_name', 'customer_name']);

export const clean = (value) => (value == null ? '' : String(value).replace(/\s+/g, ' ').trim());

// US numbers become "(214) 555-0147" (Excel keeps it as text); an extension
// becomes " x123". Anything that isn't a 10-digit US number is left as typed.
export function normalizePhone(value) {
  const v = clean(value);
  if (!v) return '';
  const ext = v.match(/\s*(?:ext\.?|extension|x)\s*(\d{1,6})$/i);
  let digits = (ext ? v.slice(0, ext.index) : v).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return v;
  const formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return ext ? `${formatted} x${ext[1]}` : formatted;
}

export function normalizeEmail(value) {
  return clean(value).replace(/^mailto:/i, '').toLowerCase();
}

// CRMs often shout names ("DOE, JOHN"); title-case those, leave mixed case alone.
export function normalizeName(value) {
  const v = clean(value);
  if (!v || (v !== v.toUpperCase() && v !== v.toLowerCase())) return v;
  return v.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

export function normalizeState(value) {
  const v = clean(value);
  const code = v.toUpperCase().replace(/\./g, '');
  if (STATES[code]) return code;
  return STATE_BY_NAME[v.toLowerCase()] ?? v;
}

export function normalizeZip(value) {
  const v = clean(value);
  const m = v.match(/^(\d{5})(?:[\s-]?(\d{4}))?$/);
  if (!m) return v;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

export function normalizeVin(value) {
  return clean(value).toUpperCase().replace(/[\s-]/g, '');
}

export function normalizeYear(value) {
  const v = clean(value);
  const m = v.match(/\b(19[5-9]\d|20\d{2})\b/);
  return m ? m[1] : v;
}

export function normalizeValue(key, value) {
  const v = clean(value);
  if (!v) return '';
  if (isPhoneKey(key)) return normalizePhone(v);
  if (isEmailKey(key)) return normalizeEmail(v);
  if (PERSON_NAME_KEYS.has(key)) return normalizeName(v);
  if (key === 'state') return normalizeState(v);
  if (/(^|_)(zip|zip_code|postal_code)$/.test(key)) return normalizeZip(v);
  if (/(^|_)vin$/.test(key)) return normalizeVin(v);
  if (key === 'vehicle_year') return normalizeYear(v);
  return v;
}

// { "Stock #": " t24518 ", email: "" } -> { stock_number: "t24518" }: keys made
// safe, values normalised, empty values dropped.
export function normalizeFields(fields = {}) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const key = toKey(rawKey);
    const value = normalizeValue(key, rawValue);
    if (key && value && !(key in out)) out[key] = value;
  }
  return out;
}
