// Tekion repair-order export, following the SOP (SOP - DMS Report Access Tekion). The user signs in
// to Tekion; the run takes over and drives the real screens with the mouse, the way the SOP describes:
//   waffle menu -> Services > Repair Order -> Action > Download Excel
//   and, when Tekion says more than 2,000 ROs, the RO Opened Date filter in date windows.
// Every control is found by its label and checked before it is clicked. A visible cursor shows each move.
//
// NOT TESTED LIVE YET: the account used for development shows "You do not have the permissions" on the
// RO list, so the selectors below are written from the SOP and the screens it shows. Each step reports
// the control it could not find, so a changed screen stops the run where it changed.
//
// Read-only, with the approved exception: clicks and typing are allowed for the SOP's controls only; the
// network is held to reads and to Tekion's export/search requests (no write verbs).
import { Tab, sleep, waitForSettled } from './cdp';
import { waitForSignIn } from './signin-wait';
import type { LogEntry, RunResult } from './agent';

const HOST = 'app.tekioncloud.com';
const HOME = '/home';
/** The Excel export is capped by Tekion at this many ROs per file. */
export const EXPORT_LIMIT = 2000;
/** Days in each date window when the export is over the limit. */
export const WINDOW_DAYS = 30;
/** How many windows to try, newest first. */
export const MAX_WINDOWS = 12;
/** Stop after this many empty windows in a row. */
export const EMPTY_STREAK = 3;

const WRITE_VERBS = /(delete|update|save|create|void|cancel|submit|edit|modify|remove|close|approve|send|post|book)/i;

/** Requests the run may make: GETs and POSTs on Tekion's own host that do not write. */
export function allowed(method: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.host !== HOST) return false;
  const m = method.toUpperCase();
  if (m === 'GET') return true;
  if (m === 'POST') return !WRITE_VERBS.test(u.pathname);
  return false;
}

const DATA = new Set(['XHR', 'Fetch', 'Document', 'Other', 'EventSource', 'Ping']);

export type Point = { x: number; y: number };

/** A way to find a control on the page. */
export interface Spec {
  /** Text the control shows. */
  text?: string;
  /** The text must match the whole element text, not part of it. */
  exact?: boolean;
  /** The control must sit inside a section that shows this text. */
  within?: string;
  /** A CSS selector to start from (used instead of text when given). */
  selector?: string;
  /** Pick the n-th visible match (default 0). */
  index?: number;
}

/** Runs in the Tekion page. Returns the centre of the smallest visible match, or null. */
function locatePage(spec: Spec): Point | null {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  let cands: Element[];
  if (spec.selector) cands = [...document.querySelectorAll(spec.selector)];
  else cands = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], li, label, span, div, input')];

  let matches = cands.filter(visible);
  if (spec.text) {
    const want = spec.text.toLowerCase();
    matches = matches.filter((el) => {
      const t = norm((el as HTMLElement).innerText || el.textContent).toLowerCase();
      const ok = spec.exact ? t === want : t.includes(want);
      if (!ok) return false;
      if (spec.within) {
        const section = el.closest('section, [class*="section" i], [class*="group" i], div');
        return !!section && norm((section as HTMLElement).innerText || '').toLowerCase().includes(spec.within.toLowerCase());
      }
      return true;
    });
  }
  // The smallest matching element is the control; its container also matches the text.
  matches.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
  const el = matches[spec.index ?? 0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Runs in the Tekion page: moves the visible cursor to a point. The cursor is drawn over the page, with
 * !important styles so the page's own CSS cannot hide it, and re-added if the page removes it. */
function cursorPage(x: number, y: number) {
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
    set('width', '28px');
    set('height', '28px');
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

/** The SOP's failure messages, one per place the screen can differ from what the SOP shows. */
class StepError extends Error {}

/** Opens the Tekion RO export and returns what each export produced. */
export async function collectTekionRo(o: RunOptions): Promise<RunResult> {
  const tab = new Tab(o.tabId);
  const result = (extra: Partial<RunResult>): RunResult => ({ tabId: o.tabId, openCalls: [], finalText: '', tokens: { input: 0, output: 0 }, ...extra });
  let blocked = 0;

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
    chrome.debugger.sendCommand(source, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, () => void chrome.runtime.lastError);
  };

  /** Finds a control, waiting for the screen to show it. */
  const find = async (spec: Spec, what: string, timeoutMs = 15_000): Promise<Point> => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (o.signal.aborted) throw o.signal.reason;
      const { result: r } = await tab.send<{ result: { value?: Point | null } }>('Runtime.evaluate', { expression: `(${locatePage.toString()})(${JSON.stringify(spec)})`, returnByValue: true });
      if (r.value) return r.value;
      if (Date.now() > until) throw new StepError(`Could not find "${what}" on the Tekion screen. Tekion may have changed this screen; the step stopped here.`);
      await sleep(500);
    }
  };
  /** Whether a control is on the screen right now (no waiting). */
  const seen = async (spec: Spec): Promise<boolean> => {
    const { result: r } = await tab.send<{ result: { value?: Point | null } }>('Runtime.evaluate', { expression: `(${locatePage.toString()})(${JSON.stringify(spec)})`, returnByValue: true });
    return !!r.value;
  };
  /** The real mouse's last position, so every move starts where the last one ended. */
  let mouse: Point = { x: 360, y: 240 };
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  /** Moves the mouse along a curve with easing (about 0.7 s), then clicks. The visible cursor follows the same path. */
  const tap = async (p: Point) => {
    const from = mouse;
    const steps = 32;
    const offset = Math.min(120, Math.hypot(p.x - from.x, p.y - from.y) * 0.2);
    const angle = Math.atan2(p.y - from.y, p.x - from.x) + Math.PI / 2;
    const mid: Point = { x: (from.x + p.x) / 2 + Math.cos(angle) * offset, y: (from.y + p.y) / 2 + Math.sin(angle) * offset };
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      const pt: Point = {
        x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * mid.x + t * t * p.x,
        y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * mid.y + t * t * p.y,
      };
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      await tab.send('Runtime.evaluate', { expression: `(${cursorPage.toString()})(${pt.x}, ${pt.y})`, returnByValue: true });
      await sleep(22);
    }
    mouse = p;
    await sleep(160);
    await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(70);
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(450);
  };
  const click = async (spec: Spec, what: string) => tap(await find(spec, what));
  /** Replaces the text of a field: click it, select all, delete, then type it one key at a time. */
  const typeInto = async (spec: Spec, what: string, value: string) => {
    await tap(await find(spec, what));
    const mac = await tab.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'navigator.platform.includes("Mac") ? "meta" : "ctrl"', returnByValue: true });
    const mod = mac.result.value === 'meta' ? 4 : 2;
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: mod, windowsVirtualKeyCode: 65 });
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: mod, windowsVirtualKeyCode: 65 });
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    for (const ch of value) {
      await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await sleep(70);
    }
    await sleep(250);
  };

  /** MM/DD/YYYY, which the Tekion date fields show. */
  const dateText = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

  /** Clicks Action > Download Excel, then reads what Tekion said back. */
  const exportOnce = async (): Promise<'downloaded' | 'too-many' | 'empty'> => {
    await click({ selector: '[data-testid*="action" i], [aria-label*="action" i]', text: 'Action', exact: true }, 'Action dropdown');
    await click({ text: 'Download Excel', exact: true }, 'Download Excel');
    const until = Date.now() + 30_000;
    for (;;) {
      if (o.signal.aborted) throw o.signal.reason;
      if (await seen({ text: 'Excel Downloaded' })) return 'downloaded';
      if (await seen({ text: 'can be generated for up to' })) return 'too-many';
      if (await seen({ text: 'No Results' })) return 'empty';
      if (Date.now() > until) throw new StepError('Tekion did not confirm the Excel file. Check the screen; the step stopped here.');
      await sleep(600);
    }
  };

  try {
    await chrome.tabs.update(o.tabId, { url: `https://${HOST}${HOME}` });
    await waitForSettled(o.tabId, 800, 30_000);
    await waitForSignIn(o.tabId, o.signal, o.log);
    if (o.signal.aborted) throw o.signal.reason;

    chrome.debugger.onEvent.addListener(onEvent);
    await tab.attach();
    await tab.send('Page.enable');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

    // SOP step 3: the waffle icon, top-left, next to the Tekion logo.
    o.log({ kind: 'info', text: 'Opening the Tekion menu (waffle icon)' });
    // The waffle (nine-dots) button on the Tekion header, as the page markup shows it.
    await click({ selector: '#fullViewToggle, [aria-label="icon-nine-dots-menu"]' }, 'apps (waffle) icon');

    // SOP step 4: Services > Repair Order.
    // Search the apps menu for "Repair Order" and open its card. No card means no access to it.
    o.log({ kind: 'info', text: 'Searching the apps menu for Repair Order' });
    await typeInto({ selector: 'input[placeholder="Search" i]' }, 'apps menu search', 'Repair Order');
    await sleep(800);
    try {
      await find({ text: 'Repair Order' }, 'Repair Order card', 4000);
    } catch {
      throw new StepError("You don't have access to Repair Order in Tekion. Ask the Tekion admin to grant repair-order access.");
    }
    o.log({ kind: 'info', text: 'Opening the Repair Order card' });
    await click({ text: 'Repair Order' }, 'Repair Order card');
    o.log({ kind: 'info', text: 'Reading the Repair Order list' });

    await find({ text: 'RO List' }, 'the RO List', 25_000).catch(async () => {
      if (await seen({ text: 'do not have the permissions' })) {
        throw new StepError('This Tekion user cannot open the Repair Order list ("You do not have the permissions"). Ask the Tekion admin for repair-order access.');
      }
      throw new StepError('The Repair Order list did not open.');
    });
    if (await seen({ text: 'do not have the permissions' })) {
      throw new StepError('This Tekion user cannot open the Repair Order list ("You do not have the permissions"). Ask the Tekion admin for repair-order access.');
    }
    if (await seen({ text: 'No Results' })) {
      throw new StepError('RO not found: the Repair Order list has no records for this account.');
    }

    // SOP steps 5 and 6: Action > Download Excel; Tekion allows up to 2,000 ROs per file.
    const exports: { window: string; status: string; detail: string }[] = [];
    o.log({ kind: 'info', text: 'Downloading the Repair Order Excel file' });
    const first = await exportOnce();
    if (first === 'downloaded') {
      exports.push({ window: 'all ROs', status: 'downloaded', detail: 'Excel file saved to Downloads' });
    } else if (first === 'empty') {
      throw new StepError('RO not found: the Repair Order list has no records for this account.');
    } else {
      // SOP steps 7 to 10: filter by RO Opened Date in windows, export each, until none are left.
      o.log({ kind: 'info', text: `More than ${EXPORT_LIMIT} ROs: exporting in ${WINDOW_DAYS}-day windows` });
      let empty = 0;
      const today = new Date();
      for (let i = 0; i < MAX_WINDOWS && empty < EMPTY_STREAK; i++) {
        const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i * WINDOW_DAYS);
        const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - WINDOW_DAYS);
        const label = `${dateText(start)} to ${dateText(end)}`;
        o.log({ kind: 'info', text: `Filtering RO Opened Date ${label}` });
        // SOP step 7: the filter icon, top-left inside the RO console.
        await click({ selector: '[aria-label*="filter" i], [title*="filter" i]' }, 'filter icon');
        if (await seen({ text: 'RO Opened Date' })) {
          // The filter from the last window is still there: change its two dates.
          await typeInto({ selector: 'input[placeholder="MM/DD/YYYY"]', index: 0 }, 'from date', dateText(start));
          await typeInto({ selector: 'input[placeholder="MM/DD/YYYY"]', index: 1 }, 'to date', dateText(end));
        } else {
          // SOP step 8: add the RO Opened Date filter with a from and to date.
          await click({ text: 'Add Filter', exact: false }, 'Add Filter');
          await click({ text: 'RO Opened Date' }, 'RO Opened Date field');
          await typeInto({ selector: 'input[placeholder="MM/DD/YYYY"]', index: 0 }, 'from date', dateText(start));
          await typeInto({ selector: 'input[placeholder="MM/DD/YYYY"]', index: 1 }, 'to date', dateText(end));
        }
        await click({ text: 'Apply', exact: true }, 'Apply');
        await sleep(1200);
        const outcome = await exportOnce();
        if (outcome === 'downloaded') {
          empty = 0;
          exports.push({ window: label, status: 'downloaded', detail: 'Excel file saved to Downloads' });
        } else if (outcome === 'empty') {
          empty++;
          exports.push({ window: label, status: 'empty', detail: 'no ROs in this window' });
        } else {
          exports.push({ window: label, status: 'too many', detail: `still more than ${EXPORT_LIMIT} ROs: the window needs to be shorter` });
        }
      }
    }

    const downloaded = exports.filter((e) => e.status === 'downloaded').length;
    const unavailable: string[] = [];
    if (exports.some((e) => e.status === 'too many')) unavailable.push('some windows still had more than 2,000 ROs');
    if (blocked) o.log({ kind: 'blocked', text: `Held ${blocked} request(s) the run does not need` });
    o.log({ kind: 'info', text: `Saved ${downloaded} Excel file(s) to Downloads.` });
    const summary = `${downloaded} Excel file(s) saved to Downloads. Upload them to the system.`;
    return result({ data: { exports, unavailable, summary } as unknown as Record<string, unknown>, finalText: summary });
  } catch (e) {
    if (o.signal.aborted) return result({ stopped: 'Stopped.' });
    return result({ error: (e as Error).message });
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await tab.detach();
  }
}
