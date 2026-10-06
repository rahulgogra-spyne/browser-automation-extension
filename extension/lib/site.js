// Names the source for the "site" CSV column. Known CRMs get their product
// name; everything else is its hostname. Add patterns as new CRMs show up.
const KNOWN_SITES = [
  { name: 'VinSolutions', host: /(^|\.)vinsolutions\.com$/i },
  { name: 'eLeads', host: /(^|\.)(eleadcrm|cdkunify)\.com$/i },
  { name: 'DriveCentric', host: /(^|\.)drivecentric\.(com|io)$/i },
  { name: 'DealerSocket', host: /(^|\.)dealersocket\.com$/i },
  { name: 'Tekion', host: /(^|\.)tekion(cloud)?\.(com|xyz)$/i },
  { name: 'Salesforce', host: /(^|\.)(salesforce|force)\.com$/i },
  { name: 'HubSpot', host: /(^|\.)hubspot\.com$/i },
];

export function detectSite(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  // host keeps a non-default port, so two local apps don't look alike
  return KNOWN_SITES.find((site) => site.host.test(parsed.hostname))?.name ?? parsed.host.replace(/^www\./, '');
}
