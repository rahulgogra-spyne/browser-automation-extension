import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone,
  normalizeEmail,
  normalizeName,
  normalizeState,
  normalizeZip,
  normalizeVin,
  normalizeYear,
  normalizeValue,
  normalizeFields,
} from '../extension/lib/normalize.js';

test('phones become (XXX) XXX-XXXX', () => {
  assert.equal(normalizePhone('214.555.0147'), '(214) 555-0147');
  assert.equal(normalizePhone('+1 214 555 0147'), '(214) 555-0147');
  assert.equal(normalizePhone('2145550147'), '(214) 555-0147');
  assert.equal(normalizePhone('(214) 555-0147 ext. 22'), '(214) 555-0147 x22');
  assert.equal(normalizePhone('555-0147'), '555-0147', 'non-10-digit numbers are left alone');
  assert.equal(normalizePhone(null), '');
});

test('emails are lowercased and lose mailto:', () => {
  assert.equal(normalizeEmail(' mailto:John.Doe@Example.com '), 'john.doe@example.com');
});

test('shouting names are title-cased, mixed case is kept', () => {
  assert.equal(normalizeName('JOHN'), 'John');
  assert.equal(normalizeName("O'BRIEN-SMITH"), "O'Brien-Smith");
  assert.equal(normalizeName('de la cruz'), 'De La Cruz');
  assert.equal(normalizeName('McDonald'), 'McDonald');
});

test('states, zips, VINs and years', () => {
  assert.equal(normalizeState('tx'), 'TX');
  assert.equal(normalizeState('Texas'), 'TX');
  assert.equal(normalizeState('Ontario'), 'Ontario');
  assert.equal(normalizeZip('75024 1234'), '75024-1234');
  assert.equal(normalizeVin('1hgcm 82633a004352'), '1HGCM82633A004352');
  assert.equal(normalizeYear('2024 model'), '2024');
});

test('the key picks the format, for standard and page-made keys alike', () => {
  assert.equal(normalizeValue('phone_mobile', '214.555.0147'), '(214) 555-0147');
  assert.equal(normalizeValue('office_telephone', '2145550147'), '(214) 555-0147');
  assert.equal(normalizeValue('work_email', 'A@B.COM'), 'a@b.com');
  assert.equal(normalizeValue('first_name', 'JANE'), 'Jane');
  assert.equal(normalizeValue('product_name', 'IPHONE 15 PRO'), 'IPHONE 15 PRO', 'only person names are re-cased');
  assert.equal(normalizeValue('billing_zip', '75024 1234'), '75024-1234');
  assert.equal(normalizeValue('order_total', '  $1,299.00 '), '$1,299.00');
});

test('normalizeFields makes keys safe and drops empty values', () => {
  assert.deepEqual(normalizeFields({ 'Stock #': ' T24518 ', email: '', 'Page URL': 'x', first_name: 'JOHN' }), {
    stock_number: 'T24518',
    page_url_value: 'x',
    first_name: 'John',
  });
});
