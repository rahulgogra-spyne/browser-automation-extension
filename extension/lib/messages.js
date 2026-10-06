// Message history (texts, emails, calls, notes...) read from a CRM record
// becomes one CSV row per entry in <prefix>_messages_<date>.csv, linked to
// the row it was read from by customer_record_id (record_type says which
// file that row is in: customers, users, deals...).
import { clean } from './normalize.js';
import { shortHash } from './records.js';

export const MESSAGE_COLUMNS = [
  'captured_at', 'site', 'store', 'crm_record_id', 'customer', 'customer_record_id', 'record_type',
  'channel', 'timestamp', 'direction', 'sender', 'recipient', 'subject', 'body', 'duration', 'outcome',
  'message_id',
];

// Default channel from the list's name when entries don't carry one.
const LIST_CHANNELS = {
  text_messages: 'sms', texts: 'sms', sms: 'sms', emails: 'email', email: 'email',
  chat_messages: 'chat', chats: 'chat', calls: 'call', call_log: 'call', notes: 'note', activities: 'activity',
};

export function normalizeDirection(value) {
  const s = String(value ?? '').toLowerCase();
  if (/outbound|outgoing|\bout\b|\bsent\b/.test(s)) return 'outbound';
  if (/inbound|incoming|\bin\b|received/.test(s)) return 'inbound';
  return clean(value);
}

export function normalizeChannel(value, listName) {
  const s = String(value ?? '').toLowerCase();
  if (/\bsms\b|\btext/.test(s)) return 'sms';
  if (/e-?mail/.test(s)) return 'email';
  if (/\bcall\b|phone|voice/.test(s)) return 'call';
  if (/chat/.test(s)) return 'chat';
  if (/\bnote/.test(s)) return 'note';
  return LIST_CHANNELS[listName] ?? listName;
}

const first = (entry, keys) => clean(keys.map((k) => entry[k]).find(Boolean));

export async function buildMessageRows({ collections = {}, base, customer, customerRecordId, recordType = 'customers' }) {
  const rows = [];
  for (const [list, entries] of Object.entries(collections)) {
    for (const entry of entries) {
      const row = {
        ...base,
        customer,
        customer_record_id: customerRecordId,
        record_type: recordType,
        channel: normalizeChannel(entry.channel, list),
        timestamp: first(entry, ['timestamp', 'date', 'time', 'sent_at', 'created']),
        direction: normalizeDirection(entry.direction),
        sender: first(entry, ['sender', 'author', 'from', 'agent']),
        recipient: first(entry, ['recipient', 'to']),
        subject: first(entry, ['subject', 'title']),
        body: first(entry, ['body', 'text', 'message', 'note', 'content', 'notes']),
        duration: first(entry, ['duration']),
        outcome: first(entry, ['outcome', 'result']),
      };
      row.message_id = await shortHash(
        [row.site, row.crm_record_id, row.channel, row.timestamp, row.direction, row.body.slice(0, 200)].join('|').toLowerCase(),
      );
      rows.push(row);
    }
  }
  return rows;
}

export const countEntries = (collections = {}) => Object.values(collections).reduce((n, list) => n + list.length, 0);
