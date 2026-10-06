// A javascript: link (an ASP.NET __doPostBack pager, a script-driven menu)
// does nothing when clicked from the extension's isolated world, so the
// in-page runtime only marks it (data-cm-follow, see press() in
// content/crm-runtime.js). This clicks it from the page's own world.

// Runs in the page's world: clicks the marked link, if any (open shadow roots included).
function clickMarkedLink() {
  const find = (root) => {
    const hit = root.querySelector('[data-cm-follow]');
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      const inner = el.shadowRoot && find(el.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  const link = find(document);
  if (!link) return false;
  link.removeAttribute('data-cm-follow');
  link.click();
  return true;
}

// Follows a marked link in any frame of the tab and waits for the page load
// it may start (a postback). Whether there was one.
export async function followScriptLinks(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: clickMarkedLink }).catch(() => []);
  if (!results.some((r) => r.result)) return false;
  await new Promise((resolve) => setTimeout(resolve, 300));
  if ((await chrome.tabs.get(tabId)).status === 'loading') {
    await new Promise((resolve) => {
      const timer = setTimeout(done, 25_000);
      function done() {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
      const onUpdated = (id, info) => id === tabId && info.status === 'complete' && done();
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }
  return true;
}
