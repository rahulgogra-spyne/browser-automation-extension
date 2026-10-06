import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence, verifyRecords, checkValue, isValidVin, phonesIn } from '../backend/src/verify.js';

const payload = {
  title: 'Sunrise Toyota of Plano - Customer Dashboard',
  selection: '',
  frames: [
    {
      url: 'https://crm.example/lead/1',
      isTop: true,
      text: [
        'DOE, JOHN',
        'Cell | (214) 555-0147 | Home | 972.555.0199',
        'Email | john.doe@example.com',
        '123 Main Street, Plano, TX 75024',
        'Vehicle of interest: 2024 Toyota Camry XSE | VIN 1HGCM82633A004352 | Stock # T24518',
        'Bad VIN on file: 1HGCM82643A004352',
        'Order Total: $1,299.00 | Color: Midnight Black',
      ].join('\n'),
      phones: ['+12145550147'],
      emails: ['john.doe@example.com'],
    },
  ],
};
const evidence = buildEvidence(payload);
const check = (key, value) => checkValue(key, value, evidence);

test('values on the page are verified, whatever the key or phone format', () => {
  const values = {
    first_name: 'JOHN',
    last_name: 'Doe',
    phone_mobile: '214-555-0147',
    home_telephone: '(972) 555-0199',
    email: 'John.Doe@example.com',
    address: '123 Main St',
    state: 'TX',
    zip: '75024',
    vehicle_model: 'Camry XSE',
    vin: '1HGCM82633A004352',
    dealer_name: 'Sunrise Toyota of Plano',
    order_total: '$1,299.00',
    color: 'Midnight Black',
  };
  for (const [key, value] of Object.entries(values)) assert.equal(check(key, value), 'verified', key);
});

test('invented values are flagged not_on_page', () => {
  assert.equal(check('first_name', 'Jane'), 'not_on_page');
  assert.equal(check('phone_work', '(469) 555-0100'), 'not_on_page');
  assert.equal(check('email', 'jdoe@gmail.com'), 'not_on_page');
  assert.equal(check('contact', 'jdoe@gmail.com'), 'not_on_page', 'email-looking values are checked as emails');
  assert.equal(check('vin', '2T1BURHE5JC000000'), 'not_on_page');
  assert.equal(check('zip', '75093'), 'not_on_page');
  assert.equal(check('color', 'Pearl White'), 'not_on_page');
});

test('on-page values with a broken format are flagged bad_format', () => {
  assert.equal(check('vin', '1HGCM82643A004352'), 'bad_format');
});

test('verifyRecords adds a check to every field of every record', () => {
  const [record] = verifyRecords([{ fields: [{ key: 'color', label: 'Color', value: 'Midnight Black' }] }], evidence);
  assert.deepEqual(record.fields[0], { key: 'color', label: 'Color', value: 'Midnight Black', check: 'verified' });
});

test('VIN check digit', () => {
  assert.equal(isValidVin('1HGCM82633A004352'), true);
  assert.equal(isValidVin('1M8GDM9AXKP042788'), true);
  assert.equal(isValidVin('1HGCM82643A004352'), false);
  assert.equal(isValidVin('1HGCM82633A00435'), false);
});

test('phone finder ignores longer digit runs', () => {
  assert.deepEqual([...phonesIn('call 214-555-0147 or +1 (972) 555 0199')], ['2145550147', '9725550199']);
  assert.equal(phonesIn('account 123456789012').size, 0);
});
