// Network firewall for read-only runs: the backstop behind lib/guard.ts. The extension attaches
// and switches this on before the DMS page even loads; from then on every XHR/fetch/form/beacon
// request pauses here first. Reads go through; anything that could write fails before it leaves
// the browser.
//
// - GET, HEAD and OPTIONS pass (unless they carry a GraphQL mutation). PUT, PATCH, DELETE and any
//   other method are blocked.
// - A GraphQL mutation is blocked wherever it goes, found by actually lexing the document, not by
//   pattern matching. A document that doesn't lex, or a persisted operation named like a write, is
//   treated as a mutation.
// - Loading the flow's page is the step the flow names, so while a page loads itself (before the
//   agent has touched it: no click, key, scroll or hover yet) its POSTs pass. They are remembered
//   exactly: method, host, path and query, plus the request body's shape (keys, and every value
//   except numbers and opaque strings such as ids, dates and cursors), with GraphQL remembered by
//   operation and document. After the agent's first input, a POST passes only if it is one of
//   those (the same request, maybe for another page of results), or matches one of the flow's
//   audited read requests. Everything else is blocked. A new document starts over.
// - A body the firewall can't read is never remembered, so after the first input it is blocked.
// lib/agent.ts runs this for the page, for frames on other sites, and (through the page) for its
// workers. Not covered: WebSocket messages, service and shared workers. The click allowlist still
// applies to every page action.
export interface Paused {
  requestId: string;
  resourceType?: string;
  request: { url: string; method: string; postData?: string; hasPostData?: boolean; postDataEntries?: { bytes?: string }[] };
}

export interface Decision {
  allow: boolean;
  /** What a learned request is matched on (see endpoint()). */
  key: string;
  /** Short and readable, for logs: method, host and path with ids normalised. */
  label: string;
}

/** Requests that can carry a write. Images, scripts, styles and fonts are left alone. */
export const PATTERNS = ['XHR', 'Fetch', 'Document', 'Ping', 'EventSource', 'Other'].map((resourceType) => ({
  urlPattern: '*',
  resourceType,
  requestStage: 'Request',
}));

const ID = /^(\d+|[0-9a-f]{8,}|[0-9a-f-]{32,36})$/i;

/** The same request whatever its ids, page number or cursor: /ro/7314021/lines?page=2 -> /ro/:id/lines?page=:id */
export function endpoint(method: string, url: string, body?: string | null): string {
  const u = new URL(url);
  const path = u.pathname
    .split('/')
    .map((seg) => (ID.test(seg) ? ':id' : seg))
    .join('/');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => `${k}=${ID.test(v) ? ':id' : v}`)
    .sort()
    .join('&');
  const tail = body === null ? ' <unreadable body>' : body ? ` ${bodyKey(body)}` : '';
  return `${method.toUpperCase()} ${u.host}${path}${query ? `?${query}` : ''}${tail}`;
}

function labelOf(method: string, url: string): string {
  try {
    const u = new URL(url);
    return `${method.toUpperCase()} ${u.host}${u.pathname
      .split('/')
      .map((seg) => (ID.test(seg) ? ':id' : seg))
      .join('/')}`;
  } catch {
    return `${method.toUpperCase()} ${url.slice(0, 80)}`;
  }
}

/** The request body as text: null if there is one but CDP didn't hand it over readably. */
export function bodyOf(r: Paused['request']): string | undefined | null {
  if (typeof r.postData === 'string') return r.postData;
  if (r.postDataEntries?.length) {
    // An entry without bytes is a file or blob CDP didn't hand over: unreadable, not empty.
    if (r.postDataEntries.some((e) => typeof e.bytes !== 'string')) return null;
    try {
      const bytes = r.postDataEntries.flatMap((e) => [...atob(e.bytes!)].map((ch) => ch.charCodeAt(0)));
      return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
      return null;
    }
  }
  return r.hasPostData ? null : undefined;
}

/* -------------------------------------------------------------- body shape */

/**
 * Values that vary from one page of results to the next become placeholders: numbers, ids, dates,
 * timestamps, cursors and tokens. Everything else stays exactly as sent, so an operation, a status
 * or a route ("ro/list", "listV2") can't be swapped for another under the same key.
 */
const opaque = (v: string) =>
  /^\d[\d\s:./TZ+-]*$/i.test(v) || // numbers, dates, timestamps
  /^([0-9a-f]{8,}|[0-9a-f-]{32,36})$/i.test(v) || // hex ids, uuids
  /^[A-Za-z0-9+/_-]{4,}={1,2}$/.test(v) || // padded base64
  /^[A-Za-z0-9+/_-]{40,}$/.test(v) || // long tokens
  (/^[A-Za-z0-9_-]{16,}$/.test(v) && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v)); // mixed-case tokens
/** Keys whose number is a choice (an operation or a status), not a page or an id. */
const CHOICE = /^(type|action|op|operation|status|state|mode|method|kind|cmd|command|verb)$/i;

function shape(v: unknown, key = '', depth = 0): string {
  if (depth > 20) return '?';
  if (typeof v === 'number') return CHOICE.test(key) ? String(v) : '#';
  if (typeof v === 'string') {
    // JSON inside a string (a "payload" field) is judged by what it says, not hidden behind it.
    if (/^\s*[[{]/.test(v)) {
      const inner = parseJson(v);
      if (inner !== undefined) return `json${shape(inner, key, depth + 1)}`;
    }
    return opaque(v) ? '$' : JSON.stringify(v);
  }
  if (v === null || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${[...new Set(v.map((x) => shape(x, key, depth + 1)))].sort().join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${ID.test(k) ? ':id' : k}:${shape(x, k, depth + 1)}`)
      .sort()
      .join(',')}}`;
  }
  return '?';
}

/** Keys a GraphQL request body has; anything else beside them is part of what the request does. */
const GQL_KEYS = new Set(['query', 'operationName', 'variables', 'extensions']);

/**
 * What identifies a body: a plain GraphQL request by its operations (its variables may change
 * from page to page); JSON and forms by shape; anything else by its text. A body that carries
 * GraphQL and other fields too is identified by both.
 */
function bodyKey(body: string): string {
  const gql = graphqlOperations(body);
  const json = parseJson(body);
  const ops = gql ? `gql(${gql.map((op) => `${op.type}:${op.name ?? '?'}#${op.id}`).join(',')})` : '';
  const plain = (v: unknown): boolean =>
    Array.isArray(v) ? v.every(plain) : !!v && typeof v === 'object' && Object.keys(v).every((k) => GQL_KEYS.has(k));
  if (gql && json !== undefined && plain(json)) return ops;
  let key: string;
  if (json !== undefined) key = shape(json);
  else if (isForm(body)) key = shape(Object.fromEntries(new URLSearchParams(body)));
  else key = `raw:${body.replace(/\d+/g, '#').replace(/\s+/g, ' ')}`;
  key = `${ops}${key}`;
  return key.length > 160 ? `~${hash(key)}` : key;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const isForm = (body: string) => /^[\w.%[\]-]+=[^&]*(&[\w.%[\]-]+=[^&]*)*$/.test(body.trim());

/** FNV-1a, 32 bit: keeps long keys short. Identity only, not security. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/* ----------------------------------------------------------------- GraphQL */

interface GqlOp {
  /** query, mutation, subscription; 'persisted' when only a hash was sent; 'unknown' if it didn't lex. */
  type: string;
  name?: string;
  /** The persisted-query hash, or a hash of the document text. */
  id: string;
  write: boolean;
}

/**
 * Persisted operations carry no document, only a name: one with a write verb anywhere in it
 * (RepairOrderUpdate, roClose, job_line_delete) is treated as a write.
 */
const WRITE_VERB =
  /^(create|update|delete|remove|save|set|add|close|submit|mark|assign|unassign|cancel|void|post|approve|reject|send|archive|unarchive|insert|upsert|patch|edit|change|reopen|complete|finali[sz]e|apply|reset|clear|merge|import|upload|pay|refund|charge|transfer|book|schedule|reschedule|dispatch|release|sign|accept|decline|move|copy|duplicate|restore|toggle|enable|disable|link|unlink|attach|detach|register|start|stop|end|convert|generate|print|email|notify|invite|lock|unlock|bulk|batch|sync|write|put|modify|mutate|mutation|upsert|persist|store|commit|finish|clock|punch)s?$/i;
const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
const writeName = (name: string) => words(name).some((w) => WRITE_VERB.test(w));

/** A GraphQL document starts (after whitespace, commas and comments) with an operation, a fragment or { . */
const DOC = /^(?:[\s,\uFEFF]|#[^\n\r]*)*(?:(?:query|mutation|subscription|fragment)\b|\{)/;
const looksLikeDoc = (s: unknown): s is string => typeof s === 'string' && DOC.test(s);

/**
 * The GraphQL operations in a request body (JSON, a JSON batch, a form, or a bare document), or
 * null if it isn't GraphQL. Any operation that is a mutation, or can't be told apart from one, is
 * marked `write`. A REST body that merely has a "query" field (a search box) isn't GraphQL.
 */
export function graphqlOperations(body: string | undefined | null): GqlOp[] | null {
  if (!body) return null;
  const json = parseJson(body);
  const ops = json !== undefined ? collect(json) : isForm(body) ? collect(formObject(new URLSearchParams(body))) : looksLikeDoc(body) ? [docOp(body)] : [];
  return ops.length ? ops : null;
}

/** GraphQL operations anywhere in a JSON value: { query, operationName } or a persisted { extensions }. */
function collect(v: unknown, out: GqlOp[] = [], depth = 0): GqlOp[] {
  if (depth > 20 || !v || typeof v !== 'object') return out;
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out, depth + 1);
    return out;
  }
  const o = v as Record<string, unknown>;
  const name = typeof o.operationName === 'string' ? o.operationName : undefined;
  const persisted = (o.extensions as { persistedQuery?: { sha256Hash?: unknown } } | undefined)?.persistedQuery?.sha256Hash;
  // A query string beside GraphQL's other fields is a document even if it doesn't look like one
  // (a description string can come first).
  const besideGql = 'operationName' in o || 'variables' in o || 'extensions' in o;
  if (looksLikeDoc(o.query) || (typeof o.query === 'string' && besideGql)) out.push(docOp(o.query as string, name));
  else if (typeof persisted === 'string') out.push({ type: 'persisted', name, id: persisted, write: !name || writeName(name) });
  for (const x of Object.values(o)) collect(x, out, depth + 1);
  return out;
}

function docOp(doc: string, name?: string): GqlOp {
  const types = lex(doc);
  return { type: types.map((t) => t.type).join('+'), name, id: hash(doc), write: types.some((t) => t.write) };
}

/** A form or query string as the JSON a GraphQL client would have sent. */
function formObject(f: URLSearchParams): Record<string, unknown> {
  const o: Record<string, unknown> = Object.fromEntries(f);
  if (typeof o.extensions === 'string') o.extensions = parseJson(o.extensions);
  return o;
}

/**
 * The operation types defined in a GraphQL document. A real lexer (comments, strings, block
 * strings, nesting), so a keyword inside a string, a comment or a selection is never mistaken for
 * an operation, and one hidden by comment tricks is still found. Unlexable: one 'unknown' write.
 */
export function lex(doc: string): { type: string; write: boolean }[] {
  const unknown = [{ type: 'unknown', write: true }];
  const types: string[] = [];
  let depth = 0;
  let atDefinition = true; // the next name at depth 0 starts a definition
  let i = 0;
  while (i < doc.length) {
    const c = doc[i]!;
    if (c === '#') {
      while (i < doc.length && doc[i] !== '\n' && doc[i] !== '\r') i++;
    } else if (doc.startsWith('"""', i)) {
      i += 3;
      while (i < doc.length && !doc.startsWith('"""', i)) i += doc.startsWith('\\"""', i) ? 4 : 1;
      if (i >= doc.length) return unknown;
      i += 3;
    } else if (c === '"') {
      i++;
      while (i < doc.length && doc[i] !== '"') {
        if (doc[i] === '\n' || doc[i] === '\r') return unknown;
        i += doc[i] === '\\' ? 2 : 1;
      }
      if (i >= doc.length) return unknown;
      i++;
    } else if (c === '{' || c === '(' || c === '[') {
      if (depth === 0 && c === '{' && atDefinition) types.push('query'); // the { ... } shorthand
      if (depth === 0 && c === '{') atDefinition = false;
      depth++;
      i++;
    } else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth < 0) return unknown;
      if (depth === 0 && c === '}') atDefinition = true;
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < doc.length && /\w/.test(doc[j]!)) j++;
      if (depth === 0 && atDefinition) {
        types.push(doc.slice(i, j));
        atDefinition = false;
      }
      i = j;
    } else {
      i++;
    }
  }
  if (depth !== 0 || !types.length) return unknown;
  // Only query, subscription and fragment definitions read. Anything else (mutation, schema
  // definitions, garbage) is treated as a write.
  return types.map((type) => ({ type, write: !['query', 'subscription', 'fragment'].includes(type) }));
}

/* ------------------------------------------------------------------ decide */

/**
 * Should this paused request go through? `seen` holds what the current document requested while
 * loading itself; `learning` is true until the agent's first input on it. `reads` are the flow's
 * audited read requests, matched against the full key (see endpoint()).
 */
export function decide(p: Paused, seen: Set<string>, learning: boolean, reads: RegExp[] = []): Decision {
  const method = p.request.method.toUpperCase();
  const url = p.request.url;
  const label = labelOf(method, url);
  let body: string | undefined | null;
  let key: string;
  try {
    body = bodyOf(p.request);
    key = endpoint(method, url, body);
  } catch {
    return { allow: false, key: label, label }; // a URL that doesn't parse is nothing Spyne Report Helper can judge
  }
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    // GraphQL over GET: the query string carries the document (servers should refuse a mutation
    // there, but don't rely on it). A persisted query without a name is normal over GET.
    const ops = collect(formObject(new URL(url).searchParams));
    const write = ops.some((op) => (op.type === 'persisted' ? !!op.name && writeName(op.name) : op.write));
    return { allow: !write, key, label };
  }
  if (method !== 'POST') return { allow: false, key, label };
  if (graphqlOperations(body)?.some((op) => op.write)) return { allow: false, key, label };
  // Multipart and other raw bodies can carry a GraphQL document Spyne Report Helper didn't parse.
  if (body && parseJson(body) === undefined && !isForm(body) && /\bmutation\b/i.test(body)) return { allow: false, key, label };
  if (learning) {
    if (body !== null) seen.add(key); // an unreadable body passes while loading, but is never remembered
    return { allow: true, key, label };
  }
  if (body !== null && seen.has(key)) return { allow: true, key, label };
  if (body !== null && reads.some((r) => r.test(key))) return { allow: true, key, label };
  return { allow: false, key, label };
}
