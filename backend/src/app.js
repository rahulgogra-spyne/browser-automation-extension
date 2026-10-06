import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { MAX_FIELDS_PER_RECORD, MAX_RECORDS, humanize, toKey } from './schema.js';
import { buildUserPrompt } from './prompt.js';
import { DATASET_IDS, datasetsOfCrm } from '../../extension/lib/mapper/datasets.js';
import { buildEvidence, verifyRecords } from './verify.js';
import { HttpError } from './errors.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

// extractPage(prompt) does the LLM call; it's injected so tests can fake it.
// crm = { store, sites, jobs, llm? } enables the CRM structure config routes
// (llm: the mapper's LLM, for mappings run inside the extension).
export function createApp({ extractPage, apiKey = '', model = '', maxPromptChars = 60_000, log = console, crm = null }) {
  const app = express();
  // Re-opening the popup on the same page shouldn't pay for a second LLM call.
  const cache = new Map();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '3mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, model }));

  app.use('/api', (req, res, next) => {
    if (apiKey && !keyMatches(req.get('x-api-key'), apiKey)) {
      return res.status(401).json({ error: 'Wrong server API key. Set it in the extension Settings.' });
    }
    next();
  });

  if (crm) addCrmRoutes(app, crm, log);

  app.post('/api/extract', async (req, res) => {
    const started = Date.now();
    try {
      const payload = parsePayload(req.body);
      const prompt = buildUserPrompt(payload, maxPromptChars);
      const cacheKey = createHash('sha256').update(`${model}\n${prompt}`).digest('hex');

      let extraction = readCache(cache, cacheKey);
      const cached = Boolean(extraction);
      if (!extraction) {
        extraction = cleanExtraction(await extractPage(prompt));
        writeCache(cache, cacheKey, extraction);
      }
      const records = verifyRecords(extraction.records, buildEvidence(payload));

      // Log shape only: no page data in server logs.
      const fields = records.flatMap((r) => r.fields);
      const flagged = fields.filter((f) => f.check !== 'verified').length;
      log.info(
        `[extract] ${hostOf(payload.url)} chars=${prompt.length} records=${records.length} ` +
          `fields=${fields.length} flagged=${flagged} ${Date.now() - started}ms${cached ? ' cached' : ''}`,
      );
      res.json({ pageType: extraction.pageType, dataset: extraction.dataset, records, model, cached });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      log.error(`[extract] ${status} ${error.message}`);
      res.status(status).json({ error: error instanceof HttpError ? error.message : 'Extraction failed on the server.' });
    }
  });

  // Malformed or oversized JSON bodies.
  app.use((error, _req, res, _next) => {
    const tooLarge = error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'This page is too large to send.' : 'Bad request.' });
  });

  return app;
}

// The CRM structure config and the mapping agent's controls.
function addCrmRoutes(app, { store, sites, jobs, llm = null }, log) {
  // The extension polls this; unchanged configs cost a 304.
  app.get('/api/config', (req, res) => {
    const etag = store.etag();
    res.set('etag', etag);
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.json(store.get());
  });

  // The extension reports a page its mapped rules couldn't read; the agent
  // re-maps that page (URL shapes only are logged, no customer data).
  app.post('/api/extraction-failures', (req, res) => {
    const { crmId, pageTypeId, url, missing = [], errors = [] } = req.body ?? {};
    if (!crmId || !url) return res.status(400).json({ error: 'crmId and url are required.' });
    const problems = [...missing.map((key) => `missing ${key}`), ...errors.map((e) => `${e.view}: ${e.error}`)];
    const reason = `extraction failed (${problems.join(', ') || 'unknown'})`;
    log.info(`[failure] ${crmId}/${pageTypeId ?? '?'} ${reason}`);
    res.status(202).json(jobs.enqueueRemap({ crmId, pageTypeId, url, reason }));
  });

  app.get('/api/mapper/status', (_req, res) => {
    // Registry sites plus CRMs mapped from the extension (known only to the store).
    const all = [...sites, ...Object.entries(store.get().crms).filter(([id]) => !sites.some((s) => s.id === id)).map(([id, crm]) => ({ id, name: crm.name }))];
    const crms = all.map((site) => {
      const entry = store.getCrm(site.id);
      return {
        id: site.id,
        name: site.name,
        mappedBy: entry?.mappedBy ?? null,
        targets: datasetsOfCrm(entry ?? site),
        version: entry?.version ?? 0,
        mappedAt: entry?.mappedAt ?? null,
        lastAttempt: entry?.lastAttempt ?? null,
        pageTypes: (entry?.pageTypes ?? []).map((pt) => ({
          id: pt.id,
          role: pt.role ?? 'record',
          entity: pt.entity ?? null,
          dataset: pt.dataset ?? null,
          views: (pt.views ?? []).map((v) => v.name),
          ok: pt.validation?.ok ?? false,
        })),
      };
    });
    res.json({ crms, jobs: jobs.status() });
  });

  app.post('/api/mapper/run', (req, res) => {
    const { crmId } = req.body ?? {};
    res.status(202).json(jobs.enqueueFull(crmId, 'requested from the extension'));
  });

  // --- the mapping agent running inside the extension (the user's signed-in
  // browser does the browsing; the server does the LLM calls and keeps the
  // config) ---------------------------------------------------------------
  if (llm) {
    app.post('/api/mapper/classify', async (req, res) => {
      try {
        // The extension sends kinds of page ({ urls: [...] }), not single pages.
        const pages = (req.body?.pages ?? []).slice(0, 60).map((p) => ({ url: String(p.url ?? p.urls?.[0] ?? ''), title: String(p.title ?? ''), text: String(p.text ?? '').slice(0, 1500), rowGroups: p.rowGroups ?? [] }));
        const datasets = Array.isArray(req.body?.datasets) ? req.body.datasets.map(String).slice(0, 20) : undefined;
        res.json(await llm.classifyPages(pages, { datasets }));
      } catch (error) {
        res.status(502).json({ error: error.message });
      }
    });
    // Click-driven CRMs: what to click next, and what a grid's columns are.
    app.post('/api/mapper/choose-clicks', async (req, res) => {
      try {
        const body = req.body ?? {};
        const clickables = (Array.isArray(body.clickables) ? body.clickables : []).slice(0, 320).map((c) => ({
          id: Number(c.id) || 0,
          text: String(c.text ?? '').slice(0, 60),
          role: String(c.role ?? '').slice(0, 20),
          area: String(c.area ?? '').slice(0, 20),
          expanded: typeof c.expanded === 'boolean' ? c.expanded : null,
          selected: Boolean(c.selected),
        }));
        log.info(`[choose-clicks] depth ${(body.path ?? []).length}, ${clickables.length} clickable`);
        res.json(
          await llm.chooseClicks({
            datasets: Array.isArray(body.datasets) ? body.datasets.map(String).slice(0, 20) : undefined,
            path: (Array.isArray(body.path) ? body.path : []).slice(0, 12).map((p) => String(p).slice(0, 60)),
            found: (Array.isArray(body.found) ? body.found : []).slice(0, 40).map((p) => String(p).slice(0, 80)),
            text: String(body.text ?? '').slice(0, 6000),
            clickables,
          }),
        );
      } catch (error) {
        res.status(502).json({ error: error.message });
      }
    });
    app.post('/api/mapper/map-columns', async (req, res) => {
      try {
        const body = req.body ?? {};
        const headers = (Array.isArray(body.headers) ? body.headers : []).slice(0, 60).map((h) => String(h).slice(0, 80));
        const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 5).map((r) => (Array.isArray(r) ? r : []).slice(0, 60).map((c) => String(c).slice(0, 120)));
        log.info(`[map-columns] ${headers.length} columns`);
        res.json(await llm.mapColumns({ dataset: String(body.dataset ?? ''), headers, rows }));
      } catch (error) {
        res.status(502).json({ error: error.message });
      }
    });
    app.post('/api/mapper/map-view', async (req, res) => {
      try {
        const { frames = [], label = '', askSections = false, mode = 'record', nudge = '', target = '' } = req.body ?? {};
        const safeFrames = frames.slice(0, 10).map((f) => ({ index: Number(f.index) || 0, url: String(f.url ?? ''), text: String(f.text ?? '').slice(0, 150_000) }));
        log.info(`[map-view] ${hostOf(safeFrames[0]?.url)} ${mode} "${label}" ${safeFrames.reduce((n, f) => n + f.text.length, 0)} chars`);
        res.json(await llm.mapView(safeFrames, { label, askSections: Boolean(askSections), mode: mode === 'message' ? 'message' : 'record', nudge: String(nudge), target: String(target) }));
      } catch (error) {
        res.status(502).json({ error: error.message });
      }
    });
  }
  // A mapping the extension produced. The site is registered if unknown, so
  // failure reports and the settings page know it; its sign-in stays with
  // the user's browser (no server-side login steps).
  app.post('/api/config/mapping', (req, res) => {
    const { site, pageTypes, reason = 'extension', replaceAll = true, mappedBy = 'extension' } = req.body ?? {};
    if (!site?.id || !site?.match?.hosts?.length || !Array.isArray(pageTypes)) return res.status(400).json({ error: 'site {id, name, match.hosts} and pageTypes are required.' });
    const known = sites.find((s) => s.id === site.id);
    const targets = Array.isArray(site.targets) ? site.targets.map(String).slice(0, 20) : undefined;
    if (!known) sites.push({ id: site.id, name: site.name || site.id, match: site.match, startUrl: site.startUrl, targets, login: null, mappedFrom: 'extension' });
    else if (targets) known.targets = targets;
    const entry = store.saveMapping({ id: site.id, name: site.name || site.id, match: site.match, startUrl: site.startUrl, targets }, pageTypes, { reason, mappedBy, replaceAll });
    log.info(`[config] ${site.id} v${entry.version} saved from the extension (${pageTypes.map((pt) => pt.id).join(', ')})`);
    res.json({ version: entry.version, pageTypes: entry.pageTypes.map((pt) => pt.id) });
  });
  app.post('/api/config/failed-attempt', (req, res) => {
    const { site, reason = 'extension', error = 'unknown' } = req.body ?? {};
    if (!site?.id) return res.status(400).json({ error: 'site.id is required.' });
    store.recordFailedAttempt({ id: site.id, name: site.name || site.id, match: site.match ?? { hosts: [] } }, { reason, error });
    res.json({ ok: true });
  });
}

function keyMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const strings = (list) => (Array.isArray(list) ? list?.map(String).filter(Boolean).slice(0, 20) : []);

function parsePayload(body) {
  if (!body || !Array.isArray(body.frames) || !body.frames.length) {
    throw new HttpError(400, 'The request had no page content.');
  }
  return {
    url: String(body.url ?? ''),
    title: String(body.title ?? ''),
    targets: Array.isArray(body.targets) ? body.targets.map(String).slice(0, 20) : [],
    selection: String(body.selection ?? ''),
    frames: body.frames.slice(0, 20)?.map((f) => ({
      url: String(f?.url ?? ''),
      isTop: Boolean(f?.isTop),
      text: String(f?.text ?? ''),
      phones: strings(f?.phones),
      emails: strings(f?.emails),
    })),
  };
}

const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// Model output -> { pageType, records: [{ fields: [{ key, label, value }] }] }
// with safe, unique keys, no empty values and bounded sizes.
function cleanExtraction(raw) {
  const labels = new Map();
  for (const field of Array.isArray(raw?.fields) ? raw.fields : []) {
    const key = toKey(field?.key);
    if (key && !labels.has(key)) labels.set(key, text(field?.label, 80));
  }
  const records = [];
  for (const record of (Array.isArray(raw?.records) ? raw.records : []).slice(0, MAX_RECORDS)) {
    const seen = new Set();
    const fields = [];
    for (const item of Array.isArray(record?.values) ? record.values : []) {
      const key = toKey(item?.key);
      const value = text(item?.value, 2000);
      if (!key || !value || seen.has(key)) continue;
      seen.add(key);
      fields.push({ key, label: labels.get(key) || humanize(key), value });
      if (fields.length === MAX_FIELDS_PER_RECORD) break;
    }
    if (fields.length) records.push({ fields });
  }
  return { pageType: text(raw?.page_type, 80), dataset: DATASET_IDS.includes(raw?.dataset) ? raw.dataset : 'other', records };
}

function readCache(cache, key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.extraction;
}

function writeCache(cache, key, extraction) {
  cache.set(key, { at: Date.now(), extraction });
  if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown-host';
  }
}
