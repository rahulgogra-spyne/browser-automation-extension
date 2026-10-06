import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageRows, normalizeChannel, normalizeDirection, countEntries, MESSAGE_COLUMNS } from '../extension/lib/messages.js';

test('direction and channel are read from text, attributes or class names', () => {
  assert.equal(normalizeDirection('sms-bubble sms-outbound'), 'outbound');
  assert.equal(normalizeDirection('conv-msg conv-msg--in'), 'inbound');
  assert.equal(normalizeDirection('Inbound'), 'inbound');
  assert.equal(normalizeDirection('Outbound call'), 'outbound');
  assert.equal(normalizeDirection(''), '');
  assert.equal(normalizeChannel('cdk-timeline__item cdk-timeline__item--email', 'communications'), 'email');
  assert.equal(normalizeChannel('call', 'communications'), 'call');
  assert.equal(normalizeChannel(undefined, 'text_messages'), 'sms');
  assert.equal(normalizeChannel(undefined, 'notes'), 'note');
  assert.equal(normalizeChannel(undefined, 'service_visits'), 'service_visits');
});

test('each entry becomes a message row linked to its customer', async () => {
  const rows = await buildMessageRows({
    collections: {
      text_messages: [{ timestamp: '09/21/2026 10:14 AM', direction: 'sms-bubble sms-inbound', sender: 'John Doe', body: 'Is the Camry still available?' }],
      notes: [{ author: 'Mike Ross', timestamp: '09/21/2026', body: 'Prefers email.' }],
    },
    base: { captured_at: 't', site: 'VinSolutions', crm_record_id: '1001' },
    customer: 'John Doe',
    customerRecordId: 'abc',
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    [...MESSAGE_COLUMNS].sort(),
  );
  assert.equal(rows[0].channel, 'sms');
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[1].channel, 'note');
  assert.equal(rows[1].sender, 'Mike Ross');
  assert.match(rows[0].message_id, /^[0-9a-f]{16}$/);
  const again = await buildMessageRows({ collections: { text_messages: [rows[0]] }, base: { site: 'VinSolutions', crm_record_id: '1001' } });
  assert.equal(again[0].message_id, rows[0].message_id, 'the same message gets the same id on a later capture');
});

test('countEntries adds up every list', () => {
  assert.equal(countEntries({ a: [1, 2], b: [3] }), 3);
  assert.equal(countEntries(undefined), 0);
});
