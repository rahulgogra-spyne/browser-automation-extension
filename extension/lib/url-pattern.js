// Turns concrete CRM URLs into regexes that match every record of the same
// kind. Ids in the path, query or hash route become wildcards; the first one
// is captured so extraction can record which CRM record a row came from.
//
//   /vinconnect/customer?GlobalCustomerID=1001
//     -> ^/vinconnect/customer\?GlobalCustomerID=([^/?&#]+)(?=$|[?&#])
//   /elead/app.html#/customer/1001/profile  (+ /communications, /notes)
//     -> ^/elead/app\.html#/customer/([^/?&#]+)/
//
// Patterns are matched against pathname + search + hash (see urlKey).
const ID = /^(?:\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{12,})$/i;
// Short numbers count as ids only behind a parameter that names one
// (user/card.php?id=5, ?record=12, ?socid=7): small CRMs have few records.
const ID_KEY = /^(?!(?:paid|valid|grid|hid|bid|mid|void|solid|rapid|lid|kid|aid|did)$)(?:[a-z0-9_-]*id|record|rowid|uid)$/i;
const isNumericIdParam = (key, value) => ID_KEY.test(key) && /^\d+$/.test(value);
const WILD = '[^/?&#]+';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isId = (s) => {
  try {
    return ID.test(decodeURIComponent(s));
  } catch {
    return false;
  }
};

export const urlKey = (url) => {
  const u = new URL(url);
  return u.pathname + u.search + u.hash;
};

function tokens(url) {
  const u = new URL(url);
  const out = [];
  const pushPath = (path) =>
    path.split('/').forEach((seg, i) => {
      if (i) out.push({ lit: '/' });
      if (seg) out.push(isId(seg) ? { id: true } : { lit: seg });
    });
  pushPath(u.pathname);
  if (u.search) {
    out.push({ lit: '?' });
    u.search
      .slice(1)
      .split('&')
      .forEach((pair, i) => {
        if (i) out.push({ lit: '&' });
        const eq = pair.indexOf('=');
        if (eq < 0) return out.push({ lit: pair });
        out.push({ lit: pair.slice(0, eq + 1) });
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (value) out.push(isId(value) || isNumericIdParam(key, value) ? { id: true } : { lit: value });
      });
  }
  if (u.hash) {
    out.push({ lit: '#' });
    // Hash routes: "#/customer/1001/profile" and "#Contact/view/66d8…" alike.
    const [route, query] = u.hash.slice(1).split('?');
    if (route.includes('/')) pushPath(route);
    else out.push({ lit: route });
    if (query) {
      out.push({ lit: '?' });
      out.push({ lit: query });
    }
  }
  return out;
}

function render(list, complete) {
  let captured = false;
  const body = list
    .map((t) => {
      if (!t.id) return escapeRe(t.lit);
      if (captured) return WILD;
      captured = true;
      return `(${WILD})`;
    })
    .join('');
  return `^${body}${complete ? '(?=$|[?&#])' : ''}`;
}

export function urlPattern(url) {
  return render(tokens(url), true);
}

// One pattern covering several URLs of the same record, e.g. the tab routes
// of a single-page app: their shared beginning.
export function commonUrlPattern(urls) {
  const lists = urls.map(tokens);
  const common = [];
  for (let i = 0; i < lists[0].length; i++) {
    const t = lists[0][i];
    if (!lists.every((l) => l[i] && Boolean(l[i].id) === Boolean(t.id) && l[i].lit === t.lit)) break;
    common.push(t);
  }
  return render(common, lists.every((l) => l.length === common.length));
}

export function matchUrl(regex, url) {
  const m = new RegExp(regex).exec(urlKey(url));
  return m ? { recordId: m[1] ?? '' } : null;
}

// Query parameters that only page, sort or filter a list.
const TRANSIENT_NAMES = 'page|p|offset|start|limit|per_?page|page_?size|sort|order|order_?by|dir|q|query|search|filter|view|tab|_|ts|t|list_offset|list_limit';
const TRANSIENT_PARAM = new RegExp(`^(${TRANSIENT_NAMES})$`, 'i');
// Fails when the query has any parameter other than paging/sorting ones.
const ONLY_TRANSIENT = `(?![^#]*[?&](?!(?:${TRANSIENT_NAMES})=)[^=&#]+=)`;

// A pattern for a list page: same path (ids wildcarded), and the query
// parameters that name the list (module=Contacts, action=index) present in
// any order, while paging and sorting parameters may come and go:
//   /app/?module=Contacts&action=index&list_offset=21&list_limit=20
//     -> ^/app/(?=[?#])(?=[^#]*[?&]module=Contacts(?:&|#|$))(?=[^#]*[?&]action=index(?:&|#|$))
// A page that no parameter names (/app/, /users?page=2) matches itself with
// paging and sorting parameters only, never /app/?module=Contacts.
export function looseUrlPattern(url) {
  const u = new URL(url);
  const path = u.pathname
    .split('/')
    .map((seg) => (isId(seg) ? WILD : escapeRe(seg)))
    .join('/');
  const params = [...u.searchParams.entries()].filter(([key, value]) => !TRANSIENT_PARAM.test(key) && !isId(value) && !/^\d+$/.test(value));
  const hashRoute = u.hash.length > 1 ? u.hash.split('?')[0].split('/').map((seg) => (isId(seg) ? WILD : escapeRe(seg))).join('/') : '';
  if (!params.length && !hashRoute) return `^${path}(?=$|[?#])${ONLY_TRANSIENT}`;
  const lookaheads = params.map(([key, value]) => `(?=[^#]*[?&]${escapeRe(key)}=${escapeRe(value)}(?:&|#|$))`).join('');
  const hash = hashRoute ? `(?=[^#]*${hashRoute}(?=$|[?]))` : '';
  return `^${path}(?=[?#])${lookaheads}${hash}`;
}
