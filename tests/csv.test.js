import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, escapeCell, csvFileName } from '../extension/lib/csv.js';
import { csvColumns, toKey } from '../extension/lib/columns.js';

test('columns: metadata, standard keys in order, other keys as first seen, trailing metadata', () => {
  const rows = [
    { captured_at: 't', site: 's', page_title: 'p', order_total: '1', email: 'e', first_name: 'f', record_id: 'r' },
    { captured_at: 't', site: 's', color: 'red', last_name: 'l', order_total: '2' },
  ];
  assert.deepEqual(csvColumns(rows), [
    'captured_at', 'site', 'page_title', 'crm_record_id',
    'first_name', 'last_name', 'email',
    'order_total', 'color',
    'messages_count', 'page_url', 'captured_by', 'unverified_fields', 'record_id',
  ]);
});

test('rows missing a column get an empty cell', () => {
  const csv = toCsv([{ a: '1' }, { b: '2' }], ['a', 'b']);
  assert.equal(csv, 'a,b\r\n1,\r\n,2\r\n');
});

test('cells with commas, quotes and newlines are quoted', () => {
  assert.equal(escapeCell('Doe, John'), '"Doe, John"');
  assert.equal(escapeCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCell('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCell(null), '');
});

test('formula-looking values are neutralised', () => {
  assert.equal(escapeCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(escapeCell('+1 555'), "'+1 555");
  assert.equal(escapeCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(escapeCell('(214) 555-0147'), '(214) 555-0147');
});

test('page labels become column keys', () => {
  assert.equal(toKey('Stock #'), 'stock_number');
  assert.equal(toKey('  Order Total ($) '), 'order_total');
  assert.equal(toKey('Café Name'), 'cafe_name');
  assert.equal(toKey('2nd Phone'), 'field_2nd_phone');
  assert.equal(toKey('Record ID'), 'record_id_value');
  assert.equal(toKey('!!!'), '');
});

test('file names are date based and safe', () => {
  assert.equal(csvFileName({ downloadFolder: 'SpyneLeads', filePrefix: 'leads' }, '2026-09-29'), 'SpyneLeads/leads_2026-09-29.csv');
  assert.equal(csvFileName({ downloadFolder: '', filePrefix: '' }, '2026-09-29'), 'leads_2026-09-29.csv');
  assert.equal(csvFileName({ downloadFolder: 'SpyneLeads', filePrefix: 'leads' }, '2026-09-29', 'messages'), 'SpyneLeads/leads_messages_2026-09-29.csv');
  assert.equal(
    csvFileName({ downloadFolder: '..\\Spyne/../Leads:', filePrefix: 'a/b?' }, '2026-09-29'),
    'Spyne/Leads/ab_2026-09-29.csv',
  );
});
