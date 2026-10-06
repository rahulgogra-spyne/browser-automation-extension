// Runs in the page's own world (not the extension's isolated one) to find
// elements that frameworks made clickable without any trace in the DOM: a
// React onClick, a Vue listener, a jQuery handler, an onclick property. The
// extension's runtime cannot see those, so this marks them with an
// attribute (attributes are shared between worlds): data-cm-click="1".
// Idempotent; re-run after the page changes.
(() => {
  const MARK = 'data-cm-click';
  const HANDLER = /^on(click|mousedown|mouseup|pointerdown|pointerup|touchstart|touchend)$/i;
  const jq = window.jQuery && typeof window.jQuery._data === 'function' ? window.jQuery : null;

  const handled = (el) => {
    if (typeof el.onclick === 'function' || typeof el.onmousedown === 'function' || typeof el.onpointerdown === 'function') return true;
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')) {
        const props = el[key];
        if (props && Object.keys(props).some((k) => HANDLER.test(k) && typeof props[k] === 'function')) return true;
      } else if (key === '_vei') {
        // Vue 3 keeps its listeners here (onClick: invoker).
        const listeners = el[key];
        if (listeners && Object.keys(listeners).some((k) => HANDLER.test(k) && listeners[k])) return true;
      }
    }
    if (jq) {
      const events = jq._data(el, 'events');
      if (events && (events.click || events.mousedown || events.mouseup)) return true;
    }
    return false;
  };

  // Every element, inside open shadow roots too (closed ones are out of reach from the page's world).
  const all = [];
  const collect = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (all.length >= 12000) return;
      all.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };
  collect(document);
  const limit = all.length;
  for (let i = 0; i < limit; i++) {
    const el = all[i];
    if (el === document.documentElement || el === document.body) continue;
    let has = false;
    try {
      has = handled(el);
    } catch {
      has = false;
    }
    if (has) el.setAttribute(MARK, '1');
    else if (el.hasAttribute(MARK)) el.removeAttribute(MARK);
  }
})();
