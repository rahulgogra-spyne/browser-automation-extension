// The LLM and the config store, as the shared agent expects them, backed by
// the server: it holds the OpenAI key and the CRM structure config; the
// browsing happens here in the user's browser.

export function remoteLLM(backend) {
  return {
    model: 'server',
    classifyPages: (pages) => backend('POST', '/api/mapper/classify', { pages }),
    mapView: (frames, opts) => backend('POST', '/api/mapper/map-view', { frames, ...opts }),
    chooseClicks: (input) => backend('POST', '/api/mapper/choose-clicks', input),
    mapColumns: (input) => backend('POST', '/api/mapper/map-columns', input),
  };
}

export function remoteStore(backend, getConfig) {
  return {
    async getCrm(id) {
      const config = await getConfig({ force: true });
      return config?.crms?.[id] ?? null;
    },
    saveMapping: (site, pageTypes, { reason, mappedBy, replaceAll }) =>
      backend('POST', '/api/config/mapping', { site: { ...site, crawl: undefined }, pageTypes, reason, mappedBy, replaceAll }),
    recordFailedAttempt: (site, { reason, error }) => backend('POST', '/api/config/failed-attempt', { site, reason, error }),
  };
}
