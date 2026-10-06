// The CRM structure config: one JSON file holding every mapped CRM's page
// types, tabs and extraction rules. The mapping agent writes it; the
// extension downloads it (GET /api/config) and extracts without AI.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const EMPTY = { schemaVersion: 1, updatedAt: null, crms: {} };

export function createConfigStore(path) {
  let data = load();

  function load() {
    try {
      return { ...EMPTY, ...JSON.parse(readFileSync(path, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Can't read ${path}: ${error.message}`);
      return structuredClone(EMPTY);
    }
  }

  // Write to a temp file then rename, so readers never see half a file.
  function save() {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, path);
  }

  return {
    path,
    get: () => data,
    etag: () => `"${createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16)}"`,
    getCrm: (id) => data.crms[id] ?? null,

    // pageTypes replace the CRM's page types with the same id; with
    // replaceAll every other page type is dropped too (full re-map).
    saveMapping(site, pageTypes, { reason, mappedBy, replaceAll }) {
      const previous = data.crms[site.id];
      const kept = replaceAll ? [] : (previous?.pageTypes ?? []).filter((pt) => !pageTypes.some((n) => n.id === pt.id));
      const now = new Date().toISOString();
      const version = (previous?.version ?? 0) + 1;
      data.crms[site.id] = {
        name: site.name,
        match: site.match,
        ...(site.startUrl || previous?.startUrl ? { startUrl: site.startUrl || previous.startUrl } : {}),
        ...(site.targets?.length || previous?.targets?.length ? { targets: site.targets?.length ? site.targets : previous.targets } : {}),
        version,
        mappedAt: now,
        mappedBy,
        pageTypes: [...kept, ...pageTypes],
        history: [
          { version, mappedAt: now, reason, pageTypes: pageTypes.map((pt) => pt.id) },
          ...(previous?.history ?? []),
        ].slice(0, 20),
        lastAttempt: { at: now, ok: true, reason },
      };
      data.updatedAt = now;
      save();
      return data.crms[site.id];
    },

    // A mapping run that didn't produce a usable result: keep the old rules.
    recordFailedAttempt(site, { reason, error }) {
      const previous = data.crms[site.id];
      const attempt = { at: new Date().toISOString(), ok: false, reason, error };
      data.crms[site.id] = previous
        ? { ...previous, lastAttempt: attempt }
        : { name: site.name, match: site.match, version: 0, mappedAt: null, pageTypes: [], history: [], lastAttempt: attempt };
      save();
    },
  };
}
