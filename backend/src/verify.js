// Guards against made-up values: every value the model returns is checked
// against the page snapshot it was given.
//   verified     the value appears on the page
//   not_on_page  it doesn't (likely invented, or reworded too much)
//   bad_format   it's on the page but isn't a valid email / phone / VIN
const PHONE_RE = /(?<!\d)(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_KEY = /(^|_)(phone|mobile|cell|fax|tel|telephone)(_|$)/;
const EMAIL_KEY = /(^|_)e_?mail(_|$)/;
const PERSON_NAME_KEYS = new Set(['first_name', 'last_name', 'middle_name', 'full_name', 'salesperson', 'contact_name', 'customer_name']);

const fold = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export function phonesIn(text) {
  return new Set([...String(text).matchAll(PHONE_RE)]?.map((m) => m[1] + m[2] + m[3]));
}

// Everything the model saw, prepared for lookups.
export function buildEvidence({ title, selection, frames }) {
  const raw = [title, selection, ...frames.flatMap((f) => [f.text, ...f.phones, ...f.emails])]
    .filter(Boolean)
    .join('\n');
  return { folded: fold(raw), phones: phonesIn(raw) };
}

// records: [{ fields: [{ key, label, value }] }] -> same, with a check on each field.
export function verifyRecords(records, evidence) {
  return records?.map((record) => ({
    fields: record.fields?.map((field) => ({ ...field, check: checkValue(field.key, field.value, evidence) })),
  }));
}

export function checkValue(key, value, evidence) {
  if (PHONE_KEY.test(key)) {
    const [phone] = phonesIn(value);
    if (!phone) return tokensPresent(key, value, evidence) ? 'bad_format' : 'not_on_page';
    return evidence.phones.has(phone) ? 'verified' : 'not_on_page';
  }
  if (EMAIL_KEY.test(key) || EMAIL_RE.test(value.trim())) {
    const email = fold(value).trim().replace(/^mailto:/, '');
    if (!evidence.folded.includes(email)) return 'not_on_page';
    return EMAIL_RE.test(email) ? 'verified' : 'bad_format';
  }
  if (/(^|_)vin$/.test(key)) {
    const vin = value.toUpperCase().replace(/[\s-]/g, '');
    if (!evidence.folded.includes(vin.toLowerCase())) return 'not_on_page';
    return isValidVin(vin) ? 'verified' : 'bad_format';
  }
  if (/(^|_)(zip|zip_code|postal_code)$/.test(key)) {
    const [zip] = value.match(/\d{5}/) ?? [];
    if (zip) return evidence.folded.includes(zip) ? 'verified' : 'not_on_page';
  }
  return tokensPresent(key, value, evidence) ? 'verified' : 'not_on_page';
}

// Person names must match word for word; other text (addresses, descriptions)
// may be lightly reworded, so 70% of its words is enough.
function tokensPresent(key, value, evidence) {
  const tokens = fold(value)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 || /\d/.test(t));
  if (!tokens.length) return true;
  const found = tokens.filter((t) => tokenOnPage(t, evidence.folded)).length;
  const needed = PERSON_NAME_KEYS.has(key) ? tokens.length : Math.ceil(tokens.length * 0.7);
  return found >= needed;
}

// Long tokens may sit anywhere. Short words must start a word on the page, so
// abbreviations still match ("St" for "Street"); short numbers must match whole.
function tokenOnPage(token, text) {
  if (token.length > 3) return text.includes(token);
  const end = /\d/.test(token) ? '(?![a-z0-9])' : '';
  return new RegExp(`(?<![a-z0-9])${token}${end}`).test(text);
}

const VIN_LETTER_VALUES = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5,
  P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// North American VINs carry a check digit in position 9.
export function isValidVin(vin) {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  const sum = [...vin].reduce(
    (acc, ch, i) => acc + (/\d/.test(ch) ? Number(ch) : VIN_LETTER_VALUES[ch]) * VIN_WEIGHTS[i],
    0,
  );
  const check = sum % 11 === 10 ? 'X' : String(sum % 11);
  return vin[8] === check;
}
