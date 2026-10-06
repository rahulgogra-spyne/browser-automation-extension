import { DATASET_IDS } from '../../extension/lib/mapper/datasets.js';

// What the model returns: the page's fields (key + the page's own label) and
// one or more records of key/value pairs. Keys are open-ended so any page
// works; STANDARD_KEYS keep common data in the same columns across sites.

// Mirrors extension/lib/columns.js (tests/schema-sync.test.js checks both).
export const STANDARD_KEYS = [
  'first_name', 'last_name', 'full_name', 'company', 'job_title',
  'email', 'phone_mobile', 'phone_home', 'phone_work', 'phone',
  'address', 'city', 'state', 'zip', 'country', 'website',
  'dealer_name', 'salesperson', 'lead_source', 'lead_status',
  'vehicle_year', 'vehicle_make', 'vehicle_model', 'vin', 'stock_number', 'price', 'mileage', 'trade_in',
  'date', 'notes',
];
// CSV metadata columns the extension adds; page fields must not reuse them.
export const META_KEYS = new Set(['captured_at', 'site', 'page_title', 'crm_record_id', 'messages_count', 'page_url', 'captured_by', 'unverified_fields', 'record_id']);

export const MAX_RECORDS = 50;
export const MAX_FIELDS_PER_RECORD = 60;

const keyValue = (valueName) => ({
  type: 'object',
  additionalProperties: false,
  required: ['key', valueName],
  properties: { key: { type: 'string' }, [valueName]: { type: 'string' } },
});

// OpenAI strict structured outputs: every property required, no extras.
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dataset', 'page_type', 'fields', 'records'],
  properties: {
    dataset: { type: 'string', enum: [...DATASET_IDS, 'other'], description: 'The kind of data the records are.' },
    page_type: {
      type: 'string',
      description: 'What the page shows, in a few words, e.g. "CRM lead record", "contact profile", "product page", "search results".',
    },
    fields: {
      type: 'array',
      description: 'Every key used in records, once each, in page order, with the label the page shows for it.',
      items: keyValue('label'),
    },
    records: {
      type: 'array',
      description: `One entry per item on the page (a single entry when the page is about one thing). At most ${MAX_RECORDS}.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['values'],
        properties: { values: { type: 'array', items: keyValue('value') } },
      },
    },
  },
};

// Page label -> column key: "Stock #" -> "stock_number", "E-mail" -> "e_mail".
// Mirrors toKey in extension/lib/columns.js.
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

export const humanize = (key) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
