import test from 'node:test';
import assert from 'node:assert/strict';
import { DATASETS, DATASET_IDS, datasetById, datasetsFrom, datasetOfPageType, datasetsOfCrm, rowTitle } from '../extension/lib/mapper/datasets.js';
import { referenceRows, REFERENCE_COLUMNS } from '../extension/lib/reference.js';
import { findDuplicateIndex, buildRecordId } from '../extension/lib/records.js';
import { buildCapture } from '../extension/lib/capture.js';
import { csvFileName } from '../extension/lib/csv.js';

test('every kind of data says how its records are recognised', () => {
  for (const id of DATASET_IDS) {
    const d = DATASETS[id];
    assert.equal(d.id, id);
    assert.ok(d.identityKeys.length, `${id} identity keys`);
    assert.ok(d.listWords instanceof RegExp && d.fieldKeys && d.recordHint && d.rules && d.description && d.plural);
    assert.equal(d.person, d.contactKeys.length > 0, `${id}: only people are matched by contact details`);
  }
  assert.ok(DATASETS.users.listWords.test('Users'));
  assert.ok(DATASETS.deals.listWords.test('Opportunities'));
  assert.ok(DATASETS.appointments.listWords.test('Calendar'));
  assert.ok(!DATASETS.customers.listWords.test('Reports'));
});

test('ids are resolved, old names included, in a stable order', () => {
  assert.equal(datasetById('staff').id, 'users');
  assert.equal(datasetById('nope'), null);
  assert.deepEqual(datasetsFrom(['vehicles', 'staff', 'customers', 'bogus']).map((d) => d.id), ['users', 'customers', 'vehicles']);
  assert.deepEqual(datasetsFrom(undefined), []);
});

test('layouts mapped before datasets are sorted by what they say', () => {
  assert.equal(datasetOfPageType({ dataset: 'deals', entity: 'contact' }), 'deals');
  assert.equal(datasetOfPageType({ entity: 'user' }), 'users');
  assert.equal(datasetOfPageType({ entity: 'opportunity' }), 'deals');
  assert.equal(datasetOfPageType({ entity: 'contact' }), 'customers');
  assert.equal(datasetOfPageType({ entity: 'contact' }, { target: 'staff' }), 'users', "the CRM's old single target wins");
  const crm = { pageTypes: [{ role: 'record', entity: 'contact' }, { role: 'record', dataset: 'users' }, { role: 'list', dataset: 'tasks' }] };
  assert.deepEqual(datasetsOfCrm(crm), ['users', 'customers']);
  assert.deepEqual(datasetsOfCrm({ targets: ['deals', 'users'], pageTypes: [] }), ['users', 'deals']);
});

test('a row gets a title whatever its kind', () => {
  assert.equal(rowTitle({ first_name: 'Mike', last_name: 'Ross', login: 'mross' }), 'Mike Ross');
  assert.equal(rowTitle([{ key: 'deal_name', value: 'Camry XSE for Doe' }]), 'Camry XSE for Doe');
  assert.equal(rowTitle({ subject: 'Test drive', start_time: '10:00' }), 'Test drive');
  assert.equal(rowTitle({ vehicle_year: '2024', vehicle_make: 'Toyota', vehicle_model: 'Camry' }), '2024 Toyota Camry');
  assert.equal(rowTitle({}), '');
});

test('rows that are not people never merge on a shared email or phone', async () => {
  const dealA = { site: 'CRM', deal_name: 'Camry', email: 'john@example.com' };
  const dealB = { site: 'CRM', deal_name: 'Tacoma', email: 'john@example.com' };
  assert.equal(findDuplicateIndex([dealA], dealB), 0, 'people: same email, same person');
  dealA.record_id = await buildRecordId(dealA, { byContact: false });
  dealB.record_id = await buildRecordId(dealB, { byContact: false });
  assert.notEqual(dealA.record_id, dealB.record_id);
  assert.equal(findDuplicateIndex([dealA], dealB, { byContact: false }), -1, 'two deals of one customer');
  assert.equal(findDuplicateIndex([dealA], { ...dealA }, { byContact: false }), 0, 'the same deal again');
  const byId = { site: 'CRM', crm_record_id: '7', deal_name: 'Camry (renamed)' };
  assert.equal(findDuplicateIndex([{ site: 'CRM', crm_record_id: '7', deal_name: 'Camry' }], byId, { byContact: false }), 0, "the CRM's own id still decides");
});

test('message rows say which file their parent row is in', async () => {
  const { rows, messages } = await buildCapture({
    records: [{ fields: { subject: 'Test drive', start_time: '10/06/2026 10:00 AM', customer_name: 'John Doe' }, collections: { notes: [{ body: 'Confirmed by phone', timestamp: '10/05/2026' }] } }],
    meta: { pageUrl: 'https://crm.example/appointments/12345', site: 'CRM', recordId: '12345' },
    capturedAt: '2026-10-05T10:00:00+05:30',
    dataset: 'appointments',
    person: false,
  });
  assert.equal(rows.length, 1);
  assert.equal(messages[0].record_type, 'appointments');
  assert.equal(messages[0].customer, 'Test drive');
  assert.equal(messages[0].customer_record_id, rows[0].record_id);
});

test('reference values are the distinct dropdown-like values, counted per site, kind and field', () => {
  const day = {
    datasets: {
      customers: [
        { site: 'CRM', first_name: 'John', lead_source: 'Website', lead_status: 'Active', salesperson: 'Mike Ross', email: 'j@example.com' },
        { site: 'CRM', first_name: 'Priya', lead_source: 'website', lead_status: 'Sold', salesperson: 'Mike Ross' },
        { site: 'CRM', first_name: 'Carlos', lead_source: 'Walk-in', notes: 'x'.repeat(200) },
      ],
      users: [{ site: 'CRM', login: 'mross', role: 'Sales', department: 'Sales', status: 'Active' }],
    },
  };
  const rows = referenceRows(day);
  assert.deepEqual(Object.keys(rows[0]), REFERENCE_COLUMNS);
  const find = (dataset, field, value) => rows.find((r) => r.dataset === dataset && r.field === field && r.value === value);
  assert.equal(find('customers', 'lead_source', 'Website').count, '2', 'case differences are one value');
  assert.equal(find('customers', 'lead_source', 'Walk-in').count, '1');
  assert.equal(find('customers', 'salesperson', 'Mike Ross').count, '2');
  assert.equal(find('users', 'role', 'Sales').count, '1');
  assert.ok(!rows.some((r) => ['first_name', 'email', 'notes', 'login'].includes(r.field)), 'personal data is not reference data');
});

test('each kind of data has its own daily file', () => {
  const settings = { downloadFolder: 'SpyneLeads', filePrefix: 'leads' };
  assert.equal(csvFileName(settings, '2026-10-05', 'users'), 'SpyneLeads/leads_users_2026-10-05.csv');
  assert.equal(csvFileName(settings, '2026-10-05', 'deals'), 'SpyneLeads/leads_deals_2026-10-05.csv');
  assert.equal(csvFileName(settings, '2026-10-05', 'reference'), 'SpyneLeads/leads_reference_2026-10-05.csv');
});
