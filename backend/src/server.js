import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createOpenAIExtractor } from './openai-extractor.js';
import { createConfigStore } from './crm/config-store.js';
import { loadSites } from './crm/sites.js';
import { createMapperLLM } from './mapper/llm.js';
import { createJobs } from './mapper/jobs.js';
import { mapCrm } from './mapper/agent.js';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
// Empty values in .env mean "use the default".
const env = (name, fallback = '') => process.env[name] || fallback;
const OPENAI_API_KEY = env('OPENAI_API_KEY');
const OPENAI_MODEL = env('OPENAI_MODEL', 'gpt-4.1-mini');
const MAPPER_MODEL = env('MAPPER_MODEL', OPENAI_MODEL);
const EXTENSION_API_KEY = env('EXTENSION_API_KEY');
const PORT = env('PORT', '8787');
const HOST = env('HOST', '127.0.0.1');
const MAX_PROMPT_CHARS = env('MAX_PROMPT_CHARS', '60000');
const CRM_CONFIG_PATH = env('CRM_CONFIG_PATH', root('config/crm-structures.json'));
const CRM_SITES_PATH = env('CRM_SITES_PATH', root('config/crm-sites.json'));
const MAPPER_SCHEDULE = env('MAPPER_SCHEDULE', 'on');
const MAP_INTERVAL_HOURS = env('MAP_INTERVAL_HOURS', '24');

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const store = createConfigStore(CRM_CONFIG_PATH);
const sites = loadSites(CRM_SITES_PATH);
const llm = createMapperLLM({ apiKey: OPENAI_API_KEY, model: MAPPER_MODEL });
const jobs = createJobs({
  sites,
  store,
  intervalHours: Number(MAP_INTERVAL_HOURS),
  runJob: (job) =>
    mapCrm({
      site: job.site,
      llm,
      store,
      onlyUrl: job.type === 'remap' ? job.url : null,
      reason: job.reason,
      log: (line) => console.log(`[mapper] ${line}`),
    }),
});

const app = createApp({
  extractPage: createOpenAIExtractor({ apiKey: OPENAI_API_KEY, model: OPENAI_MODEL }),
  apiKey: EXTENSION_API_KEY,
  model: OPENAI_MODEL,
  maxPromptChars: Number(MAX_PROMPT_CHARS),
  crm: { store, sites, jobs, llm },
});

app.listen(Number(PORT), HOST, () => {
  console.log(`Extraction server on http://${HOST}:${PORT} (model ${OPENAI_MODEL})`);
  console.log(`CRM config: ${CRM_CONFIG_PATH} (${Object.keys(store.get().crms).length} CRMs mapped)`);
  if (!EXTENSION_API_KEY) console.log('EXTENSION_API_KEY is empty: any caller can use this server.');
  if (MAPPER_SCHEDULE !== 'off') {
    console.log(`Mapping agent: re-maps each CRM every ${MAP_INTERVAL_HOURS}h and on reported failures.`);
    jobs.startSchedule();
  }
});
