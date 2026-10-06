// A click that opens its page in a new tab or window (window.open, a
// target="_blank" link: a launcher's application cards often do this) would
// leave the work tab where it was. The work stays in one tab: the new tab's
// address is noted, the new tab closed, and the caller loads the address in
// the work tab (the browser's signed-in session goes with it).
//
// Which tab opened which is told by webNavigation: a tab's openerTabId names
// the window's active tab when the opener is a tab in the background.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const opened = []; // { sourceTabId, tabId, url, at }

chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url, timeStamp }) => {
  opened.push({ sourceTabId, tabId, url, at: timeStamp });
  if (opened.length > 50) opened.shift();
});

// The address a tab that tabId opened leads to, after closing that tab; null
// when tabId opened none.
export async function adoptOpenedTab(tabId) {
  const index = opened.findIndex((o) => o.sourceTabId === tabId);
  if (index < 0) return null;
  const [entry] = opened.splice(index, 1);
  let url = entry.url || '';
  // Its address may only arrive a moment later (window.open('') then a redirect).
  for (let i = 0; i < 40 && !/^https?:/i.test(url); i++) {
    await sleep(250);
    const now = await chrome.tabs.get(entry.tabId).catch(() => null);
    if (!now) break;
    url = now.pendingUrl || now.url || '';
  }
  await chrome.tabs.remove(entry.tabId).catch(() => {});
  return /^https?:/i.test(url) ? url : null;
}
