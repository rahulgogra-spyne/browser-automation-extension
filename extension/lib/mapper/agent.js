// The mapping agent, shared by the extension (which drives tabs in the
// user's signed-in browser) and the backend (which drives Playwright for
// CRMs with configured credentials). Everything browser-specific goes
// through an adapter:
//   adapter.open(url) -> page              open a page (signed in) at url
//   adapter.goto(page, url)                navigate and wait until rendered
//   adapter.url(page), adapter.title(page)
//   adapter.frames(page) -> [{ id, url, main }]   frames worth reading
//   adapter.evaluate(page, frameId, fn, arg)      run fn(arg) in that frame
//   adapter.settle(page)                   wait for the page to stop changing
//   adapter.close(page)
// The in-page runtime (content/crm-runtime.js) is present in every frame.
//
// For one CRM the agent:
//   1. explores it: a prioritised crawl that dives into the rows of every
//      list it meets (a couple of records per list are enough)
//   2. asks the LLM what each kind of page shows: one person, a list, other
//   3. on a person's record: snapshots the view, asks the LLM where each
//      value and message list sits and which tabs/expanders reveal more,
//      then opens every one of those and does the same
//   4. follows the links of message lists (an email's body lives on its own
//      page) and maps that page too
//   5. on a list of people: learns the row element and the link to each record
//   6. turns the LLM's element picks into CSS/label rules, keeping only rules
//      that read back the value the LLM saw, and replays every page type on a
//      second example to validate it
//   7. saves it all to the CRM structure config (old rules stay if this fails)
// A CRM with no links at all (one address, click-driven menus and grids,
// often inside a frame from another host) is explored by clicking instead:
// see "CRMs that navigate by clicks" below.
import { urlPattern, commonUrlPattern, looseUrlPattern, matchUrl, urlKey } from '../url-pattern.js';
import { DATASETS, DATASET_IDS, datasetById, datasetOfPageType } from './datasets.js';

export const MESSAGE_ENTITIES = new Set(['email', 'message', 'sms', 'text', 'call', 'note', 'chat', 'activity', 'task', 'meeting']);

// Pages that are one entry of somebody's history, never a kind of their own.
const MESSAGE_ENTITIES_ONLY = new Set(['email', 'message', 'sms', 'text', 'call', 'note', 'chat']);
const MAX_RECORD_TYPES_PER_KIND = 2;
const MESSAGE_KEYS = ['body', 'subject'];
// Long texts: read the whole container, not just the paragraph the LLM picked.
const WIDE_KEYS = new Set(['body', 'notes', 'message', 'text', 'description', 'comments']);
const MAX_MESSAGE_TYPES = 2;

// Links the explorer never follows: anything that changes or exports data.
export const UNSAFE_LINK =
  /log-?out|sign-?out|delete|remove|destroy|unsubscribe|\b(edit|create|new|add|import|export|print|merge|convert|duplicate|mass|clear|reset|save|send|change[-_]?password)(view|record|item)?\b|\.(pdf|csv|xlsx?|zip|docx?)(\?|$)/i;
// Paging/sorting variants of a page we have already seen.
const TRANSIENT = /[?&#](page|p|offset|start|limit|per_?page|sort|order|order_?by|dir|list_offset|list_limit)=/i;
const ID_IN_URL = /\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{16,}|(?:^|[/=])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{12,}(?:$|[/?&#])|[?&](?:[a-z0-9_-]*id|record|rowid|uid)=\d+(?:$|[&#])/i;
const RECORD_WORD = /detail|record|view|profile|customer|contact|lead|prospect|person|client/i;
// Links that lead to any module's list page ("Return to List", ".../list").
const LIST_URL = /action=index|\/(list|all|index)\b/i;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
// Long texts (message bodies) may come back abbreviated from the LLM.
function sameValue(actual, expected) {
  const a = norm(actual);
  const e = norm(expected);
  if (!a || !e) return false;
  return a === e || (e.length >= 40 && (a.startsWith(e.slice(0, 40)) || e.startsWith(a.slice(0, 40))));
}
const slug = (name, fallback) =>
  norm(name)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || fallback;

export function hostAllowed(host, patterns) {
  return patterns.some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(host));
}

// ------------------------------------------------------------------ explore

// Links of the same URL shape sitting in the same kind of row: the rows of
// a list. Returns [{ shape, count, urls, text }] with 3+ members.
export function rowLinkGroups(links) {
  const groups = new Map();
  for (const link of links) {
    const key = `${urlPattern(link.url)}|${link.ancestry}`;
    const group = groups.get(key) ?? { shape: urlPattern(link.url), count: 0, urls: [], text: link.text };
    group.count++;
    if (!group.urls.includes(link.url)) group.urls.push(link.url);
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.urls.length >= 3).sort((a, b) => b.count - a.count);
}

// Text and navigations of every frame. Links come from the runtime, so
// script-driven rows (onclick, data-href) and new-tab links count too.
async function pageInfo(adapter, page) {
  const frames = await Promise.all(
    (await adapter.frames(page)).map((frame) =>
      adapter
        .evaluate(page, frame.id, () => {
          const rt = window.__crmRuntime;
          if (rt) rt.snapshot();
          return {
            text: (rt?.pageText ? rt.pageText() : document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
            links: rt ? rt.pageLinks() : [],
          };
        })
        .catch(() => null),
    ),
  );
  const found = frames.filter(Boolean);
  return { title: await adapter.title(page), text: found.map((f) => f.text).join(' | '), links: found.flatMap((f) => f.links) };
}

const sameShape = (a, b) => urlPattern(a) === urlPattern(b);

// Explores the CRM: a prioritised crawl inside its hosts that dives into the
// rows of every list it meets and prefers record-looking URLs over menus.
// Returns the pages seen: [{ url, pattern, title, text, rowGroups }].
export async function explore(adapter, page, site, { maxPages = 20, perPattern = 2, maxDepth = 3, log = () => {}, progress = () => {}, datasets = Object.values(DATASETS) } = {}) {
  const hosts = site.match.hosts;
  const listWord = (text) => datasets.some((d) => d.listWords.test(text));
  const frontier = [{ url: site.startUrl, depth: 0, score: 100 }];
  const visited = new Set();
  const perShape = new Map();
  const pages = [];
  const allowed = (url) => {
    try {
      const { host, protocol } = new URL(url);
      return /^https?:$/.test(protocol) && hostAllowed(host, hosts) && !UNSAFE_LINK.test(url);
    } catch {
      return false;
    }
  };

  while (frontier.length && pages.length < maxPages) {
    frontier.sort((a, b) => b.score - a.score || a.depth - b.depth);
    const next = frontier.shift();
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    if ((perShape.get(urlPattern(next.url)) ?? 0) >= perPattern) continue;
    progress({ stage: 'explore', current: pages.length + 1, total: maxPages, detail: next.url });
    try {
      await adapter.goto(page, next.url);
    } catch (error) {
      log(`  skip ${next.url}: ${String(error.message).split('\n')[0]}`);
      continue;
    }
    const finalUrl = await adapter.url(page);
    const finalShape = urlPattern(finalUrl);
    if (finalUrl !== next.url) {
      visited.add(finalUrl);
      if ((perShape.get(finalShape) ?? 0) >= perPattern) continue;
    }
    perShape.set(finalShape, (perShape.get(finalShape) ?? 0) + 1);
    const info = await pageInfo(adapter, page);
    // Paging and sorting variants of the page we are on teach nothing new.
    const variantOfThisPage = (url) => TRANSIENT.test(url) && (sameShape(url, finalUrl) || matchUrl(looseUrlPattern(finalUrl), url));
    const links = info.links.filter((l) => allowed(l.url) && urlKey(l.url) !== urlKey(finalUrl) && !variantOfThisPage(l.url));
    const rowGroups = rowLinkGroups(links);
    pages.push({ url: finalUrl, pattern: finalShape, title: info.title, text: info.text, rowGroups });
    log(`  explored ${finalUrl}${rowGroups.length ? ` (lists: ${rowGroups.map((g) => `${g.urls.length}× ${g.shape}`).join(', ')})` : ''}`);
    if (next.depth >= maxDepth) continue;
    const inRows = new Set(rowGroups.flatMap((g) => g.urls));
    for (const link of links) {
      if (visited.has(link.url)) continue;
      let score = 1;
      if (inRows.has(link.url)) score += 4; // a row of a list: dive in
      if (ID_IN_URL.test(urlKey(link.url))) score += 3; // record-looking URL
      if (RECORD_WORD.test(link.text) || RECORD_WORD.test(urlKey(link.url))) score += 1;
      if (!ID_IN_URL.test(urlKey(link.url)) && (listWord(link.text) || LIST_URL.test(urlKey(link.url)))) score += 3; // a list page of what we look for
      if (TRANSIENT.test(link.url)) score -= 3;
      frontier.push({ url: link.url, depth: next.depth + 1, score });
    }
  }
  return pages;
}

// ------------------------------------------------------------------ mapping

// root: { frameId, selector } shows only that element (a record's panel).
async function snapshotFrames(adapter, page, root = null) {
  const frames = [];
  let nextId = 1;
  for (const [index, frame] of (await adapter.frames(page)).entries()) {
    if (root && frame.id !== root.frameId) continue;
    const snap = await adapter
      .evaluate(page, frame.id, ([startId, rootSel]) => window.__crmRuntime.snapshot({ startId, root: rootSel }), [nextId, root?.selector ?? ''])
      .catch(() => null);
    if (!snap?.count) continue;
    frames.push({ index, frameId: frame.id, main: frame.main, url: snap.url, text: snap.text, firstId: nextId, endId: snap.nextId });
    nextId = snap.nextId;
  }
  return frames;
}
const frameOf = (frames, mid) => frames.find((f) => mid >= f.firstId && mid < f.endId);

// One view (a page as opened, or one tab/expander of it): LLM picks -> checked rules.
// root: { frameId, selector } maps only what is inside that panel.
async function mapView(adapter, page, llm, { label, askSections, mode = 'record', log, progress = () => {}, dataset, root = null }) {
  const within = root?.selector ?? '';
  const frames = await snapshotFrames(adapter, page, root);
  if (!frames.length) return null;
  const forLLM = frames.map((f) => ({ index: f.index, url: f.url, text: f.text }));
  progress({ detail: `Asking the AI where the data sits (${label})`, llmCall: true });
  let answer = await llm.mapView(forLLM, { label, askSections, mode, target: dataset?.id });
  // Models sometimes answer only part of the request (e.g. just the sections).
  if (answer.is_target && !answer.fields.length && !answer.collections.length) {
    log('    nothing mapped in a target view; asking again');
    progress({ detail: `Asking the AI again (${label})`, llmCall: true });
    answer = await llm.mapView(forLLM, { label, askSections, mode, target: dataset?.id, nudge: 'Your previous answer had no fields and no lists. This view shows the data: map it.' });
  }
  progress({ detail: `Building and checking the rules (${label})` });
  const view = { isTarget: answer.is_target, summary: answer.summary, fields: {}, collections: {}, sections: [] };
  const votes = new Map();
  const vote = (frameId) => votes.set(frameId, (votes.get(frameId) ?? 0) + 1);
  const run = (frameId, fn, arg) => adapter.evaluate(page, frameId, fn, arg);

  for (const pick of answer.fields) {
    const f = frameOf(frames, pick.mid);
    if (!f || view.fields[pick.key]) continue;
    const widen = WIDE_KEYS.has(pick.key);
    const describe = (regex, valueSlot = false) =>
      run(f.frameId, ([mid, opts]) => window.__crmRuntime.describeField(mid, opts), [pick.mid, { attr: pick.attr, regex, valueSlot, widen, within }]);
    let found = await describe(pick.regex);
    // An unneeded regex that broke an exact value: retry without it.
    if (found && !sameValue(found.value, pick.value) && pick.regex && sameValue(found.raw, pick.value)) found = await describe('');
    // The LLM pointed at the label instead of the value: use the value next to it.
    if (found && !sameValue(found.value, pick.value)) {
      const beside = await describe(pick.regex, true);
      if (beside && sameValue(beside.value, pick.value)) found = beside;
    }
    // "DOE, JOHN" labelled first_name is an unsplit name, not a first name.
    if (found && /^(first|last)_name$/.test(pick.key) && found.value.includes(',')) {
      log(`    dropped field ${pick.key}: "${found.value}" is not split`);
      continue;
    }
    if (found && sameValue(found.value, pick.value)) {
      // Two keys reading exactly the same thing (city and zip both pointed at
      // the whole address, with no regex to split it): keep the first.
      const twin = Object.entries(view.fields).find(([, rules]) => JSON.stringify(rules) === JSON.stringify(found.rules));
      if (twin) {
        log(`    dropped field ${pick.key}: same rule as ${twin[0]}`);
        continue;
      }
      view.fields[pick.key] = found.rules;
      vote(f.frameId);
    } else {
      log(`    dropped field ${pick.key}: LLM saw "${pick.value}", rule reads "${found?.value ?? '(nothing)'}"`);
    }
  }

  for (const list of answer.collections) {
    const f = frameOf(frames, list.container_mid);
    if (!f) continue;
    const picks = list.item_fields.map(({ key, mid, attr, regex }) => ({ key, mid, attr, regex }));
    const found = await run(f.frameId, ([container, items, fields]) => window.__crmRuntime.describeCollection(container, items, fields), [list.container_mid, list.item_mids, picks]);
    if (!found?.count) {
      log(`    dropped list ${list.name}: no entries found`);
      continue;
    }
    for (const pick of list.item_fields) {
      const reads = found.examples.map((entry) => entry[pick.key]);
      const ok = pick.attr ? reads.some(Boolean) : reads.some((value) => sameValue(value, pick.value));
      if (!ok && found.spec.fields[pick.key]) {
        delete found.spec.fields[pick.key];
        log(`    dropped ${list.name}.${pick.key}: LLM saw "${pick.value}", rules read ${JSON.stringify(reads)}`);
      }
    }
    if (!Object.keys(found.spec.fields).filter((k) => k !== 'link').length) continue;
    const name = slug(list.name, 'entries');
    view.collections[name] = found.spec;
    view.collections[name].sampleLinks = found.examples.map((e) => e.link).filter(Boolean);
    vote(f.frameId);
  }

  for (const section of askSections ? answer.sections : []) {
    const f = frameOf(frames, section.mid);
    if (!f) continue;
    const activate = await run(f.frameId, ([mid, kind, sel]) => window.__crmRuntime.describeActivator(mid, kind, sel), [section.mid, section.kind, within]);
    // Captions often carry counts ("Texting (5)") that differ per record.
    const name = section.name.replace(/\(\s*\d+\s*\)/g, '').trim() || section.name;
    if (activate) view.sections.push({ name, isOpen: section.is_open, activate, frameId: f.frameId });
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  view.frame = frames.find((f) => f.frameId === best) ?? frames.find((f) => f.main) ?? frames[0];
  return view;
}

// First rule's selector of a view's first list or field: shows its content loaded.
function waitSelector(view) {
  const list = Object.values(view.collections)[0];
  if (list) return list.container;
  const rules = Object.values(view.fields)[0];
  return rules?.find((r) => r.css && r.css !== ':scope')?.css ?? null;
}

async function runInPage(adapter, page, pageType) {
  for (const frame of await adapter.frames(page)) {
    const result = await adapter.evaluate(page, frame.id, (pt) => window.__crmRuntime.extractPage(pt), pageType).catch(() => null);
    if (result) return result;
  }
  return null;
}

// Reads a record the way the extension does: the in-place views in the
// record's page, then each link-tab view on the page its tab leads to.
export async function readPageType(adapter, page, pageType, url) {
  await adapter.goto(page, url);
  if (!matchUrl(pageType.urlRegex, await adapter.url(page))) return { fields: {}, collections: {}, views: [], errors: [{ error: 'url_mismatch' }] };
  const linkViews = (pageType.views ?? []).filter((v) => v.activate?.kind === 'link');
  const result = await runInPage(adapter, page, pageType);
  if (!result) return null;
  for (const view of linkViews) {
    let href = null;
    for (const frame of await adapter.frames(page)) {
      href = await adapter.evaluate(page, frame.id, (spec) => window.__crmRuntime.activatorHref(spec), view.activate).catch(() => null);
      if (href) break;
    }
    if (!href) {
      result.errors.push({ view: view.name, error: 'tab_not_found' });
      continue;
    }
    await adapter.goto(page, href);
    const part = await runInPage(adapter, page, { ...pageType, frame: null, views: [{ ...view, activate: null }] });
    if (!part) {
      result.errors.push({ view: view.name, error: 'tab_page_unreadable' });
    } else {
      for (const [key, value] of Object.entries(part.fields)) if (!(key in result.fields)) result.fields[key] = value;
      for (const [name, entries] of Object.entries(part.collections)) if (!result.collections[name]?.length) result.collections[name] = entries;
      result.views.push(view.name);
      result.errors.push(...part.errors);
    }
    await adapter.goto(page, url);
  }
  return result;
}

const extractWith = readPageType;

const summarize = (r) =>
  r && { fields: Object.keys(r.fields).length, collections: Object.fromEntries(Object.entries(r.collections).map(([k, v]) => [k, v.length])), errors: r.errors };

// Replays a page type on its sample URLs; sets required/expectOneOf/validation.
async function validate(adapter, page, pageType, urls, { requiredFrom, oneOfFrom, anyCommon = false, log, progress = () => {} }) {
  const [firstUrl, secondUrl] = urls;
  progress({ stage: 'validate', detail: `Replaying the ${pageType.role} layout on ${secondUrl ? 'two examples' : 'the example'}` });
  const first = await extractWith(adapter, page, pageType, firstUrl);
  const second = secondUrl ? await extractWith(adapter, page, pageType, secondUrl) : null;
  const onBoth = (key) => first?.fields[key] && (!second || second.fields[key]);
  pageType.required = requiredFrom.filter(onBoth);
  if (!pageType.required.length && anyCommon) {
    // Not a person: no usual identity key, but both examples share several values.
    const common = Object.keys(first?.fields ?? {}).filter(onBoth);
    if (common.length >= 3) pageType.required = common.slice(0, 2);
  }
  pageType.expectOneOf = oneOfFrom.filter(onBoth);
  const clean = (r) => r && !r.errors.length;
  pageType.validation = {
    at: new Date().toISOString(),
    ok: Boolean(clean(first) && (!second || clean(second)) && pageType.required.length),
    first: summarize(first),
    second: summarize(second),
  };
  log(`    validation ${pageType.validation.ok ? 'passed' : 'FAILED'}: ${JSON.stringify({ first: pageType.validation.first, second: pageType.validation.second })}`);
  return pageType;
}

const frameSpec = (view) => (view.frame?.main ? null : { urlRegex: urlPattern(view.frame.url) });

// The page one entry of a message list links to (an email with its body).
async function mapMessageType(adapter, page, llm, { id, urls, collection }, { log, progress = () => {} }) {
  log(`  mapping ${collection} entry page ${urls[0]}`);
  progress({ stage: 'message', detail: `Opening one ${collection.replace(/_/g, ' ')} entry's own page` });
  await adapter.goto(page, urls[0]);
  const view = await mapView(adapter, page, llm, { label: `the page of one entry from a customer's "${collection}" list`, askSections: false, mode: 'message', log, progress });
  if (!view?.isTarget || !Object.keys(view.fields).length) {
    log(`    not a message page: ${view?.summary ?? 'no content'}`);
    return null;
  }
  const pageType = {
    id,
    role: 'message',
    description: view.summary,
    urlRegex: urlPattern(urls[0]),
    frame: frameSpec(view),
    views: [{ name: 'Main', activate: null, waitFor: waitSelector(view), fields: view.fields, collections: {} }],
    samples: urls,
  };
  log(`    fields ${Object.keys(view.fields).join(', ')}`);
  return validate(adapter, page, pageType, urls, { requiredFrom: MESSAGE_KEYS, oneOfFrom: [], log, progress });
}

// One person's record: the page as opened plus every tab/expander.
async function mapRecordType(adapter, page, llm, { id, entity, urls, dataset }, { log, progress = () => {} }) {
  const [firstUrl] = urls;
  progress({ stage: 'record', detail: `Opening a ${entity} record`, current: 1, total: 1 });
  await adapter.goto(page, firstUrl);
  const main = await mapView(adapter, page, llm, { label: `a ${entity} record as opened`, askSections: true, log, progress, dataset });
  if (!main?.isTarget) {
    log(`    not one of the ${dataset.plural} after all: ${main?.summary ?? 'no content'}`);
    return null;
  }
  const dataFrameId = main.frame.frameId;
  // The view the record opens with is read in place; its tab, if any, is
  // only needed to come back to it after other in-place tabs (not for a
  // link-tab, whose page we are already on).
  const open = main.sections.find((s) => s.isOpen && s.activate.kind !== 'expander');
  const views = [{ name: open?.name ?? 'Main', activate: open && open.activate.kind !== 'link' ? open.activate : null, ...main }];
  const urlsSeen = [await adapter.url(page)];
  log(`    view "${views[0].name}": ${Object.keys(main.fields).length} fields, lists [${Object.keys(main.collections)}]; sections [${main.sections.map((s) => `${s.name}${s.isOpen ? ' (open)' : ''}`)}]`);

  const closed = main.sections.filter((s) => !s.isOpen);
  const tabShapes = []; // the pages of this record's link-tabs: not records of their own
  let onRecordPage = true;
  for (const [i, section] of closed.entries()) {
    progress({ stage: 'record', detail: `Opening section "${section.name}" of the ${entity} record`, current: i + 2, total: closed.length + 1 });
    if (section.frameId !== dataFrameId) {
      log(`    skipped section ${section.name}: it lives in another frame than the record`);
      continue;
    }
    if (!onRecordPage) {
      await adapter.goto(page, firstUrl);
      onRecordPage = true;
    }
    if (section.activate.kind === 'link') {
      // A tab that is its own page: go there, map it, come back.
      const href = await adapter.evaluate(page, section.frameId, (spec) => window.__crmRuntime.activatorHref(spec), section.activate);
      if (!href) {
        log(`    skipped section ${section.name}: its link was not found`);
        continue;
      }
      tabShapes.push(urlPattern(href));
      await adapter.goto(page, href);
      onRecordPage = false;
    } else {
      const clicked = await adapter.evaluate(page, section.frameId, (spec) => window.__crmRuntime.activate(spec), section.activate);
      if (!clicked) {
        log(`    skipped section ${section.name}: could not click it`);
        continue;
      }
      await adapter.settle(page);
      urlsSeen.push(await adapter.url(page));
    }
    const view = await mapView(adapter, page, llm, { label: `section "${section.name}" of the ${entity} record`, askSections: false, log, progress, dataset });
    if (!view) continue;
    // A link-tab's page may be a frame-less page of its own: its rules are
    // read on that page, so its frame is irrelevant.
    views.push({ name: section.name, activate: section.activate, ...view });
    log(`    view "${section.name}": ${Object.keys(view.fields).length} fields, lists [${Object.keys(view.collections)}]${section.activate.kind === 'link' ? ' (own page)' : ''}`);
  }

  const pageType = {
    id,
    role: 'record',
    dataset: dataset.id,
    entity,
    description: main.summary,
    urlRegex: urlsSeen.some((u) => u !== urlsSeen[0]) ? commonUrlPattern(urlsSeen) : urlPattern(firstUrl),
    frame: frameSpec(main),
    views: cleanViews(views),
    tabShapes,
    samples: urls,
  };
  await validate(adapter, page, pageType, urls, { requiredFrom: dataset.identityKeys, oneOfFrom: dataset.contactKeys, anyCommon: !dataset.person, log, progress });
  return [pageType, ...(await mapEntryPages(adapter, page, llm, pageType, { log, progress }))];
}

// A record's views as saved: each field and list is read from the first view
// that has it, and views left with nothing are dropped.
function cleanViews(views) {
  const taken = new Set();
  const takenLists = new Set();
  return views
    .map((v) => {
      const fields = Object.fromEntries(Object.entries(v.fields).filter(([key]) => !taken.has(key) && taken.add(key)));
      const collections = Object.fromEntries(Object.entries(v.collections).filter(([name]) => !takenLists.has(name) && takenLists.add(name)));
      return { name: v.name, activate: v.activate, waitFor: v.activate ? waitSelector({ ...v, collections }) : null, fields, collections };
    })
    .filter((v) => Object.keys(v.fields).length || Object.keys(v.collections).length);
}

// Entries of a record's lists that link to their own page (an email with its
// body): that page is mapped too, 2 kinds at most, and the list names it in
// detailPageType. Leaves the browser on the last entry page it mapped.
async function mapEntryPages(adapter, page, llm, owner, { log, progress }) {
  const messageTypes = [];
  for (const view of owner.views) {
    for (const [name, spec] of Object.entries(view.collections)) {
      const links = spec.sampleLinks ?? [];
      delete spec.sampleLinks;
      if (!spec.fields.link || !links.length || messageTypes.length >= MAX_MESSAGE_TYPES) continue;
      const shape = urlPattern(links[0]);
      const existing = messageTypes.find((mt) => mt.urlRegex === shape);
      if (existing) {
        spec.detailPageType = existing.id;
        continue;
      }
      const sameShapeLinks = links.filter((u) => urlPattern(u) === shape).slice(0, 2);
      const mt = await mapMessageType(adapter, page, llm, { id: `${owner.id}_${name}_entry`, urls: sameShapeLinks, collection: name }, { log, progress });
      if (mt?.validation.ok) {
        messageTypes.push(mt);
        spec.detailPageType = mt.id;
      }
    }
  }
  return messageTypes;
}

// A list of people: the row element and each row's link into its record.
// Needs no LLM: rows are recognised by their links into a mapped record type.
export async function mapListType(adapter, page, llm, { id, entity, url, recordTypes }, { log, progress = () => {} }) {
  log(`  mapping ${entity} list ${url}`);
  progress({ stage: 'list', detail: `Learning the ${entity} list's rows` });
  await adapter.goto(page, url);
  for (const frame of await adapter.frames(page)) {
    const links = await adapter
      .evaluate(page, frame.id, () => {
        window.__crmRuntime.snapshot();
        return window.__crmRuntime.pageLinks();
      })
      .catch(() => []);
    for (const recordType of recordTypes) {
      const into = links.filter((l) => l.mid && matchUrl(recordType.urlRegex, l.url));
      if (into.length < 2) continue;
      const found = await adapter.evaluate(page, frame.id, (mids) => window.__crmRuntime.describeList(mids), into.slice(0, 3).map((l) => l.mid));
      if (!found || found.count < 2) continue;
      const pageType = {
        id,
        role: 'list',
        ...(recordType.dataset ? { dataset: recordType.dataset } : {}),
        entity,
        recordPageType: recordType.id,
        urlRegex: looseUrlPattern(url),
        frame: frame.main ? null : { urlRegex: looseUrlPattern(frame.url) },
        items: found.spec,
        samples: [url],
        validation: { at: new Date().toISOString(), ok: true, first: { rows: found.count } },
      };
      log(`    ${found.count} rows, each linking to ${recordType.id} (e.g. ${found.examples[0]?.title})`);
      return pageType;
    }
  }
  log('    no rows linking to a mapped record page');
  return null;
}

// Explored pages whose repeated rows link into one of the record types.
export function listPagesAmong(pages, recordTypes) {
  const out = [];
  for (const p of pages) {
    const rt = recordTypes.find((t) => (p.rowGroups ?? []).some((g) => g.urls.length >= 3 && g.urls.every((u) => matchUrl(t.urlRegex, u))));
    if (rt && !out.some((o) => o.pattern === p.pattern)) out.push({ ...p, recordType: rt });
  }
  return out;
}

const groupShapes = (pages) => {
  const shapes = [];
  for (const p of pages) {
    const shape = shapes.find((s) => s.pattern === p.pattern);
    if (shape) shape.urls.push(p.url);
    else shapes.push({ pattern: p.pattern, urls: [p.url], title: p.title, text: p.text, rowGroups: p.rowGroups });
  }
  return shapes;
};

// ------------------------------------------ CRMs that navigate by clicks
//
// Some CRMs keep one address for everything and have no links: a launcher
// tile opens the CRM inside a frame (often from another host), a side menu
// switches screens, lists are script-driven grids. Nothing can be reached
// or recognised by URL there, so a list is a "screen": the path of clicks
// that leads to it from the start page, plus the grid found on it.
//
//   { id, role: 'screen', dataset, path: [{ label, nav }], table: { container,
//     row, headers, offset, columns: [{ index, key }] }, recordPageType? }
//
// The LLM is shown what is on screen and what can be clicked, and picks; the
// agent clicks, records the path, and reads the grid's columns. Capturing
// later replays the path and reads the grid, page after page, without AI.

// Captions the explorer never clicks, whatever the LLM says.
export const UNSAFE_CLICK = /^(add|new|create|edit|delete|remove|send|compose|import|export|print|upload|save|submit)\b|\b(wizard|log ?out|sign ?out|logout|signout|unsubscribe)\b/i;
const MAX_CLICKS = 30;
const MAX_CLICK_DEPTH = 6;
const MAX_SCREENS_PER_KIND = 4;
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What is on screen in every frame: its text, and what can be clicked
// (numbered across frames; each remembers its frame).
async function screenInfo(adapter, page) {
  const out = { text: '', clickables: [] };
  let nextId = 1;
  for (const frame of await adapter.frames(page)) {
    const got = await adapter
      .evaluate(
        page,
        frame.id,
        (startId) => {
          const rt = window.__crmRuntime;
          if (!rt?.clickables) return null;
          return { text: (rt.pageText ? rt.pageText() : document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 2500), clickables: rt.clickables({ startId }), url: location.href };
        },
        nextId,
      )
      .catch(() => null);
    if (!got) continue;
    if (got.text) out.text += `${out.text ? ' | ' : ''}${got.text}`;
    for (const c of got.clickables) out.clickables.push({ ...c, frameId: frame.id, frameHost: hostOf(got.url) });
    nextId += got.clickables.length;
  }
  return out;
}

// The frame in which a step's element is on screen right now, or null.
async function frameOfStep(adapter, page, step) {
  const frames = await adapter.frames(page);
  frames.sort((a, b) => Number(hostOf(b.url) === step.frameHost) - Number(hostOf(a.url) === step.frameHost));
  for (const frame of frames) {
    const there = await adapter.evaluate(page, frame.id, (spec) => window.__crmRuntime?.hasNav?.(spec) ?? false, step.nav).catch(() => false);
    if (there) return frame;
  }
  return null;
}

// Presses a step's element and waits for what it started. The element may
// take a moment to appear (an app still loading inside its frame).
async function pressStep(adapter, page, step, { tries = 5 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const frame = await frameOfStep(adapter, page, step);
    if (frame) {
      const pressed = await adapter.evaluate(page, frame.id, (spec) => window.__crmRuntime.pressNav(spec), step.nav).catch(() => false);
      if (pressed) {
        await (adapter.afterClick ?? adapter.settle)(page);
        return true;
      }
    }
    await pause(1500);
    await adapter.settle(page);
  }
  return false;
}

// From the start page, click by click, to the screen a path leads to. A step
// whose next step is already on screen is skipped (an app that remembers
// its open menus: pressing the group again would close it).
export async function replayPath(adapter, page, startUrl, path) {
  await adapter.goto(page, startUrl);
  for (const [i, step] of path.entries()) {
    const next = path[i + 1];
    if (next && (await frameOfStep(adapter, page, next))) continue;
    if (!(await pressStep(adapter, page, step))) return false;
  }
  return true;
}

// The grid on the screen we are on, as a "screen" page type (null when the
// screen has no grid with rows).
// url: the list has an address of its own (its rows have no links); the
// capture opens it there, then follows path (empty) as usual.
async function mapScreenType(adapter, page, llm, { id, path, dataset, title, url = null }, { log, progress = () => {} }) {
  progress({ stage: 'list', detail: `Learning the grid of "${title}"` });
  let best = null;
  for (const frame of await adapter.frames(page)) {
    const found = await adapter.evaluate(page, frame.id, () => window.__crmRuntime?.describeTable?.() ?? null).catch(() => null);
    if (found && (!best || found.count * found.headers.length > best.count * best.headers.length)) best = { ...found, frame };
  }
  if (!best) {
    log(`    "${title}": no grid with rows on this screen (the list is empty for the current filter, or it is not a table)`);
    return null;
  }
  // Which field each column holds: asked once; the headers themselves otherwise.
  let columns = [];
  try {
    progress({ detail: `Asking the AI what the columns of "${title}" are`, llmCall: true });
    const answer = await llm.mapColumns({ dataset: dataset.id, headers: best.headers, rows: best.rows });
    progress({ detail: `Checking the grid of "${title}"` });
    columns = answer.columns ?? [];
  } catch (error) {
    log(`    column names not available from the AI (${error.message}); using the headers`);
  }
  const used = new Set();
  columns = columns
    .map((c) => ({ index: Number(c.index), key: slug(c.key, '') }))
    .filter((c) => Number.isInteger(c.index) && c.index >= 0 && c.index < best.headers.length && c.key && !used.has(c.key) && used.add(c.key));
  if (!columns.length) columns = best.headers.map((h, index) => ({ index, key: slug(h, '') })).filter((c) => c.key && !used.has(c.key) && used.add(c.key));
  const table = { ...best.spec, columns };
  const read = await adapter.evaluate(page, best.frame.id, (spec) => window.__crmRuntime.readTable(spec), table).catch(() => null);
  const rows = (read?.rows ?? []).filter((r) => r.fields && Object.keys(r.fields).length);
  const required = dataset.identityKeys.filter((key) => rows.length && rows.every((r) => r.fields[key]));
  const ok = rows.length >= 1 && (required.length > 0 || Object.keys(rows[0].fields).length >= 2);
  const pageType = {
    id,
    role: 'screen',
    dataset: dataset.id,
    entity: title,
    description: path.length ? `${title}: the list reached by clicking ${path.map((s) => `"${s.label}"`).join(' > ')}` : `${title}: the list at ${url}`,
    ...(url ? { url } : {}),
    urlRegex: '(?!)', // never matched by address: a screen has none of its own
    path: path.map(({ label, nav, frameHost }) => ({ label, nav, frameHost })),
    frameHost: hostOf(best.frame.url),
    table,
    required,
    samples: [],
    validation: { at: new Date().toISOString(), ok, first: { rows: rows.length, columns: columns.map((c) => c.key) } },
  };
  // Rows that lead to a page with an address (a link, an onclick that opens
  // a window): that page can be mapped and captured like any record.
  const links = [...new Set(rows.map((r) => r.link).filter(Boolean))];
  log(`    "${title}" (${dataset.plural}): ${rows.length} rows, columns ${columns.map((c) => c.key).join(', ')}${links.length ? `; rows link to ${urlPattern(links[0])}` : ''} ${ok ? '' : '(not usable)'}`);
  return { pageType, links };
}

// Explores by clicking. onScreen({ path, dataset, title }) is called on
// every list of a wanted kind, while that list is on screen; it returns
// true when the screen was usable. Returns the hosts of the frames clicked in.
async function exploreByClicks(adapter, page, site, llm, { datasets, log, progress = () => {}, onScreen }) {
  const wanted = datasets.map((d) => d.id);
  const found = [];
  const perKind = new Map();
  const tried = new Set();
  const hosts = new Set();
  let clicks = 0;

  async function visit(path) {
    const info = await screenInfo(adapter, page);
    if (!info.clickables.length && !info.text) return;
    const where = path.length ? `after ${path.map((s) => `"${s.label}"`).join(' > ')}` : 'on the start page';
    progress({ stage: 'explore', current: clicks, total: MAX_CLICKS, detail: `Asking the AI what to click ${where}`, llmCall: true });
    let answer;
    try {
      answer = await llm.chooseClicks({
        datasets: wanted,
        path: path.map((s) => s.label),
        found,
        text: info.text,
        clickables: info.clickables.slice(0, 300).map(({ id, text, role, expanded, selected, area }) => ({ id, text, role, expanded, selected, area })),
      });
    } catch (error) {
      log(`  could not ask what to click ${where}: ${error.message}`);
      return;
    }
    progress({ stage: 'explore', current: clicks, total: MAX_CLICKS, detail: `Looking at the screen ${where}` });
    const screen = answer.screen ?? { kind: 'other', dataset: 'other', title: '' };
    const picked = (answer.clicks ?? []).map((pick) => info.clickables.find((x) => x.id === pick.id)?.text).filter(Boolean);
    log(`  ${'  '.repeat(path.length)}${where}: ${screen.kind}${screen.kind === 'list' || screen.kind === 'record' ? ` of ${screen.dataset}` : ''} "${screen.title}"; ${info.clickables.length} clickable; AI picked: ${picked.map((t) => `"${t}"`).join(', ') || 'nothing'}`);
    if (screen.kind === 'list' && wanted.includes(screen.dataset) && path.length && (perKind.get(screen.dataset) ?? 0) < MAX_SCREENS_PER_KIND) {
      if (await onScreen({ path, dataset: screen.dataset, title: screen.title || path.at(-1).label })) {
        perKind.set(screen.dataset, (perKind.get(screen.dataset) ?? 0) + 1);
        found.push(`${screen.dataset}: ${screen.title}`);
      }
    }
    if (path.length >= MAX_CLICK_DEPTH) return;

    // The picks become steps now, while their elements are on screen.
    const steps = [];
    for (const pick of (answer.clicks ?? []).slice(0, 6)) {
      const c = info.clickables.find((x) => x.id === pick.id);
      if (!c) continue;
      if (UNSAFE_CLICK.test(c.text) || path.some((s) => s.label === c.text)) {
        log(`  ${'  '.repeat(path.length)}not clicking "${c.text}" (${UNSAFE_CLICK.test(c.text) ? 'it may change data' : 'already on the path'})`);
        continue;
      }
      const signature = [...path.map((s) => s.label), c.text].join(' > ');
      if (tried.has(signature)) continue;
      let why = '';
      let nav = await adapter.evaluate(page, c.frameId, (id) => window.__crmRuntime.describeNav(id), c.id).catch((error) => {
        why = String(error.message).split('\n')[0];
        return null;
      });
      if (!nav) {
        // The app re-drew it while the AI was deciding (the mark it was listed
        // with is gone): find it again by its caption.
        nav = await adapter
          .evaluate(
            page,
            c.frameId,
            (text) => {
              const rt = window.__crmRuntime;
              const again = rt.clickables({ startId: 900000 }).find((x) => x.text === text);
              return again ? rt.describeNav(again.id) : null;
            },
            c.text,
          )
          .catch((error) => {
            why = String(error.message).split('\n')[0];
            return null;
          });
      }
      if (!nav) {
        log(`  ${'  '.repeat(path.length)}could not describe "${c.text}" for later replay (${why || 'it is no longer on screen'})`);
        continue;
      }
      tried.add(signature);
      steps.push({ label: c.text, nav, frameHost: c.frameHost });
    }
    for (const step of steps) {
      if (clicks >= MAX_CLICKS) return;
      // Still somewhere this can be pressed (menus stay)? Otherwise come back.
      if (!(await frameOfStep(adapter, page, step))) {
        const back = (await replayPath(adapter, page, site.startUrl, path)) && (await frameOfStep(adapter, page, step));
        if (!back) {
          log(`  ${'  '.repeat(path.length)}skipped "${step.label}": could not get back to it`);
          continue;
        }
      }
      clicks++;
      progress({ stage: 'explore', current: clicks, total: MAX_CLICKS, detail: `Clicking ${[...path, step].map((s) => s.label).join(' > ')}` });
      if (!(await pressStep(adapter, page, step, { tries: 2 }))) continue;
      if (step.frameHost) hosts.add(step.frameHost);
      await visit([...path, step]);
    }
  }

  await visit([]);
  log(`  explored by clicking: ${clicks} clicks, lists reached: ${found.join('; ') || 'none'}`);
  return { hosts: [...hosts], clicks };
}

// ------------------------------------------ records that open in place
//
// Rows that hold no link: their record opens in a drawer, a dialog or a side
// pane over the list, or on a page the app reaches only by script. The agent
// clicks a row and looks at what happened:
//   - the address changed: those pages are mapped as ordinary records, and
//     the list remembers what to click in a row to open one (rowOpen)
//   - something appeared: that panel is mapped as the record (its fields,
//     message lists and tabs), with how to close it again, and checked on a
//     second row, which must show different values
// The screen keeps the panel's layout as its detail:
//   { id, inPlace: true, open, panel, close, views, required, expectOneOf,
//     validation, dataset, entity, description }

const runIn = (adapter, page, frameId, fn, arg) => adapter.evaluate(page, frameId, fn, arg);

// The frame showing a grid, and how many rows it has.
async function gridFrame(adapter, page, table) {
  for (const frame of await adapter.frames(page)) {
    const rows = await runIn(adapter, page, frame.id, (spec) => window.__crmRuntime?.tableRows?.(spec) ?? 0, table).catch(() => 0);
    if (rows) return { frame, rows };
  }
  return null;
}

// Clicks row index on its opener and reports what happened:
// { navigated: url }, { panel: { selector, text, length, dialog, frameId } },
// {} (nothing), or null (no such row).
async function openRow(adapter, page, table, index, open) {
  const grid = await gridFrame(adapter, page, table);
  if (!grid || index >= grid.rows) return null;
  const before = await adapter.url(page);
  for (const frame of await adapter.frames(page)) await runIn(adapter, page, frame.id, () => window.__crmRuntime?.markVisible?.()).catch(() => {});
  const pressed = await runIn(adapter, page, grid.frame.id, ([spec, i, o]) => window.__crmRuntime.pressRow(spec, i, o), [table, index, open]).catch(() => false);
  if (!pressed) return null;
  await (adapter.afterClick ?? adapter.settle)(page);
  const after = await adapter.url(page);
  if (urlKey(after) !== urlKey(before)) return { navigated: after };
  let best = null;
  for (const frame of await adapter.frames(page)) {
    const exclude = frame.id === grid.frame.id ? table.container : '';
    const panel = await runIn(adapter, page, frame.id, (ex) => window.__crmRuntime?.openedPanel?.({ exclude: ex }) ?? null, exclude).catch(() => null);
    if (panel && (!best || panel.length > best.length)) best = { ...panel, frameId: frame.id };
  }
  return best ? { panel: best } : {};
}

const readPanel = (adapter, page, frameId, detail) => runIn(adapter, page, frameId, (pt) => window.__crmRuntime.extractPage(pt), { ...detail, inPlace: true }).catch(() => null);

// Presses close; whether the panel is gone afterwards.
async function closePanel(adapter, page, frameId, panelSel, close) {
  if (!close) return false;
  await runIn(adapter, page, frameId, (spec) => window.__crmRuntime.pressClose(spec), close).catch(() => false);
  await adapter.settle(page);
  return !(await runIn(adapter, page, frameId, (sel) => window.__crmRuntime.shown(sel), panelSel).catch(() => true));
}

// The panel row 0 opened: its views, how to close it, checked on row 1.
async function mapPanel(adapter, page, llm, { id, entity, dataset, table, open, panel, rows }, { log, progress }) {
  const root = { frameId: panel.frameId, selector: panel.selector };
  progress({ stage: 'record', detail: `Mapping the ${entity} panel a row opens`, current: 1, total: 1 });
  const label = `the details of one ${entity}, shown in a panel that opened over the list when its row was clicked`;
  const main = await mapView(adapter, page, llm, { label, askSections: true, log, progress, dataset, root });
  if (!main?.isTarget) {
    log(`    the panel is not one of the ${dataset.plural}: ${main?.summary ?? 'no content'}`);
    return null;
  }
  const openTab = main.sections.find((s) => s.isOpen && !s.activate.kind);
  const views = [{ name: openTab?.name ?? 'Main', activate: openTab?.activate ?? null, ...main }];
  log(`    panel view "${views[0].name}": ${Object.keys(main.fields).length} fields, lists [${Object.keys(main.collections)}]; sections [${main.sections.map((s) => `${s.name}${s.isOpen ? ' (open)' : ''}`)}]`);
  for (const section of main.sections.filter((s) => !s.isOpen)) {
    if (section.activate.kind === 'link') {
      log(`    skipped section ${section.name}: it leads to a page of its own`);
      continue;
    }
    const clicked = await runIn(adapter, page, panel.frameId, ([spec, sel]) => window.__crmRuntime.activate(spec, sel), [section.activate, panel.selector]).catch(() => false);
    if (!clicked) {
      log(`    skipped section ${section.name}: could not click it`);
      continue;
    }
    await adapter.settle(page);
    const view = await mapView(adapter, page, llm, { label: `section "${section.name}" of the ${entity} panel`, askSections: false, log, progress, dataset, root });
    if (!view) continue;
    views.push({ name: section.name, activate: section.activate, ...view });
    log(`    panel view "${section.name}": ${Object.keys(view.fields).length} fields, lists [${Object.keys(view.collections)}]`);
  }
  const detail = { id, inPlace: true, dataset: dataset.id, entity, description: main.summary, open, panel: panel.selector, views: cleanViews(views) };

  // Read row 0 with the new rules, put the panel away, then row 1.
  progress({ stage: 'validate', detail: `Replaying the panel layout on ${rows > 1 ? 'two rows' : 'the row'}` });
  const first = await readPanel(adapter, page, panel.frameId, detail);
  const closeSpec = await runIn(adapter, page, panel.frameId, (sel) => window.__crmRuntime.describeClose(sel), panel.selector).catch(() => null);
  detail.close = (await closePanel(adapter, page, panel.frameId, panel.selector, closeSpec)) ? closeSpec : null;
  log(`    closing it: ${detail.close ? (detail.close.key ? `the ${detail.close.key} key` : `"${detail.close.text}"`) : 'not needed (the next row replaces it)'}`);
  let second = null;
  if (rows > 1) {
    const opened = await openRow(adapter, page, table, 1, open);
    if (opened && !opened.navigated) second = await readPanel(adapter, page, panel.frameId, detail);
    if (detail.close) await closePanel(adapter, page, panel.frameId, panel.selector, detail.close);
  }
  const onBoth = (key) => first?.fields[key] && (rows < 2 || second?.fields[key]);
  detail.required = dataset.identityKeys.filter(onBoth);
  if (!detail.required.length && !dataset.person) {
    const common = Object.keys(first?.fields ?? {}).filter(onBoth);
    if (common.length >= 3) detail.required = common.slice(0, 2);
  }
  detail.expectOneOf = dataset.contactKeys.filter(onBoth);
  // A panel that kept showing the first row's values is not following the rows.
  const differs = rows < 2 || Object.keys(first?.fields ?? {}).some((key) => second?.fields[key] && second.fields[key] !== first.fields[key]);
  const clean = (r) => r && !r.errors.length;
  detail.validation = {
    at: new Date().toISOString(),
    ok: Boolean(clean(first) && (rows < 2 || clean(second)) && detail.required.length && differs),
    first: summarize(first),
    second: summarize(second),
    ...(differs ? {} : { problem: 'the second row showed the same values as the first' }),
  };
  log(`    panel validation ${detail.validation.ok ? 'passed' : 'FAILED'}: ${JSON.stringify({ first: detail.validation.first, second: detail.validation.second, problem: detail.validation.problem })}`);
  if (!detail.validation.ok) return { detail, messageTypes: [] };
  return { detail, messageTypes: await mapEntryPages(adapter, page, llm, detail, { log, progress }) };
}

// What clicking the rows of a link-less grid opens (the grid on screen now).
// backToList() brings the list back after a row navigated away.
// Returns { kind: 'navigates', open, urls }, { kind: 'panel', detail,
// messageTypes } or null.
export async function mapRowDetail(adapter, page, llm, { id, entity, dataset, table, backToList }, { log = () => {}, progress = () => {} } = {}) {
  const grid = await gridFrame(adapter, page, table);
  if (!grid) return null;
  const openers = await runIn(adapter, page, grid.frame.id, (spec) => window.__crmRuntime.rowOpeners(spec, 0), table).catch(() => []);
  for (const open of openers) {
    progress({ stage: 'record', detail: `Clicking a row of the ${entity} list to see what it opens` });
    const opened = await openRow(adapter, page, table, 0, open);
    if (!opened) continue;
    if (opened.navigated) {
      log(`    clicking a row (${open.css}) opens ${opened.navigated}`);
      const urls = [opened.navigated];
      if (grid.rows > 1 && (await backToList())) {
        const again = await openRow(adapter, page, table, 1, open);
        if (again?.navigated && again.navigated !== urls[0]) urls.push(again.navigated);
      }
      return { kind: 'navigates', open, urls };
    }
    if (opened.panel) {
      log(`    clicking a row (${open.css}) opens a ${opened.panel.dialog ? 'dialog' : 'panel'} ${opened.panel.selector}: "${opened.panel.text.slice(0, 60)}"`);
      const mapped = await mapPanel(adapter, page, llm, { id, entity, dataset, table, open, panel: opened.panel, rows: grid.rows }, { log, progress });
      return mapped ? { kind: 'panel', ...mapped } : null;
    }
  }
  log('    clicking its rows opens nothing');
  return null;
}

// A list screen whose rows hold no link: maps what a row click opens and
// attaches it to the screen (detail, or recordPageType + rowOpen). Returns
// the page types it mapped on the way (record and message pages). Leaves
// the list on screen.
async function mapScreenRows(adapter, page, llm, screen, { dataset, entity, backToList, newId, log, progress }) {
  const out = [];
  const found = await mapRowDetail(adapter, page, llm, { id: newId(`${slug(entity, dataset.id)}_panel`), entity, dataset, table: screen.table, backToList }, { log, progress }).catch((error) => {
    log(`    could not open its rows (${String(error.message).split('\n')[0]})`);
    return null;
  });
  if (found?.kind === 'panel') {
    if (found.detail.validation.ok) {
      screen.detail = found.detail;
      out.push(...found.messageTypes);
    } else log(`    the grid's own columns are captured instead`);
  } else if (found?.kind === 'navigates') {
    const mapped = await mapRecordType(adapter, page, llm, { id: newId(slug(entity, dataset.id)), entity, urls: found.urls, dataset }, { log, progress }).catch((error) => {
      log(`    could not map the page its rows open (${String(error.message).split('\n')[0]})`);
      return null;
    });
    if (mapped) out.push(...mapped);
    if (mapped?.[0].validation.ok) {
      screen.recordPageType = mapped[0].id;
      screen.rowOpen = found.open;
    }
  }
  if (found) await backToList();
  return out;
}

// site: { id, name, match: { hosts }, startUrl, crawl? }
// llm: { model, classifyPages(pages, { datasets }), mapView(frames, opts) }
// store: { getCrm(id), saveMapping(site, pageTypes, opts), recordFailedAttempt(site, info) }
// datasets: the kinds of data to look for (lib/mapper/datasets.js).
// progress({ stage, detail, current, total, llmCall, plan }) is called as the
// work advances; stages: explore, classify, record, message, list, validate, save.
// onReady(pageTypes) is called each time one kind of record is fully mapped
// and validated (its record page, its message pages, its lists), while the
// agent goes on with the next kind: the caller can start capturing with
// those layouts straight away.
export async function mapCrm({ site, llm, store, adapter, log = () => {}, progress = () => {}, onlyUrl = null, reason = 'manual', mappedBy = 'mapper-agent', datasets = Object.values(DATASETS), onReady = async () => {} }) {
  const started = Date.now();
  if (!onlyUrl) log(`Looking for: ${datasets.map((d) => d.plural).join(', ')}`);
  progress({ stage: 'explore', detail: `Opening ${onlyUrl || site.startUrl}` });
  const page = await adapter.open(onlyUrl || site.startUrl);
  try {
    const previousCrm = await store.getCrm(site.id);
    const previous = previousCrm?.pageTypes ?? [];
    let pageTypes = [];

    if (onlyUrl) {
      const old = previous.find((pt) => matchUrl(pt.urlRegex, onlyUrl));
      const role = old?.role ?? 'record';
      const samples = [onlyUrl, ...(old?.samples ?? []).filter((u) => u !== onlyUrl)].slice(0, 2);
      log(`Re-mapping ${site.name} ${role} page ${onlyUrl}`);
      if (role === 'list') {
        const recordTypes = previous.filter((pt) => pt.role === 'record');
        const lt = await mapListType(adapter, page, llm, { id: old.id, entity: old.entity, url: onlyUrl, recordTypes }, { log, progress });
        pageTypes = lt ? [lt] : [];
      } else if (role === 'message') {
        const mt = await mapMessageType(adapter, page, llm, { id: old.id, urls: samples, collection: 'history' }, { log, progress });
        pageTypes = mt ? [mt] : [];
      } else {
        // The page keeps the kind it was mapped as.
        const dataset = DATASETS[old ? datasetOfPageType(old, previousCrm) : datasets[0].id];
        pageTypes = (await mapRecordType(adapter, page, llm, { id: old?.id ?? 'record', entity: old?.entity ?? dataset.plural.replace(/s$/, ''), urls: samples, dataset }, { log, progress })) ?? [];
      }
    } else {
      log(`Exploring ${site.name} from ${site.startUrl}`);
      const pages = await explore(adapter, page, site, { ...site.crawl, log, progress, datasets });
      const shapes = groupShapes(pages);
      progress({ stage: 'classify', detail: `Asking the AI what the ${shapes.length} kinds of page show` });
      const wanted = new Set(datasets.map((d) => d.id));
      const { pages: kinds } = await llm.classifyPages(shapes, { datasets: [...wanted] });
      const classified = shapes.map((shape, i) => {
        const k = kinds.find((x) => x.index === i) ?? { kind: 'other', entity: 'other', dataset: 'other' };
        // Servers from before datasets only name the entity.
        const dataset = k.dataset ? datasetById(k.dataset)?.id ?? null : datasetOfPageType({ entity: k.entity });
        return { ...shape, kind: k.kind, entity: norm(k.entity), dataset };
      });
      const order = (s) => DATASET_IDS.indexOf(s.dataset);
      const isWanted = (s) => s.dataset && wanted.has(s.dataset) && !MESSAGE_ENTITIES_ONLY.has(s.entity);
      // A couple of record layouts per kind are plenty (a CRM rarely has more).
      const perKind = new Map();
      const records = classified
        .filter((s) => s.kind === 'record' && isWanted(s))
        .sort((a, b) => order(a) - order(b))
        .filter((s) => (perKind.get(s.dataset) ?? 0) < MAX_RECORD_TYPES_PER_KIND && perKind.set(s.dataset, (perKind.get(s.dataset) ?? 0) + 1));
      const lists = classified.filter((s) => s.kind === 'list' && isWanted(s));
      const messages = classified.filter((s) => s.kind === 'record' && !records.includes(s) && MESSAGE_ENTITIES.has(s.entity));
      for (const d of datasets) {
        const r = records.filter((s) => s.dataset === d.id);
        const l = lists.filter((s) => s.dataset === d.id);
        log(`  ${d.plural}: ${r.length ? `record ${r.map((s) => s.urls[0]).join(', ')}` : 'no record page seen'}${l.length ? `; list ${l.map((s) => s.urls[0]).join(', ')}` : ''}`);
      }
      const others = [...new Set(classified.filter((s) => !records.includes(s) && !lists.includes(s) && s.kind !== 'other').map((s) => `${s.kind} of ${s.entity}`))];
      if (others.length) log(`  other pages seen (not captured): ${others.join(', ')}`);
      if (messages.length) log(`  message pages seen: ${messages.map((s) => s.pattern).join(', ')}`);

      const usedIds = new Set();
      const uniqueId = (base) => {
        let id = base;
        for (let n = 2; usedIds.has(id); n++) id = `${base}_${n}`;
        usedIds.add(id);
        return id;
      };
      // Layouts are handed over as soon as they are usable.
      const emitted = new Set();
      const handOver = async () => {
        const fresh = pageTypes.filter((pt) => pt.validation?.ok && !emitted.has(pt.id));
        for (const pt of fresh) emitted.add(pt.id);
        if (fresh.length) await onReady(fresh);
      };
      const linksInto = (shape, recordTypes) => recordTypes.find((rt) => (shape.rowGroups ?? []).some((g) => g.urls.length >= 3 && g.urls.every((u) => matchUrl(rt.urlRegex, u))));
      const listMapped = (shape) => pageTypes.some((pt) => pt.role === 'list' && matchUrl(pt.urlRegex, shape.urls[0]));

      progress({ plan: { records: records.length, lists: lists.length } });
      for (const shape of records) {
        if (pageTypes.some((pt) => pt.role === 'record' && (matchUrl(pt.urlRegex, shape.urls[0]) || (pt.tabShapes ?? []).includes(shape.pattern)))) continue; // a tab of a mapped record
        const dataset = DATASETS[shape.dataset];
        log(`  mapping ${shape.entity} record (${dataset.plural}) ${shape.urls[0]}`);
        const mapped = await mapRecordType(adapter, page, llm, { id: uniqueId(slug(shape.entity, dataset.id)), entity: shape.entity, urls: shape.urls.slice(0, 2), dataset }, { log, progress });
        if (!mapped) continue;
        pageTypes.push(...mapped);
        const recordType = mapped[0];
        if (!recordType.validation.ok) continue;
        // Its lists right away (no AI needed): the lists the LLM named for this
        // kind, plus any explored page whose rows link into this record.
        const named = classified.filter((s) => s.kind === 'list' && s.dataset === shape.dataset);
        const linking = classified.filter((s) => s.kind !== 'record' && !named.includes(s) && linksInto(s, [recordType])).sort((a, b) => Number(b.kind === 'list') - Number(a.kind === 'list'));
        let found = 0;
        for (const candidate of [...named, ...linking]) {
          if (found && !named.includes(candidate)) break; // a real list was learned: no need for a dashboard's few links
          if (listMapped(candidate)) continue;
          const lt = await mapListType(adapter, page, llm, { id: uniqueId(`${recordType.id}_list`), entity: recordType.entity, url: candidate.urls[0], recordTypes: [recordType] }, { log, progress });
          if (lt) {
            pageTypes.push(lt);
            found++;
          }
        }
        await handOver();
      }
      await handOver();

      // A kind with a list page but no record reached through links: its rows
      // may open the record in place (a drawer, a dialog) or by script.
      for (const d of datasets) {
        if (pageTypes.some((pt) => pt.validation?.ok && (pt.role === 'record' || pt.role === 'screen') && pt.dataset === d.id)) continue;
        for (const shape of lists.filter((s) => s.dataset === d.id).slice(0, 2)) {
          const url = shape.urls[0];
          log(`  ${d.plural}: the list ${url} links to no record page; trying its rows`);
          await adapter.goto(page, url);
          const mapped = await mapScreenType(adapter, page, llm, { id: uniqueId(`${slug(shape.entity, d.id)}_list`), path: [], url, dataset: d, title: shape.title || shape.entity }, { log, progress });
          if (!mapped?.pageType.validation.ok || mapped.links.length) continue;
          const backToList = async () => {
            await adapter.goto(page, url);
            return true;
          };
          pageTypes.push(...(await mapScreenRows(adapter, page, llm, mapped.pageType, { dataset: d, entity: shape.entity, backToList, newId: uniqueId, log, progress })));
          pageTypes.push(mapped.pageType);
          await handOver();
          break;
        }
      }

      // Nothing could be reached through links: the CRM navigates by clicks.
      if (!pageTypes.some((pt) => (pt.role === 'record' || pt.role === 'screen') && pt.validation?.ok) && llm.chooseClicks) {
        log(`No record page of ${site.name} could be reached through links: exploring by clicking (launcher tiles, menus, grids)`);
        progress({ stage: 'explore', plan: { clicks: MAX_CLICKS }, current: 0, total: MAX_CLICKS, detail: 'Exploring by clicking' });
        await adapter.goto(page, site.startUrl);
        const withLinks = [];
        const explored = await exploreByClicks(adapter, page, site, llm, {
          datasets,
          log,
          progress,
          onScreen: async ({ path, dataset, title }) => {
            const mapped = await mapScreenType(adapter, page, llm, { id: uniqueId(`${slug(title, dataset)}_screen`), path, dataset: DATASETS[dataset], title }, { log, progress });
            if (!mapped?.pageType.validation.ok) return false;
            // Rows that lead to a page of their own wait until that page is mapped.
            if (mapped.links.length) withLinks.push(mapped);
            else {
              // No links in its rows: what does a click on one open?
              const d = DATASETS[dataset];
              const backToList = () => replayPath(adapter, page, site.startUrl, path);
              pageTypes.push(...(await mapScreenRows(adapter, page, llm, mapped.pageType, { dataset: d, entity: d.plural.replace(/s$/, ''), backToList, newId: uniqueId, log, progress })));
              pageTypes.push(mapped.pageType);
              await handOver();
            }
            return true;
          },
        });
        const extraHosts = new Set(explored.hosts);
        // Pages that rows open by script may live on another host, and so may
        // the screens themselves (a launcher's card opens the CRM on its own host).
        for (const pt of pageTypes) {
          if (pt.role === 'record' && pt.validation?.ok) extraHosts.add(hostOf(pt.samples?.[0] ?? ''));
          if (pt.role === 'screen' && pt.frameHost) extraHosts.add(pt.frameHost);
        }
        for (const { pageType, links } of withLinks) {
          let recordType = pageTypes.find((pt) => pt.role === 'record' && pt.validation?.ok && matchUrl(pt.urlRegex, links[0]));
          if (!recordType) {
            const dataset = DATASETS[pageType.dataset];
            const entity = dataset.plural.replace(/s$/, '');
            log(`  mapping the page the rows of "${pageType.entity}" open: ${links[0]}`);
            const mapped = await mapRecordType(adapter, page, llm, { id: uniqueId(slug(entity, dataset.id)), entity, urls: links.slice(0, 2), dataset }, { log, progress }).catch((error) => {
              log(`    could not map it (${String(error.message).split('\n')[0]}): the grid's own columns are captured instead`);
              return null;
            });
            if (mapped) {
              pageTypes.push(...mapped);
              if (mapped[0].validation.ok) recordType = mapped[0];
            }
          }
          if (recordType) {
            pageType.recordPageType = recordType.id;
            extraHosts.add(hostOf(links[0]));
          }
          pageTypes.push(pageType);
          await handOver();
        }
        // The frames (and record pages) of other hosts belong to this CRM.
        extraHosts.delete('');
        if (extraHosts.size) site = { ...site, match: { ...site.match, hosts: [...new Set([...site.match.hosts, ...extraHosts])] } };
      }
    }

    const usable = pageTypes.filter((pt) => pt.validation?.ok);
    if (!usable.some((pt) => pt.role === 'record' || pt.role === 'screen') && !(onlyUrl && usable.length)) {
      const error = pageTypes.length ? 'mapped rules failed validation' : `no pages showing ${datasets.map((d) => d.plural).join(', ')} were found, by links or by clicking: start the mapping from one of their lists`;
      await store.recordFailedAttempt(site, { reason, error });
      throw new Error(`${site.name}: ${error}; keeping the previous config.`);
    }
    progress({ stage: 'save', detail: 'Saving the layout' });
    const entry = await store.saveMapping(site, usable, { reason, mappedBy: `${mappedBy} (${llm.model})`, replaceAll: !onlyUrl });
    log(`Saved ${site.name} config v${entry.version}: ${usable.map((pt) => `${pt.id} (${pt.role})`).join(', ')} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    return entry;
  } finally {
    await adapter.close(page);
  }
}
