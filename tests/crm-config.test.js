import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlPattern, commonUrlPattern, looseUrlPattern, matchUrl } from '../backend/src/crm/url-pattern.js';
import { findCrm, findPageType, assessExtraction, describeProblems } from '../extension/lib/crm-config.js';

test('record URLs become patterns with the record id captured', () => {
  const vin = urlPattern('http://localhost:4101/vinconnect/customer?GlobalCustomerID=1001');
  assert.equal(vin, '^/vinconnect/customer\\?GlobalCustomerID=([^/?&#]+)(?=$|[?&#])');
  assert.deepEqual(matchUrl(vin, 'http://localhost:4101/vinconnect/customer?GlobalCustomerID=1005&tab=2'), { recordId: '1005' });
  assert.equal(matchUrl(vin, 'http://localhost:4101/vinconnect/customers?GlobalCustomerID=1005'), null);

  const rest = urlPattern('https://crm.example/leads/8f14e45f-ceea-467a-9a7e-5e0c1b2d3f4a/edit');
  assert.equal(rest, '^/leads/([^/?&#]+)/edit(?=$|[?&#])');
  assert.equal(urlPattern('https://crm.example/vinconnect/?view=desking'), '^/vinconnect/\\?view=desking(?=$|[?&#])');

  // Short numeric ids count behind a parameter that names an id (a CRM with 12 users).
  const user = urlPattern('https://crm.example/user/card.php?id=5');
  assert.equal(user, '^/user/card\\.php\\?id=([^/?&#]+)(?=$|[?&#])');
  assert.deepEqual(matchUrl(user, 'https://crm.example/user/card.php?id=12'), { recordId: '12' });
  assert.equal(urlPattern('https://crm.example/app/?paid=1&module=Users'), '^/app/\\?paid=1&module=Users(?=$|[?&#])');
});

test('tab routes of one record collapse into their shared beginning', () => {
  const pattern = commonUrlPattern([
    'http://localhost:4102/elead/app.html#/customer/1001/profile',
    'http://localhost:4102/elead/app.html#/customer/1001/communications',
    'http://localhost:4102/elead/app.html#/customer/1001/notes',
  ]);
  assert.equal(pattern, '^/elead/app\\.html#/customer/([^/?&#]+)/');
  assert.deepEqual(matchUrl(pattern, 'http://localhost:4102/elead/app.html#/customer/1004/notes'), { recordId: '1004' });
  assert.equal(matchUrl(pattern, 'http://localhost:4102/elead/app.html#/customers'), null);
});

test('list pages get a pattern that ignores paging and sorting parameters', () => {
  const sugar = looseUrlPattern('https://crm.example/app/?module=Contacts&action=index&list_offset=21&list_limit=20');
  assert.ok(matchUrl(sugar, 'https://crm.example/app/?module=Contacts&action=index'));
  assert.ok(matchUrl(sugar, 'https://crm.example/app/?action=index&module=Contacts&sort=last_name&list_offset=41'));
  assert.equal(matchUrl(sugar, 'https://crm.example/app/?module=Leads&action=index'), null);
  assert.equal(matchUrl(sugar, 'https://crm.example/app/?action=DetailView&module=Contacts&record=1'), null);

  const spa = looseUrlPattern('https://crm.example/elead/app.html#/customers?page=3');
  assert.ok(matchUrl(spa, 'https://crm.example/elead/app.html#/customers'));
  assert.equal(matchUrl(spa, 'https://crm.example/elead/app.html#/customer/1001/profile'), null);

  const rest = looseUrlPattern('https://crm.example/accounts/12345/contacts?page=2');
  assert.ok(matchUrl(rest, 'https://crm.example/accounts/99999/contacts'));
  assert.equal(matchUrl(rest, 'https://crm.example/accounts/12345/leads'), null);
});

const config = {
  crms: {
    vinsolutions: {
      name: 'VinSolutions',
      match: { hosts: ['*.vinsolutions.com', 'localhost:4101'] },
      pageTypes: [{ id: 'customer_record', urlRegex: '^/vinconnect/customer\\?GlobalCustomerID=([^/?&#]+)', required: ['first_name'], expectOneOf: ['email', 'phone_mobile'] }],
    },
  },
};

test('pages are matched to a CRM by host (with wildcards and ports) and to a page type by URL', () => {
  assert.equal(findCrm(config, 'https://apps.vinsolutions.com/x')?.id, 'vinsolutions');
  assert.equal(findCrm(config, 'http://localhost:4101/vinconnect/')?.id, 'vinsolutions');
  assert.equal(findCrm(config, 'http://localhost:4102/elead/'), null);
  const { crm } = findCrm(config, 'http://localhost:4101/vinconnect/');
  assert.equal(findPageType(crm, 'http://localhost:4101/vinconnect/customer?GlobalCustomerID=1003').recordId, '1003');
  assert.equal(findPageType(crm, 'http://localhost:4101/vinconnect/'), null);
});

test('an extraction is trusted only when required, contact and format checks pass', () => {
  const pageType = config.crms.vinsolutions.pageTypes[0];
  const good = { fields: { first_name: 'Jane', phone_mobile: '(214) 555-0147' }, errors: [] };
  assert.equal(assessExtraction(pageType, good).ok, true);

  const noContact = assessExtraction(pageType, { fields: { first_name: 'Jane' }, errors: [] });
  assert.deepEqual(noContact.missing, ['email or phone_mobile']);

  const odd = assessExtraction(pageType, { fields: { first_name: 'Jane', email: 'Email Address:' }, errors: [] });
  assert.deepEqual(odd.invalid, ['email']);
  const oddWork = assessExtraction(pageType, { fields: { ...good.fields, work_email: 'n/a', email_2: 'x' }, errors: [] });
  assert.deepEqual(oddWork.invalid, ['work_email', 'email_2']);

  // Keys that only mention email hold no address: an email's body is no "odd email".
  const mentions = { ...good.fields, last_email_body: 'Hi Jane, the quote is attached.', email_subject: 'Your quote', email_opt_out: 'No' };
  assert.equal(assessExtraction(pageType, { fields: mentions, errors: [] }).ok, true);

  const tabGone = assessExtraction(pageType, { ...good, errors: [{ view: 'Texting', error: 'tab_not_found' }] });
  assert.equal(tabGone.ok, false);
  assert.equal(describeProblems(tabGone), 'Texting: tab not found');

  assert.equal(assessExtraction(pageType, null).errors[0].error, 'record_frame_not_found');
});

test('hash routes without a leading slash (EspoCRM style) are records and lists too', () => {
  const record = urlPattern('https://crm.example/#Contact/view/66d82d6b5d192de78');
  assert.equal(record, '^/#Contact/view/([^/?&#]+)(?=$|[?&#])');
  assert.deepEqual(matchUrl(record, 'https://crm.example/#Contact/view/5f5b3f733670098a0'), { recordId: '5f5b3f733670098a0' });
  assert.equal(matchUrl(record, 'https://crm.example/#Lead/view/5f5b3f733670098a0'), null);
  const list = looseUrlPattern('https://crm.example/#Contact');
  assert.ok(matchUrl(list, 'https://crm.example/#Contact'));
  assert.equal(matchUrl(list, 'https://crm.example/#Contact/view/5f5b3f733670098a0'), null, 'a record is not the list');
  assert.equal(matchUrl(list, 'https://crm.example/#Lead'), null);
});
