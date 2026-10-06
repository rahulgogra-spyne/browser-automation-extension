export const DEFAULT_SETTINGS = {
  capturedBy: '',
  defaultDealerName: '',
  downloadFolder: 'SpyneLeads',
  filePrefix: 'leads',
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
