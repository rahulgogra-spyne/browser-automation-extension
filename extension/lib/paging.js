// Walking a list page by page. Most CRMs page with URL parameters, so the
// next page's URL can be computed: list_offset=21&list_limit=20 -> 41,
// page=2 -> 3, start=40&count=20 -> 60. When the URL carries no paging
// parameter the pager's "Next" link (found in the page) is used instead.
const OFFSET_PARAMS = ['list_offset', 'offset', 'start', 'skip', 'from', 'startIndex', 'first'];
const LIMIT_PARAMS = ['list_limit', 'limit', 'count', 'per_page', 'perPage', 'page_size', 'pageSize', 'rows', 'max', 'num'];
const PAGE_PARAMS = ['page', 'p', 'pageNumber', 'page_number', 'pg'];

const readParams = (url) => {
  const u = new URL(url);
  // Hash routes ("#/customers?page=2") keep their query in the hash.
  const hashQuery = u.hash.includes('?') ? new URLSearchParams(u.hash.slice(u.hash.indexOf('?') + 1)) : null;
  return { u, params: hashQuery ?? u.searchParams, inHash: Boolean(hashQuery) };
};

const withParams = ({ u, params, inHash }) => {
  if (inHash) u.hash = `${u.hash.slice(0, u.hash.indexOf('?'))}?${params}`;
  return u.href;
};

// The next page's URL from the current one, or null when the URL isn't paged.
export function nextPageUrl(url, { pageSizeHint = 0 } = {}) {
  const state = readParams(url);
  const { params } = state;
  const find = (names) => names.find((n) => params.has(n) && /^\d+$/.test(params.get(n)));
  const offsetKey = find(OFFSET_PARAMS);
  if (offsetKey) {
    const limitKey = find(LIMIT_PARAMS);
    const step = limitKey ? Number(params.get(limitKey)) : pageSizeHint;
    if (!step) return null;
    params.set(offsetKey, String(Number(params.get(offsetKey)) + step));
    return withParams(state);
  }
  const pageKey = find(PAGE_PARAMS);
  if (pageKey) {
    params.set(pageKey, String(Number(params.get(pageKey)) + 1));
    return withParams(state);
  }
  return null;
}

// Whether a URL is paged at all (so the first page can be walked forward).
export const isPagedUrl = (url) => nextPageUrl(url, { pageSizeHint: 1 }) !== null;
