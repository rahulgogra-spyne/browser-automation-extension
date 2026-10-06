import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ext from '../extension/lib/columns.js';
import * as api from '../backend/src/schema.js';
import { SYSTEM_PROMPT } from '../backend/src/prompt.js';

test('extension and backend agree on standard and metadata keys', () => {
  assert.deepEqual(api.STANDARD_KEYS, ext.STANDARD_KEYS);
  assert.deepEqual([...api.META_KEYS].sort(), [...ext.META_KEYS].sort());
});

test('extension and backend turn labels into the same keys', () => {
  for (const label of ['Stock #', 'E-mail', 'Café Name', '2nd Phone', 'record_id', '  Order Total ($) ', '']) {
    assert.equal(api.toKey(label), ext.toKey(label), label);
  }
});

test('the prompt names every standard key', () => {
  for (const key of api.STANDARD_KEYS) assert.match(SYSTEM_PROMPT, new RegExp(`\\b${key}\\b`), key);
});

test('schema follows OpenAI strict-mode rules at every level', () => {
  const walk = (node, path) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, path);
      assert.deepEqual(node.required, Object.keys(node.properties), path);
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.${key}`);
    }
    if (node.type === 'array') walk(node.items, `${path}[]`);
  };
  walk(api.EXTRACTION_SCHEMA, 'root');
});
