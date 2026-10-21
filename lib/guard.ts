// Read-only guard for flows that run inside a customer's DMS. The promise: a run never changes
// anything there and only does the steps its flow names. The prompt says so; this enforces it in
// code. It fails closed: an action runs only when it is positively judged harmless.
//
// - No typing, dragging or double-clicking (double-click often opens an edit mode). Keys: only
//   Tab, Shift and Esc, so a focused control can't be changed with arrows or Page Up/Down.
// - Clicks are an allowlist: only controls whose name the flow lists (paging: Next, Previous, page
//   numbers; bare numbers and arrows, or an unnamed button, only inside the page's pager) can be
//   clicked, judged by the control's own accessible name. Before that, left button
//   only, no modifier keys; the pointer is moved first (hover menus can swap what's underneath),
//   then the target is inspected in the page, through frames and shadow roots, and refused anyway
//   if it, or any control around it that would also get the click, could change data: write-verb
//   names, value controls, form submit/reset buttons (including ones tied to a form elsewhere),
//   downloads, script/mail/phone links, links to any page but this one, and anything it can't
//   inspect (cross-origin or transformed frames, closed components, nothing under the pointer).
// - Scrolling is refused over controls that change value on the wheel, and over closed components.
// - Nothing at all (not even a hover) except on the flow's own pages; the run opens only the exact
//   pages it lists.
// The agent also dismisses every confirm/alert, and the network firewall (lib/firewall.ts) stops
// requests that would write to the DMS even if a click got through.
import type { Tab } from './cdp';
import { sleep } from './cdp';
import { toCss } from './geometry';
import type { ComputerAction } from './input';

export interface ReadOnly {
  /** Hosts the run may act on; subdomains included. */
  allowedHosts: string[];
  /** The flow's pages: the run opens exactly these, and acts only on them (whatever query the app adds). */
  urls: string[];
  /** The only clickable names, as a RegExp's source and flags (it crosses into the page). */
  clicks: { source: string; flags: string };
  /** POST endpoints audited as reads (lib/firewall.ts). */
  readEndpoints?: RegExp[];
}

/** A page's identity: origin and path, plus the route of a hash-routed app (#/...). Query ignored. */
export function pageKey(raw: string): string {
  const u = new URL(raw);
  const route = /^#!?\//.test(u.hash) ? u.hash.split('?')[0]!.replace(/\/+$/, '') : '';
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}${route}`;
}

/** May the run open `url` itself? Only exactly one of the flow's pages, query included: no filters of its own. */
export function urlAllowed(url: string | undefined, ro: ReadOnly): boolean {
  try {
    const want = new URL(url ?? '');
    return ro.urls.some((allowed) => {
      const a = new URL(allowed);
      return pageKey(a.href) === pageKey(want.href) && a.search === want.search;
    });
  } catch {
    return false;
  }
}

/** Is `url` one of the flow's pages (whatever query the app itself put on it)? The run acts only there. */
export function pageAllowed(url: string | undefined, ro: ReadOnly): boolean {
  try {
    const key = pageKey(url ?? '');
    return ro.urls.some((allowed) => pageKey(allowed) === key);
  } catch {
    return false;
  }
}

const SAFE_KEYS = new Set(['TAB', 'SHIFT', 'ESC', 'ESCAPE']);

export function hostAllowed(url: string | undefined, ro: ReadOnly): boolean {
  try {
    const u = new URL(url ?? '');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return ro.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Why `action` is blocked in read-only mode, or null if it may run. */
export async function blockedReason(tab: Tab, action: ComputerAction, scale: number, ro: ReadOnly): Promise<string | null> {
  if (action.type === 'wait' || action.type === 'screenshot') return null;
  const here = (await chrome.tabs.get(tab.tabId).catch(() => undefined))?.url;
  if (!hostAllowed(here, ro)) return `acting on ${hostOf(here)}, which isn't one of the DMS's sites`;
  if (!pageAllowed(here, ro)) return `acting on ${pathOf(here)}, which isn't one of this flow's pages`;
  if (action.type === 'move') return null;

  switch (action.type) {
    case 'type':
      return 'typing (this job only reads; the dealer types their own sign-in)';
    case 'drag':
      return 'dragging';
    case 'double_click':
      return 'double-clicking (it often opens an edit mode)';
    case 'keypress': {
      const keys = action.keys.flatMap((k) => k.split('+')).map((k) => k.toUpperCase().replace(/[^A-Z]/g, ''));
      return keys.every((k) => SAFE_KEYS.has(k)) ? null : `pressing ${action.keys.join('+')} (only Tab and Esc are allowed)`;
    }
    case 'scroll': {
      if (action.keys?.length) return `scrolling with ${action.keys.join('+')} held`;
      const p = toCss(action.x, action.y, scale);
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await sleep(60);
      return inspect(tab, p, 'scroll', ro);
    }
    case 'click': {
      if (action.button && action.button !== 'left') return `${action.button}-clicking`;
      if (action.keys?.length) return `clicking with ${action.keys.join('+')} held`;
      const p = toCss(action.x, action.y, scale);
      // Hover first: menus and tooltips can replace what's under the pointer before the press.
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await sleep(60);
      return inspect(tab, p, 'click', ro);
    }
  }
  return `an action Spyne Report Helper doesn't know (${(action as { type: string }).type})`;
}

async function inspect(tab: Tab, p: { x: number; y: number }, mode: 'click' | 'scroll', ro: ReadOnly): Promise<string | null> {
  try {
    const res = await tab.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: `(${inspectPoint.toString()})(${p.x}, ${p.y}, ${JSON.stringify(mode)}, ${JSON.stringify(ro.allowedHosts)}, ${JSON.stringify(ro.clicks)}, ${JSON.stringify(ro.urls.map(pageKey))})`,
      returnByValue: true,
    });
    if (res.exceptionDetails) return `a ${mode} Spyne Report Helper couldn't check (the page raised an error)`;
    const verdict = res.result?.value as { allow?: unknown; block?: unknown } | undefined;
    if (verdict?.allow === true) return null;
    return typeof verdict?.block === 'string' ? verdict.block : `a ${mode} Spyne Report Helper couldn't check`;
  } catch (e) {
    return `a ${mode} Spyne Report Helper couldn't check (${(e as Error).message})`;
  }
}

function pathOf(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    return `${u.host}${u.pathname}`;
  } catch {
    return 'this page';
  }
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').host || 'this page';
  } catch {
    return 'this page';
  }
}

/**
 * Runs in the page: what would a click (or wheel) at (x, y) reach, and is it harmless? Returns
 * { allow: true } or { block: reason }. Self-contained: it is serialised with toString().
 */
function inspectPoint(
  x: number,
  y: number,
  mode: 'click' | 'scroll',
  allowedHosts: string[],
  clicks: { source: string; flags: string },
  pages: string[],
): { allow?: true; block?: string } {
  const WRITE =
    /\b(save|submit|delete|remove|update|edit|create|add|new|send|post|approve|reject|void|finali[sz]e|complete|confirm|apply|assign|merge|archive|restore|duplicate|import|upload|pay|charge|refund|sign|book|schedule|transfer|invoice|change|reset|clear|discard|accept|decline|yes|ok|done|finish|continue|proceed|publish|share|print|email|text|call|clock|punch|dispatch|release|reopen|start|stop|log ?out|close ro|cancel ro|cancel appointment)\b/i;
  const hostOk = (host: string) => allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  // Same as pageKey() outside: origin and path, plus a hash route.
  const pageKey = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, '')}${/^#!?\//.test(u.hash) ? u.hash.split('?')[0]!.replace(/\/+$/, '') : ''}`;
  // The composed parent, the way a click bubbles: slotted content into its slot first, then up
  // through shadow roots to their host.
  const up = (n: Element): Element | null => (n as HTMLElement).assignedSlot ?? n.parentElement ?? ((n.getRootNode() as ShadowRoot).host || null);
  const style = (n: Element) => (n.ownerDocument.defaultView ?? window).getComputedStyle(n);
  // Anything but a plain shift moves the frame's content away from where its box says it is.
  const transformed = (n: Element | null) => {
    for (; n; n = up(n)) {
      const cs = style(n);
      if (cs.transform && cs.transform !== 'none' && !/^matrix\(1, 0, 0, 1, [^,]+, [^,]+\)$/.test(cs.transform)) return true;
      if ((cs.scale && cs.scale !== 'none') || (cs.rotate && cs.rotate !== 'none') || (cs.zoom && !['1', 'normal'].includes(cs.zoom))) return true;
      if (cs.offsetPath && cs.offsetPath !== 'none') return true; // a motion path moves and turns it too
    }
    return false;
  };

  // Resolve the real target through same-origin frames and open shadow roots.
  let el: Element | null = document.elementFromPoint(x, y);
  let resolved = false;
  for (let hops = 0; el && hops < 25; hops++) {
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      const frame = el as HTMLIFrameElement;
      let inner: Document | null = null;
      try {
        inner = frame.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) return { block: 'reaching into a frame Spyne Report Helper cannot inspect' };
      const r = frame.getBoundingClientRect();
      const scaled = (a: number, b: number) => b > 0 && Math.abs(a / b - 1) > 0.01;
      if (scaled(r.width, frame.offsetWidth) || scaled(r.height, frame.offsetHeight) || transformed(frame)) return { block: 'reaching into a transformed frame' };
      const cs = style(frame);
      x -= r.left + frame.clientLeft + parseFloat(cs.paddingLeft || '0');
      y -= r.top + frame.clientTop + parseFloat(cs.paddingTop || '0');
      el = inner.elementFromPoint(x, y);
      continue;
    }
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) {
      const inner = shadow.elementFromPoint(x, y);
      if (inner && inner !== el) {
        el = inner;
        continue;
      }
    }
    resolved = true;
    break;
  }
  if (!el) return { block: `a ${mode} where Spyne Report Helper found nothing to inspect` };
  if (!resolved) return { block: `a ${mode} on something nested too deeply to inspect` };

  // Everything the event reaches on its way up, shadow hosts included.
  const chain: Element[] = [];
  for (let n: Element | null = el; n && chain.length < 80; n = up(n)) chain.push(n);
  const CONTROL =
    'button, a, input, select, textarea, label, option, summary, [role=button], [role=link], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=menuitemcheckbox], [role=menuitemradio], [role=slider], [role=spinbutton], [role=combobox], [role=listbox], [role=tab], [onclick]';
  // Controls further out that would act on the same click (not plain [onclick] containers, which
  // are often whole toolbars or tables delegating events).
  const ACTIONABLE =
    'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=menuitemcheckbox], [role=menuitemradio], [role=slider], [role=spinbutton], [role=combobox], [role=listbox], [role=tab]';
  const control = (chain.find((n) => n.matches(CONTROL)) ?? el) as HTMLElement;
  const outer = chain.filter((n) => n !== control && chain.indexOf(n) > chain.indexOf(control) && n.matches(ACTIONABLE)) as HTMLElement[];

  const namesOf = (c: HTMLElement) => {
    const tag = c.tagName.toLowerCase();
    const doc = c.ownerDocument;
    const labelledBy = (c.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .join(' ');
    // A control in a shadow root shows its host's content through slots: that text is its label too.
    const slotted = [...c.querySelectorAll('slot')]
      .flatMap((sl) => sl.assignedNodes({ flatten: true }))
      .map((n) => (n as HTMLElement).innerText ?? n.textContent ?? '')
      .join(' ');
    return [labelledBy, c.getAttribute('aria-label') ?? '', c.getAttribute('title') ?? '', tag === 'input' ? (c as HTMLInputElement).value : '', `${c.innerText || c.textContent || ''} ${slotted}`]
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  };
  /** What a control's icons and images say (a trash icon labelled "Delete"): checked for write verbs too. */
  const innerLabels = (c: HTMLElement) =>
    [...c.querySelectorAll('img[alt], [aria-label], [title], svg title')]
      .map((n) => (n.tagName.toLowerCase() === 'title' ? n.textContent : (n.getAttribute('alt') ?? n.getAttribute('aria-label') ?? n.getAttribute('title'))) ?? '')
      .map((v) => v.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  /** Inside the page's pager: a pagination container within `levels` ancestors of `c`. */
  const inPager = (c: Element, levels: number) => {
    let n: Element | null = c;
    for (let i = 0; n && i <= levels; i++, n = up(n)) {
      if (/paginat|\bpager\b/i.test(`${n.getAttribute('class') ?? ''} ${n.getAttribute('aria-label') ?? ''}`)) return true;
    }
    return false;
  };
  const describe = (c: HTMLElement) => {
    const n = namesOf(c)[0];
    return n ? `"${n.slice(0, 60)}"` : `an unlabelled ${c.tagName.toLowerCase()}`;
  };
  const VALUE_ROLES = ['checkbox', 'radio', 'switch', 'option', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'combobox', 'listbox'];
  const TEXTLIKE = ['', 'text', 'search', 'email', 'tel', 'url', 'password'];
  const wheelChanges = (c: HTMLElement) => {
    const tag = c.tagName.toLowerCase();
    const role = (c.getAttribute('role') ?? '').toLowerCase();
    return tag === 'select' || (tag === 'input' && ['number', 'range'].includes((c.getAttribute('type') ?? '').toLowerCase())) || ['slider', 'spinbutton', 'listbox', 'combobox'].includes(role);
  };

  if (mode === 'scroll') {
    const over = [control, ...outer].find(wheelChanges);
    if (over) return { block: `scrolling over ${describe(over)}, which can change its value` };
    if (el.tagName.includes('-') && !(el as HTMLElement).shadowRoot && !el.childElementCount && !(el.textContent ?? '').trim()) return { block: 'scrolling over a component Spyne Report Helper cannot inspect' };
    return { allow: true };
  }

  /** Why clicking `c` could change something, or null. */
  const judge = (c: HTMLElement): string | null => {
    const tag = c.tagName.toLowerCase();
    const role = (c.getAttribute('role') ?? '').toLowerCase();
    const type = (c.getAttribute('type') ?? '').toLowerCase();
    const what = describe(c);
    if (tag === 'select' || tag === 'option' || VALUE_ROLES.includes(role)) return `changing a value (${what})`;
    if (tag === 'input') {
      if (['submit', 'reset', 'image'].includes(type)) return `clicking ${what}, which submits or resets a form`;
      if (type !== 'button' && !TEXTLIKE.includes(type)) return `changing a value (${what})`;
    }
    if (tag === 'label') {
      const target = (c as HTMLLabelElement).control as HTMLInputElement | null;
      if (target && (target.tagName !== 'INPUT' || !TEXTLIKE.includes((target.getAttribute('type') ?? '').toLowerCase()))) return `changing a value (${what})`;
    }
    if (tag === 'button') {
      const b = c as HTMLButtonElement;
      if (b.form && (b.type === 'submit' || b.type === 'reset')) return `clicking ${what}, which submits or resets a form`;
    }
    // A custom element can submit its form like a button (form-associated custom elements).
    if (tag.includes('-') && ['submit', 'reset'].includes(type)) return `clicking ${what}, which submits or resets a form`;
    if (tag === 'a') {
      const a = c as HTMLAnchorElement;
      const raw = (a.getAttribute('href') ?? '').trim();
      if (a.hasAttribute('download')) return `clicking ${what}, which downloads a file`;
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return `following ${what} (${raw.split(':')[0]}: link)`;
      if (raw && !raw.startsWith('#')) {
        let u: URL;
        try {
          u = new URL(a.href);
        } catch {
          return `following ${what}, a link Spyne Report Helper can't read`;
        }
        if (!hostOk(u.hostname.toLowerCase())) return `following ${what} off the DMS (${u.hostname})`;
        // Paging stays on this page (maybe with another query); anything else is somewhere the flow doesn't go.
        if (pageKey(u) !== pageKey(new URL(c.ownerDocument.location.href)) && !pages.includes(pageKey(u))) return `following ${what} to another page (${u.pathname})`;
      }
    }
    if ([...namesOf(c), ...innerLabels(c)].some((n) => WRITE.test(n))) return `clicking ${what}, which could change data`;
    return null;
  };
  for (const c of [control, ...outer]) {
    const why = judge(c);
    if (why) return { block: why };
  }

  // A component with no open shadow root and no surrounding control: Spyne Report Helper can't see what it does.
  if (control === el && el.tagName.includes('-') && !(el as HTMLElement).shadowRoot) return { block: 'clicking a component Spyne Report Helper cannot inspect' };

  // The allowlist: only controls the flow names (e.g. paging) may be clicked, judged by the
  // control's own accessible name. A bare number or arrow is only paging inside the page's pager
  // (elsewhere it's an RO number or a row). An icon-only pager button has no name of its own: a
  // close ancestor that names it ("Next Page" on an Ant Design item), or being an item of the
  // pager itself, says what it is.
  const allowed = new RegExp(clicks.source, clicks.flags);
  const name = namesOf(control)[0];
  if (name) {
    if (!allowed.test(name)) return { block: `clicking ${describe(control)}, which this flow doesn't need (it only pages and reads)` };
    if (/^(\d{1,4}|[‹›«»<>])$/.test(name) && !inPager(control, 6)) return { block: `clicking "${name}", which isn't part of the page's pager` };
    return { allow: true };
  }
  const near = chain.slice(chain.indexOf(control) + 1, chain.indexOf(control) + 4) as HTMLElement[];
  const named = near.some((n) => [n.getAttribute('title'), n.getAttribute('aria-label')].some((v) => !!v && allowed.test(v.trim()) && !/^\d+$/.test(v.trim())));
  if (named || inPager(control, 3)) return { allow: true };
  return { block: `clicking ${describe(control)}, which this flow doesn't need (it only pages and reads)` };
}
