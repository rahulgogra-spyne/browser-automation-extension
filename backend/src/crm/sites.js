import { readFileSync } from 'node:fs';

// The site registry (config/crm-sites.json): which CRMs the agent maps and
// how to reach them.
export function loadSites(path) {
  const { sites } = JSON.parse(readFileSync(path, 'utf8'));
  for (const site of sites) {
    if (!site.id || !site.startUrl || !site.match?.hosts?.length) {
      throw new Error(`${path}: every site needs id, startUrl and match.hosts (problem with ${JSON.stringify(site.id)})`);
    }
  }
  return sites;
}
