// Pages can yield any fields, so each day's CSV uses the union of the keys its
// rows contain: leading metadata, then standard keys (in STANDARD_KEYS order)
// when present, then every other key in the order it first appeared, then
// trailing metadata.
export const META_START = ['captured_at', 'site', 'page_title', 'crm_record_id'];
export const META_END = ['messages_count', 'page_url', 'captured_by', 'unverified_fields', 'record_id'];
export const META_KEYS = new Set([...META_START, ...META_END]);

// Keys the LLM uses whenever they fit, so the same kind of value lands in the
// same column whatever site it came from. Mirrored in backend/src/schema.js.
export const STANDARD_KEYS = [
  'first_name', 'last_name', 'full_name', 'company', 'job_title',
  'email', 'phone_mobile', 'phone_home', 'phone_work', 'phone',
  'address', 'city', 'state', 'zip', 'country', 'website',
  'dealer_name', 'salesperson', 'lead_source', 'lead_status',
  'vehicle_year', 'vehicle_make', 'vehicle_model', 'vin', 'stock_number', 'price', 'mileage', 'trade_in',
  'date', 'notes',
];
const STANDARD_SET = new Set(STANDARD_KEYS);

export function csvColumns(rows) {
  const present = new Set();
  const others = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (present.has(key)) continue;
      present.add(key);
      if (!META_KEYS.has(key) && !STANDARD_SET.has(key)) others.push(key);
    }
  }
  return [...META_START, ...STANDARD_KEYS.filter((k) => present.has(k)), ...others, ...META_END];
}

// Page label -> column key: "Stock #" -> "stock_number", "E-mail" -> "e_mail".
// Mirrors toKey in backend/src/schema.js.
export function toKey(label) {
  let key = String(label ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/#/g, ' number ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  if (/^\d/.test(key)) key = `field_${key}`;
  if (META_KEYS.has(key)) key = `${key}_value`;
  return key;
}

export const isPhoneKey = (key) => /(^|_)(phone|mobile|cell|fax|tel|telephone)(_|$)/.test(key);
// A key that holds an address: email, work_email, email_2, email_address.
// Not one that only mentions email (last_email_body, email_subject, email_opt_out).
export const isEmailKey = (key) => /(^|_)e_?mail(_?\d+|_address|_addr)?$/.test(key);
