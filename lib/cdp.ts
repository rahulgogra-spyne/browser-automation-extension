// Thin promise wrapper over chrome.debugger for one tab.
import { shotSize } from './geometry';

const COMMAND_TIMEOUT_MS = 20_000;

/**
 * Read-only protection couldn't be switched on, or a blocked request couldn't be stopped. Never
 * absorbed as an ordinary action failure: the run ends, and nothing more happens on the page.
 */
export class ProtectionLost extends Error {}

export class Tab {
  readonly target: chrome.debugger.Debuggee;
  /**
   * Called when a command finds the session gone while the tab lives on (another extension's
   * frame appeared in the page, a process swap). Resolves once we're attached again.
   */
  onLost?: () => Promise<void>;
  /** Bumped on every regain: work planned against the page before then may be stale. */
  generation = 0;
  constructor(readonly tabId: number) {
    this.target = { tabId };
  }

  attach(): Promise<void> {
    return new Promise((resolve, reject) =>
      chrome.debugger.attach(this.target, '1.3', () => {
        const err = chrome.runtime.lastError;
        if (!err) return resolve();
        reject(
          new Error(
            /already attached/i.test(err.message ?? '')
              ? 'This tab is already being debugged (DevTools or another extension). Close that and try again.'
              : err.message,
          ),
        );
      }),
    );
  }

  detach(): Promise<void> {
    return new Promise((resolve) =>
      chrome.debugger.detach(this.target, () => {
        void chrome.runtime.lastError; // already detached is fine
        resolve();
      }),
    );
  }

  /** CDP command with a timeout; if the session was lost, wait to regain it and try once more. */
  async send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    try {
      return await this.sendOnce<T>(method, params, timeoutMs);
    } catch (e) {
      // Lost: the session ended, or a frame Chrome won't let us touch (another extension's) appeared.
      if (!this.onLost || !/not attached|detached while handling|URL of different extension/i.test((e as Error).message)) throw e;
      await this.onLost();
      this.generation++;
      // Reads are safe to repeat; input planned against the page as it was is not.
      if (method.startsWith('Input.')) throw new Error('Skipped: the page was out of reach for a moment.');
      return this.sendOnce<T>(method, params, timeoutMs);
    }
  }

  /**
   * One attempt, never waiting to regain a lost session: for event handlers (dialogs, the
   * firewall). `sessionId` addresses a child session (an out-of-process frame, a worker).
   * Resolves to Chrome's error, or null if it worked.
   */
  fire(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<string | null> {
    return this.sendOnce(method, params, COMMAND_TIMEOUT_MS, sessionId).then(
      () => null,
      (e: Error) => e.message,
    );
  }

  /** A command to a child session, no regaining: it ends with the root session anyway. */
  sendChild<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>): Promise<T> {
    return this.sendOnce<T>(method, params, COMMAND_TIMEOUT_MS, sessionId);
  }

  /** CDP command with a timeout, so a wedged page can never hang the run forever. */
  private sendOnce<T>(method: string, params?: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS, sessionId?: string): Promise<T> {
    const target: chrome.debugger.DebuggerSession = sessionId ? { tabId: this.tabId, sessionId } : this.target;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      chrome.debugger.sendCommand(target, method, params, (result) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        err ? reject(new Error(`${method}: ${err.message}`)) : resolve(result as T);
      });
    });
  }

  /** Background tabs don't paint, so screenshots of them stall. Keep the driven tab in front. */
  async bringToFront(): Promise<void> {
    const tab = await chrome.tabs.get(this.tabId);
    if (!tab.active) await chrome.tabs.update(this.tabId, { active: true });
  }

  /** JPEG in CSS pixels (capped), plus the scale from CSS px to screenshot px. */
  async screenshot(): Promise<Screenshot> {
    await this.bringToFront();
    const metrics = await this.send<{ cssVisualViewport: { clientWidth: number } }>('Page.getLayoutMetrics');
    const cssW = Math.round(metrics.cssVisualViewport.clientWidth);
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true });

    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const { scale, width, height } = shotSize(cssW, bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    // JPEG: a fraction of PNG's size on real pages (faster to encode and upload), text stays legible.
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return { dataUrl: await blobToDataUrl(blob), scale, width, height };
  }
}

export interface Screenshot {
  dataUrl: string;
  scale: number;
  width: number;
  height: number;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Pages Chrome never lets an extension debug. */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return (
    /^(chrome|chrome-extension|chrome-search|chrome-untrusted|edge|about|devtools|view-source|file):/i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com/i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore/i.test(url)
  );
}

/** A tab with nothing in it yet. The agent can start here and navigate away. */
export function isEmptyTab(url: string | undefined): boolean {
  return !!url && /^(about:blank|chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?|chrome-search:\/\/local-ntp)/i.test(url);
}

export async function waitForLoad(tabId: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.status === 'complete') return;
    await sleep(150);
  }
}

/**
 * Wait until the tab has finished loading and its URL has stopped changing for `quietMs`.
 * SSO and app shells bounce through several redirects after the first load completes
 * (VinSolutions: four hosts); a screenshot mid-bounce costs a whole extra model turn.
 */
export async function waitForSettled(tabId: number, quietMs = 600, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  let last = '';
  let since = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) return;
    const state = `${tab.status} ${tab.url}`;
    if (state !== last) [last, since] = [state, Date.now()];
    else if (tab.status === 'complete' && Date.now() - since >= quietMs) return;
    await sleep(100);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
