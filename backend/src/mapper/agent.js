// Server-side mapping: the shared agent (extension/lib/mapper/agent.js)
// driving a Playwright browser that signs in with the site's configured
// steps. Used for CRMs whose credentials the server holds; CRMs the user is
// already signed in to are mapped from the extension instead.
import { mapCrm as run } from '../../../extension/lib/mapper/agent.js';
import { openBrowser, openSession, playwrightAdapter } from './browser.js';

export { MESSAGE_ENTITIES } from '../../../extension/lib/mapper/agent.js';
import { DATASETS, datasetsFrom, datasetsOfCrm } from '../../../extension/lib/mapper/datasets.js';

export { DATASETS };

// The kinds of data to map: asked for, else the site's (crm-sites.json
// "targets"), else what its saved layout covers, else every kind.
export async function mapCrm({ site, llm, store, log = console.log, onlyUrl = null, reason = 'manual', headless = true, targets }) {
  const ids = targets ?? site.targets ?? (site.target ? [site.target] : null) ?? datasetsOfCrm(store.getCrm(site.id));
  const datasets = datasetsFrom(ids).length ? datasetsFrom(ids) : Object.values(DATASETS);
  const browser = await openBrowser({ headless });
  try {
    const { page } = await openSession(browser, site);
    return await run({ site, llm, store, adapter: playwrightAdapter(page, site), log, onlyUrl, reason, mappedBy: 'mapper-agent', datasets });
  } finally {
    await browser.close();
  }
}
