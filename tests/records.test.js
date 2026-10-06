import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateIndex, mergeRow, buildRecordId, contactIds } from '../extension/lib/records.js';
import { localDateKey, localTimestamp } from '../extension/lib/dates.js';
import { detectSite } from '../extension/lib/site.js';

const john = { site: 'VinSolutions', dealer_name: 'Sunrise Toyota', email: 'john@example.com', phone_mobile: '(214) 555-0147', record_id: 'a1' };

test('a shared email or phone on the same site is the same person', () => {
  const rows = [john];
  assert.equal(findDuplicateIndex(rows, { site: 'VinSolutions', dealer_name: 'SUNRISE TOYOTA', email: 'john@example.com' }), 0);
  assert.equal(findDuplicateIndex(rows, { site: 'VinSolutions', work_phone: '214-555-0147' }), 0, 'any phone-like column counts');
  assert.equal(findDuplicateIndex(rows, { site: 'linkedin.com', email: 'john@example.com' }), -1, 'other sites stay separate');
  assert.equal(findDuplicateIndex(rows, { site: 'VinSolutions', dealer_name: 'Other Motors', email: 'john@example.com' }), -1);
  assert.equal(findDuplicateIndex(rows, { site: 'VinSolutions', email: 'jane@example.com' }), -1);
});

test('the CRM record id decides, when both rows have one', async () => {
  const a = { site: 'CDK', crm_record_id: '1001', email: 'john@example.com' };
  assert.equal(findDuplicateIndex([a], { site: 'CDK', crm_record_id: '1001', email: 'new@example.com' }), 0);
  assert.equal(findDuplicateIndex([a], { site: 'CDK', crm_record_id: '1002', email: 'john@example.com' }), -1, 'shared email, different record');
  assert.equal(findDuplicateIndex([a], { site: 'VinSolutions', crm_record_id: '1001' }), -1, 'same id in another CRM');
  assert.equal(await buildRecordId(a), await buildRecordId({ ...a, email: 'changed@example.com' }));
});

test('rows without contact details match only when their values are identical', async () => {
  const product = { site: 'shop.example', product_name: 'Widget', price: '$10' };
  product.record_id = await buildRecordId(product);
  const same = { ...product, captured_at: 'later', page_url: 'other' };
  same.record_id = await buildRecordId(same);
  const different = { site: 'shop.example', product_name: 'Widget', price: '$12' };
  different.record_id = await buildRecordId(different);
  assert.equal(findDuplicateIndex([product], same), 0, 'metadata does not change the id');
  assert.equal(findDuplicateIndex([product], different), -1);
});

test('contact ids come from any email/phone column, extensions ignored', () => {
  const ids = contactIds({ work_email: 'A@B.com', office_phone: '(214) 555-0147 x22', fax: '972 555 0199', notes: 'x' });
  assert.deepEqual([...ids.emails], ['a@b.com']);
  assert.deepEqual([...ids.phones], ['2145550147', '9725550199']);
});

test('merge keeps old values the new capture lacks, and the record id', () => {
  const merged = mergeRow(john, { email: '', phone_home: '(972) 555-0199', record_id: 'zz' });
  assert.equal(merged.email, 'john@example.com');
  assert.equal(merged.phone_home, '(972) 555-0199');
  assert.equal(merged.record_id, 'a1');
});

test('record ids are stable 16-char hex', async () => {
  const a = await buildRecordId(john);
  const b = await buildRecordId({ ...john, first_name: 'Johnny' });
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
});

test('dates use the local calendar day with an offset', () => {
  const d = new Date(2026, 8, 29, 7, 5, 9);
  assert.equal(localDateKey(d), '2026-09-29');
  assert.match(localTimestamp(d), /^2026-09-29T07:05:09[+-]\d{2}:\d{2}$/);
});

test('known CRMs are named, other sites use their host', () => {
  assert.equal(detectSite('https://apps.vinsolutions.com/CarDashboard/Pages/x.aspx'), 'VinSolutions');
  assert.equal(detectSite('https://app.drivecentric.com/customer/1'), 'DriveCentric');
  assert.equal(detectSite('https://www.linkedin.com/in/someone'), 'linkedin.com');
  assert.equal(detectSite('not a url'), '');
});
