// Capture a CRM through its own JSON API instead of its pages. No tabs are
// opened and nothing is clicked: the requests run in the CRM tab's own world
// (window.fetch with credentials included), so the user's signed-in session
// (cookies, and any bearer the app already holds) is reused. The endpoints and
// the JSON-path for each field live in the CRM's `api` block in
// config/crm-structures.json, built once from DevTools -> Network, the same
// way the DOM layouts are built once by the mapper.
//
// A dataset's `list` endpoint is walked page by page for record ids; each id's
// `record` endpoint is fetched and mapped to { fields, collections } of the
// exact shape save() expects. A record the API can't yield (missing required
// fields, an error, no identity) is reported so the caller can fall back to
// the page-based capture for just that record.

import { execScript } from './exec.js';

// -------------------------------------------------------------- JSON paths

// Reads a dotted/bracketed path out of a JSON value:
//   "address.city", "phones.0.number", "lead.status", "items[2].id".
// A path step that isn't there yields '' (never throws). Arrays can be
// indexed by number; an object step applied to an array reads the first item
// (so "activities.subject" over a list is the first activity's subject only
// when a single value is wanted — collections use readList instead).
function readPath(value, path) {
  if (value == null || !path) return value ?? '';
  const steps = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = value;
  for (const step of steps) {
    if (cur == null) return '';
    cur = Array.isArray(cur) && !/^\d+$/.test(step) ? cur[0]?.[step] : cur[step];
  }
  return cur == null ? '' : cur;
}

// The array a collection lives at (activities, notes...): the value at the
// path, as an array (a single object becomes a one-item array; nothing an
// empty one).
function readList(value, path) {
  const at = path ? readPath(value, path) : value;
  if (Array.isArray(at)) return at;
  return at && typeof at === 'object' ? [at] : [];
}

// A scalar for a CSV cell: strings/numbers/bools as text; an object/array
// JSON-stringified so nothing is silently dropped.
const scalar = (v) => {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) {
    // Arrays of scalars (e.g. AI summary bullets) read best joined; arrays of
    // objects are JSON so nothing is lost.
    if (v.every((x) => x == null || typeof x !== 'object')) return v.filter((x) => x != null && x !== '').join('; ');
    return JSON.stringify(v);
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

// -------------------------------------------------------------- templating

// Fills {id}, {offset}, {limit}, {page} in an endpoint path.
function fillPath(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? encodeURIComponent(vars[k]) : ''));
}

// Deep-fills a JSON body template: any string value "{{name}}" (whole string)
// is replaced by vars[name] with its real type (number/array/object/null kept),
// and "...{{name}}..." inside a longer string is substituted as text. Objects
// and arrays are walked. Used for POST bodies like GetProspectList, whose
// company/user/dept/date fields come from the live session, never the config.
function fillBody(template, vars) {
  if (typeof template === 'string') {
    const whole = template.match(/^\{\{(\w+)\}\}$/);
    if (whole) return vars[whole[1]] ?? null; // keep the real type
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  }
  if (Array.isArray(template)) return template.map((v) => fillBody(v, vars));
  if (template && typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = fillBody(v, vars);
    return out;
  }
  return template;
}

// An absolute URL from a config path: baseUrl (or the page's own origin when
// baseUrl is blank) + the path.
function apiUrl(origin, baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  const root = (baseUrl || origin || '').replace(/\/+$/, '');
  return `${root}${path.startsWith('/') ? '' : '/'}${path}`;
}

// ------------------------------------------- runtime params from the session

// The department id(s) from the session's UserInformation cookie(s). The
// GetProspectList endpoint returns HTTP 401 "Unauthorized Attempt" when the
// body's DepartmentIds is empty, so this must resolve even when the cookie's
// name doesn't carry the current employeeId. Strategy, most-specific first:
//   1) a UserInformation cookie whose name contains the signed-in employeeId,
//   2) ANY UserInformation cookie that carries an lDepartmentID,
//   3) any cookie at all that carries an lDepartmentID.
// Every lDepartmentID found across the matched cookies is collected (a user
// may belong to several departments), de-duplicated, order preserved.
export function departmentIdsFromJar(jar = {}, employeeId = null) {
  const deptsIn = (value) => [...String(value).matchAll(/lDepartmentID=(\d+)/gi)].map((m) => Number(m[1]));
  const names = Object.keys(jar);
  const uiNames = names.filter((k) => /^UserInformation[_%]/i.test(k));
  const groups = [
    employeeId != null ? uiNames.filter((k) => k.includes(String(employeeId))) : [],
    uiNames,
    names,
  ];
  for (const group of groups) {
    const ids = [];
    for (const k of group) for (const id of deptsIn(jar[k])) if (!ids.includes(id)) ids.push(id);
    if (ids.length) return ids;
  }
  return [];
}

// Pure: derives the request-body params from a cookie jar ({name:value}) and a
// date window. Shared by the in-page resolver and the background's
// chrome.cookies resolver so both agree. The CDK session's company/user/dept
// ids are read from the app's own cookies; the auth cookies (.ASPXAUTH, SAML,
// ASP.NET_SessionId) are never used here — they ride along via credentials.
// A local midnight as the CRMs' list bodies take it: "2026-10-01T00:00:00+05:30".
function dayStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const tzStr = `${tz >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00${tzStr}`;
}

export function buildParams(jar = {}, windowDays = 7) {
  const num = (v) => {
    const n = parseInt(String(v || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const companyId = num(jar.CurrentCompanySession ?? jar.BackUpCompanyID ?? jar.SessionChildCompany);
  const childCompanyId = num(jar.SessionChildCompany ?? jar.CurrentCompanySession ?? jar.BackUpCompanyID);
  const employeeId = num(jar.BackUpEmpID);
  // UserInformation_<empId> holds "lDepartmentID=45848&..." (or URL-encoded).
  const departmentIds = departmentIdsFromJar(jar, employeeId);
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (Number(windowDays) || 7));
  return {
    companyId, childCompanyId, employeeId,
    selectedUserDeptId: employeeId,
    departmentIds,
    startDate: dayStamp(start),
    endDate: dayStamp(end),
    _cookieNames: Object.keys(jar), // for the log (names only, no values)
  };
}

// Runs in the CRM tab's MAIN world: reads the (non-HttpOnly) cookies and builds
// the params. Fallback for when the background can't use chrome.cookies.
function resolveParamsInPage(windowDays) {
  const jar = {};
  for (const part of (document.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = decodeURIComponent(part.slice(0, i).trim());
    jar[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  // Inline the same derivation (MAIN-world func can't import buildParams).
  const num = (v) => {
    const n = parseInt(String(v || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const companyId = num(jar.CurrentCompanySession ?? jar.BackUpCompanyID ?? jar.SessionChildCompany);
  const childCompanyId = num(jar.SessionChildCompany ?? jar.CurrentCompanySession ?? jar.BackUpCompanyID);
  const employeeId = num(jar.BackUpEmpID);
  // Mirror departmentIdsFromJar (inlined; MAIN-world func can't import it):
  // every lDepartmentID across the most specific group of cookies that has one.
  const deptsIn = (value) => [...String(value).matchAll(/lDepartmentID=(\d+)/gi)].map((m) => Number(m[1]));
  const names = Object.keys(jar);
  const uiNames = names.filter((k) => /^UserInformation[_%]/i.test(k));
  let departmentIds = [];
  for (const group of [employeeId != null ? uiNames.filter((k) => k.includes(String(employeeId))) : [], uiNames, names]) {
    const ids = [];
    for (const k of group) for (const id of deptsIn(jar[k])) if (!ids.includes(id)) ids.push(id);
    if (ids.length) { departmentIds = ids; break; }
  }
  const pad = (n) => String(n).padStart(2, '0');
  const tz = -new Date().getTimezoneOffset();
  const tzStr = `${tz >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`;
  const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00${tzStr}`;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (Number(windowDays) || 7));
  return { companyId, childCompanyId, employeeId, selectedUserDeptId: employeeId, departmentIds, startDate: dayStr(start), endDate: dayStr(end), _cookieNames: Object.keys(jar) };
}

// Resolves the runtime params in the given tab. Returns the param object (ids
// may be null when a cookie is absent, which the log will surface).
async function resolveParams(where, windowDays) {
  const results = await execScript(
    { target: where, world: 'MAIN', func: resolveParamsInPage, args: [windowDays] },
    {},
  ).catch(() => []);
  return results?.[0]?.result ?? null;
}

// -------------------------------------------------- fetching in the CRM tab

// Runs in the CRM tab's MAIN world: one fetch with the page's own session.
// Returns a plain, structured-cloneable result so execScript can hand it back.
// Fetches an HTML page (same-origin, session cookies) and extracts fields and
// collections with CSS selectors + optional regex — in the page's own world,
// so the full HTML never leaves the tab. spec: { fields: { key: {sel, attr?,
// regex?} }, collections: { name: { container, item, fields:{key:{sel,...}} } } }.
// Much faster than rendering the page in a tab (no SPA boot, parallelisable).
function extractHtmlInPage(url, spec, timeoutMs) {
  return (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 60_000);
    try {
      const res = await fetch(url, { credentials: 'include', signal: controller.signal });
      const text = await res.text();
      if (/<title>[^<]*log ?in|name="password"|id="loginForm"/i.test(text.slice(0, 2000)) && !res.url.includes(url.split('?')[0].split('/').pop())) {
        return { ok: false, status: res.status, error: 'HTML looked like a login/redirect (session?)' };
      }
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
      const read = (el, rule) => {
        if (!el) return '';
        let v = rule.attr ? el.getAttribute(rule.attr) : (el.innerText || el.textContent);
        v = clean(v);
        if (rule.regex) { const m = v.match(new RegExp(rule.regex, rule.flags || 'i')); v = m ? clean(m[1] ?? m[0]) : ''; }
        return v;
      };
      const fields = {};
      for (const [key, rule] of Object.entries(spec.fields || {})) {
        let el = null; try { el = doc.querySelector(rule.sel); } catch {}
        const v = read(el, rule);
        if (v && !/^(None|N\/A|-- Status Not Set --|\(none entered\)|Click to add customer note)$/i.test(v)) fields[key] = v.slice(0, 2000);
      }
      const collections = {};
      for (const [name, c] of Object.entries(spec.collections || {})) {
        let cont = null; try { cont = c.container ? doc.querySelector(c.container) : doc; } catch {}
        if (!cont) continue;
        let items = []; try { items = c.item === ':scope' ? [cont] : [...cont.querySelectorAll(c.item)]; } catch {}
        const entries = [];
        for (const it of items) {
          const entry = {};
          for (const [key, rule] of Object.entries(c.fields || {})) {
            let el = rule.sel === ':scope' ? it : null; if (!el) { try { el = it.querySelector(rule.sel); } catch {} }
            const v = read(el, rule);
            if (v) entry[key] = v.slice(0, 2000);
          }
          if (Object.keys(entry).length) entries.push(entry);
        }
        if (entries.length) collections[name] = entries;
      }
      return { ok: res.ok, status: res.status, fields, collections };
    } catch (e) {
      const timedOut = e && e.name === 'AbortError';
      return { ok: false, status: 0, timedOut, error: timedOut ? 'timed out' : String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  })();
}

function fetchInPage(url, method, headers, body, timeoutMs) {
  return (async () => {
    // A request the CRM never answers is given up, so it can be tried again.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 60_000);
    try {
      // A bodyless request has no content-type to declare; sending one anyway
      // makes some ASP.NET ScriptService .asmx endpoints append a "{\"d\":null}"
      // envelope after the real JSON, which then won't parse. Drop it when there
      // is no body (a GET never has one).
      const sendHeaders = { ...(headers || {}) };
      if (body == null) for (const k of Object.keys(sendHeaders)) if (/^content-type$/i.test(k)) delete sendHeaders[k];
      const res = await fetch(url, {
        method: method || 'GET',
        credentials: 'include',
        headers: sendHeaders,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const contentType = res.headers.get('content-type') || '';
      const base = {
        status: res.status,
        finalUrl: res.url,
        redirected: res.redirected,
        contentType,
        rawSample: text.slice(0, 2000),
        length: text.length,
      };
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
        // Some CDK endpoints double-encode: the body is a JSON *string* that
        // itself contains JSON (e.g. "\"{\\\"firstName\\\":...}\""). Unwrap it.
        if (typeof json === 'string') {
          const trimmed = json.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { json = JSON.parse(trimmed); } catch { /* keep the string */ }
          }
        }
      } catch {
        // Not JSON: usually an HTML login page (session expired) or the wrong URL.
        const looksLikeLogin = /<html|<!doctype|sign in|log ?in|password/i.test(text.slice(0, 500));
        return { ...base, ok: false, json: null, error: looksLikeLogin ? 'response was HTML, not JSON (likely a login/redirect — sign in to the CRM in that tab)' : 'response was not JSON' };
      }
      return { ...base, ok: res.ok, json };
    } catch (e) {
      const timedOut = e && e.name === 'AbortError';
      return { ok: false, status: 0, finalUrl: url, timedOut, error: timedOut ? `no answer within ${Math.round((timeoutMs || 60_000) / 1000)}s` : String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  })();
}

// Fetches url in the given tab's page world. Always returns an object with at
// least { ok, status, url }, plus { json } on success or { error } on failure,
// and { contentType, rawSample, finalUrl, redirected } for the log.
// Each try is bounded twice: the fetch itself (FETCH_MS, in the page) and the
// call into the page (a little longer: a tab that reloads or navigates mid-call
// never answers). A try that gets no answer is made once more.
const FETCH_MS = 60_000;
// Fetches + extracts an HTML detail page in the page world (see extractHtmlInPage).
async function apiExtractHtml(where, url, spec) {
  const results = await execScript(
    { target: where, world: 'MAIN', func: extractHtmlInPage, args: [url, spec, FETCH_MS] },
    { timeoutMs: FETCH_MS + 15_000 },
  ).catch((e) => [{ result: { ok: false, status: 0, error: e.message } }]);
  return results?.[0]?.result ?? { ok: false, status: 0, error: 'no response from the page' };
}

async function apiGet(where, url, { method = 'GET', headers = {}, body = null } = {}) {
  let r = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const results = await execScript(
      { target: where, world: 'MAIN', func: fetchInPage, args: [url, method, headers, body, FETCH_MS] },
      { timeoutMs: FETCH_MS + 15_000 },
    ).catch((e) => [{ result: { ok: false, status: 0, noAnswer: true, error: e.message } }]);
    r = results?.[0]?.result ?? { ok: false, status: 0, noAnswer: true, error: 'no response from the page (is the CRM tab open and loaded?)' };
    if (!(r.timedOut || r.noAnswer) || /cancelled/.test(r.error || '')) break;
  }
  return { url, ...r };
}

// --------------------------------------------- the stores, from the session

// Runs in the CRM tab's MAIN world: GETs url and returns the JSON it answers,
// or (with pattern) the JSON in the pattern's first group of the HTML (CDK
// writes its dealer list into index.aspx's scripts). Plain data back.
function storesInPage(url, headers, pattern, timeoutMs) {
  return (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 60_000);
    try {
      const res = await fetch(url, { credentials: 'include', headers: headers || {}, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const found = pattern ? text.match(new RegExp(pattern))?.[1] : text;
      if (found == null) return { error: 'the dealer list was not in the page (signed out, or the page changed)' };
      return { json: JSON.parse(found) };
    } catch (e) {
      return { error: e && e.name === 'AbortError' ? `no answer within ${Math.round((timeoutMs || 60_000) / 1000)}s` : String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  })();
}

// The stores the signed-in user can see, read the way the CRM's own dealer
// picker reads them (api.storesFrom), so each user gets their own dealerships:
//   storesFrom: { path, pattern?, itemsPath, idPath, namePath, where? }
// Returns [{ name, companyId, childCompanyId }] or { error }.
export async function resolveStores({ tabId, frameId = null, origin, api }) {
  const from = api.storesFrom;
  if (!from?.path) return { error: 'no storesFrom in the config' };
  const where = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  const url = apiUrl(origin, api.baseUrl, from.path);
  const results = await execScript(
    { target: where, world: 'MAIN', func: storesInPage, args: [url, headersFor(api), from.pattern || null, FETCH_MS] },
    { timeoutMs: FETCH_MS + 15_000 },
  ).catch((e) => [{ result: { error: e.message } }]);
  const res = results?.[0]?.result ?? { error: 'no answer from the CRM tab' };
  if (res.error) return res;
  const stores = [];
  for (const item of readList(res.json, from.itemsPath)) {
    if (Object.entries(from.where || {}).some(([path, value]) => readPath(item, path) !== value)) continue;
    const id = scalar(readPath(item, from.idPath));
    if (!id || stores.some((s) => String(s.companyId) === id)) continue;
    // CDK labels a dealer "Inver Grove Ford (16654)": the id is dropped from the name.
    const name = scalar(readPath(item, from.namePath)).replace(new RegExp(`\\s*\\(${id}\\)\\s*$`), '').trim() || id;
    const companyId = /^\d+$/.test(id) ? Number(id) : id;
    stores.push({ name, companyId, childCompanyId: companyId });
  }
  return stores.length ? stores : { error: 'the dealer list was empty' };
}

// A short, log-friendly summary of a JSON value's shape: top-level keys for an
// object; "[N] of {keys}" for an array of objects; the type otherwise. Helps
// read an unknown response in the log without dumping all of it.
function summarizeKeys(json, depth = 2, prefix = '') {
  if (json == null) return `${prefix || 'value'}: null`;
  if (Array.isArray(json)) {
    const first = json.find((x) => x && typeof x === 'object');
    const inner = first ? ` of { ${Object.keys(first).join(', ')} }` : '';
    return `${prefix || 'array'}[${json.length}]${inner}`;
  }
  if (typeof json === 'object') {
    const lines = [];
    for (const [k, v] of Object.entries(json)) {
      const here = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && depth > 0) lines.push(summarizeKeys(v, depth - 1, here));
      else lines.push(`${here}: ${Array.isArray(v) ? `array[${v.length}]` : typeof v}`);
    }
    return lines.join('\n');
  }
  return `${prefix || 'value'}: ${typeof json}`;
}

// Whether every endpoint/field path a dataset needs is filled in (no TODO).
// A root-array list uses itemsPath "" (valid, not missing). A list-only dataset
// (record.mode "none") needs no record endpoint — the list row IS the record.
export const pathsReady = (dataset) => {
  const noTodo = (s) => s != null && !/TODO/i.test(String(s));
  const listReady =
    noTodo(dataset.list?.path) &&
    dataset.list?.itemsPath != null && noTodo(dataset.list?.itemsPath) && // "" allowed (root)
    noTodo(dataset.list?.idPath) && !/^\s*$/.test(String(dataset.list?.idPath || ''));
  const fieldsReady = Object.values(dataset.record?.fields || {}).every(noTodo);
  // 'none' = list row is the record; 'page' = the record's own page (DOM layout)
  // supplies the fields — neither needs a record API endpoint or field map.
  const mode = dataset.record?.mode;
  if (mode === 'none' || mode === 'page' || mode === 'html') return Boolean(listReady);
  const recordReady = noTodo(dataset.record?.path) && !/^\s*$/.test(String(dataset.record?.path || ''));
  return Boolean(listReady && fieldsReady && recordReady && Object.keys(dataset.record?.fields || {}).length);
};

// ------------------------------------------------------------- mapping

// A time as ms: Unix seconds or ms (number or numeric text), else a date string.
const epochMs = (v) => {
  const n = Number(v);
  if (v === '' || v == null) return NaN;
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(v);
};

// A field path's value; "path|date" turns a Unix time into local "YYYY-MM-DD HH:MM:SS".
function readField(json, path) {
  const [at, format] = String(path).split('|');
  const value = readPath(json, at);
  if (format !== 'date') return value;
  const ms = epochMs(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('sv-SE') : value;
}

// A JSON record -> { fields: {key:value}, collections: {name:[entry]} } using
// the dataset's field/collection paths. Empty values are left out so the CSV
// column order (STANDARD_KEYS) stays clean and assessExtraction sees the truth.
function mapRecord(json, recordSpec) {
  const fields = {};
  for (const [key, path] of Object.entries(recordSpec.fields || {})) {
    const value = scalar(readField(json, path));
    if (value !== '') fields[key] = value;
  }
  const collections = {};
  for (const [name, spec] of Object.entries(recordSpec.collections || {})) {
    const entries = readList(json, spec.path).map((item) => {
      const entry = {};
      for (const [key, path] of Object.entries(spec.fields || {})) {
        const value = scalar(readField(item, path));
        if (value !== '') entry[key] = value;
      }
      return entry;
    });
    if (entries.length) collections[name] = entries;
  }
  return { fields, collections };
}

// A mapped record is trusted when it has every `required` field and at least
// one `identity` field (mirrors assessExtraction's intent for the DOM path, so
// the API and the page go through the same bar). Returns the missing keys.
function missingKeys(fields, recordSpec) {
  const missing = (recordSpec.required || []).filter((k) => !fields[k]);
  const identity = recordSpec.identity || [];
  if (identity.length && !identity.some((k) => fields[k])) missing.push(identity.join(' or '));
  return missing;
}

// ------------------------------------------------------------- paging

// The request headers for a store: "{{companyId}}" etc. filled from its params
// (dealr.cloud picks the store per request with x-dealer-id). A header left
// empty (no store yet) is not sent, so the session's own store answers.
const headersFor = (api, params = {}) =>
  Object.fromEntries(Object.entries(api.headers || {}).map(([k, v]) => [k, String(fillBody(v, params) ?? '')]).filter(([, v]) => v !== ''));

// Reads one page of the list endpoint and returns { ids, items, total, next }.
// ids: each record's id (idPath); items: the raw list items (so list-level
// fields can seed the record, like the DOM path does); total/next: paging.
// params: runtime session values (company/user/dept/dates) for a POST body.
async function readListPage(where, origin, api, dataset, vars, params = {}) {
  const { list } = dataset;
  const url = apiUrl(origin, api.baseUrl, fillPath(list.path, vars));
  const method = (list.method || 'GET').toUpperCase();
  // POST lists carry their filters in a JSON body template; GET lists in the path.
  const body = method === 'POST' && list.body ? fillBody(list.body, { ...params, ...vars }) : null;
  const res = await apiGet(where, url, { method, headers: headersFor(api, params), body });
  const meta = { url, status: res.status, contentType: res.contentType, rawSample: res.rawSample, sentBody: body };
  if (!res.ok) return { ...meta, error: res.error || `HTTP ${res.status}` };
  const items = readList(res.json, list.itemsPath);
  const ids = items.map((it) => scalar(readPath(it, list.idPath))).filter(Boolean);
  const total = list.totalPath ? Number(readPath(res.json, list.totalPath)) || 0 : 0;
  const next = list.nextPath ? scalar(readPath(res.json, list.nextPath)) : '';
  return { ...meta, ids, items, total, next, shape: summarizeKeys(res.json) };
}

// A list that stops at list.maxRows rows without saying so (VinSolutions'
// customer search stops at 500): a full answer is read again as two half
// windows of dates, down to a day, so no row is lost. The halves meet on a
// day both include, so rows are merged by id. Needs a body whose dates come
// from {{startDate}}/{{endDate}}; an endDate of null means "up to now".
async function readCappedList(where, origin, api, dataset, vars, params, onNote) {
  const res = await readListPage(where, origin, api, dataset, vars, params);
  const cap = Number(dataset.list.maxRows) || 0;
  if (res.error || !cap || res.ids.length < cap) return res;
  const from = new Date(params.startDate);
  const to = params.endDate ? new Date(params.endDate) : new Date();
  const mid = new Date(from.getTime() + (to - from) / 2);
  mid.setHours(0, 0, 0, 0);
  if (!(mid > from && to - from > 86_400_000)) {
    onNote(`  the list gave its ${cap}-row maximum for a single day (${params.startDate}): rows past ${cap} can't be read`);
    return res;
  }
  onNote(`  the list gave its ${cap}-row maximum: reading ${params.startDate} … ${params.endDate ?? 'now'} again in two halves`);
  const halves = [
    await readCappedList(where, origin, api, dataset, vars, { ...params, endDate: dayStamp(mid) }, onNote),
    await readCappedList(where, origin, api, dataset, vars, { ...params, startDate: dayStamp(mid) }, onNote),
  ];
  const failed = halves.find((h) => h.error);
  if (failed) return failed;
  const byId = new Map();
  for (const h of halves) h.ids.forEach((id, i) => byId.has(id) || byId.set(id, h.items[i]));
  return { ...halves[1], ids: [...byId.keys()], items: [...byId.values()], total: byId.size };
}

// --------------------------------------------------------------- the walk

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES = 200;
const MAX_RECORDS = 5000;

// Captures one dataset of a CRM through its API. Calls hooks as it goes so the
// background can log every value and save in batches, exactly like the DOM run:
//   onNote(line)                   a timestamped log line
//   onData(record)                 { fields, collections } just mapped (to log)
//   onRecord({ record, id, url })  a good record, shaped for save()
//   onFallback({ id, url, missing, error })  a record the API couldn't give;
//                                   returns a save-shaped record to use instead,
//                                   or null/undefined to count it failed
//   isCancelled()                  stop as soon as the user cancels
// Returns { found, captured, failed, fallbacks, pages }.
export async function captureDatasetViaApi({ tabId, frameId = null, origin, api, dataset, params: externalParams = null, hooks = {} }) {
  // The page the requests run in: the tab, or the CRM's frame inside it.
  const where = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  const { onNote = () => {}, onData = () => {}, onRecord = async () => {}, onFallback = async () => null, onPageCapture = async () => null, onProgress = () => {}, isCancelled = () => false } = hooks;
  // failedStores: the stores whose list could not be read at all, so the
  // caller can read them another way (their screens' grids).
  const stats = { found: 0, captured: 0, failed: 0, fallbacks: 0, pages: 0, failedStores: [] };
  const list = dataset.list;
  const record = dataset.record;
  const pageSize = Number(list.pageSize) || DEFAULT_PAGE_SIZE;
  const byPage = list.paging === 'page';
  const seen = new Set();

  // POST lists need the session's company/user/dept/date params in the body.
  // Prefer params resolved by the caller (background, via chrome.cookies, which
  // can read HttpOnly cookies); fall back to reading the page's own cookies.
  let params = externalParams || {};
  if ((list.method || 'GET').toUpperCase() === 'POST' && list.body) {
    if (!externalParams) params = (await resolveParams(where, api.windowDays)) || {};
  }

  // The page a record is shown on: record.pageUrl ({id} and the list row's own
  // fields, e.g. {autoLeadId}), else CDK eLead's OpptyDetails page.
  const pageUrlOf = (id, item = {}) => (record.pageUrl
    ? apiUrl(origin, api.baseUrl, fillPath(record.pageUrl, { ...params, ...item, id }))
    : `${origin}/evo2/fresh/elead-v45/elead_track/newprospects/OpptyDetails.aspx?lPID=${id}`);

  // The stores to capture. api.stores (an array of { companyId, childCompanyId,
  // name, employeeId?, departmentIds? }) means capture each in turn, tagging
  // rows per store. With no api.stores, capture the one store from the session.
  const stores = (api.stores && api.stores.length)
    ? api.stores
    : [{ companyId: params.companyId, childCompanyId: params.childCompanyId, name: '', employeeId: params.employeeId, departmentIds: params.departmentIds }];

  for (const store of stores) {
    if (isCancelled()) break;
    // Per-store body params: the store's own ids override the session defaults;
    // employeeId/departmentIds fall back to the signed-in user's when a store
    // doesn't specify them (works when one user has access across stores).
    const storeParams = {
      ...params,
      companyId: store.companyId ?? params.companyId,
      childCompanyId: store.childCompanyId ?? store.companyId ?? params.childCompanyId,
      employeeId: store.employeeId ?? params.employeeId,
      selectedUserDeptId: store.employeeId ?? params.selectedUserDeptId ?? params.employeeId,
      departmentIds: store.departmentIds ?? params.departmentIds,
    };
    // list.openEnded: the window runs up to now (an end date of midnight today would drop today's rows).
    if (list.openEnded) storeParams.endDate = null;
    const storeTag = store.name || (store.companyId != null ? String(store.companyId) : '');
    // The record detail endpoint resolves within the session's CURRENT company
    // only (cross-store detail returns 500). So fetch detail only for the store
    // that matches the signed-in session; other stores capture list fields only.
    // Headers that name the store (x-dealer-id) make the detail per store too.
    const storeInHeaders = /\{\{companyId\}\}/.test(JSON.stringify(api.headers || {}));
    const detailAllowed = record.mode === 'none' || storeInHeaders || (params.companyId != null && String(store.companyId) === String(params.companyId));
    if (list.body) {
      onNote(`Store "${storeTag || '(session)'}": companyId=${storeParams.companyId ?? '?'}, childCompanyId=${storeParams.childCompanyId ?? '?'}, employeeId=${storeParams.employeeId ?? '?'}, departmentIds=[${(storeParams.departmentIds || []).join(',')}]${record.mode && record.mode !== 'none' ? (detailAllowed ? ' — full detail' : ' — list fields only (not the session store)') : ''}`);
      const usesSessionIds = /\{\{(employeeId|departmentIds|selectedUserDeptId)\}\}/.test(JSON.stringify(list.body));
      if (!usesSessionIds) {
        // the body needs only the store's own ids
      } else if (storeParams.companyId == null || storeParams.employeeId == null) {
        onNote('  warning: companyId/employeeId missing — this store will likely 500. Open the CRM and sign in on crm.connectcdk.com.');
      } else if (!(storeParams.departmentIds || []).length) {
        onNote('  warning: departmentIds is empty — GetProspectList returns 401 "Unauthorized Attempt" without it. Open the Prospects screen in the CRM once (it sets the UserInformation cookie), then run again.');
      }
    }
    const listed = await walkStore(storeParams, storeTag, detailAllowed);
    if (listed === false) stats.failedStores.push({ ...store, name: storeTag });
    if (stats.found >= MAX_RECORDS) break;
  }
  return stats;

  // Walks one store's list, paging, and emits each record tagged with the store.
  async function walkStore(storeParams, store, detailAllowed = true) {
    const seen = new Set(); // per store: the same person may appear in several
    let page = 1;
    let offset = 0;
    for (let i = 0; i < MAX_PAGES && !isCancelled(); i++) {
    const vars = byPage ? { page, limit: pageSize } : { offset, limit: pageSize };
    const res = await readCappedList(where, origin, api, dataset, vars, storeParams, onNote);
    if (res.error) {
      onNote(`List request FAILED [HTTP ${res.status}${res.contentType ? `, ${res.contentType}` : ''}] (${res.error}) — ${res.url}`);
      if (res.rawSample) onNote(`  response sample: ${String(res.rawSample).replace(/\s+/g, ' ').slice(0, 300)}`);
      if (i === 0) return false; // nothing of this store's list could be read
      break;
    }
    stats.pages++;
    if (i === 0) { stats.expected += res.total || res.ids.length; onProgress(stats.found, stats.expected); }
    onNote(`${store ? `[${store}] ` : ''}List page ${i + 1} (${byPage ? `page ${page}` : `offset ${offset}`}) [HTTP ${res.status}]: ${res.ids.length} ids${res.total ? ` of ${res.total} total` : ''} — ${res.url}`);
    if (i === 0 && res.shape) onNote(`  list response shape:\n${String(res.shape).split('\n').map((l) => `    ${l}`).join('\n')}`);
    // list.since: a newest-first list with no date filter; rows created before
    // the window are dropped and the paging stops at the first of them.
    let pastWindow = false;
    if (list.since && storeParams.startDate) {
      const start = new Date(storeParams.startDate).getTime();
      const keep = res.items.map((it) => !(epochMs(readPath(it, list.since)) < start));
      pastWindow = keep.includes(false);
      res.ids = res.ids.filter((_, k) => keep[k]);
      res.items = res.items.filter((_, k) => keep[k]);
      if (pastWindow) onNote(`  ${res.ids.length} of this page are since ${storeParams.startDate}; older ones are not read`);
    }
    if (!res.ids.length) break;

    // Pair each id with its list item, so list-shown fields can seed the record.
    const idToItem = new Map(res.ids.map((id, idx) => [id, res.items[idx] || {}]));
    const newIds = res.ids.filter((id) => !seen.has(id)).length;
    let loggedRecordShape = false;
    let loggedFeed = false;
    for (const id of res.ids) {
      if (isCancelled()) break;
      if (seen.has(id)) continue;
      seen.add(id);
      stats.found++;
      onProgress(stats.found, stats.expected);

      // List-only: the list row already carries the record's fields; no fetch.
      if (record.mode === 'none') {
        const mapped = mapRecord(idToItem.get(id) || {}, { fields: record.fields, collections: record.collections });
        const missing = missingKeys(mapped.fields, record);
        if (missing.length) { stats.failed++; onNote(`Row ${id} skipped: missing ${missing.join(', ')}`); continue; }
        const built = { fields: mapped.fields, collections: mapped.collections, pageUrl: pageUrlOf(id, idToItem.get(id)), recordId: id, dataset: dataset.dataset, store };
        stats.captured++;
        onData({ fields: mapped.fields, collections: mapped.collections });
        await onRecord({ record: built, id, url: built.pageUrl });
        if (stats.found >= MAX_RECORDS) { onNote(`Reached ${MAX_RECORDS} records; stopping.`); return; }
        continue;
      }

      // Page mode: the full record comes from the record's own page (the DOM
      // layout reads customer + opportunity + vehicle/trade + activities). The
      // API list only supplies the ids (fast, multi-store) and seed fields.
      if (record.mode === 'page') {
        const item = idToItem.get(id) || {};
        const seed = mapRecord(item, { fields: dataset.listFields || {} }).fields;
        let captured = null;
        try {
          captured = await onPageCapture({ id, item, seedFields: seed, store });
        } catch (e) {
          onNote(`Record ${id}: page capture error (${e.message})`);
        }
        if (!captured) {
          // Page unreadable: keep the list seed so the row isn't lost.
          const missing = missingKeys(seed, record);
          if (missing.length) { stats.failed++; onNote(`Record ${id} skipped: page unreadable and seed missing ${missing.join(', ')}`); continue; }
          const built = { fields: seed, collections: {}, pageUrl: '', recordId: id, dataset: dataset.dataset, store };
          stats.captured++; stats.partial = (stats.partial || 0) + 1;
          onData({ fields: seed, collections: {} });
          await onRecord({ record: built, id, url: built.pageUrl });
          continue;
        }
        const fields = { ...seed, ...captured.fields };
        const collections = captured.collections || {};
        const built = { fields, collections, pageUrl: captured.pageUrl || '', recordId: id, dataset: dataset.dataset, store };
        stats.captured++;
        onData({ fields, collections });
        await onRecord({ record: built, id, url: built.pageUrl });
        if (stats.found >= MAX_RECORDS) { onNote(`Reached ${MAX_RECORDS} records; stopping.`); return; }
        continue;
      }

      // HTML mode: the record's detail is a same-origin server-rendered page
      // (e.g. VinSolutions SaleLeadView.aspx) fetched and parsed in the page
      // world — fast, no tab, parallelisable. record.html = { path, fields,
      // collections }. List rows seed the core fields; the page adds the rest.
      if (record.mode === 'html') {
        const item = idToItem.get(id) || {};
        const seed = mapRecord(item, { fields: dataset.listFields || {} }).fields;
        const url = apiUrl(origin, api.baseUrl, fillPath(record.html.path, { ...params, ...item, id }));
        const got = await apiExtractHtml(where, url, record.html);
        if (!loggedRecordShape) { loggedRecordShape = true; onNote(`  record ${id} page [HTTP ${got.status}]: ${got.ok ? `${Object.keys(got.fields || {}).length} fields, ${Object.keys(got.collections || {}).length} lists` : got.error} — ${url}`); }
        if (!got.ok) {
          const missing = missingKeys(seed, record);
          if (missing.length) { stats.failed++; onNote(`Record ${id} skipped: page ${got.status || ''} (${got.error}) and seed missing ${missing.join(', ')}`); continue; }
          const built = { fields: seed, collections: {}, pageUrl: url, recordId: id, dataset: dataset.dataset, store };
          stats.captured++; stats.partial = (stats.partial || 0) + 1;
          onData({ fields: seed, collections: {} }); await onRecord({ record: built, id, url });
          continue;
        }
        let fields = { ...seed, ...got.fields };
        const collections = { ...(got.collections || {}) };
        // Extra server-rendered pages merged in — e.g. VinSolutions'
        // CustomerDashboard.aspx for the freeform note + tasks block (a page
        // apart from the lead panel). Each: { path, fields, collections } read
        // the same way (extractHtmlInPage). A page that fails loses only itself.
        for (const ep of record.html.extraPages || []) {
          const epUrl = apiUrl(origin, api.baseUrl, fillPath(ep.path, { ...storeParams, ...item, id }));
          const epGot = await apiExtractHtml(where, epUrl, ep);
          if (epGot.ok) {
            fields = { ...fields, ...epGot.fields };
            for (const [n, e] of Object.entries(epGot.collections || {})) if (e.length) collections[n] = e;
          } else if (!loggedRecordShape) {
            onNote(`  record ${id} extra page ${epGot.status ? `HTTP ${epGot.status}` : ''} (${epGot.error || 'failed'}) — ${epUrl}`);
          }
        }
        // Per-record JSON feeds (same-origin, session cookies) merged as named
        // collections — e.g. VinSolutions' Notes & History .asmx. Each: { name,
        // path (templated with the id/list row), itemsPath, fields:{key:jsonPath} }.
        for (const ac of record.html.apiCollections || []) {
          const acUrl = apiUrl(origin, api.baseUrl, fillPath(ac.path, { ...storeParams, ...item, id }));
          const acRes = await apiGet(where, acUrl, { method: ac.method, headers: headersFor(api, storeParams) });
          if (acRes.ok && acRes.json != null) {
            const entries = readList(acRes.json, ac.itemsPath).map((it) => {
              const entry = {};
              for (const [k, p] of Object.entries(ac.fields || {})) { const v = scalar(readField(it, p)); if (v !== '') entry[k] = v; }
              return entry;
            }).filter((e) => Object.keys(e).length);
            if (entries.length) collections[ac.name] = entries;
            if (!loggedFeed) { loggedFeed = true; onNote(`  record ${id} ${ac.name} feed [HTTP ${acRes.status}]: ${entries.length} entries — ${acUrl}`); }
          } else if (!loggedFeed) {
            loggedFeed = true;
            onNote(`  record ${id} ${ac.name} feed ${acRes.status ? `HTTP ${acRes.status}` : ''} (${acRes.error || 'failed'}) — ${acUrl}`);
          }
        }
        const built = { fields, collections, pageUrl: url, recordId: id, dataset: dataset.dataset, store };
        stats.captured++;
        onData({ fields, collections }); await onRecord({ record: built, id, url });
        if (stats.found >= MAX_RECORDS) { onNote(`Reached ${MAX_RECORDS} records; stopping.`); return; }
        continue;
      }

      // Not the session's store: detail would 500 cross-store, so list-only.
      if (!detailAllowed) {
        const seed = mapRecord(idToItem.get(id) || {}, { fields: dataset.listFields || {} }).fields;
        const missing = missingKeys(seed, record);
        if (missing.length) { stats.failed++; onNote(`Row ${id} skipped: missing ${missing.join(', ')}`); continue; }
        const built = { fields: seed, collections: {}, pageUrl: pageUrlOf(id, idToItem.get(id)), recordId: id, dataset: dataset.dataset, store };
        stats.captured++; stats.partial = (stats.partial || 0) + 1;
        onData({ fields: seed, collections: {} });
        await onRecord({ record: built, id, url: built.pageUrl });
        if (stats.found >= MAX_RECORDS) { onNote(`Reached ${MAX_RECORDS} records; stopping.`); return; }
        continue;
      }

      // The session store: fetch the detail endpoint(s) and merge. record is the
      // primary; record.extraDetails[] are additional JSON calls (e.g. the AI
      // summary) each mapped and merged. A failing extra never loses the rest.
      const seed = mapRecord(idToItem.get(id) || {}, { fields: dataset.listFields || {} }).fields;
      const details = [record, ...(record.extraDetails || [])];
      const recUrl = apiUrl(origin, api.baseUrl, fillPath(record.path, { id }));
      let fields = { ...seed };
      let collections = {};
      let anyDetailOk = false;
      for (const det of details) {
        const dUrl = apiUrl(origin, api.baseUrl, fillPath(det.path, { id }));
        const got = await apiGet(where, dUrl, { method: det.method, headers: headersFor(api, storeParams) });
        if (!loggedRecordShape && got.json != null) {
          loggedRecordShape = true;
          onNote(`  record ${id} response shape [HTTP ${got.status}]:\n${summarizeKeys(got.json).split('\n').map((l) => `    ${l}`).join('\n')}`);
        }
        if (got.ok && got.json != null) {
          const mapped = mapRecord(got.json, det);
          fields = { ...fields, ...mapped.fields };
          collections = { ...collections, ...mapped.collections };
          anyDetailOk = true;
        } else {
          onNote(`Record ${id}: ${det.label || 'detail'} ${got.status ? `HTTP ${got.status}` : ''} (${got.error || 'failed'}) — skipped`);
        }
      }
      const missing = missingKeys(fields, record);
      if (missing.length) {
        const fb = await onFallback({ id, url: recUrl, missing, seedFields: fields });
        if (fb) { stats.fallbacks++; stats.captured++; await onRecord({ record: { ...fb, store }, id, url: recUrl }); onNote(`Record ${id}: API missing ${missing.join(', ')} — read from the page instead`); }
        else { stats.failed++; onNote(`Record ${id} skipped: missing ${missing.join(', ')}`); }
        continue;
      }
      const built = { fields, collections, pageUrl: record.pageUrl ? pageUrlOf(id, idToItem.get(id)) : recUrl, recordId: id, dataset: dataset.dataset, store };
      stats.captured++;
      if (!anyDetailOk) stats.partial = (stats.partial || 0) + 1;
      onData({ fields, collections });
      await onRecord({ record: built, id, url: built.pageUrl || recUrl });
      if (stats.found >= MAX_RECORDS) { onNote(`Reached ${MAX_RECORDS} records; stopping.`); return; }
      continue;
    }

    // Next page: offset/page math, or a next cursor the list gave, else stop.
    // A list that isn't paged (paging "none") answers everything at once, and
    // a page that brings no id not already seen means the list ignores paging:
    // asking again would only return the same rows.
    if (list.paging === 'none' || !newIds || pastWindow) break;
    if (res.total && (byPage ? page * pageSize : offset + pageSize) >= res.total) break;
    if (!res.total && res.ids.length < pageSize && !res.next) break;
    page += 1;
    offset += pageSize;
    }
  }
}

// The datasets a CRM's api block declares, each resolved against the config.
// A dataset is usable if it has a list endpoint and either a record endpoint
// or record.mode "none" (list-only: the list row is the record).
export const apiDatasets = (api) => (api?.datasets ?? []).filter((d) => d.list?.path && (d.record?.path || ['none', 'page', 'html'].includes(d.record?.mode)));

// Whether a CRM config has a usable api block.
export const hasApi = (crm) => apiDatasets(crm?.api).length > 0;
