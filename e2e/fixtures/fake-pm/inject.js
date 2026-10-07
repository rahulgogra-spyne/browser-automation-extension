// Like a password manager's inline menu: this extension's own page in an iframe, 1.5s after load,
// on the sign-in page and on any page with ?pm in its URL.
if (location.pathname === '/login' || location.search.includes('pm')) {
  setTimeout(() => {
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('popup.html');
    f.id = 'fake-pm';
    f.style = 'position:fixed;top:10px;left:40%;width:320px;height:60px;border:0;z-index:99999';
    document.documentElement.append(f);
  }, 1500);
}
