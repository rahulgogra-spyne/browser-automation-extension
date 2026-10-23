// CDK inventory PDF (Modern Retail CRM > Reports > All > Inventory > Total Inventory > Print > Entire
// Inventory). The steps follow the SOP the user gave. Notes on how it works:
//  - The CRM is an iframe from crm.connectcdk.com inside the CDK Unify page. Page-level code can't see it,
//    so the run reads it through a DevTools isolated world in that frame (DOM access, not page scripts).
//  - The print window is a new tab; Page.printToPDF writes it to a PDF without the native print dialog.
//  - The PDF is returned to the side panel, which saves it to Downloads.
//
// NOT TESTED LIVE YET: the frame and the report are checked; the print icon's attributes are not (its markup
// in the frame is not readable from the top page). The run reports what it could not find.
import { Tab, sleep, waitForSettled } from './cdp';
import { waitForSignIn } from './signin-wait';
import type { LogEntry, RunResult } from './agent';

// Start on the CDK launcher: if the user is already signed in, it goes straight to the applications.
const LOGIN = 'https://launch.cdkunify.com/';
const APPS = 'https://app-unify.app.connectcdk.com/applications';
const CRM_FRAME = 'crm.connectcdk.com';
const WRITE_VERBS = /(delete|update|save|create|void|cancel|submit|edit|modify|remove|close|approve|send|post|book|lock|unlock)/i;

/** Requests the run may make: reads on the CDK hosts; writes are blocked by path. */
export function allowed(method: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/(connectcdk\.com|cdkunify\.com)$/.test(u.host)) return false;
  const m = method.toUpperCase();
  if (m === 'GET') return true;
  if (m === 'POST') return !WRITE_VERBS.test(u.pathname);
  return false;
}

const DATA = new Set(['XHR', 'Fetch', 'Document', 'Other', 'EventSource', 'Ping']);

/** A way to find a control. `scroll` brings it into view first. */
export interface Spec {
  text?: string;
  exact?: boolean;
  selector?: string;
  scroll?: boolean;
  /** Skip matches inside the sidebar (the sidebar also has an "Inventory" item). */
  notNav?: boolean;
}

/** Runs inside the page or the frame. Returns the centre of the smallest visible match, in its own viewport. */
function locateIn(spec: Spec): { x: number; y: number } | null {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  let cands: Element[] = spec.selector
    ? [...document.querySelectorAll(spec.selector)]
    : [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], li, label, span, div, img, td, input')];
  let matches = cands.filter(visible);
  // The sidebar has no nav tag. The main panel starts where its "Report Menu" banner starts (its left edge);
  // skip anything left of that. Without a banner, fall back to the right edge of the Quick Search box.
  if (spec.notNav) {
    const banner = cands
      .filter((el) => visible(el) && norm((el as HTMLElement).innerText || el.textContent).startsWith('Report Menu'))
      .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    const search = document.querySelector('input[type="search" i], input[placeholder*="search" i]');
    const mainLeft = banner ? banner.getBoundingClientRect().left - 4 : (search?.getBoundingClientRect().right ?? window.innerWidth * 0.22) + 8;
    matches = matches.filter((el) => !el.closest('nav, aside, [role="navigation"]') && el.getBoundingClientRect().left >= mainLeft);
  }
  if (spec.text) {
    const want = spec.text.toLowerCase();
    matches = matches.filter((el) => {
      const t = norm((el as HTMLElement).innerText || el.textContent).toLowerCase();
      return spec.exact ? t === want : t.includes(want);
    });
  }
  // A selector names one control, so when it matches several visible elements the largest is the one on screen
  // (a small copy of the same element can sit beside it). A text match takes the smallest element with that text.
  const area = (el: Element) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  matches.sort((a, b) => (spec.selector ? area(b) - area(a) : area(a) - area(b)));
  const el = matches[0];
  if (!el) return null;
  if (spec.scroll) (el as HTMLElement).scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Runs inside a frame: the first visible element matching the spec (scrolled into view if asked), or null. */
function elementIn(spec: Spec): Element | null {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const cands: Element[] = spec.selector
    ? [...document.querySelectorAll(spec.selector)]
    : [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], li, label, span, div, img, td, input')];
  let matches = cands.filter(visible);
  if (spec.text) {
    const want = spec.text.toLowerCase();
    matches = matches.filter((el) => {
      const t = norm((el as HTMLElement).innerText || el.textContent).toLowerCase();
      return spec.exact ? t === want : t.includes(want);
    });
  }
  // A selector names one control, so when it matches several visible elements the largest is the one on screen
  // (a small copy of the same element can sit beside it). A text match takes the smallest element with that text.
  const area = (el: Element) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  matches.sort((a, b) => (spec.selector ? area(b) - area(a) : area(a) - area(b)));
  const el = matches[0];
  if (!el) return null;
  if (spec.scroll) el.scrollIntoView({ block: 'center' });
  return el;
}

/** Runs in the top page: draws the visible cursor at a point (CSS pixels of the top viewport). */
function cursorIn(x: number, y: number) {
  let c = document.getElementById('spyne-cursor') as HTMLDivElement | null;
  if (!c) {
    c = document.createElement('div');
    c.id = 'spyne-cursor';
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M3 2l17 10-7.5 1.8L8.6 21z" fill="#4600F2" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const set = (k: string, v: string) => c!.style.setProperty(k, v, 'important');
    set('position', 'fixed');
    set('z-index', '2147483647');
    set('pointer-events', 'none');
    set('top', '0');
    set('left', '0');
    set('display', 'block');
    set('filter', 'drop-shadow(0 1px 2px rgba(0,0,0,.45))');
  }
  if (!c.isConnected) (document.body || document.documentElement).appendChild(c);
  c.style.setProperty('left', `${x}px`, 'important');
  c.style.setProperty('top', `${y}px`, 'important');
}

export interface RunOptions {
  tabId: number;
  log: (e: LogEntry) => void;
  signal: AbortSignal;
}

class StepError extends Error {}

/** Waits for the newest download that started after `since` to finish. Returns it, or throws if it fails. */
async function waitForDownload(since: number, timeoutMs: number, signal: AbortSignal): Promise<chrome.downloads.DownloadItem> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal.aborted) throw signal.reason;
    const [item] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
    if (item && Date.parse(item.startTime) >= since - 1000) {
      if (item.state === 'complete') return item;
      if (item.state === 'interrupted') throw new StepError(`The Excel download was interrupted: ${item.error ?? 'unknown error'}`);
    }
    await sleep(700);
  }
  throw new StepError('The Excel file did not finish downloading.');
}

/** Chrome's error when a frame's execution context was replaced (the CRM frame reloaded). */
const contextGone = (e: unknown) => /Cannot find context/i.test(String(e instanceof Error ? e.message : e));

/** Runs the CDK inventory PDF steps and returns the PDF (base64) for the side panel to save. */
export async function collectCdkInventory(o: RunOptions): Promise<RunResult> {
  // Every step is written to a trace; the side panel saves it as a text file after each run (cdk-run-log-*.txt).
  const trace: string[] = [];
  const note = (msg: string) => trace.push(`${new Date().toISOString()}  ${msg}`);
  const logLine = (e: LogEntry) => {
    note(e.kind === 'stage' ? `stage: ${e.stage}` : `${e.kind}: ${(e as { text?: string }).text ?? ''}`);
    o.log(e);
  };
  const tab = new Tab(o.tabId);
  const result = (extra: Partial<RunResult>): RunResult => ({ tabId: o.tabId, openCalls: [], finalText: '', tokens: { input: 0, output: 0 }, ...extra });
  let blocked = 0;
  let mouse = { x: 360, y: 240 };
  const stage = (name: 'open' | 'signin' | 'read' | 'save') => logLine({ kind: 'stage', stage: name });
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== o.tabId) return;
    if (method === 'Page.javascriptDialogOpening') {
      chrome.debugger.sendCommand(source, 'Page.handleJavaScriptDialog', { accept: false }, () => void chrome.runtime.lastError);
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    const p = params as { requestId: string; request: { url: string; method: string }; resourceType?: string };
    const judged = !p.resourceType || DATA.has(p.resourceType);
    if (!judged || allowed(p.request.method, p.request.url)) {
      chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: p.requestId }, () => void chrome.runtime.lastError);
      return;
    }
    blocked++;
    note(`blocked ${p.request.method} ${p.resourceType ?? '?'} ${(p.request.url.split('?')[0] ?? '').slice(0, 140)}`);
    chrome.debugger.sendCommand(source, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, () => void chrome.runtime.lastError);
  };

  /**
   * The CRM screen and every frame nested inside it, with the frame they sit in (parent '' = the top page).
   * The sidebar and the report menu are separate frames, so a search has to look in each of them.
   */
  const crmFrameList = async (): Promise<{ id: string; name: string; url: string; parent: string }[]> => {
    type Node = { frame: { id: string; name?: string; url: string }; childFrames?: Node[] };
    const { frameTree } = await tab.send<{ frameTree: Node }>('Page.getFrameTree');
    const list: { id: string; name: string; url: string; parent: string }[] = [];
    const add = (node: Node, parent: string) => {
      list.push({ id: node.frame.id, name: node.frame.name ?? '', url: node.frame.url, parent });
      for (const c of node.childFrames ?? []) add(c, node.frame.id);
    };
    const top = (frameTree.childFrames ?? []).find((c) => c.frame.url.includes(CRM_FRAME) && !c.frame.url.includes('about:blank'));
    if (top) add(top, '');
    return list;
  };

  /**
   * Where a frame sits on the top page. Chrome gives the <iframe> element that holds each frame (DOM.getFrameOwner),
   * which works for frames nested inside other frames too, so no src/name matching is needed. The positions of the
   * frames above it are added up to the top page.
   */
  const frameOffset = async (
    frame: { id: string; name: string; url: string; parent: string },
    byId: Map<string, { id: string; name: string; url: string; parent: string }>,
  ): Promise<{ x: number; y: number } | null> => {
    let base = { x: 0, y: 0 };
    if (frame.parent) {
      const parent = byId.get(frame.parent);
      if (!parent) return null;
      const above = await frameOffset(parent, byId);
      if (!above) return null;
      base = above;
    }
    const owner = await tab.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame.id }).catch(() => null);
    if (!owner) return null;
    const resolved = await tab.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: owner.backendNodeId }).catch(() => null);
    const objectId = resolved?.object.objectId;
    if (!objectId) return null;
    const box = await tab.send<{ model: { content: number[] } }>('DOM.getBoxModel', { objectId }).catch(() => null);
    if (!box) return null;
    const q = box.model.content as number[];
    return { x: base.x + q[0]!, y: base.y + q[1]! };
  };

  /**
   * Looks for a control in every CRM frame (the sidebar and the report menu are separate frames). A control counts
   * as found when the element exists in a frame. Its on-page position is measured too, but only to move the
   * visible cursor; it is null when the position cannot be worked out. Returns null when no frame has it.
   */
  const locateInCrm = async (spec: Spec): Promise<{ objectId: string; at: { x: number; y: number } | null } | null> => {
    const frames = await crmFrameList();
    const byId = new Map(frames.map((f) => [f.id, f]));
    for (const frame of frames) {
      const world = await tab.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'spyne-inventory' });
      const { result: r } = await tab.send<{ result: { objectId?: string } }>('Runtime.evaluate', {
        expression: `(${elementIn.toString()})(${JSON.stringify(spec)})`,
        returnByValue: false,
        contextId: world.executionContextId,
      });
      if (!r.objectId) continue;
      // The element's centre as the frame itself sees it, plus where the frame sits on the page.
      let at: { x: number; y: number } | null = null;
      const centre = await tab.send<{ result: { value?: { x: number; y: number } } }>('Runtime.callFunctionOn', {
        objectId: r.objectId,
        functionDeclaration: 'function () { const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }',
        returnByValue: true,
      }).then((c) => c.result.value).catch(() => undefined);
      const off = await frameOffset(frame, byId);
      if (!off) note(`no page offset for frame ${frame.name || frame.id} (${frame.url.slice(0, 80)})`);
      if (centre && off) at = { x: centre.x + off.x, y: centre.y + off.y };
      return { objectId: r.objectId, at };
    }
    return null;
  };

  /** Finds a control: in the CRM screen when `inCrm` (any of its frames), otherwise on the page; waits for it. */
  const find = async (spec: Spec, what: string, inCrm: boolean, timeoutMs = 15_000): Promise<{ x: number; y: number }> => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (o.signal.aborted) throw o.signal.reason;
      try {
        if (inCrm) {
          // Found in the CRM screen: the position may be unknown, the click does not need it (see click).
          if (await locateInCrm(spec)) {
            note(`found in CRM screen: ${what} ${JSON.stringify(spec)}`);
            return { x: NaN, y: NaN };
          }
        } else {
          const { result: r } = await tab.send<{ result: { value?: { x: number; y: number } | null } }>('Runtime.evaluate', {
            expression: `(${locateIn.toString()})(${JSON.stringify(spec)})`,
            returnByValue: true,
          });
          if (r.value) return r.value;
        }
      } catch (e) {
        // A frame reloaded while searching: search again on the next pass.
        if (!contextGone(e)) throw e;
      }
      if (Date.now() > until) {
        // The text on the CRM screen (every CRM frame), so a failed step shows what is actually there.
        const texts: string[] = [];
        for (const f of await crmFrameList().catch(() => [])) {
          const world = await tab.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: f.id, worldName: 'spyne-inventory' });
          const { result: d } = await tab.send<{ result: { value?: string[] } }>('Runtime.evaluate', {
            expression: `[...document.querySelectorAll('a, span, div')].filter(e => e.children.length === 0 && e.getBoundingClientRect().width > 0 && (e.textContent||'').trim()).map(e => e.textContent.trim()).filter((t, i, a) => a.indexOf(t) === i).slice(0, 60)`,
            returnByValue: true,
            contextId: world.executionContextId,
          }).catch(() => ({ result: { value: undefined } }));
          texts.push(...(d.value ?? []));
        }
        throw new StepError(`Could not find "${what}" on the CDK screen. Text on screen: ${texts.join(' | ') || 'none'}`);
      }
      await sleep(500);
    }
  };
  /** Whether a control is on the screen now (no waiting). */
  const present = async (spec: Spec): Promise<boolean> => {
    try {
      return (await locateInCrm(spec)) !== null;
    } catch (e) {
      if (!contextGone(e)) throw e;
      return false;
    }
  };
  /**
   * Scrolls the CRM main panel down by `dy` pixels with a real mouse-wheel event over the middle of the
   * CRM screen (right of the sidebar), the same thing a person's scroll does. The wheel reaches whatever
   * box the screen scrolls, so this does not depend on the page's markup.
   */
  const scrollPanel = async (dy: number) => {
    const { result: r } = await tab.send<{ result: { value?: { x: number; y: number } | null } }>('Runtime.evaluate', {
      expression: `(() => { const f = [...document.querySelectorAll('iframe')].find(i => (i.getAttribute('src') || '').includes('${CRM_FRAME}')); if (!f) return null; const b = f.getBoundingClientRect(); return { x: b.left + b.width * 0.6, y: b.top + b.height * 0.5 }; })()`,
      returnByValue: true,
    });
    if (!r.value) return;
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.value.x, y: r.value.y, deltaX: 0, deltaY: dy });
  };
  /** Whether the CRM's store dropdown shows this store as the current one (searched in every CRM frame). */
  const currentStoreIs = async (name: string): Promise<boolean> => {
    try {
      for (const frame of await crmFrameList()) {
        const world = await tab.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'spyne-inventory' });
        const { result: r } = await tab.send<{ result: { value?: boolean } }>('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector('input[data-testid="autocomplete-menu-input-field"]'); return !!el && (el.value || '').includes(${JSON.stringify(name)}); })()`,
          returnByValue: true,
          contextId: world.executionContextId,
        });
        if (r.value) return true;
      }
      return false;
    } catch (e) {
      if (!contextGone(e)) throw e;
      return false;
    }
  };
  /** Chooses a store: the cursor opens the store dropdown, then clicks the store in its list. */
  const chooseStore = async (optionText: string) => {
    // The store box is a read-only autocomplete: its input shows the current store and opens the list on click.
    await click({ selector: 'input[data-testid="autocomplete-menu-input-field"]' }, 'store dropdown', true);
    await click({ text: optionText, exact: true }, `store "${optionText}" in the list`, true);
  };
  /** Moves the mouse along a curve with easing (about 0.7 s), then clicks. The visible cursor follows. */
  /** Moves the visible cursor along a curve with easing (about 0.7 s). */
  const moveTo = async (p: { x: number; y: number }) => {
    const from = mouse;
    const steps = 32;
    const offset = Math.min(120, Math.hypot(p.x - from.x, p.y - from.y) * 0.2);
    const angle = Math.atan2(p.y - from.y, p.x - from.x) + Math.PI / 2;
    const mid = { x: (from.x + p.x) / 2 + Math.cos(angle) * offset, y: (from.y + p.y) / 2 + Math.sin(angle) * offset };
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      const pt = { x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * mid.x + t * t * p.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * mid.y + t * t * p.y };
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      await tab.send('Runtime.evaluate', { expression: `(${cursorIn.toString()})(${pt.x}, ${pt.y})`, returnByValue: true });
      await sleep(22);
    }
    mouse = p;
    await sleep(160);
  };
  /** Moves the cursor to the point and presses the mouse there (used on the top page). */
  const tap = async (p: { x: number; y: number }) => {
    await moveTo(p);
    await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(70);
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(700);
  };
  /**
   * Clicks a control inside the CRM screen. The cursor glides to it first, so the click is visible; the click
   * itself is made on the control, in its own frame, so a slightly off cursor position cannot click the wrong thing.
   */
  const click = async (spec: Spec, what: string, inCrm: boolean) => {
    if (!inCrm) {
      await tap(await find(spec, what, false));
      return;
    }
    // Wait until the control exists in the CRM screen, then move the cursor to it (if its place is known) and
    // click the element itself.
    const until = Date.now() + 25_000;
    let hit: { objectId: string; at: { x: number; y: number } | null } | null = null;
    while (!hit) {
      if (o.signal.aborted) throw o.signal.reason;
      hit = await locateInCrm(spec);
      if (hit) break;
      if (Date.now() > until) throw new StepError(`Could not find "${what}" on the CDK screen.`);
      await sleep(500);
    }
    note(`click: ${what} ${JSON.stringify(spec)} cursor=${hit.at ? `${Math.round(hit.at.x)},${Math.round(hit.at.y)}` : 'unknown'}`);
    if (hit.at) await moveTo(hit.at);
    const describe = 'function () { return { tag: this.tagName, id: this.id, title: this.getAttribute("title"), expanded: this.getAttribute("aria-expanded"), cls: this.className, accordionHeaders: this.ownerDocument.querySelectorAll(".ui-accordion-header").length, html: this.outerHTML.slice(0, 160) }; }';
    const before = await tab.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', { objectId: hit.objectId, functionDeclaration: describe, returnByValue: true });
    note(`element before ${what}: ${JSON.stringify(before.result.value)}`);
    await tab.send('Runtime.callFunctionOn', {
      objectId: hit.objectId,
      functionDeclaration: 'function () { this.scrollIntoView({ block: "center" }); this.click(); }',
      returnByValue: true,
    });
    await sleep(700);
    const after = await tab.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', { objectId: hit.objectId, functionDeclaration: describe, returnByValue: true }).catch(() => null);
    note(`element after ${what}: ${JSON.stringify(after?.result.value ?? 'element gone')}`);
  };

  try {
    // Step 1: the login page. If the user is signed in already, this passes straight through.
    stage('open');
    await chrome.tabs.update(o.tabId, { url: LOGIN });
    await waitForSettled(o.tabId, 800, 30_000);
    await sleep(900);
    stage('signin');
    await waitForSignIn(o.tabId, o.signal, o.log);
    if (o.signal.aborted) throw o.signal.reason;
    await sleep(900);

    chrome.debugger.onEvent.addListener(onEvent);
    await tab.attach();
    await tab.send('Page.enable');
    await tab.send('DOM.enable');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

    // Step 2: the applications page, the Modern Retail CRM card.
    logLine({ kind: 'info', text: 'Opening Modern Retail CRM from the applications page' });
    if (!/applications/.test((await chrome.tabs.get(o.tabId)).url ?? '')) {
      await chrome.tabs.update(o.tabId, { url: APPS });
      await waitForSettled(o.tabId, 800, 30_000);
    }
    await click({ text: 'Modern Retail CRM' }, 'Modern Retail CRM card', false);

    // Step 3: the dashboard in the CRM frame: Reports > All.
    stage('read');
    logLine({ kind: 'info', text: 'Reading the inventory report: Reports > All > Inventory > Total Inventory' });
    // The sidebar's Reports section header (the CRM's own markup; it is not a plain text match).
    const reportsHeader: Spec = { selector: 'h3.Home_LeftNavigation_MainMenu[title="Reports"]' };
    await find(reportsHeader, 'Reports in the sidebar', true, 25_000);
    // Proof of concept: the dashboard opens on Saxon Auto Group, which has no data yet. Switch to
    // Inver Grove Ford (16654), the store with data. CDK may log the session out after a store change.
    const onFord = await currentStoreIs('Inver Grove Ford');
    note(`store check: already on Inver Grove Ford? ${onFord}`);
    if (!onFord) {
      logLine({ kind: 'info', text: 'Switching the store from Saxon Auto Group to Inver Grove Ford' });
      await chooseStore('Inver Grove Ford (16654)');
      await sleep(4000);
      // Let the CRM finish re-drawing after the store change before the next click.
      await find(reportsHeader, 'the CRM after the store change', true, 40_000);
      await sleep(1500);
      if (await present({ text: 'Logging out' })) {
        throw new StepError('CDK logged the session out after the store change. Sign in again and run it again.');
      }
      await find(reportsHeader, 'the CRM after the store change', true, 40_000);
    }
    // The sidebar's Reports section and its All link, matched by the CRM's own markup:
    //   <h3 title="Reports" class="...Home_LeftNavigation_MainMenu...">  the Reports section header (toggles the list)
    //   <a onclick="goTo('Reports/ReportMenu.aspx',null,0);...">          the All link
    // Clicking the header again would close the list, so it is clicked only when All is not showing yet.
    const allLink: Spec = { selector: 'a[onclick="goTo(\'Reports/ReportMenu.aspx\',null,0);return false;"]' };
    // The header is clicked until the All link shows: a click that lands while the screen is still
    // re-rendering (after the store change) does nothing, so it is tried again.
    for (let attempt = 1; attempt <= 3 && !(await present(allLink)); attempt++) {
      note(`Reports header: try ${attempt}, All link not showing yet; requests blocked so far: ${blocked}`);
      await click(reportsHeader, 'Reports section in the sidebar', true);
      await sleep(1200);
    }
    await click(allLink, 'All link in the Reports section', true);

    // Step 4: the Report Menu (in the CRM frame). Matched by the markup the CRM uses:
    //   <tr class="SectionHeader" id="Inventory">  the Inventory group heading (click shows/hides its reports)
    //   <a href="../Reports/TotalInventory.aspx">  the Total Inventory report link
    const inventoryHeading: Spec = { selector: 'tr.SectionHeader#Inventory' };
    const totalInventory: Spec = { selector: 'a[href*="TotalInventory.aspx" i]' };
    await find(inventoryHeading, 'Inventory heading in the Report Menu', true, 30_000);
    // The group's reports are hidden until its heading is clicked. Open it only when its link is not showing.
    if (!(await present(totalInventory))) await click(inventoryHeading, 'Inventory heading', true);
    for (let i = 0; i < 12 && !(await present(totalInventory)); i++) {
      await scrollPanel(400);
      await sleep(400);
    }
    await click({ ...totalInventory, scroll: true }, 'Total Inventory report', true);
    // The report opens the Inventory Management grid.
    await find({ text: 'Inventory Management' }, 'the Total Inventory report', true, 25_000);

    // Step 5: export the grid to Excel. Matched by the export icon's markup on the grid toolbar:
    //   <img alt="export" id="exportButton">, then the dialog's <button> "Entire Inventory ...".
    // The cursor hovers and clicks it like a person would; the export then downloads straight to
    // Downloads, with no print window.
    const exportIcon: Spec = { selector: 'img#exportButton[alt="export" i]' };
    const entireInventory: Spec = { selector: 'button', text: 'Entire Inventory' };
    await click({ ...exportIcon, scroll: true }, 'Excel export icon', true);
    await find(entireInventory, 'Entire Inventory export option', true, 15_000);
    const started = Date.now();
    await click(entireInventory, 'Entire Inventory export option', true);

    // Step 6: wait for Chrome to finish saving the file to Downloads.
    logLine({ kind: 'info', text: 'Waiting for the Excel file to download' });
    const download = await waitForDownload(started, 120_000, o.signal);
    const file = download.filename.split(/[\\/]/).pop() ?? 'inventory.csv';

    stage('save');
    await sleep(900);
    const summary = `Downloaded ${file} to Downloads.`;
    if (blocked) logLine({ kind: 'blocked', text: `Held ${blocked} request(s) the run does not need` });
    logLine({ kind: 'info', text: summary });
    return result({ data: { file, summary, unavailable: [], run_log: trace.join('\n') } as unknown as Record<string, unknown>, finalText: summary });
  } catch (e) {
    note('STOPPED by the user');
    if (o.signal.aborted) return result({ stopped: 'Stopped.', data: { run_log: trace.join('\n') } as unknown as Record<string, unknown> });
    note(`FAILED: ${(e as Error).message}`);
    return result({ error: (e as Error).message, data: { run_log: trace.join('\n') } as unknown as Record<string, unknown> });
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await tab.detach();
  }
}
