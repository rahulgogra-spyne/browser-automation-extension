// Map CRMs from the command line (the server does the same on a schedule):
//   npm run map                        every CRM in config/crm-sites.json
//   npm run map -- cdk                 one CRM
//   npm run map -- cdk --url <url>     re-map only the page type behind <url>
//   npm run map -- --new <startUrl>    a CRM not in the registry yet: opens a
//                                      visible browser, lets you sign in by
//                                      hand, maps it, and adds it to the
//                                      registry (with a manual sign-in step)
//   add --headed to watch the browser
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConfigStore } from '../crm/config-store.js';
import { loadSites } from '../crm/sites.js';
import { createMapperLLM } from './llm.js';
import { mapCrm } from './agent.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const ids = args.filter((a, i) => !a.startsWith('--') && !['--url', '--new'].includes(args[i - 1]));

const { OPENAI_API_KEY, OPENAI_MODEL, MAPPER_MODEL, CRM_CONFIG_PATH, CRM_SITES_PATH } = process.env;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set (see backend/.env.example).');
  process.exit(1);
}

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const sitesPath = CRM_SITES_PATH || root('config/crm-sites.json');
const store = createConfigStore(CRM_CONFIG_PATH || root('config/crm-structures.json'));
let sites = loadSites(sitesPath);
const llm = createMapperLLM({ apiKey: OPENAI_API_KEY, model: MAPPER_MODEL || OPENAI_MODEL || 'gpt-4.1-mini' });

// --new: a site entry made from the URL, signed in by hand.
let headless = !flag('--headed');
const newUrl = option('--new');
if (newUrl) {
  const { host } = new URL(newUrl);
  const id = host.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const site = {
    id,
    name: host,
    match: { hosts: [host] },
    startUrl: newUrl,
    login: { url: newUrl, steps: [{ manual: `Sign in to ${host} in the browser window (and get past any first-time screens).` }] },
    crawl: { maxPages: 16, perPattern: 2 },
  };
  sites = [...sites.filter((s) => s.id !== id), site];
  const registry = JSON.parse(readFileSync(sitesPath, 'utf8'));
  registry.sites = [...registry.sites.filter((s) => s.id !== id), site];
  writeFileSync(sitesPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`Added "${id}" to ${sitesPath}. Replace its manual sign-in step with fill/click steps for unattended re-maps.`);
  ids.push(id);
  headless = false;
}

let failed = false;
for (const site of sites.filter((s) => !ids.length || ids.includes(s.id))) {
  try {
    await mapCrm({ site, llm, store, onlyUrl: option('--url'), reason: 'cli', headless });
  } catch (error) {
    failed = true;
    console.error(error.message);
  }
}
console.log(`Config: ${store.path}`);
process.exit(failed ? 1 : 0);
