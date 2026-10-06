// The shared agent's browser adapter over Chrome extension APIs: pages are
// background tabs in the user's own browser, so whatever CRM the user is
// signed in to can be mapped without any credentials. The in-page runtime is
// injected into every frame after each navigation.
import { hostAllowed } from './agent.js';
import { followScriptLinks } from '../follow-links.js';
import { adoptOpenedTab } from '../opened-tabs.js';

const RUNTIME = ['content/crm-runtime.js'];
const MARKER = ['content/mark-handlers.js']; // runs in the page's world: finds framework click handlers
const LOAD_TIMEOUT_MS = 30_000;

function waitForTabLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (id, info) => id === tabId && info.status === 'complete' && done();
    const timer = setTimeout(() => done(new Error('the page took too long to load')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(
      (tab) => tab.status === 'complete' && done(),
      () => done(new Error('the tab is gone')),
    );
  });
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: RUNTIME });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: RUNTIME }).catch(() => {});
  }
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: MARKER, world: 'MAIN' }).catch(() => {});
}

export function chromeAdapter(site, { onProgress = () => {}, windowId = null } = {}) {
  const hosts = site.match.hosts;

  async function settle(tab, { minMs = 0 } = {}) {
    await followScriptLinks(tab.id); // a javascript: link the last click only marked
    await inject(tab.id);
    await chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, func: (minMs) => window.__crmRuntime?.waitQuiet({ quietMs: 1000, timeoutMs: 20000, minMs }), args: [minMs] })
      .catch(() => {});
    // Again now that the page has drawn what it fetched: a launcher's cards
    // arrive after load, and their click handlers must be marked too.
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: MARKER, world: 'MAIN' }).catch(() => {});
  }

  // Navigates and waits for the NEW page to load: a tab that was "complete"
  // before the navigation would otherwise look loaded at once. A hash change
  // starts no load, so after 1.5 s without one we carry on.
  async function goto(tab, url) {
    onProgress(`Opening ${url}`);
    let started = false;
    const onUpdated = (id, info) => {
      if (id === tab.id && (info.status === 'loading' || info.url)) started = true;
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    try {
      await chrome.tabs.update(tab.id, { url });
      const t0 = Date.now();
      while (!started && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 50));
      if (started) await waitForTabLoad(tab.id);
    } finally {
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }
    // A hash change loads nothing, but the app usually fetches new data now.
    await settle(tab, { minMs: started ? 0 : 1500 });
  }

  return {
    async open(url) {
      const inWindow = windowId && (await chrome.windows.get(windowId).catch(() => null)) ? { windowId } : {};
      const tab = await chrome.tabs.create({ url, active: false, ...inWindow });
      await waitForTabLoad(tab.id);
      await settle(tab);
      return tab;
    },
    goto,
    url: async (tab) => (await chrome.tabs.get(tab.id)).url,
    title: async (tab) => (await chrome.tabs.get(tab.id)).title ?? '',
    async frames(tab) {
      const all = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) ?? [];
      const out = [];
      for (const f of all) {
        let host;
        try {
          const url = new URL(f.url);
          if (!/^https?:$/.test(url.protocol)) continue;
          host = url.host;
        } catch {
          continue;
        }
        if (f.frameId !== 0) {
          // A frame with no address of its own (srcdoc, about:blank written in
          // by script) is read as part of its page.
          const [inline] = await chrome.scripting
            .executeScript({ target: { tabId: tab.id, frameIds: [f.frameId] }, func: () => window.__crmRuntime?.inlineFrame ?? false })
            .catch(() => []);
          if (inline?.result) continue;
        }
        if (!hostAllowed(host, hosts)) {
          // Another host: only a frame large enough to be the app (not a
          // tracker, a chat bubble or a hidden helper frame).
          const [size] = await chrome.scripting
            .executeScript({ target: { tabId: tab.id, frameIds: [f.frameId] }, func: () => [window.innerWidth, window.innerHeight, document.visibilityState] })
            .catch(() => []);
          const [width, height] = size?.result ?? [0, 0];
          if (width < 400 || height < 300) continue;
        }
        out.push({ id: f.frameId, url: f.url, main: f.frameId === 0, external: !hostAllowed(host, hosts) });
      }
      return out;
    },
    async evaluate(tab, frameId, fn, arg) {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, func: fn, args: arg === undefined ? [] : [arg] });
      return result?.result;
    },
    settle,
    // Like goto, for a page that is already loaded and was just clicked in:
    // waits for whatever the click started (a fetch, a frame load) to finish.
    afterClick: async (tab) => {
      await settle(tab, { minMs: 1200 });
      // The click opened its page in a new tab (an application card): load it here instead.
      const opened = await adoptOpenedTab(tab.id);
      if (opened) {
        onProgress(`The click opened ${opened} in a new tab; continuing there in this tab`);
        await goto(tab, opened);
        return;
      }
      await settle(tab, { minMs: 300 }); // a frame the click replaced is waited for here
    },
    close: (tab) => chrome.tabs.remove(tab.id).catch(() => {}),
  };
}
