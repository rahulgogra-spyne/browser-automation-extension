// Headless-browser plumbing for the server-side mapping agent: launch, sign
// in from configured steps, and an adapter that lets the shared agent
// (extension/lib/mapper/agent.js) drive Playwright pages.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hostAllowed } from '../../../extension/lib/mapper/agent.js';

// The same runtime file the extension injects, so mapped rules are checked
// by exactly the code that will run them.
export const RUNTIME_PATH = fileURLToPath(new URL('../../../extension/content/crm-runtime.js', import.meta.url));

// Uses an installed Chrome or Edge (no browser download needed).
export async function openBrowser({ headless = true, channel = process.env.MAPPER_BROWSER } = {}) {
  const tried = [];
  for (const candidate of [channel, 'chrome', 'msedge'].filter(Boolean)) {
    try {
      return await chromium.launch({ channel: candidate, headless });
    } catch (error) {
      tried.push(`${candidate}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(`No browser for the mapping agent. Install Chrome or Edge, or set MAPPER_BROWSER. Tried ${tried.join('; ')}`);
}

export async function openSession(browser, site) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript({ content: await readFile(RUNTIME_PATH, 'utf8') });
  const page = await context.newPage();
  if (site.login) await logIn(page, site.login);
  return { context, page };
}

// Runs the sign-in steps from the site registry. Credentials come from the
// environment variables the steps name (a "default" is for the local mocks).
// Step shapes: { fill, env|default }, { click }, { goto }, { wait: ms },
// { manual: "message" } (a headed run pauses so you can sign in yourself,
// for MFA or bot checks; press Enter in the terminal to continue);
// "optional": true skips a step whose element isn't there (e.g. a one-time
// "confirm your time zone" screen some CRMs show after the first sign-in).
async function logIn(page, login) {
  if (login.url) await goto(page, login.url);
  for (const step of login.steps ?? []) {
    const timeout = step.optional ? 4000 : 30_000;
    try {
      if (step.manual) await manualStep(page, step);
      if (step.goto) await goto(page, step.goto);
      if (step.wait) await page.waitForTimeout(step.wait);
      if (step.fill) {
        const value = (step.env && process.env[step.env]) || step.default;
        if (!value) throw new Error(`Login needs ${step.env} to be set.`);
        await page.fill(step.fill, value, { timeout });
      }
      if (step.click) {
        await page.click(step.click, { timeout });
        await settle(page);
      }
    } catch (error) {
      if (!step.optional) throw error;
    }
  }
  await settle(page);
  if (login.successUrlIncludes && !page.url().includes(login.successUrlIncludes)) {
    throw new Error(`Login at ${login.url} did not succeed (ended on ${page.url()}).`);
  }
}

// Pauses until Enter is pressed in the terminal (or step.timeout ms, 5 min by
// default). Without a terminal (the scheduled server) the step is skipped.
async function manualStep(page, step) {
  if (!process.stdin.isTTY) {
    console.log(`[mapper] skipping manual sign-in step (no terminal): ${step.manual}`);
    return;
  }
  console.log(`\n${step.manual}\nPress Enter here when you are signed in (browser: ${page.url()})`);
  await new Promise((resolve) => {
    const timer = setTimeout(done, step.timeout ?? 300_000);
    function done() {
      clearTimeout(timer);
      process.stdin.pause();
      process.stdin.off('data', done);
      resolve();
    }
    process.stdin.resume();
    process.stdin.once('data', done);
  });
  await settle(page);
}

// Wait for network quiet, then for the DOM to stop changing (single-page
// apps render their content well after "load").
export async function settle(page, extraMs = 300) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch {
    // long-polling pages never go idle; carry on
  }
  await Promise.all(page.frames().map((frame) => frame.evaluate(() => window.__crmRuntime?.waitQuiet({ quietMs: 1000, timeoutMs: 20000, minMs: 600 })).catch(() => null)));
  await page.waitForTimeout(extraMs);
}

export async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await settle(page);
}

// Frames worth looking at (skips blank and cross-site ad frames).
export function contentFrames(page, hosts) {
  return page.frames().filter((frame) => {
    try {
      const { host, protocol } = new URL(frame.url());
      return /^https?:$/.test(protocol) && hostAllowed(host, hosts);
    } catch {
      return false;
    }
  });
}

// The shared agent's browser adapter over one signed-in Playwright page.
export function playwrightAdapter(page, site) {
  const frames = new Map(); // id -> Frame, refreshed on every frames() call
  return {
    async open(url) {
      await goto(page, url);
      return page;
    },
    goto: (p, url) => goto(p, url),
    url: async (p) => p.url(),
    title: (p) => p.title(),
    async frames(p) {
      frames.clear();
      const out = [];
      for (const [i, frame] of contentFrames(p, site.match.hosts).entries()) {
        // A frame with no address of its own is read as part of its page.
        if (frame !== p.mainFrame() && (await frame.evaluate(() => window.__crmRuntime?.inlineFrame ?? false).catch(() => false))) continue;
        const id = `f${i}`;
        frames.set(id, frame);
        out.push({ id, url: frame.url(), main: frame === p.mainFrame() });
      }
      return out;
    },
    evaluate: (p, frameId, fn, arg) => frames.get(frameId).evaluate(fn, arg),
    settle: (p) => settle(p),
    close: async () => {},
  };
}
