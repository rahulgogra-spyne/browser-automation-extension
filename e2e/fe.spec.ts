// The product's front end driving the extension: install detection, Start from the page (which
// opens the side panel and runs the flow there), progress and the result relayed back to the page.
import { chromium, expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FLOWS } from '../lib/flows';
import { ORIGIN, RESULT, RO_RESULT, debuggerAttached, fn, launch, signIn } from './harness';

test('without the extension the page asks for it', async () => {
  // Same fixture server, plain Chromium: nothing installed.
  await launch({ panel: false }).then((s) => s.context.close()); // makes sure the fixture server is up
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(process.env.CLAUDE_SCRATCH ?? tmpdir(), 'vin-flow-')), { channel: 'chromium', headless: true });
  const fe = await context.newPage();
  await fe.goto(`${ORIGIN}/fe`);
  await expect(fe.getByText('Install the VIN Flow extension')).toBeVisible();
  await expect(fe.getByRole('button', { name: 'Start' })).toBeHidden();
  await context.close();
});

test('the page detects the extension, starts the flow, and gets the handoff and the result', async () => {
  const s = await launch({ panel: false });
  const fe = await s.context.newPage();
  // The product passes the customer's DMS; the demo takes it from ?dms=.
  await fe.goto(`${ORIGIN}/fe?dms=tekion`);
  await expect(fe.getByText('VIN Flow is installed')).toBeVisible();
  await expect(fe.getByText('v0.1.0')).toBeVisible();
  await expect(fe.getByRole('heading', { name: 'Connect Tekion' })).toBeVisible();

  // Start opens the side panel (allowed: it's the page's click) and the panel runs Tekion's flow,
  // which starts signed out at the fixture's Tekion login.
  s.replies.push(fn('wait_for_user', { message: 'Please sign in to Tekion.' }), fn('submit_result', RO_RESULT));
  await fe.getByRole('button', { name: 'Start' }).click();
  await expect(fe.getByText('Waiting for you in Tekion')).toBeVisible({ timeout: 20_000 });
  await expect(fe.getByText('Please sign in to Tekion.', { exact: true })).toBeVisible();
  expect(s.requests[0].input[0].content[0].text).toContain(FLOWS.tekion.goal.split('\n')[0]);
  // The page names the tab in use, and "Go to" brings it to the front.
  await expect(fe.locator('#tab-title')).toHaveText('Tekion ARC Login');
  await fe.bringToFront();
  await fe.getByRole('button', { name: 'Go to the Tekion tab' }).click();
  await expect.poll(() => s.worker.evaluate(async (url) => (await chrome.tabs.query({ url })).at(0)?.active, `${ORIGIN}/tekion/login*`)).toBe(true);

  // The dealer signs in in the flow's tab; the run resumes by itself and the page gets the ROs.
  await signIn(s);
  await expect(fe.getByText('This is the data your backend would receive.')).toBeVisible({ timeout: 20_000 });
  await expect(fe.locator('#result')).toContainText('Lakeside Toyota');
  await expect(fe.locator('#records table tbody tr')).toHaveCount(2);
  await expect(fe.locator('#records')).toContainText('4T1G11AK5MU512345');
  // The page that pressed Start comes back to the front with the result.
  await expect.poll(() => s.worker.evaluate(async (url) => (await chrome.tabs.query({ url })).at(0)?.active, `${ORIGIN}/fe*`)).toBe(true);
  expect(await debuggerAttached(s)).toBe(false);
  await s.context.close();
});

test('Stop on the page stops the run and releases the tab', async () => {
  const s = await launch({ panel: false });
  const fe = await s.context.newPage();
  await fe.goto(`${ORIGIN}/fe?dms=tekion`);
  s.replies.push(() => new Promise(() => {})); // the model never answers
  await fe.getByRole('button', { name: 'Start' }).click();
  await expect(fe.getByText('Working in Tekion')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => s.requests.length).toBe(1);
  await fe.getByRole('button', { name: 'Stop' }).click();
  await expect(fe.getByText('You have control of the tab.')).toBeVisible({ timeout: 20_000 }); // under the Stopped heading
  expect(await debuggerAttached(s)).toBe(false);
  await s.context.close();
});

test('the DMS the product passes picks the flow, and an unsupported one gets a clear answer', async () => {
  const s = await launch({ panel: false });
  const fe = await s.context.newPage();
  await fe.goto(`${ORIGIN}/fe?dms=reynolds`);
  await expect(fe.getByText('VIN Flow is installed')).toBeVisible();
  await fe.getByRole('button', { name: 'Start' }).click();
  await expect(fe.getByText('VIN Flow doesn\'t support the DMS "reynolds" yet. Supported: Tekion, VinSolutions.')).toBeVisible();
  expect(s.requests).toHaveLength(0);

  await fe.goto(`${ORIGIN}/fe?dms=vinsolutions`);
  s.replies.push(fn('submit_result', RESULT));
  await fe.getByRole('button', { name: 'Start' }).click();
  await expect(fe.getByText('This is the data your backend would receive.')).toBeVisible({ timeout: 20_000 });
  expect(s.requests[0].input[0].content[0].text).toContain(FLOWS.vinsolutions.goal.split('\n')[0]);
  await s.context.close();
});

test('one run at a time: a second Start is refused, and a DMS that is not text gets a clear error', async () => {
  const s = await launch({ panel: false });
  const fe = await s.context.newPage();
  await fe.goto(`${ORIGIN}/fe?dms=tekion`);
  await expect(fe.getByText('VIN Flow is installed')).toBeVisible();
  // Buttons that send raw commands, clicked for real so Chrome counts the gesture.
  await fe.evaluate((id) => {
    const w = window as any;
    w.replies = [];
    const send = (cmd: object) => w.chrome.runtime.sendMessage(id, cmd, (r: unknown) => w.replies.push(r));
    const add = (label: string, onclick: () => void) => document.body.append(Object.assign(document.createElement('button'), { textContent: label, onclick }));
    add('bad dms', () => send({ type: 'start', dms: 123 }));
    add('twice', () => (send({ type: 'start', dms: 'tekion' }), send({ type: 'start', dms: 'vinsolutions' })));
  }, s.extId);
  await fe.getByRole('button', { name: 'bad dms' }).click();
  await fe.waitForFunction(() => (window as any).replies.length === 1);
  s.replies.push(() => new Promise(() => {})); // the first run never finishes
  await fe.getByRole('button', { name: 'twice' }).click();
  await fe.waitForFunction(() => (window as any).replies.length === 3);
  const replies = await fe.evaluate(() => (window as any).replies);
  expect(replies[0]).toMatchObject({ ok: false, error: expect.stringContaining('doesn\'t support the DMS "123"') });
  // The refusal answers at once; the accepted Start answers after the side panel opens.
  expect(replies.slice(1)).toEqual(expect.arrayContaining([{ ok: true }, { ok: false, error: 'A run is already starting or in progress.' }]));
  await s.context.close();
});

test("a run's progress and data go only to the tab that started it", async () => {
  const s = await launch({ panel: false });
  const a = await s.context.newPage();
  const b = await s.context.newPage();
  await a.goto(`${ORIGIN}/fe?dms=tekion`);
  await b.goto(`${ORIGIN}/fe?dms=tekion`);
  await expect(b.getByText('VIN Flow is installed')).toBeVisible();
  s.replies.push(fn('wait_for_user', { message: 'Please sign in to Tekion.' }), fn('submit_result', RO_RESULT));
  await a.bringToFront();
  await a.getByRole('button', { name: 'Start' }).click();
  await expect(a.getByText('Please sign in to Tekion.', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(b.locator('#running')).toBeVisible(); // B knows VIN Flow is busy...
  await expect(b.getByText('Please sign in to Tekion.', { exact: true })).toBeHidden(); // ...but not the details
  await signIn(s);
  await expect(a.getByText('This is the data your backend would receive.')).toBeVisible({ timeout: 20_000 });
  await expect(b.getByText('VIN Flow is installed')).toBeVisible(); // back to ready, never shown the data
  await expect(b.locator('#records')).toBeEmpty();
  await s.context.close();
});
