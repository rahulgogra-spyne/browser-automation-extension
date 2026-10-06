// What a save turns into: one row per record (in the file of its kind of
// data), plus one message row per entry of its message lists (texts, emails,
// calls, notes...).
import { toKey } from './columns.js';
import { normalizeFields } from './normalize.js';
import { buildRecordId } from './records.js';
import { buildMessageRows, countEntries } from './messages.js';
import { detectSite } from './site.js';
import { rowTitle } from './datasets.js';

// records: [{ fields: { key: value }, unverified: [key], collections: { list: [entry] } }]
// meta: { pageUrl, pageTitle, site (CRM name when known), recordId (CRM's id) }
// dataset: the kind of data the records are; person: its rows are people.
export async function buildCapture({ records = [], meta = {}, settings = {}, capturedAt, dataset = 'customers', person = true }) {
  const site = meta.site || detectSite(meta.pageUrl);
  const rows = [];
  const messages = [];
  for (const record of records) {
    const data = normalizeFields(record.fields);
    if (!Object.keys(data).length) continue;
    if (settings.defaultDealerName && !data.dealer_name) data.dealer_name = settings.defaultDealerName;
    const messageCount = countEntries(record.collections);
    const row = {
      captured_at: capturedAt,
      site,
      page_title: meta.pageTitle || '',
      crm_record_id: meta.recordId || '',
      ...data,
      messages_count: messageCount ? String(messageCount) : '',
      page_url: meta.pageUrl || '',
      captured_by: settings.capturedBy || '',
      unverified_fields: (record.unverified || []).map(toKey).join(' '),
    };
    row.record_id = await buildRecordId(row, { byContact: person });
    rows.push(row);
    messages.push(
      ...(await buildMessageRows({
        collections: record.collections,
        base: { captured_at: capturedAt, site, crm_record_id: row.crm_record_id },
        recordType: dataset,
        customer: rowTitle(data),
        customerRecordId: row.record_id,
      })),
    );
  }
  return { rows, messages };
}
