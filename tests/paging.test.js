import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPageUrl, isPagedUrl } from '../extension/lib/paging.js';

test('next page from offset/limit, page and hash-route parameters', () => {
  assert.equal(
    nextPageUrl('https://crm.example/app/?module=Contacts&action=index&list_offset=1&list_limit=20'),
    'https://crm.example/app/?module=Contacts&action=index&list_offset=21&list_limit=20',
  );
  assert.equal(nextPageUrl('https://crm.example/leads?page=2&sort=name'), 'https://crm.example/leads?page=3&sort=name');
  assert.equal(nextPageUrl('https://crm.example/app.html#/customers?page=1'), 'https://crm.example/app.html#/customers?page=2');
  assert.equal(nextPageUrl('https://crm.example/list?start=40&count=20'), 'https://crm.example/list?start=60&count=20');
  assert.equal(nextPageUrl('https://crm.example/list?offset=40', { pageSizeHint: 20 }), 'https://crm.example/list?offset=60');
  assert.equal(nextPageUrl('https://crm.example/list?offset=40'), null, 'an offset without a page size cannot be advanced');
  assert.equal(nextPageUrl('https://crm.example/contacts'), null);
  assert.equal(isPagedUrl('https://crm.example/contacts?page=1'), true);
  assert.equal(isPagedUrl('https://crm.example/contacts'), false);
});
