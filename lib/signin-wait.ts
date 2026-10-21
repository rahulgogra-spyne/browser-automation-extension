// Waits in the CRM tab until the user has signed in. The run does not attach to the tab while the
// login page is up: holding its requests would stop the user's own sign-in from going through. It
// attaches only once the tab has settled on a page that is not a sign-in page (lib/signin.ts).
import { looksLikeSignIn } from './signin';
import { sleep } from './cdp';
import type { LogEntry } from './agent';

/** How long the run waits for the user to sign in before it gives up. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** The tab must sit on a non-sign-in page this long before the run goes on (redirects settle first). */
const SETTLE_MS = 3000;

export async function waitForSignIn(tabId: number, signal: AbortSignal, log: (e: LogEntry) => void, timeoutMs = SIGN_IN_TIMEOUT_MS): Promise<void> {
  const started = Date.now();
  let told = false;
  let since = 0;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) throw new Error('The CRM tab was closed.');
    const onApp = tab.status === 'complete' && !!tab.url && !looksLikeSignIn(tab.url);
    if (onApp) {
      if (!since) since = Date.now();
      if (Date.now() - since >= SETTLE_MS) return;
    } else {
      since = 0;
      if (!told) {
        log({ kind: 'info', text: 'Sign in to the CRM in the tab that opened. I will continue once you are in.' });
        told = true;
      }
    }
    if (Date.now() - started > timeoutMs) throw new Error('Sign-in took longer than 10 minutes.');
    await sleep(1000);
  }
}
