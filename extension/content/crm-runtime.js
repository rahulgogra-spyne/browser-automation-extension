// In-page runtime shared by the extension (injected into CRM pages) and the
// backend mapping agent (injected into its headless browser). Plain script,
// no imports; it installs window.__crmRuntime once per frame.
//
// Mapping side: snapshot() prints a compact DOM with an id per element for
// the LLM; describe*() turn the elements the LLM picked into rules.
// Extraction side: extractPage(pageType) follows those rules (click each tab,
// wait for it, read fields and repeated entries) with no AI involved.
//
// A rule finds one element and reads it:
//   { css }            CSS selector (":scope" = the entry itself in a collection)
//   { label }          the value next to a visible label, e.g. "Cell Phone:"
//   + attr             read this attribute instead of the text
//   + regex            one capture group pulls the value out of the text
// A selector reaches into a web component's shadow root with " >>> ":
//   "records-record-layout >>> div.slds-form-element > span"
(() => {
  const RUNTIME_VERSION = 3;
  if (window.__crmRuntime?.version >= RUNTIME_VERSION) return;

  const STABLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-field', 'data-key', 'data-name', 'data-label', 'name', 'aria-label'];
  // Record-specific or generated tokens: long numbers, framework prefixes, hex hashes.
  const UNSTABLE = /\d{4,}|^(ember|react-|ng-|mui-|css-|sc-|jsx-|svelte-)|\b[0-9a-f]{8,}\b/i;
  // A random-looking piece of an id or class ("last_name_pq6dxjzw-main",
  // "phone_work_onjmax99"): letters mixed with 2+ digits, no vowels, or
  // several rare letters. "lblAddress1" and "first_name-main" pass.
  const randomSegment = (seg) =>
    seg.length >= 6 &&
    /^[a-z0-9]+$/i.test(seg) &&
    (((seg.match(/\d/g) || []).length >= 2 && /[a-z]/i.test(seg)) || !/[aeiouy]/i.test(seg) || (seg.match(/[xqzj]/gi) || []).length >= 2);
  // Classes that describe state, not identity.
  const STATE_CLASS = /(^|[-_])(is|has)[-_]|active|selected|current|open|expanded|collapsed|hidden|disabled|focus|hover|highlight|visible|loading|error|invalid|valid|odd|even|first|last|dirty|touched/i;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'FRAME', 'HEAD', 'META', 'LINK', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO']);
  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const SHOWN_ATTRS = ['role', 'name', 'type', 'for', 'title', 'aria-label', 'aria-selected', 'data-testid', 'data-field', 'data-direction', 'data-dir', 'data-channel', 'data-type'];
  const CLICKABLE = 'a,button,[role="tab"],[onclick],li';
  const URL_ATTR = /^(href|src|data-href|data-url|data-link)$/i;
  // Where a script-driven element navigates to: location.href = '…', window.open('…'), …
  const ONCLICK_URL = /(?:location(?:\.href)?\s*=\s*|window\.open\(\s*|location\.(?:assign|replace)\(\s*|\.href\s*=\s*)['"]([^'"]+)['"]/;

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const absoluteUrl = (value) => {
    try {
      return new URL(value, location.href).href;
    } catch {
      return value;
    }
  };
  const normLabel = (s) => clean(s).replace(/[:*]+$/, '').trim().toLowerCase();
  // Tab captions often carry counts ("Texting (5)") that change per record.
  const tabCaption = (s) => clean(String(s ?? '').replace(/\(\s*\d+\s*\)|\b\d+\b/g, ' '));
  const isStable = (s) => Boolean(s) && s.length <= 60 && !UNSTABLE.test(s) && !s.split(/[_-]+/).some(randomSegment);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cssString = (v) => v.replace(/["\\]/g, '\\$&');

  // -------------------------------------------------------------- shadow DOM
  //
  // Web-component CRMs (Salesforce Lightning and the like) keep their content
  // in shadow roots, which querySelector, closest() and MutationObserver on
  // the document never enter. Closed roots are reachable from the extension
  // (chrome.dom), not from the backend's browser.
  //
  // A frame with no address of its own (srcdoc, or about:blank written in by
  // script: how email viewers often show a message's body) is treated the
  // same way: its document is read as part of the page, " >>> " stepping into
  // it like into a shadow root. Frames with an address are read on their own.

  const SHADOW_STEP = /\s*>>>\s*/;

  // A frame element with no address of its own: srcdoc, no src, or about:…
  // (its document's URL says nothing: document.open() gives it the page's).
  const isInlineFrame = (el) => {
    const src = el.getAttribute('src');
    return el.hasAttribute('srcdoc') || !src || /^\s*about:/i.test(src);
  };

  // The document of a same-origin frame that has no address of its own, or null.
  function inlineFrameDoc(el) {
    if (!isInlineFrame(el)) return null;
    try {
      return el.contentDocument?.documentElement ? el.contentDocument : null;
    } catch {
      return null; // a sandbox without allow-same-origin
    }
  }

  // This frame is such a frame: its page reads it, so it is not read on its own.
  const INLINE_FRAME = (() => {
    try {
      return window !== window.top && Boolean(window.frameElement) && isInlineFrame(window.frameElement);
    } catch {
      return false;
    }
  })();

  // What " >>> " steps into from el: its shadow root, or an inline frame's document.
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return inlineFrameDoc(el);
    if (!el.localName?.includes('-')) return null; // closed roots live on custom elements
    try {
      return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) ?? null;
    } catch {
      return null;
    }
  }

  // The element above the top of a shadow root (its host) or of an inline
  // frame's document (the frame), or null. Node types, not instanceof: an
  // inline frame's nodes come from another window.
  function hostAbove(node) {
    if (node.parentElement) return null;
    const up = node.parentNode;
    if (up?.nodeType === Node.DOCUMENT_FRAGMENT_NODE && up.host) return up.host;
    if (up?.nodeType === Node.DOCUMENT_NODE && up !== document) return up.defaultView?.frameElement ?? null;
    return null;
  }
  // The parent across those boundaries.
  const parentOf = (el) => el.parentElement || hostAbove(el);

  function deepContains(ancestor, el) {
    for (let node = el; node; node = parentOf(node)) if (node === ancestor) return true;
    return false;
  }

  // closest() that carries on outside the shadow root it starts in.
  function deepClosest(el, sel) {
    for (let node = el; node; ) {
      const hit = node.closest(sel);
      if (hit) return hit;
      const root = node.getRootNode();
      if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) node = root.host ?? null;
      else node = root !== document ? root.defaultView?.frameElement ?? null : null;
    }
    return null;
  }

  // Every shadow root under root, nested ones included (root's own too).
  function shadowRoots(root) {
    const out = [];
    const walk = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        const sr = shadowOf(el);
        if (sr) {
          out.push(sr);
          walk(sr);
        }
      }
    };
    const own = root.nodeType === Node.ELEMENT_NODE ? shadowOf(root) : null;
    if (own) {
      out.push(own);
      walk(own);
    }
    walk(root);
    return out;
  }

  // Matches of a plain selector in root and in every shadow tree beneath it.
  function findEverywhere(root, css) {
    const out = [...root.querySelectorAll(css)];
    for (const sr of shadowRoots(root)) out.push(...sr.querySelectorAll(css));
    return out;
  }

  // What a rule's selector finds from scope; " >>> " steps from the hosts
  // matched so far into their shadow roots.
  function queryDeep(scope, sel) {
    const parts = sel.split(SHADOW_STEP);
    if (parts.length === 1) return [...scope.querySelectorAll(sel)];
    let scopes = [scope];
    let found = [];
    for (const [i, part] of parts.entries()) {
      found = [];
      for (const s of scopes) {
        if (part === ':scope') {
          if (s === scope && s.nodeType === Node.ELEMENT_NODE) found.push(s);
        } else found.push(...s.querySelectorAll(part));
      }
      if (i < parts.length - 1) scopes = found.map(shadowOf).filter(Boolean);
    }
    return [...new Set(found)];
  }
  const queryOne = (scope, sel) => queryDeep(scope, sel)[0] ?? null;
  // What a rule's selector names inside root (a record's panel). A chain into
  // shadow roots may start from a host outside root: it is followed from the
  // document, keeping what lies inside root.
  function findIn(root, sel) {
    const el = queryOne(root, sel);
    if (el || root === document || root.nodeType !== Node.ELEMENT_NODE || !SHADOW_STEP.test(sel)) return el;
    return queryDeep(document, sel).find((found) => deepContains(root, found)) ?? null;
  }
  // A whole-page lookup: a chained selector as written, a plain one in any shadow tree.
  const findAll = (css) => (SHADOW_STEP.test(css) ? queryDeep(document, css) : findEverywhere(document, css));

  // An element's text, its shadow roots' included (innerText leaves them out).
  const NOT_TEXT = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'LINK']);
  function deepText(el) {
    const parts = [el.innerText || ''];
    for (const sr of shadowRoots(el)) {
      for (const child of sr.children) if (!NOT_TEXT.has(child.tagName)) parts.push(child.innerText || '');
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  const pageText = () => (document.body ? deepText(document.body) : '');

  // Calls onChange whenever the page changes, inside shadow roots too.
  // refresh() starts watching shadow roots that appeared since.
  function watchChanges(onChange) {
    const observer = new MutationObserver(onChange);
    const opts = { childList: true, subtree: true, characterData: true };
    observer.observe(document.documentElement, opts);
    const roots = new Set();
    const refresh = () => {
      for (const sr of shadowRoots(document)) {
        if (roots.has(sr)) continue;
        roots.add(sr);
        observer.observe(sr, opts);
      }
    };
    refresh();
    return { roots, refresh, stop: () => observer.disconnect() };
  }

  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      if (el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return true;
      return getComputedStyle(el).display === 'contents';
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function ownText(el) {
    let text = '';
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue;
    return clean(text);
  }

  function readValue(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return clean(el.value);
    if (el.tagName === 'SELECT') return clean(el.selectedOptions?.[0]?.text);
    return clean(el.innerText ?? el.textContent);
  }

  // ---------------------------------------------------------------- snapshot

  // Compact DOM for the LLM. Wrappers with no text and a single child are
  // folded away; every printed element gets data-cm="<id>" so the agent can
  // find what the LLM picked. root: a selector; only that element is shown
  // (a record's panel, without the list around it).
  function snapshot({ startId = 1, maxNodes = 3000, root = '' } = {}) {
    findEverywhere(document, '[data-cm]').forEach((el) => el.removeAttribute('data-cm'));
    let budget = maxNodes;

    function visit(el) {
      if (budget <= 0 || !isVisible(el)) return [];
      const shadow = shadowOf(el); // an inline frame's document too, though frames are skipped otherwise
      if (SKIP_TAGS.has(el.tagName.toUpperCase()) && !shadow) return [];
      const children = shadow ? shadow.children : el.tagName === 'SLOT' ? el.assignedElements({ flatten: true }) : el.children;
      const kids = [];
      for (const child of children) kids.push(...visit(child));
      const interesting =
        ownText(el) ||
        INTERACTIVE.has(el.tagName) ||
        el.hasAttribute('role') ||
        el.hasAttribute('onclick') ||
        [...el.attributes].some((a) => a.name.startsWith('data-'));
      if (!interesting && kids.length < 2) return kids;
      budget--;
      return [{ el, kids }];
    }

    function describe(el) {
      let line = el.tagName.toLowerCase();
      if (el.id) line += `#${el.id}`;
      const classes = [...el.classList].slice(0, 4);
      if (classes.length) line += `.${classes.join('.')}`;
      for (const name of SHOWN_ATTRS) {
        const v = el.getAttribute(name);
        if (v) line += `[${name}=${JSON.stringify(v.slice(0, 40))}]`;
      }
      if (el.tagName === 'A' && el.getAttribute('href')) line += `[href=${JSON.stringify(el.getAttribute('href').slice(0, 60))}]`;
      if (el.hasAttribute('onclick')) line += '[onclick]';
      const text = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? readValue(el) : ownText(el);
      return text ? `${line} ${JSON.stringify(text.slice(0, 120))}` : line;
    }

    const lines = [];
    let id = startId;
    const render = (node, depth) => {
      node.el.setAttribute('data-cm', String(id));
      lines.push(`${'  '.repeat(depth)}[${id++}] ${describe(node.el)}`);
      for (const kid of node.kids) render(kid, depth + 1);
    };
    const top = root ? panelOf(root) : document.body || document.documentElement;
    if (top) for (const node of visit(top)) render(node, 0);
    return { text: lines.join('\n'), nextId: id, count: id - startId, truncated: budget <= 0, url: location.href, title: document.title };
  }

  const byMid = (mid) => {
    const sel = `[data-cm="${mid}"]`;
    return document.querySelector(sel) || findEverywhere(document, sel)[0] || null;
  };

  // --------------------------------------------------------------- selectors

  // One step of a selector: the shortest description of this element that
  // tells it apart from its siblings. A stable id wins; then a stable
  // attribute, then classes, adding classes to an attribute that siblings
  // share (every panel has data-test="sub-panel", only one is .History) and
  // nth-of-type as the last resort.
  function stepFor(node, relative) {
    const tag = node.tagName.toLowerCase();
    if (!relative && node.id && isStable(node.id)) return { sel: `#${CSS.escape(node.id)}`, anchor: true };
    const classes = [...node.classList].filter((c) => isStable(c) && !STATE_CLASS.test(c)).slice(0, 3);
    const classSel = classes.map((c) => `.${CSS.escape(c)}`).join('');
    const attr = STABLE_ATTRS.map((name) => [name, node.getAttribute(name)]).find(([, v]) => v && isStable(v));
    const attrSel = attr ? `${tag}[${attr[0]}="${cssString(attr[1])}"]` : '';
    const candidates = [attrSel, attrSel && classSel && attrSel + classSel, classSel && tag + classSel, tag].filter(Boolean);
    const parent = node.parentElement || node.parentNode; // a shadow root has children too
    const siblings = parent?.children ? [...parent.children] : [node];
    for (const sel of candidates) {
      if (siblings.filter((s) => s.matches(sel)).length === 1) return { sel, anchor: false };
    }
    const sameTag = siblings.filter((s) => s.tagName === node.tagName);
    return { sel: `${candidates[0]}:nth-of-type(${sameTag.indexOf(node) + 1})`, anchor: false };
  }

  // Shortest selector (from the element upwards) that finds exactly this
  // element, preferring stable ids, data attributes and classes. With a root
  // element the selector is relative to it (":scope ..."). Inside a shadow
  // root it goes on from the host: "host-el >>> div.field > span".
  function selectorFor(el, root = document) {
    const relative = root !== document;
    if (relative && el === root) return ':scope';
    const scope = relative ? root : document;
    const unique = (sel) => {
      try {
        const found = queryDeep(scope, sel);
        return found.length === 1 && found[0] === el;
      } catch {
        return false;
      }
    };
    const steps = []; // outermost first; null = into the shadow root of the host before it
    const render = (prefix) => {
      const groups = [[]];
      for (const step of steps) step === null ? groups.push([]) : groups.at(-1).push(step);
      const [first, ...rest] = groups.map((g) => g.join(' > '));
      return [relative ? (first ? prefix + first : ':scope') : first, ...rest].join(' >>> ');
    };
    let node = el;
    while (node && node !== scope && node !== document.documentElement) {
      steps.unshift(stepFor(node, relative).sel);
      const candidate = render(':scope ');
      if (unique(candidate)) return candidate;
      const host = hostAbove(node);
      if (host) {
        steps.unshift(null);
        node = host;
      } else node = node.parentElement;
    }
    return render(':scope > ');
  }

  // Selector matching every entry of a list, relative to its container. It
  // goes through the entries' parent (":scope > tbody > tr" skips a table's
  // header row), and uses a class only when it tells entries apart from
  // other children of that parent: zebra classes like rgRow/rgAltRow would
  // otherwise make a one-email example miss every other row.
  function itemSelectorFor(container, items) {
    const first = items[0];
    const tag = first.tagName.toLowerCase();
    const common = [...first.classList].filter(
      (c) => isStable(c) && !STATE_CLASS.test(c) && items.every((item) => item.tagName === first.tagName && item.classList.contains(c)),
    );
    // The entries' parent: an element, or the shadow root of a host (whose
    // top-level children can only be matched as descendants from there).
    const parent = first.parentNode;
    const inShadow = parent?.nodeType === Node.DOCUMENT_FRAGMENT_NODE && Boolean(parent.host);
    const parentEl = inShadow ? parent.host : parent;
    if (!parent || !items.every((item) => item.parentNode === parent) || !(parentEl === container || deepContains(container, parentEl))) {
      return `:scope ${tag}${common.slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('')}`;
    }
    const siblings = [...parent.children].filter((c) => c.tagName === first.tagName);
    const needed = siblings.every((s) => common.every((c) => s.classList.contains(c))) ? [] : common.slice(0, 2);
    const path = parentEl === container ? ':scope' : selectorFor(parentEl, container);
    return `${path} ${inShadow ? '>>>' : '>'} ${tag}${needed.map((c) => `.${CSS.escape(c)}`).join('')}`;
  }

  // Text of the label that sits before a value ("Cell Phone:" -> "Cell Phone").
  function labelFor(el) {
    const asLabel = (node) => {
      const text = clean(node?.innerText ?? node?.textContent);
      if (!text || text.length > 40 || /\d{3,}|@/.test(text) || text.split(' ').length > 5) return '';
      return text.replace(/[:*]+$/, '').trim();
    };
    if (el.labels?.length) return asLabel(el.labels[0]);
    let node = el;
    for (let depth = 0; depth < 3 && node && node !== document.body; depth++) {
      if (node.tagName === 'DD') {
        let dt = node.previousElementSibling;
        while (dt && dt.tagName !== 'DT') dt = dt.previousElementSibling;
        if (dt) return asLabel(dt);
      }
      const label = asLabel(node.previousElementSibling);
      if (label) return label;
      node = parentOf(node);
    }
    return '';
  }

  // The element right after a label is its value slot, even when empty (a
  // customer without a home phone); only climb when the label has no
  // following sibling at all, so an empty value never reads the next row.
  function valueForLabel(labelEl) {
    if (labelEl.tagName === 'LABEL' && labelEl.htmlFor) return labelEl.getRootNode().getElementById?.(labelEl.htmlFor) ?? null;
    let node = labelEl;
    for (let depth = 0; depth < 3 && node; depth++) {
      let next = node.nextElementSibling;
      if (node.tagName === 'DT') while (next && next.tagName !== 'DD') next = next.nextElementSibling;
      if (next) return next;
      node = parentOf(node);
    }
    return null;
  }

  function findByLabel(label, root = document) {
    const want = normLabel(label);
    for (const el of findEverywhere(root, 'td,th,dt,label,span,div,b,strong,p,li,h3,h4,h5,h6')) {
      if (el.children.length > 2 || normLabel(el.textContent) !== want) continue;
      // Use the innermost match: a field wrapper whose value is empty has the
      // same text as its label, and its next sibling is the next field.
      if ([...el.children].some((child) => normLabel(child.textContent) === want)) continue;
      const target = valueForLabel(el);
      if (target) return target;
    }
    return null;
  }

  // ------------------------------------------------------------------- rules

  // labelRoot: where label rules look (a record's panel, so a grid's column
  // header with the same caption is never taken for the label).
  function evalRule(rule, root = document, labelRoot = root) {
    let el = null;
    try {
      if (rule.css === ':scope') el = root === document ? null : root;
      else if (rule.css) el = findIn(root, rule.css);
      else if (rule.label) el = findByLabel(rule.label, labelRoot);
    } catch {
      return '';
    }
    if (!el) return '';
    let value = rule.attr ? clean(el.getAttribute(rule.attr)) : readValue(el);
    if (rule.regex) {
      try {
        const m = value.match(new RegExp(rule.regex, 'i'));
        value = m ? clean(m[1] ?? m[0]) : '';
      } catch {
        value = '';
      }
    }
    // Link attributes come back absolute, so a captured URL can be opened later.
    if (value && (URL_ATTR.test(rule.attr || '') || rule.attr === 'onclick')) value = absoluteUrl(value);
    return value;
  }

  // Rule reading the URL an element navigates to, relative to root.
  function linkRuleFor(el, root) {
    const css = selectorFor(el, root);
    if (el.tagName === 'A' && el.getAttribute('href')) return { css, attr: 'href' };
    for (const attr of ['data-href', 'data-url', 'data-link']) if (el.getAttribute(attr)) return { css, attr };
    if (ONCLICK_URL.test(el.getAttribute('onclick') || '')) return { css, attr: 'onclick', regex: ONCLICK_URL.source };
    return null;
  }

  // The element that carries a navigation: the anchor itself, or the
  // row/card whose onclick or data-href does it.
  const linkCarrier = (el) => deepClosest(el, 'a[href],[data-href],[data-url],[data-link],[onclick]');

  const firstValue = (rules, root, labelRoot = root) => {
    for (const rule of rules || []) {
      const value = evalRule(rule, root, labelRoot);
      if (value) return value;
    }
    return '';
  };

  function readCollection(spec, root = document) {
    let container = root;
    try {
      if (spec.container) container = findIn(root, spec.container);
      if (!container) return [];
      return queryDeep(container, spec.item)
        .map((item) => {
          const entry = {};
          for (const [key, rules] of Object.entries(spec.fields || {})) {
            const value = firstValue(rules, item);
            if (value) entry[key] = value;
          }
          return entry;
        })
        .filter((entry) => Object.keys(entry).length);
    } catch {
      return [];
    }
  }

  function readView(view, root = document, labelRoot = root) {
    const fields = {};
    for (const [key, rules] of Object.entries(view.fields || {})) {
      const value = firstValue(rules, root, labelRoot);
      if (value) fields[key] = value;
    }
    const collections = {};
    for (const [name, spec] of Object.entries(view.collections || {})) collections[name] = readCollection(spec, root);
    return { fields, collections };
  }

  // ---------------------------------------------------------------- tabs

  // within: only controls inside this element, or the panel this selector
  // names (a record's drawer).
  function findActivator(spec, within = null) {
    const scope = typeof within === 'string' ? panelOf(within) : within;
    if (typeof within === 'string' && within && !scope) return null;
    let pool;
    try {
      pool = findAll(spec.css || CLICKABLE);
      if (scope) pool = pool.filter((el) => deepContains(scope, el));
    } catch {
      return null;
    }
    if (!spec.text) return pool[0] || null;
    const want = tabCaption(spec.text).toLowerCase();
    const caption = (el) => tabCaption(el.innerText || el.textContent).toLowerCase();
    return pool.find((el) => caption(el) === want) || pool.find((el) => caption(el).startsWith(want)) || null;
  }

  // Clicks a tab or an expander. An expander that is already open is left
  // alone: clicking it again would collapse the content we want to read.
  function activate(spec, within = null) {
    const el = findActivator(spec, within);
    if (!el) return false;
    if (spec.kind === 'expander') {
      const toggle = deepClosest(el, '[aria-expanded]');
      if (toggle?.getAttribute('aria-expanded') === 'true') return true;
      if (deepClosest(el, 'details')?.open) return true;
    }
    el.click();
    return true;
  }

  // The shown element a panel selector names (a drawer that is open), or null.
  const panelOf = (css) => {
    if (!css) return null;
    try {
      const all = findAll(css);
      return all.find(isVisible) ?? null;
    } catch {
      return null;
    }
  };

  const present = (css) => {
    try {
      const el = css && findAll(css)[0];
      return Boolean(el && (el.textContent.trim() || el.children.length || shadowOf(el)));
    } catch {
      return false;
    }
  };

  const BUSY = '[aria-busy="true"],[class*="loading" i],[class*="spinner" i],[class*="skeleton" i]';
  // roots: the shadow roots being watched (watchChanges), so no page-wide search per tick.
  const busy = (roots = []) => [document, ...roots].some((root) => [...root.querySelectorAll(BUSY)].some(isVisible));

  // After a tab click: done when the view's marker element shows up, or when
  // the page has stopped changing for quietMs with no spinner showing (a
  // customer with no emails has no email table to wait for). Returns whether
  // the marker appeared.
  async function waitForView(css, { timeoutMs = 8000, quietMs = 1000 } = {}) {
    let lastChange = Date.now();
    const watch = watchChanges(() => (lastChange = Date.now()));
    try {
      const start = Date.now();
      for (let tick = 1; Date.now() - start < timeoutMs; tick++) {
        if (present(css)) return true;
        if (Date.now() - lastChange >= quietMs && !busy(watch.roots)) return false;
        await sleep(100);
        if (tick % 5 === 0) watch.refresh(); // components rendered since
      }
      return false;
    } finally {
      watch.stop();
    }
  }

  // Page load: done when the DOM has stopped changing and no new network
  // responses have arrived for quietMs, with no spinner showing (single-page
  // apps fetch their data well after "load", and after a hash change). The
  // first minMs always pass, so a fetch that starts a moment after
  // navigation is not missed. Returns whether it went quiet before timeoutMs.
  async function waitQuiet({ quietMs = 800, timeoutMs = 15000, minMs = 0 } = {}) {
    let lastChange = Date.now();
    const watch = watchChanges(() => (lastChange = Date.now()));
    let resources = performance.getEntriesByType('resource').length;
    try {
      const start = Date.now();
      for (let tick = 1; Date.now() - start < timeoutMs; tick++) {
        const now = performance.getEntriesByType('resource').length;
        if (now !== resources) {
          resources = now;
          lastChange = Date.now();
        }
        if (Date.now() - start >= minMs && Date.now() - lastChange >= quietMs && !busy(watch.roots)) return true;
        await sleep(100);
        if (tick % 5 === 0) watch.refresh(); // components rendered since
      }
      return false;
    } finally {
      watch.stop();
    }
  }

  // ---------------------------------------------------------------- links

  // Where an element leads: a plain link, a data-href/data-url attribute, or
  // an onclick that navigates. newTab: it would open in a new tab/window.
  function linkTarget(el) {
    if (el.tagName === 'A' && el.getAttribute('href')) {
      return { url: absoluteUrl(el.getAttribute('href')), newTab: el.target === '_blank' };
    }
    for (const attr of ['data-href', 'data-url', 'data-link']) {
      const value = el.getAttribute(attr);
      if (value) return { url: absoluteUrl(value), newTab: false };
    }
    const onclick = el.getAttribute('onclick') || '';
    const m = onclick.match(ONCLICK_URL);
    if (m) return { url: absoluteUrl(m[1]), newTab: /window\.open/.test(onclick) };
    return null;
  }

  // The element that carries a link's navigation (the anchor itself, or the
  // row/card whose onclick does it).
  const linkElements = () => findEverywhere(document, 'a[href], [data-href], [data-url], [data-link], [onclick]');

  // Structural signature of an element's ancestors: links of one list share it.
  function ancestry(el, depth = 4) {
    const parts = [];
    let node = el;
    for (let i = 0; i < depth && node && node !== document.body; i++) {
      const cls = [...node.classList].filter((c) => isStable(c) && !STATE_CLASS.test(c)).slice(0, 2).join('.');
      parts.push(node.tagName.toLowerCase() + (cls ? `.${cls}` : ''));
      node = parentOf(node);
    }
    return parts.join('>');
  }

  // Every navigation on the page (needs a snapshot() first so mids exist):
  // [{ mid, url, newTab, text, ancestry }]. javascript: and mailto: links are
  // not navigations.
  function pageLinks() {
    const out = [];
    for (const el of linkElements()) {
      const target = linkTarget(el);
      if (!target || !/^https?:/i.test(target.url)) continue;
      const mid = Number(el.getAttribute('data-cm') || deepClosest(el, '[data-cm]')?.getAttribute('data-cm') || 0);
      out.push({ mid, url: target.url, newTab: target.newTab, text: clean(el.innerText || el.textContent).slice(0, 80), ancestry: ancestry(el) });
    }
    return out;
  }

  // The link to a list's next page, when the pager is made of links:
  // rel="next", an aria-label or title saying next, or a "Next"/"›"/"»" caption.
  function nextPageLink() {
    const isNext = (s) => /^(next( page)?|›|»|>|>>|→)$/i.test(clean(String(s ?? '')).replace(/^next\s*[›»>→]+$/i, 'next'));
    for (const el of linkElements()) {
      const target = linkTarget(el);
      if (!target || !/^https?:/i.test(target.url) || target.url === location.href) continue;
      if (el.getAttribute('rel')?.split(/\s+/).includes('next')) return target.url;
      if (/\bnext\b/i.test(el.getAttribute('aria-label') || el.getAttribute('title') || '')) return target.url;
      // e.g. Dolibarr's "paginationnext": an icon-only link
      if (/next/i.test(el.getAttribute('class') || '') && !/prev/i.test(el.getAttribute('class') || '')) return target.url;
      if (isNext(el.innerText || el.textContent)) return target.url;
    }
    return null;
  }

  // Lists that grow in place: presses "Show more"/"Load more" and scrolls to
  // the end until nothing more arrives. Returns how many times it had to.
  async function expandAll({ maxRounds = 100, rows = null } = {}) {
    const MORE = /^(show|load|view|see)\s+more|^more(\s+results)?$|next\s+\d+/i;
    const rowCount = () => {
      try {
        return rows ? queryDeep(document, rows).length : 0;
      } catch {
        return 0;
      }
    };
    const size = () => rowCount() * 100000 + pageText().length;
    let rounds = 0;
    let scroller = null;
    while (rounds < maxRounds) {
      const before = size();
      const button = findEverywhere(document, 'button, a, [role="button"]').find((el) => isVisible(el) && MORE.test(clean(el.innerText || el.textContent)));
      scroller = scrollerOf(rows); // again each round: the app may have re-rendered it
      if (button) button.click();
      else scrollToEnd(scroller);
      rounds++;
      await waitQuiet({ quietMs: 800, timeoutMs: 10000, minMs: 500 });
      if (size() === before) {
        if (button) break; // the button did nothing
        // scrolling did nothing: try once more, then stop
        scrollToEnd(scroller);
        await waitQuiet({ quietMs: 800, timeoutMs: 6000, minMs: 500 });
        if (size() === before) break;
      }
    }
    if (scroller) scroller.scrollTop = 0;
    window.scrollTo(0, 0);
    return rounds;
  }

  // What scrolls a list: the nearest ancestor of its rows (rows: their
  // selector) that scrolls its own content; with no rows to go by, the
  // biggest such element on the page; null when it is the page itself.
  function scrollerOf(rows) {
    const scrolls = (el) => {
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4;
    };
    const isPage = (el) => !el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement;
    let row = null;
    try {
      row = rows ? queryDeep(document, rows)[0] : null;
    } catch {
      row = null;
    }
    if (row) {
      for (let node = parentOf(row); !isPage(node); node = parentOf(node)) if (scrolls(node)) return node;
      return null;
    }
    const area = (el) => el.clientHeight * el.clientWidth;
    return allElements().filter((el) => !isPage(el) && el.clientHeight >= 150 && scrolls(el)).sort((a, b) => area(b) - area(a))[0] ?? null;
  }

  // Scrolls to the end and says so: a tab in the background renders no
  // frames, so the browser's own scroll event may never come.
  function scrollToEnd(scroller) {
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
    } else {
      window.scrollTo(0, document.body.scrollHeight);
      window.dispatchEvent(new Event('scroll'));
    }
  }

  // Rules for a list page: the repeated row element and, per row, its link
  // to the record and a title. linkMids: 2+ example links into records.
  function describeList(linkMids) {
    const links = linkMids.map(byMid).filter(Boolean);
    if (links.length < 2) return null;
    // The container is the nearest ancestor of the first link that holds all
    // the examples; the rows are its children on the way down to each link.
    let container = parentOf(links[0]);
    while (container && container !== document.body && !links.every((l) => deepContains(container, l))) container = parentOf(container);
    if (!container) return null;
    const rowOf = (link) => {
      let node = link;
      while (parentOf(node) !== container) node = parentOf(node);
      return node;
    };
    const rows = links.map(rowOf);
    const carrier = linkCarrier(links[0]) || links[0];
    const link = linkRuleFor(carrier, rows[0]);
    if (!link) return null;
    const spec = {
      container: selectorFor(container),
      item: itemSelectorFor(container, rows),
      fields: { link: [link], title: [{ css: selectorFor(links[0], rows[0]) }] },
    };
    const entries = readCollection(spec);
    return { spec, count: entries.length, examples: entries.slice(0, 3) };
  }

  // ----------------------------------------------------- mapping (agent side)

  // Rules for a single value the LLM located. The label rule is kept only
  // when it reads the same value as the CSS rule. valueSlot: the LLM pointed
  // at a label, so use the value element next to it. widen: use the outermost
  // element with the same text (a message body picked as its first
  // paragraph would otherwise lose later paragraphs).
  // within: the selector of the record's panel, where its label rules must work.
  function describeField(mid, { attr = '', regex = '', valueSlot = false, widen = false, within = '' } = {}) {
    const picked = byMid(mid);
    let el = picked && valueSlot ? valueForLabel(picked) : picked;
    if (!el) return null;
    if (widen && !attr) {
      const text = readValue(el);
      while (el.parentElement && el.parentElement !== document.body && readValue(el.parentElement) === text) el = el.parentElement;
    }
    const extras = { ...(attr ? { attr } : {}), ...(regex ? { regex } : {}) };
    const cssRule = { css: selectorFor(el), ...extras };
    const rules = [cssRule];
    const value = evalRule(cssRule);
    const label = attr ? '' : labelFor(el);
    if (label) {
      const labelRule = { label, ...extras };
      if (evalRule(labelRule, document, panelOf(within) ?? document) === value) rules.push(labelRule);
    }
    return { rules, value, raw: attr ? clean(el.getAttribute(attr)) : readValue(el) };
  }

  // Rules for a repeated list: container, entry selector, and per-entry rules
  // relative to whichever example entry holds each picked value (a subject
  // may exist only on the email entries of a mixed timeline).
  function describeCollection(containerMid, itemMids, itemFields) {
    const container = byMid(containerMid);
    const items = itemMids.map(byMid).filter(Boolean);
    if (!container || !items.length) return null;
    const fields = {};
    for (const pick of itemFields) {
      const el = byMid(pick.mid);
      const item = el && items.find((it) => deepContains(it, el));
      if (!item || fields[pick.key]) continue;
      fields[pick.key] = [{ css: selectorFor(el, item), ...(pick.attr ? { attr: pick.attr } : {}), ...(pick.regex ? { regex: pick.regex } : {}) }];
    }
    // An entry that links to its own page (an email's full body lives there):
    // remember the link so it can be followed later.
    if (!fields.link) {
      for (const item of items) {
        const anchor = findEverywhere(item, 'a[href]').find((a) => /^https?:/i.test(a.href) && !/^(mailto|tel):/i.test(a.getAttribute('href')));
        if (anchor) {
          fields.link = [linkRuleFor(anchor, item)];
          break;
        }
      }
    }
    const spec = { container: selectorFor(container), item: itemSelectorFor(container, items), fields };
    const read = (item) => Object.fromEntries(Object.entries(fields).map(([key, rules]) => [key, firstValue(rules, item)]));
    return { spec, count: readCollection(spec).length, examples: items.map(read) };
  }

  // How to click a tab (or an expander) again later: a selector matching all
  // its sibling tabs plus the caption without counts.
  function describeActivator(mid, kind = 'tab', within = '') {
    const target = byMid(mid);
    if (!target) return null;
    // Prefer the real link/button: clicking an <li> doesn't fire the link inside it.
    const PRESSABLE = 'a,button,[role="tab"],[onclick]';
    const el = deepClosest(target, PRESSABLE) || findEverywhere(target, PRESSABLE)[0] || target;
    const tag = el.tagName.toLowerCase();
    let css;
    if (el.getAttribute('role') === 'tab') css = `${tag}[role="tab"]`;
    else {
      const classes = [...el.classList].filter((c) => isStable(c) && !STATE_CLASS.test(c)).slice(0, 2);
      css = tag + classes.map((c) => `.${CSS.escape(c)}`).join('');
    }
    const text = tabCaption(el.innerText || el.textContent);
    // A tab that is a link to another page (Dolibarr-style) is followed by
    // navigating there, not by clicking in place.
    const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
    const isLink = Boolean(href) && !/^(#|javascript:|mailto:|tel:)/i.test(href) && /^https?:/i.test(absoluteUrl(href));
    const extra = isLink ? { kind: 'link' } : kind === 'expander' ? { kind } : {};
    const spec = { css, text, ...extra };
    return findActivator(spec, panelOf(within)) === el ? spec : { css: selectorFor(el), text, ...extra };
  }

  // ------------------------------------------- apps that navigate by clicks
  //
  // Some CRMs never change the address and have no links: a launcher tile, a
  // side menu and data grids, all driven by click handlers, often inside a
  // frame from another host. There a "page" is the screen reached by a path
  // of clicks. The mapping side lists what can be clicked (clickables), the
  // LLM picks, describeNav() turns a pick into a replayable step; the
  // extraction side replays the steps (pressNav), reads the grid on the
  // screen (readTable) and pages through it (pressNext).

  const NAV_ROLES = new Set(['menuitem', 'menuitemradio', 'treeitem', 'tab', 'link', 'button', 'option']);
  const NAV_TAGS = new Set(['A', 'BUTTON', 'SUMMARY']);
  const navText = (el) => tabCaption(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
  const inEditor = (el) => Boolean(el.closest('[contenteditable="true"], .cke, .ck-editor, .tox, .ql-toolbar, [role="toolbar"]'));

  // An element a framework handles clicks on (data-cm-click, set by
  // content/mark-handlers.js in the page's world), or a caption inside one:
  // the handler sits a few levels up on a tile or a menu entry, never on
  // something as big as the whole page.
  function handledByFramework(el) {
    let node = el;
    for (let up = 0; node && up < 4; node = parentOf(node), up++) {
      if (node.hasAttribute('data-cm-click')) return node.getElementsByTagName('*').length <= 80;
    }
    return false;
  }

  // What a user could click to move around: [{ id, text, role, expanded,
  // selected, area }]. Each gets data-cn="<id>". The innermost element that
  // carries a caption is kept (its click bubbles to whatever handles it).
  function clickables({ startId = 1, max = 260 } = {}) {
    findEverywhere(document, '[data-cn]').forEach((el) => el.removeAttribute('data-cn'));
    const found = [];
    const all = document.body ? [...document.body.getElementsByTagName('*'), ...shadowRoots(document.body).flatMap((sr) => [...sr.querySelectorAll('*')])] : [];
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i];
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag) || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'OPTION' || tag === 'LABEL') continue;
      const role = el.getAttribute('role') || '';
      // tabindex="0": a control the app made focusable by hand (a launcher's
      // application cards are often plain divs like that).
      let pressable = NAV_TAGS.has(tag) || NAV_ROLES.has(role) || el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0' || handledByFramework(el);
      if (!pressable && el.childElementCount <= 3) pressable = getComputedStyle(el).cursor === 'pointer';
      if (!pressable || !isVisible(el) || inEditor(el)) continue;
      const text = navText(el);
      if (!text || text.length > 60) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) continue;
      found.push({ el, text, role: role || tag.toLowerCase() });
    }
    // An element that only wraps another candidate with the same caption, or
    // that wraps several different ones (a whole menu), is not the target.
    const kept = found.filter((c) => {
      const inner = found.filter((d) => d !== c && deepContains(c.el, d.el));
      if (inner.some((d) => d.text === c.text)) return false;
      return new Set(inner.map((d) => d.text)).size < 2;
    });
    let id = startId;
    return kept.slice(0, max).map((c) => {
      c.el.setAttribute('data-cn', String(id));
      const state = deepClosest(c.el, '[aria-expanded]');
      const area = deepClosest(c.el, 'nav, aside, header, [role="navigation"], [role="menu"], [role="menubar"], [role="tree"], [role="tablist"], [role="grid"], table, main');
      return {
        id: id++,
        text: c.text,
        role: c.role,
        expanded: state ? state.getAttribute('aria-expanded') === 'true' : null,
        selected: deepClosest(c.el, '[aria-selected="true"], [aria-current]') ? true : null,
        area: area ? area.getAttribute('role') || area.tagName.toLowerCase() : '',
        // A plain link with an address: a crawler opens it by address instead.
        link: /^https?:/i.test(deepClosest(c.el, 'a[href]')?.href || ''),
      };
    });
  }

  const navPool = (spec) => {
    try {
      return findAll(spec.css || '*').filter(isVisible);
    } catch {
      return [];
    }
  };
  // The element a navigation step names: same selector, same caption; when
  // several qualify (two menus with an "Active" entry) the one at the same
  // position among them.
  function findNav(spec) {
    const want = tabCaption(spec.text || '').toLowerCase();
    const matches = navPool(spec).filter((el) => navText(el).toLowerCase() === want);
    return matches[spec.nth || 0] || matches[0] || null;
  }

  // A replayable step for the element clickables() numbered id.
  function describeNav(id) {
    const el = findEverywhere(document, `[data-cn="${id}"]`)[0];
    return el ? describeNavEl(el) : null;
  }

  function describeNavEl(el) {
    const text = navText(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const classes = [...el.classList].filter((c) => isStable(c) && !STATE_CLASS.test(c)).slice(0, 2);
    const candidates = [tag + (role ? `[role="${role}"]` : '') + classes.map((c) => `.${CSS.escape(c)}`).join(''), tag + (role ? `[role="${role}"]` : ''), tag];
    for (const css of candidates) {
      const want = text.toLowerCase();
      const matches = navPool({ css }).filter((e) => navText(e).toLowerCase() === want);
      const nth = matches.indexOf(el);
      if (nth >= 0) return { css, text, ...(nth ? { nth } : {}), kind: 'nav' };
    }
    return { css: selectorFor(el), text, kind: 'nav' };
  }

  // A click the way a user's would arrive: pointer and mouse events, then
  // click (menus built on mousedown or pointerup miss a bare click()).
  // A javascript: link (an ASP.NET __doPostBack pager, a script-driven menu)
  // does nothing when clicked from the extension's isolated world: it is
  // marked with data-cm-follow instead, and the extension clicks it from the
  // page's own world (followScriptLinks in background.js / the chrome adapter).
  const ISOLATED_WORLD = Boolean(globalThis.chrome?.runtime?.id);
  const SCRIPT_HREF = /^\s*javascript:(?!\s*(void\s*\(\s*0\s*\)|;)?\s*;?\s*$)/i;
  function press(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 0 };
    for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const Ctor = type.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
      el.dispatchEvent(new Ctor(type, { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    }
    const link = deepClosest(el, 'a[href]');
    if (ISOLATED_WORLD && link && SCRIPT_HREF.test(link.getAttribute('href'))) {
      link.setAttribute('data-cm-follow', '1');
      return;
    }
    el.click();
  }

  const hasNav = (spec) => Boolean(findNav(spec));
  // Presses a step's element. A menu group that is already open is left open.
  function pressNav(spec, { toggle = false } = {}) {
    const el = findNav(spec);
    if (!el) return false;
    const state = deepClosest(el, '[aria-expanded]');
    // el is the header of that group: the group itself, or inside its first child.
    const isHeader = state && (state === el || Boolean(state.firstElementChild && deepContains(state.firstElementChild, el)) || navText(state) === navText(el));
    if (!toggle && isHeader && state.getAttribute('aria-expanded') === 'true') return true;
    press(el);
    return true;
  }

  // ------------------------------------------------------------ data grids

  const CELL_SEL = 'td, [role="gridcell"], [role="cell"]';
  const HEADER_SEL = 'th, [role="columnheader"]';
  const directCells = (row) => [...row.children].filter((c) => c.matches(CELL_SEL));
  const dataRows = (root) =>
    findEverywhere(root, 'tr, [role="row"]').filter((row) => isVisible(row) && directCells(row).length >= 2 && !row.querySelector(HEADER_SEL) && !row.closest('thead'));

  function cellValue(cell) {
    const box = cell.querySelector('input[type="checkbox"], input[type="radio"]');
    const text = clean(cell.innerText ?? cell.textContent);
    if (text) return text;
    if (box) return box.checked ? 'Yes' : 'No';
    const input = cell.querySelector('input, select, textarea');
    if (input) return readValue(input);
    const labelled = cell.querySelector('[aria-label], [title], img[alt]');
    return labelled ? clean(labelled.getAttribute('aria-label') || labelled.getAttribute('title') || labelled.getAttribute('alt')) : '';
  }

  // The main data grid of this frame (an HTML table, or an ARIA grid whose
  // header may sit in a table of its own): { spec, headers, rows (examples),
  // count }, or null. spec: { container, row, headers, offset }.
  function describeTable() {
    // Rows grouped by their parent: the biggest group is the grid's body.
    const groups = new Map();
    for (const row of dataRows(document)) {
      const parent = parentOf(row); // a shadow root's rows group under its host
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(row);
    }
    let best = null;
    for (const [parent, rows] of groups) {
      const cells = directCells(rows[0]).length;
      const score = rows.length * cells;
      if (!best || score > best.score) best = { parent, rows, cells, score };
    }
    if (!best) return null;
    // The grid: the closest ancestor that also holds the column headers.
    let container = best.parent;
    let headerCells = [];
    for (let node = best.parent, up = 0; node && node !== document.body && up < 7; node = parentOf(node), up++) {
      const found = findEverywhere(node, HEADER_SEL).filter((h) => isVisible(h) && !best.rows.some((r) => deepContains(r, h)));
      if (found.length >= 2) {
        container = node;
        headerCells = found;
        break;
      }
    }
    // The last header row is the one naming the columns (grouped headers sit above).
    if (headerCells.length > best.cells) {
      const lastRow = headerCells[headerCells.length - 1].closest('tr, [role="row"]');
      const inLast = headerCells.filter((h) => h.closest('tr, [role="row"]') === lastRow);
      if (inLast.length >= 2) headerCells = inLast;
    }
    let headers = headerCells.map((h) => clean(h.innerText || h.textContent || h.getAttribute('aria-label') || h.getAttribute('title') || ''));
    // No header cells: a first row of labels, else numbered columns.
    if (!headers.length) headers = Array.from({ length: best.cells }, (_, i) => `column_${i + 1}`);
    // Leading cells without a header (a checkbox, an expander) shift the columns.
    const offset = Math.max(0, best.cells - headers.length);
    const spec = { container: selectorFor(container), row: itemSelectorFor(container, best.rows.slice(0, 6)), headers, offset };
    const read = readTable(spec);
    if (!read.rows.length) {
      // The learned row selector missed: fall back to every data row in the grid.
      spec.row = '';
    }
    const rows = readTable(spec).rows;
    return rows.length ? { spec, headers, count: rows.length, rows: rows.slice(0, 4).map((r) => r.cells) } : null;
  }

  // Rows of a described grid: { rows: [{ cells: [text], fields?: { key: text }, link }], signature }.
  // spec.columns ([{ index, key }], indexes into headers) names the cells.
  // The row elements of a described grid, in order.
  function tableRows(spec) {
    let container;
    try {
      container = queryOne(document, spec.container);
    } catch {
      container = null;
    }
    if (!container) return [];
    let rowEls = [];
    if (spec.row) {
      try {
        rowEls = queryDeep(container, spec.row).filter((row) => isVisible(row) && directCells(row).length >= 2);
      } catch {
        rowEls = [];
      }
    }
    return rowEls.length ? rowEls : dataRows(container);
  }

  function readTable(spec) {
    const rowEls = tableRows(spec);
    if (!rowEls.length) return { rows: [], signature: '' };
    const offset = spec.offset || 0;
    const rows = rowEls.map((row) => {
      const cells = directCells(row).map(cellValue);
      const out = { cells };
      if (spec.columns) {
        out.fields = {};
        for (const { index, key } of spec.columns) {
          const value = cells[index + offset];
          if (key && value && !(key in out.fields)) out.fields[key] = value;
        }
      }
      // A row that leads somewhere by URL (a link, or an onclick that opens one).
      for (const el of findEverywhere(row, 'a[href], [data-href], [data-url], [data-link], [onclick]')) {
        const target = linkTarget(el);
        if (target && /^https?:/i.test(target.url) && target.url !== location.href) {
          out.link = target.url;
          break;
        }
      }
      return out;
    });
    const filled = rows.filter((r) => r.cells.some(Boolean));
    return { rows: filled, signature: filled.slice(0, 3).map((r) => r.cells.join('|')).join('\n') };
  }

  // The pager's "next" control when there is one and it is enabled. near: the
  // selector of the list being paged; only a control close to it counts (the
  // nearest one around it), never a "Next" elsewhere on the page (a setup
  // wizard, a carousel).
  function findNext({ near = '' } = {}) {
    const disabled = (el) =>
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      Boolean(deepClosest(el, '[aria-disabled="true"], .disabled, .aspNetDisabled, .k-disabled, .k-state-disabled, .ag-disabled, .Mui-disabled, [disabled]'));
    const label = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
    const icon = (el) => `${el.getAttribute('class') || ''} ${[...el.querySelectorAll('[class]')].slice(0, 3).map((c) => c.getAttribute('class')).join(' ')}`.toLowerCase();
    const isNext = (el) => {
      const l = label(el);
      // "Next >", "Next page ›", "» Next" are all just "next".
      const t = clean(el.innerText || el.textContent)
        .toLowerCase()
        .replace(/^next( page)?\s*[›»>→]+$|^[›»>→]+\s*next( page)?$/, 'next');
      if (/\b(prev|previous|first|last)\b/.test(`${l} ${t}`)) return false;
      if (/\bnext\b/.test(l) || /^(next( page)?|›|»|>|→)$/.test(t)) return true;
      const c = icon(el);
      return !t && /(^|[\s_-])(next|arrow-e|arrow-right|caret-alt-right|chevron-right|page-next|pager-next)([\s_-]|$)/.test(c) && !/prev|last|left/.test(c);
    };
    const pagerish = findEverywhere(document, 'a, button, [role="button"], li, span').filter((el) => isVisible(el) && isNext(el));
    // Prefer one that lives in something that looks like a pager.
    const inPager = (el) => Boolean(deepClosest(el, '[class*="pager" i], [class*="paginat" i], [role="navigation"], nav, [aria-label*="pag" i]'));
    let el = null;
    if (near) {
      let list = null;
      try {
        list = findAll(near).find(isVisible) ?? null;
      } catch {
        list = null;
      }
      if (!list) return null;
      // The smallest element around the list that holds a "next" control.
      for (let scope = list, up = 0; scope && scope !== document.body && scope !== document.documentElement && up < 6; scope = parentOf(scope), up++) {
        const here = pagerish.filter((c) => deepContains(scope, c));
        if (here.length) {
          el = here.find(inPager) || here[0];
          break;
        }
      }
      // Nothing around it (a list straight in <body>): the page's only pager will do.
      if (!el && pagerish.filter(inPager).length === 1) el = pagerish.find(inPager);
    } else el = pagerish.find(inPager) || pagerish[0] || null;
    return el && !disabled(el) ? el : null;
  }
  const hasNext = (opts) => Boolean(findNext(opts));
  function pressNext(opts) {
    const el = findNext(opts);
    if (!el) return false;
    press(el);
    return true;
  }

  // Where a link-tab leads on this page (absolute), or null.
  function activatorHref(spec) {
    const el = findActivator(spec);
    const href = el && deepClosest(el, 'a[href]')?.getAttribute('href');
    return href ? absoluteUrl(href) : null;
  }

  // ------------------------------------------- records that open in place
  //
  // Rows whose record opens in a drawer, a modal or a side pane, with no
  // address of its own (or one the app only reaches by script). Mapping:
  // rowOpeners() lists what in a row could open it, markVisible() notes what
  // is on screen, pressRow() clicks it, openedPanel() finds what appeared and
  // describeClose() how to put it away. Capture: pressRow(), extractPage()
  // with the panel's views (pageType.inPlace), pressClose().

  // Captions of row controls that change data or start something else.
  const ROW_ACTION = /^(add|new|create|edit|delete|remove|send|compose|import|export|print|upload|save|submit|archive|merge|convert|assign|call|email|text|sms|dial|share|copy|duplicate|more|actions?)\b/i;
  const OPEN_CAPTION = /^(view|open|details?|show|preview)\b/i;
  const CLOSE_CAPTION = /^(close|close (panel|dialog|drawer|window|details)|dismiss|cancel|back|back to (list|results)|done|hide|×|✕|✖|x)$/i;
  const PANEL_HINT =
    '[role="dialog"], dialog, [aria-modal="true"], [role="complementary"], [role="region"], aside, [class*="drawer" i], [class*="modal" i], [class*="flyout" i], [class*="panel" i], [class*="pane" i], [class*="sidebar" i], [class*="detail" i]';

  function allElements() {
    const out = [...document.getElementsByTagName('*')];
    for (const sr of shadowRoots(document)) out.push(...sr.querySelectorAll('*'));
    return out;
  }

  // What in a grid's row could open its record, best first: a link naming it
  // (never an action like Delete, nor a mailto:/tel: link) or a View/Open
  // button, then its first cell with text, then the row itself. Selectors are
  // relative to the row: [{ css }].
  function rowOpeners(spec, index = 0) {
    const row = tableRows(spec)[index];
    if (!row) return [];
    const out = [];
    const add = (el) => {
      const css = el === row ? ':scope' : selectorFor(el, row);
      if (!out.some((o) => o.css === css)) out.push({ css });
    };
    for (const el of findEverywhere(row, 'a, [role="link"], button, [role="button"]')) {
      const text = navText(el);
      const isButton = el.matches('button, [role="button"]');
      if (!isVisible(el) || !text || ROW_ACTION.test(text) || /^(mailto|tel|sms|callto):/i.test(el.getAttribute('href') || '')) continue;
      if (isButton && !OPEN_CAPTION.test(text)) continue; // an unknown button may do anything
      add(el);
      break;
    }
    const cell = directCells(row).find((c) => clean(c.innerText) && !findEverywhere(c, 'input, button, select, textarea').length);
    if (cell) add(cell);
    add(row);
    return out;
  }

  // Clicks row index of a grid, on its opener (open: one of rowOpeners()).
  function pressRow(spec, index, open = { css: ':scope' }) {
    const row = tableRows(spec)[index];
    if (!row) return false;
    let el = row;
    if (open?.css && open.css !== ':scope') {
      try {
        el = queryOne(row, open.css) || row;
      } catch {
        el = row;
      }
    }
    press(el);
    return true;
  }

  // Notes what is on screen now, for openedPanel() to compare against.
  let shownBefore = null;
  function markVisible() {
    shownBefore = new WeakSet(allElements().filter(isVisible));
    return true;
  }

  // What appeared since markVisible(), outside exclude (the grid's selector):
  // the element holding (nearly) all of the new content, or a drawer, dialog
  // or pane just around it. { selector, text, length, dialog } or null.
  function openedPanel({ exclude = '', minText = 20 } = {}) {
    if (!shownBefore) return null;
    const before = shownBefore;
    shownBefore = null;
    let grid = null;
    try {
      grid = exclude ? queryOne(document, exclude) : null;
    } catch {
      grid = null;
    }
    const fresh = allElements().filter((el) => !before.has(el) && !SKIP_TAGS.has(el.tagName) && isVisible(el));
    const freshSet = new Set(fresh);
    const tops = fresh.filter((el) => !freshSet.has(parentOf(el)) && !(grid && (deepContains(grid, el) || deepContains(el, grid))));
    const texts = new Map(tops.map((el) => [el, deepText(el)]));
    const total = [...texts.values()].reduce((n, t) => n + t.length, 0);
    if (total < minText) return null;
    tops.sort((a, b) => texts.get(b).length - texts.get(a).length);
    const holds = (el) => tops.reduce((n, t) => n + (deepContains(el, t) ? texts.get(t).length : 0), 0);
    const stop = (el) => !el || el === document.body || el === document.documentElement || (grid && deepContains(el, grid));
    let panel = tops[0];
    while (holds(panel) < total * 0.8 && !stop(parentOf(panel))) panel = parentOf(panel);
    // A drawer, dialog or pane just around it is the steadier thing to name.
    for (let node = panel, up = 0; !stop(node) && up < 4; node = parentOf(node), up++) {
      if (node.matches(PANEL_HINT)) {
        panel = node;
        break;
      }
    }
    const text = deepText(panel);
    return { selector: selectorFor(panel), text: text.slice(0, 200), length: text.length, dialog: Boolean(deepClosest(panel, '[role="dialog"], dialog, [aria-modal="true"]')) };
  }

  // How to put a panel away again: its close (×, Close, Back…) control as a
  // replayable step, else the Escape key.
  function describeClose(panelSel) {
    const panel = panelOf(panelSel);
    if (!panel) return null;
    const scope = deepClosest(panel, '[role="dialog"], dialog, [aria-modal="true"], aside') || panel;
    const label = (el) => clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent);
    const candidates = findEverywhere(scope, 'button, a, [role="button"], [aria-label], [title]').filter(isVisible);
    const el =
      candidates.find((c) => CLOSE_CAPTION.test(label(c))) ||
      candidates.find((c) => !clean(c.innerText) && /(^|[\s_-])close([\s_-]|$)/i.test(c.getAttribute('class') || ''));
    return el ? describeNavEl(el) : { key: 'Escape' };
  }

  function pressClose(spec) {
    if (!spec) return false;
    if (spec.key) {
      const active = document.activeElement;
      const target = active && active !== document.body ? active : document.body;
      for (const type of ['keydown', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, { key: spec.key, code: spec.key, keyCode: 27, which: 27, bubbles: true, composed: true, cancelable: true }));
      }
      return true;
    }
    return pressNav(spec);
  }

  // Whether a panel selector names something on screen.
  const shown = (css) => Boolean(panelOf(css));

  // ---------------------------------------- crawling (proof of concept)
  //
  // Everything a page shows, read with no mapping and no AI: every table as
  // rows (named by its column headers), every label/value pair, the text and
  // the links. Shadow roots and inline frames included. SSNs and card numbers
  // are blanked, sensitive inputs (passwords, SSN, card) skipped.

  const SENSITIVE_LABEL = /ssn|social.?sec|tax.?id|card.?(num|no)|cc.?num|cvv|cvc|routing|account.?(num|no)|password|\bpin\b/i;
  const redact = (s) =>
    String(s ?? '')
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
      .replace(/\b(?:\d[ -]?){13,19}\b/g, '[redacted]');

  // Grids under top: [{ name, headers, rows: [{ header: value }] }]. A
  // two-column grid with no headers is label/value pairs: it goes to fields.
  function scrapeTables(top, fields) {
    const groups = new Map();
    for (const row of dataRows(top)) {
      if (findEverywhere(row, 'table, [role="grid"]').length) continue; // a layout row around other tables
      const parent = parentOf(row);
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(row);
    }
    const out = [];
    for (const [parent, rows] of groups) {
      let headerCells = [];
      let grid = parent;
      for (let node = parent, up = 0; node && node !== document.body && up < 7; node = parentOf(node), up++) {
        const found = findEverywhere(node, HEADER_SEL).filter((h) => isVisible(h) && !rows.some((r) => deepContains(r, h)));
        if (found.length >= 2) {
          headerCells = found;
          grid = node;
          break;
        }
      }
      const width = directCells(rows[0]).length;
      if (headerCells.length > width) {
        const lastRow = headerCells.at(-1).closest('tr, [role="row"]');
        const inLast = headerCells.filter((h) => h.closest('tr, [role="row"]') === lastRow);
        if (inLast.length >= 2) headerCells = inLast;
      }
      const headers = headerCells.map((h) => clean(h.innerText || h.textContent || h.getAttribute('aria-label') || ''));
      if (!headers.length && width === 2) {
        for (const row of rows) {
          const [label, value] = directCells(row).map(cellValue);
          if (label && value && label.length <= 60) fields.push({ label: label.replace(/[:*]+$/, '').trim(), value });
        }
        continue;
      }
      const offset = Math.max(0, width - headers.length);
      const named = (i) => (i >= offset && headers[i - offset]) || `column_${i + 1}`;
      const name = clean(grid.getAttribute?.('aria-label') || grid.querySelector?.('caption')?.innerText || grid.id || '') || `table ${out.length + 1}`;
      out.push({
        name,
        headers,
        rows: rows.slice(0, 1000).map((row) => {
          const entry = {};
          directCells(row).forEach((cell, i) => {
            const value = cellValue(cell);
            if (value) entry[named(i)] = value;
          });
          return entry;
        }),
      });
    }
    return out;
  }

  // Label/value pairs: <dl>, labelled form controls, and "Label:" elements
  // with their value beside them.
  function scrapeFields(top, fields) {
    for (const dt of findEverywhere(top, 'dt')) {
      let dd = dt.nextElementSibling;
      while (dd && dd.tagName !== 'DD' && dd.tagName !== 'DT') dd = dd.nextElementSibling;
      if (dd?.tagName === 'DD' && isVisible(dd)) fields.push({ label: clean(dt.innerText || dt.textContent), value: readValue(dd) });
    }
    for (const input of findEverywhere(top, 'input, select, textarea')) {
      if (!isVisible(input) || /^(hidden|password|submit|button|reset|image|file)$/i.test(input.type || '')) continue;
      const label = clean(input.labels?.[0]?.innerText || input.getAttribute('aria-label') || input.getAttribute('placeholder') || input.name || '');
      if (!label || SENSITIVE_LABEL.test(`${label} ${input.name || ''} ${input.id || ''}`)) continue;
      const value = input.type === 'checkbox' || input.type === 'radio' ? (input.checked ? 'Yes' : 'No') : readValue(input);
      if (value) fields.push({ label, value });
    }
    for (const el of findEverywhere(top, 'label, span, div, b, strong, th, td, p')) {
      const own = ownText(el);
      if (!/^[^:]{1,40}:$/.test(own) || el.children.length > 1 || !isVisible(el)) continue;
      const slot = valueForLabel(el);
      const value = slot && !deepContains(slot, el) ? readValue(slot) : '';
      if (value && value.length <= 500 && !/:$/.test(value)) fields.push({ label: own.replace(/:$/, '').trim(), value });
    }
  }

  // { url, title, text, tables, fields, links } of this frame, or of the
  // panel a selector names (root).
  function scrapePage({ root = '' } = {}) {
    const top = root ? panelOf(root) : document.body;
    if (!top) return null;
    const fields = [];
    const tables = scrapeTables(top, fields);
    scrapeFields(top, fields);
    const seen = new Set();
    const unique = fields
      .filter((f) => f.label && f.value && !SENSITIVE_LABEL.test(f.label))
      .map((f) => ({ label: f.label, value: redact(f.value) }))
      .filter((f) => !seen.has(`${f.label}\n${f.value}`) && seen.add(`${f.label}\n${f.value}`));
    return {
      url: location.href,
      title: document.title,
      text: redact(deepText(top)).slice(0, 50000),
      tables: tables.map((t) => ({ ...t, rows: t.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, redact(v)]))) })),
      fields: unique,
      links: [...new Set(pageLinks().map((l) => l.url))],
    };
  }

  // ------------------------------------------------- extraction (extension)

  // Runs a mapped page type in this frame: clicks each view's tab, waits for
  // its content, reads fields and collections. Returns null when this frame
  // is not the one the page type lives in.
  // pageType.inPlace: a record shown in a panel (pageType.panel, its
  // selector) over the page; its tabs are looked for inside the panel only.
  async function extractPage(pageType) {
    const here = location.pathname + location.search + location.hash;
    const inPlace = Boolean(pageType.inPlace);
    const inThisFrame = inPlace ? shown(pageType.panel) : pageType.frame ? new RegExp(pageType.frame.urlRegex).test(here) : window === window.top;
    if (!inThisFrame) return null;
    const within = () => (inPlace ? panelOf(pageType.panel) : null);
    // errors = the rules no longer fit the page; notes = worth knowing only.
    const result = { fields: {}, collections: {}, views: [], errors: [], notes: [] };
    const views = pageType.views || [];
    for (const view of views) {
      if (view.activate?.kind === 'link') continue; // read on its own page by the caller
      if (inPlace && !within()) {
        result.errors.push({ view: view.name, error: 'panel_closed' });
        break;
      }
      if (view.activate) {
        if (!activate(view.activate, within())) {
          result.errors.push({ view: view.name, error: 'tab_not_found' });
          continue;
        }
        await sleep(150);
      }
      if (view.waitFor && !(await waitForView(view.waitFor))) result.notes.push({ view: view.name, note: 'marker_missing' });
      // A panel's rules are read inside it: the list around it may hold look-alikes.
      const { fields, collections } = readView(view, within() ?? document);
      for (const [key, value] of Object.entries(fields)) if (!(key in result.fields)) result.fields[key] = value;
      for (const [name, entries] of Object.entries(collections)) if (!result.collections[name]?.length) result.collections[name] = entries;
      result.views.push(view.name);
    }
    // Leave the user on the tab the record opened with.
    if (views.length > 1 && views[0].activate && views[0].activate.kind !== 'link') activate(views[0].activate, within());
    return result;
  }

  window.__crmRuntime = {
    version: RUNTIME_VERSION,
    inlineFrame: INLINE_FRAME,
    snapshot,
    byMid,
    selectorFor,
    labelFor,
    evalRule,
    readView,
    readCollection,
    findActivator,
    activate,
    waitForView,
    waitQuiet,
    pageLinks,
    nextPageLink,
    expandAll,
    describeList,
    describeField,
    describeCollection,
    describeActivator,
    activatorHref,
    extractPage,
    pageText,
    clickables,
    describeNav,
    hasNav,
    pressNav,
    describeTable,
    readTable,
    hasNext,
    pressNext,
    scrapePage,
    tableRows: (spec) => tableRows(spec).length, // how many rows (elements don't cross to the caller)
    rowOpeners,
    pressRow,
    markVisible,
    openedPanel,
    describeClose,
    pressClose,
    shown,
  };
})();
