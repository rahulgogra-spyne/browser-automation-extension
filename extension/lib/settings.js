export const DEFAULT_SETTINGS = {
  backendUrl: 'http://localhost:8787',
  apiKey: '',
  capturedBy: '',
  defaultDealerName: '',
  downloadFolder: 'SpyneLeads',
  filePrefix: 'leads',
  // The kinds of data to map and capture (lib/mapper/datasets.js): each goes
  // to its own daily file.
  captureTargets: ['users', 'customers', 'deals', 'appointments', 'tasks', 'vehicles'],
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
