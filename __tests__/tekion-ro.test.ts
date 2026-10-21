import { describe, expect, it } from 'vitest';
import { allowed } from '../lib/tekion-ro-run';

describe('Tekion RO export: requests it may make', () => {
  it('allows reads and searches on Tekion', () => {
    expect(allowed('GET', 'https://app.tekioncloud.com/ro/repair-orders/ro-list')).toBe(true);
    expect(allowed('POST', 'https://app.tekioncloud.com/api/service-module/u/ro/v2/search')).toBe(true);
  });
  it('blocks writes and other hosts', () => {
    expect(allowed('POST', 'https://app.tekioncloud.com/api/service-module/u/ro/update')).toBe(false);
    expect(allowed('DELETE', 'https://app.tekioncloud.com/api/anything')).toBe(false);
    expect(allowed('GET', 'https://example.com/')).toBe(false);
  });
});
