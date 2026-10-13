// Pages can yield any fields, so each day's CSV uses the union of the keys its
// rows contain: leading metadata, then standard keys (in STANDARD_KEYS order)
// when present, then every other key in the order it first appeared, then
// trailing metadata.
export const META_START = ['captured_at', 'site', 'store', 'page_title', 'crm_record_id'];
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

// ------------------------------------------------- grid/export header mapping

// A grid or export column caption -> a standard field key. Used when reading a
// data grid (background.js guessDataset/columnsFromHeaders) and when mapping an
// exported CSV's columns to fields. Order matters: the first match wins, so
// specific captions come before general ones (e.g. "work phone" before "phone").
export const HEADER_KEYS = [
  [/^(full )?name$|^customer( name)?$|^contact( name)?$|^prospect( name)?$|^client$/i, 'full_name'],
  [/^first( name)?$/i, 'first_name'], [/^last( name)?$|^surname$/i, 'last_name'],
  [/^e-?mail( address)?$/i, 'email'],
  [/^(cell|mobile|cell phone|mobile phone)$/i, 'phone_mobile'], [/^(home|home phone)$/i, 'phone_home'], [/^(work|work phone|business phone|office)$/i, 'phone_work'], [/^(phone|phone number|telephone|tel)$/i, 'phone'],
  [/^(company|dealer|dealership|organization|organisation|account)$/i, 'company'], [/^(title|job title|position|role)$/i, 'job_title'],
  [/^(address|street|address 1)$/i, 'address'], [/^city$/i, 'city'], [/^(state|province|st)$/i, 'state'], [/^(zip|zip code|postal code|postcode)$/i, 'zip'],
  [/^(salesperson|sales person|sales rep|rep|owner|assigned to|assigned|agent|bdc)$/i, 'salesperson'],
  [/^(source|lead source)$/i, 'lead_source'], [/^(status|lead status|stage)$/i, 'lead_status'],
  [/^(year|yr|model year)$/i, 'vehicle_year'], [/^make$/i, 'vehicle_make'], [/^model$/i, 'vehicle_model'], [/^vin$/i, 'vin'], [/^(stock|stock ?#|stock no\.?|stock number)$/i, 'stock_number'],
  [/^(price|retail|retail price|list price|asking|msrp|internet price|selling price)$/i, 'price'], [/^(mileage|miles|odometer)$/i, 'mileage'],
  [/^(date|created|created on|date created|added|date in stock|in stock date|age)$/i, 'date'], [/^(notes?|comments?)$/i, 'notes'],
  [/^(login|user ?name|user id|userid)$/i, 'login'], [/^(last login|last signed in)$/i, 'last_login'], [/^(department|dept)$/i, 'department'],
  [/^(trim|series)$/i, 'trim'], [/^(body|body style|body type)$/i, 'body_style'],
  [/^(ext(erior)? colou?r|colou?r)$/i, 'exterior_color'], [/^int(erior)? colou?r$/i, 'interior_color'],
  [/^(condition|type|new\/used|new or used)$/i, 'condition'], [/^(engine)$/i, 'engine'], [/^(trans(mission)?)$/i, 'transmission'], [/^(fuel|fuel type)$/i, 'fuel_type'],
];

export const slugKey = (header) =>
  String(header ?? '').toLowerCase().replace(/#/g, ' number ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// A single caption -> field key: the first HEADER_KEYS match, else a slug of
// the caption. An explicit overrides map ({ caption: key }) wins over both.
export function headerKeyFor(caption, overrides = {}) {
  const text = String(caption ?? '').trim();
  if (!text) return '';
  for (const [raw, key] of Object.entries(overrides)) {
    if (raw.toLowerCase() === text.toLowerCase()) return key;
  }
  return HEADER_KEYS.find(([re]) => re.test(text))?.[1] ?? slugKey(text);
}

// headers[] -> [{ index, key }], skipping non-data captions (image, select,
// actions) and de-duplicating repeated keys. overrides maps a caption to the
// key it must take (for a column the regexes can't place).
export function columnsFromHeaders(headers, overrides = {}) {
  const used = new Set();
  const columns = [];
  headers.forEach((header, index) => {
    const caption = String(header ?? '').trim();
    if (!caption || /^(image|photo|pic|select|select all\b.*|actions?)$/i.test(caption)) return;
    let key = headerKeyFor(caption, overrides);
    if (!key) return;
    if (used.has(key)) key = `${key}_${index + 1}`;
    used.add(key);
    columns.push({ index, key });
  });
  return columns;
}
