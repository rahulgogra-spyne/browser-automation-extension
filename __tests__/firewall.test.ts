import { describe, expect, it } from 'vitest';
import { decide, endpoint, graphqlOperations, lex, type Paused } from '../lib/firewall';

const req = (method: string, url: string, postData?: string): Paused => ({ requestId: '1', request: { method, url, postData, hasPostData: postData != null } });
const gql = (query: string, extra: object = {}) => JSON.stringify({ query, ...extra });

describe('firewall', () => {
  it('lets reads through and always blocks other write methods, even while the page loads itself', () => {
    const seen = new Set<string>();
    expect(decide(req('GET', 'https://app.tekioncloud.com/api/ro/1'), seen, false).allow).toBe(true);
    for (const m of ['PUT', 'PATCH', 'DELETE', 'PROPFIND']) {
      expect(decide(req(m, 'https://app.tekioncloud.com/api/ro/1'), seen, true).allow, m).toBe(false);
    }
  });

  it("learns the page's own POSTs while it loads, then allows exactly those", () => {
    const seen = new Set<string>();
    expect(decide(req('POST', 'https://api.tekioncloud.com/ro/7314021/lines?page=1'), seen, true).allow).toBe(true);
    // Same endpoint, other ids and page: still the app's own read.
    expect(decide(req('POST', 'https://api.tekioncloud.com/ro/7314099/lines?page=2'), seen, false).allow).toBe(true);
    // Not learned, or a different operation in the query: blocked.
    expect(decide(req('POST', 'https://api.tekioncloud.com/ro/7314021/update'), seen, false).allow).toBe(false);
    expect(decide(req('POST', 'https://api.tekioncloud.com/ro/7314021/lines?op=delete'), seen, false).allow).toBe(false);
  });

  it('no longer trusts read-sounding paths', () => {
    const seen = new Set<string>();
    for (const path of ['/api/ro/search', '/search/delete', '/getAndUpdate', '/ro/list/close']) {
      expect(decide(req('POST', `https://app.tekioncloud.com${path}`), seen, false).allow, path).toBe(false);
    }
  });

  it('allows audited read endpoints the flow lists', () => {
    const search = /^POST app\.tekioncloud\.com\/api\/ro\/search \{page:#,status:"OPEN"\}$/;
    expect(decide(req('POST', 'https://app.tekioncloud.com/api/ro/search', '{"status":"OPEN","page":3}'), new Set(), false, [search]).allow).toBe(true);
    // Audited means the whole request: the same path with another operation is still blocked.
    expect(decide(req('POST', 'https://app.tekioncloud.com/api/ro/search', '{"status":"CLOSED","page":3}'), new Set(), false, [search]).allow).toBe(false);
  });

  it('blocks GraphQL mutations everywhere, including learned endpoints and comment tricks', () => {
    const seen = new Set<string>();
    const url = 'https://app.tekioncloud.com/graphql';
    expect(decide(req('POST', url, gql('query ROs { repairOrders { id } }', { operationName: 'ROs' })), seen, true).allow).toBe(true);
    expect(decide(req('POST', url, gql('query ROs { repairOrders { id } }', { operationName: 'ROs' })), seen, false).allow).toBe(true);
    // A mutation to the same learned endpoint, and one hidden behind a comment.
    expect(decide(req('POST', url, gql('mutation Close { closeRo(id: 1) { id } }', { operationName: 'ROs' })), seen, false).allow).toBe(false);
    expect(decide(req('POST', url, gql('# heading\nmutation# comment\nClose { closeRo(id: 1) { id } }')), seen, true).allow).toBe(false);
    // A mutation even while the page loads itself.
    expect(decide(req('POST', url, gql('mutation { b }')), seen, true).allow).toBe(false);
    // "mutation" inside a string or a field name is not an operation.
    expect(graphqlOperations(gql('query { notes(text: "mutation here") { mutationCount } }'))![0]!.write).toBe(false);
  });

  it('matches persisted GraphQL queries by operation and hash', () => {
    const seen = new Set<string>();
    const url = 'https://app.tekioncloud.com/graphql';
    const persisted = (name: string, hash: string) => JSON.stringify({ operationName: name, extensions: { persistedQuery: { sha256Hash: hash } } });
    expect(decide(req('POST', url, persisted('ROs', 'aaa')), seen, true).allow).toBe(true);
    expect(decide(req('POST', url, persisted('ROs', 'aaa')), seen, false).allow).toBe(true);
    expect(decide(req('POST', url, persisted('ListROs', 'ccc')), seen, false).allow).toBe(false); // never loaded
    // Named like a write, or not named at all: blocked even while the page loads itself.
    expect(decide(req('POST', url, persisted('CloseRo', 'bbb')), seen, true).allow).toBe(false);
    expect(decide(req('POST', url, JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'ddd' } } })), seen, true).allow).toBe(false);
  });

  it('lexes GraphQL: comment and string tricks never hide a mutation, and field names are not operations', () => {
    const seen = new Set<string>();
    const url = 'https://app.tekioncloud.com/graphql';
    expect(decide(req('POST', url, gql('{ repairOrders { id } }')), seen, true).allow).toBe(true);
    // Quotes inside comments used to swallow the real mutation between them.
    expect(decide(req('POST', url, gql('# "\nmutation Close { closeRo(id: 1) { id } }\n# "')), seen, false).allow).toBe(false);
    expect(decide(req('POST', url, gql('"""a "" b""" mutation X { y }')), seen, false).allow).toBe(false);
    expect(lex('query { mutation }')).toEqual([{ type: 'query', write: false }]);
    expect(lex('query A($f: In = {a: "}"}) { x } fragment F on T { y }')).toEqual([
      { type: 'query', write: false },
      { type: 'fragment', write: false },
    ]);
    // Anything that doesn't lex is treated as a write.
    expect(lex('query { x ').every((t) => t.write)).toBe(true);
    expect(lex('query { x(s: "unterminated) }').every((t) => t.write)).toBe(true);
    // Batches, bare documents, forms and GET query strings.
    expect(decide(req('POST', url, JSON.stringify([{ query: '{ a }' }, { query: 'mutation { b }' }])), seen, true).allow).toBe(false);
    expect(decide(req('POST', url, 'mutation { closeRo(id: 1) { id } }'), seen, true).allow).toBe(false);
    expect(decide(req('POST', url, `query=${encodeURIComponent('mutation { b }')}`), seen, true).allow).toBe(false);
    expect(decide(req('GET', `${url}?query=${encodeURIComponent('mutation { b }')}`), seen, false).allow).toBe(false);
    expect(decide(req('GET', `${url}?query=${encodeURIComponent('{ a }')}`), seen, false).allow).toBe(true);
  });

  it("a search box's query field is not GraphQL", () => {
    expect(graphqlOperations('{"query":"camry","page":1}')).toBeNull();
    expect(decide(req('GET', 'https://app.tekioncloud.com/api/search?query=delete%20camry'), new Set(), false).allow).toBe(true);
  });

  it('remembers the body too: the same request passes for another page, a different operation does not', () => {
    const seen = new Set<string>();
    const url = 'https://app.tekioncloud.com/rpc';
    expect(decide(req('POST', url, '{"op":"list","page":1,"cursor":"eyJwYWdlIjoxfQ=="}'), seen, true).allow).toBe(true);
    expect(decide(req('POST', url, '{"op":"list","page":2,"cursor":"eyJwYWdlIjoyfQ=="}'), seen, false).allow).toBe(true);
    expect(decide(req('POST', url, '{"op":"delete","id":7314021}'), seen, false).allow).toBe(false);
    expect(decide(req('POST', url, '{"op":"list","page":2,"archive":true}'), seen, false).allow).toBe(false);
    // Forms the same way.
    expect(decide(req('POST', url, 'action=list&page=1'), seen, true).allow).toBe(true);
    expect(decide(req('POST', url, 'action=list&page=4'), seen, false).allow).toBe(true);
    expect(decide(req('POST', url, 'action=close&page=4'), seen, false).allow).toBe(false);
  });

  it('a write never shares a key with a learned read (round-4 review cases)', () => {
    const url = 'https://app.tekioncloud.com/rpc';
    const pairs: [string, string][] = [
      ['{"action":"ro/list"}', '{"action":"ro/close"}'],
      ['{"op":"listV2"}', '{"op":"closeV2"}'],
      ['{"action":1}', '{"action":3}'],
      [JSON.stringify({ payload: JSON.stringify({ op: 'list' }) }), JSON.stringify({ payload: JSON.stringify({ op: 'delete' }) })],
      [`data=${encodeURIComponent('{"op":"list"}')}`, `data=${encodeURIComponent('{"op":"delete"}')}`],
      ['{"query":"{ a }","op":"list"}', '{"query":"{ a }","op":"delete","ids":[1,2]}'],
    ];
    for (const [read, write] of pairs) {
      const seen = new Set<string>();
      expect(decide(req('POST', url, read), seen, true).allow, read).toBe(true);
      expect(decide(req('POST', url, write), seen, false).allow, write).toBe(false);
    }
    // A file or blob CDP didn't hand over is unreadable, not empty.
    const seen = new Set<string>();
    expect(decide(req('POST', 'https://app.tekioncloud.com/api/ro/list'), seen, true).allow).toBe(true);
    const blob: Paused = { requestId: '1', request: { method: 'POST', url: 'https://app.tekioncloud.com/api/ro/list', hasPostData: true, postDataEntries: [{}] } };
    expect(decide(blob, seen, false).allow).toBe(false);
  });

  it('persisted operations with a write verb anywhere in the name are writes, over POST and GET', () => {
    const url = 'https://app.tekioncloud.com/graphql';
    const persisted = (name: string) => JSON.stringify({ operationName: name, extensions: { persistedQuery: { sha256Hash: 'h' } } });
    for (const name of ['RepairOrderUpdate', 'roClose', 'ROStatusChange', 'job_line_delete']) {
      expect(decide(req('POST', url, persisted(name)), new Set(), true).allow, name).toBe(false);
      const ext = encodeURIComponent(JSON.stringify({ persistedQuery: { sha256Hash: 'h' } }));
      expect(decide(req('GET', `${url}?operationName=${name}&extensions=${ext}`), new Set(), false).allow, name).toBe(false);
    }
    expect(decide(req('POST', url, persisted('RepairOrderList')), new Set(), true).allow).toBe(true);
    // A description before the operation still gets the document lexed.
    expect(decide(req('POST', url, JSON.stringify({ query: '"close" mutation Ro { x }', operationName: 'Ro' })), new Set(), true).allow).toBe(false);
  });

  it("a body the firewall can't read passes while loading but is never remembered", () => {
    const seen = new Set<string>();
    const opaque: Paused = { requestId: '1', request: { method: 'POST', url: 'https://app.tekioncloud.com/rpc', hasPostData: true } };
    expect(decide(opaque, seen, true).allow).toBe(true);
    expect(decide(opaque, seen, false).allow).toBe(false);
  });

  it('reads bodies CDP hands over as postDataEntries', () => {
    const seen = new Set<string>();
    const entries = (text: string): Paused => ({
      requestId: '1',
      request: { method: 'POST', url: 'https://app.tekioncloud.com/graphql', hasPostData: true, postDataEntries: [{ bytes: btoa(text) }] },
    });
    expect(decide(entries(gql('mutation { b }')), seen, true).allow).toBe(false);
    expect(decide(entries(gql('{ a }')), seen, true).allow).toBe(true);
    expect(decide(entries(gql('{ a }')), seen, false).allow).toBe(true);
  });

  it('applies to every host, not just the DMS', () => {
    expect(decide(req('POST', 'https://api.segment.io/v1/t'), new Set(), false).allow).toBe(false);
  });

  it('normalises ids but keeps the rest of the query', () => {
    expect(endpoint('post', 'https://a.tekioncloud.com/ro/7314021/lines?x=1&mode=view')).toBe('POST a.tekioncloud.com/ro/:id/lines?mode=view&x=:id');
    expect(endpoint('POST', 'https://a.tekioncloud.com/ro/3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe('POST a.tekioncloud.com/ro/:id');
  });
});
