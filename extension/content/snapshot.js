// Injected into every frame of the active tab (chrome.scripting.executeScript)
// when the popup opens. Turns what the user can see into compact text for the
// LLM:
//   - table cells stay on one line: "Cell | (214) 555-0147"
//   - form field values are included as "[Label: value]" (innerText misses them)
//   - tel:/mailto: links are collected separately
//   - shadow roots are walked (Salesforce-style components), closed ones too
//   - hidden elements are skipped
// SSNs, card numbers and sensitive form fields are removed before anything
// leaves the browser. The IIFE's return value is what executeScript hands back.
(() => {
  const MAX_CHARS = 30000;
  // A frame with no address of its own (srcdoc, about:blank written in by
  // script: an email body, often) is read inside its page, below; it is not
  // read again on its own.
  // (Its document's URL says nothing: document.open() gives it the page's.)
  const isInlineFrame = (el) => {
    const src = el.getAttribute('src');
    return el.hasAttribute('srcdoc') || !src || /^\s*about:/i.test(src);
  };
  try {
    if (window !== window.top && window.frameElement && isInlineFrame(window.frameElement)) return null;
  } catch {
    // another origin's frame: read on its own
  }
  const inlineFrameDoc = (el) => {
    if (!isInlineFrame(el)) return null;
    try {
      return el.contentDocument?.body ? el.contentDocument : null;
    } catch {
      return null;
    }
  };
  // Open shadow roots, closed ones on custom elements (reachable from an
  // extension), and inline frames' documents.
  const shadowOf = (el) => {
    if (el.shadowRoot) return el.shadowRoot;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return inlineFrameDoc(el)?.body ?? null;
    if (!el.localName.includes('-')) return null;
    try {
      return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) ?? null;
    } catch {
      return null;
    }
  };
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'FRAME',
    'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'HEAD',
  ]);
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL',
    'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LEGEND', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
    'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL',
  ]);
  const CELL_TAGS = new Set(['TD', 'TH']);
  const INLINE_TEXT_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK', 'ABBR', 'FONT', 'CODE', 'WBR']);
  const SKIP_INPUT_TYPES = new Set(['hidden', 'password', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);
  const SENSITIVE_FIELD = /ssn|social.?sec|tax.?id|card.?(num|no)|cc.?num|cvv|cvc|routing|account.?(num|no)|password|\bpin\b|licen[cs]e|\bdob\b|birth/i;

  const lines = [];
  let line = '';
  let size = 0;
  const phones = new Set();
  const emails = new Set();

  const flush = () => {
    const text = line.replace(/\s+/g, ' ').replace(/^[\s|]+|[\s|]+$/g, '');
    if (text && text !== lines[lines.length - 1]) {
      lines.push(text);
      size += text.length + 1;
    }
    line = '';
  };

  const isHidden = (el) => {
    if (typeof el.checkVisibility !== 'function') {
      const style = getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden';
    }
    if (el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
    // display:contents (e.g. <slot>) has no box of its own but its children render.
    return getComputedStyle(el).display !== 'contents';
  };

  const decode = (s) => {
    try {
      return decodeURIComponent(s).trim();
    } catch {
      return s.trim();
    }
  };

  const fieldLabel = (el) => {
    let text = el.labels?.[0]?.innerText || el.getAttribute('aria-label') || '';
    const labelledBy = el.getAttribute('aria-labelledby');
    if (!text && labelledBy) {
      const root = el.getRootNode();
      text = labelledBy.split(/\s+/)?.map((id) => root.getElementById?.(id)?.innerText || '').join(' ');
    }
    text = text || el.getAttribute('placeholder') || el.name || el.id || '';
    return text.replace(/\s+/g, ' ').replace(/[\s:*]+$/, '').trim().slice(0, 60);
  };

  const emitField = (el, tag) => {
    if (tag === 'INPUT' && SKIP_INPUT_TYPES.has(el.type)) return;
    const label = fieldLabel(el);
    if (SENSITIVE_FIELD.test(`${label} ${el.name} ${el.id} ${el.autocomplete}`)) return;
    const raw = tag === 'SELECT' ? (el.value ? el.selectedOptions[0]?.text : '') : el.value;
    const value = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (value) line += ` [${label ? `${label}: ` : ''}${value}] `;
  };

  const collectLink = (el) => {
    const href = el.getAttribute('href') || '';
    if (/^tel:/i.test(href)) phones.add(decode(href.slice(4)));
    else if (/^mailto:/i.test(href)) emails.add(decode(href.slice(7).split('?')[0]));
  };

  const walk = (node) => {
    if (size > MAX_CHARS) return;
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.nodeValue;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName.toUpperCase();
    if ((SKIP_TAGS.has(tag) && !shadowOf(el)) || isHidden(el)) return;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      emitField(el, tag);
      return;
    }
    if (tag === 'BR') {
      flush();
      return;
    }
    if (tag === 'A') collectLink(el);

    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    const shadow = shadowOf(el);
    const children = shadow
      ? shadow.tagName === 'BODY' // an inline frame: its body itself
        ? [shadow]
        : shadow.childNodes
      : tag === 'SLOT'
        ? el.assignedNodes({ flatten: true })
        : el.childNodes;
    for (const child of children) walk(child);

    if (CELL_TAGS.has(tag)) line += ' | ';
    else if (block) flush();
    else if (!INLINE_TEXT_TAGS.has(tag)) line += ' ';
  };

  const luhn = (digits) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  };

  const redact = (text) =>
    text
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN removed]')
      .replace(/(\b(?:ssn|social security(?: number| no\.?)?|soc\.? ?sec\.?)\D{0,20})\d{9}\b/gi, '$1[SSN removed]')
      .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[card number removed]' : m));

  walk(document.body || document.documentElement);
  flush();

  const selection = String(window.getSelection?.() || '').replace(/[ \t]+/g, ' ').trim();

  return {
    url: location.href,
    isTop: window === window.top,
    text: redact(lines.join('\n')).slice(0, MAX_CHARS),
    phones: [...phones].filter(Boolean).slice(0, 20),
    emails: [...emails].filter(Boolean).slice(0, 20),
    selection: redact(selection).slice(0, 5000),
  };
})();
