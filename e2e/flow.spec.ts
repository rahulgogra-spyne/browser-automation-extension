// The fixed flow end to end, with OpenAI replaced by a fake relay with scripted replies:
// panel -> new tab -> debugger -> real input on the page -> tool outputs -> result card.
import { expect, test } from '@playwright/test';
import { FLOWS } from '../lib/flows';
import { ORIGIN, RESULT, RO_RESULT, apiHits, call, debuggerAttached, finished, flowTab, fn, launch, say, start, tabGroup } from './harness';

test('Start runs the Tekion flow in a new tab and shows the repair orders as a table', async () => {
  const s = await launch({ startPath: '/tekion/ro-list', signedIn: true });
  await expect(s.panel.getByText(FLOWS.tekion.summary)).toBeVisible();
  s.replies.push(fn('submit_result', RO_RESULT));
  await start(s);
  await expect.poll(() => tabGroup(s).then((g) => g?.title)).toMatch(/Spyne Report Helper/); // grouped as soon as the run starts
  await finished(s, 20_000);

  const result = s.panel.getByTestId('result');
  await expect(result).toContainText('Lakeside Toyota');
  await expect(result.locator('table')).toContainText('7314021');
  await expect(result.locator('table')).toContainText('2T3P1RFV8KW123456');
  await expect(result.locator('table tbody tr')).toHaveCount(2);
  expect(flowTab(s).url()).toBe(`${ORIGIN}/tekion/ro-list`);
  expect(await debuggerAttached(s)).toBe(false);

  // The request carries Tekion's goal, the result tool with Tekion's schema (nested rows strict too).
  const r = s.requests[0];
  expect(r.input[0].content[0].text).toContain(FLOWS.tekion.goal.split('\n')[0]);
  const submit = r.tools.find((t: any) => t.name === 'submit_result');
  expect(submit).toMatchObject({ strict: true, parameters: { type: 'object', required: FLOWS.tekion.result.required, additionalProperties: false } });
  expect(submit.parameters.properties.repair_orders.items).toMatchObject({ type: 'object', additionalProperties: false });
  expect(r.instructions).toContain('This run must end with submit_result');
  expect(r.input[2]).toMatchObject({ type: 'computer_call_output', output: { type: 'computer_screenshot' } });
  await s.context.close();
});

// VinSolutions no longer runs the model (lib/vinsolutions-run.ts reads through the page), so this uses Tekion.
test('picking another DMS in the panel runs that DMS flow', async () => {
  const s = await launch({ startPath: '/dashboard' });
  await s.panel.getByRole('button', { name: 'Tekion' }).click();
  await expect(s.panel.getByText(FLOWS.tekion.summary)).toBeVisible();
  s.replies.push(fn('submit_result', RO_RESULT));
  await start(s);
  await finished(s, 20_000);
  expect(s.requests[0].input[0].content[0].text).toContain(FLOWS.tekion.goal.split('\n')[0]);
  await expect(s.panel.getByTestId('result')).toContainText('Lakeside Toyota');
  await s.context.close();
});

test('signed out: hands over, resumes once the user is signed in, then submits', async () => {
  const s = await launch({ startPath: '/app' });
  s.replies.push(fn('wait_for_user', { message: 'Please sign in to VinSolutions.' }), fn('submit_result', RESULT));
  await start(s);
  await expect(s.panel.locator('[data-state="handoff"]')).toBeVisible({ timeout: 20_000 });
  await expect(s.panel.getByText('Please sign in to VinSolutions.', { exact: true })).toBeVisible();
  await expect.poll(() => debuggerAttached(s)).toBe(false);
  // The tab strip says whose turn it is, even with the panel out of sight.
  await expect.poll(() => tabGroup(s)).toEqual({ title: 'Spyne Report Helper · your turn', color: 'yellow' });
  await expect(s.panel.getByText('Waiting for you', { exact: true })).toBeVisible(); // the tab's row

  // The dealer signs in: the login page, then the app.
  const tab = flowTab(s);
  await tab.goto(`${ORIGIN}/login`);
  await s.panel.waitForTimeout(800);
  await expect(s.panel.locator('[data-state="handoff"]')).toBeVisible();
  await tab.goto(`${ORIGIN}/dashboard`);
  await finished(s, 20_000);
  await expect(s.panel.getByRole('definition').filter({ hasText: 'Lakeside Honda' })).toBeVisible();
  expect(JSON.parse(s.requests[1].input[0].output[0].text).resumed).toBe(`The page moved on to ${ORIGIN}/dashboard after the user acted.`);
  await expect.poll(() => tabGroup(s)).toEqual({ title: 'Spyne Report Helper · done', color: 'green' });
  await s.context.close();
});

// Flows are read-only (lib/guard.ts): whatever the model asks for, nothing that could change the
// dealer's data runs, and the model is told what was refused.
test('read-only guard: no typing, no data-changing clicks, no confirms, no other sites', async () => {
  const s = await launch({ startPath: '/guard' });
  // Playwright auto-dismisses dialogs on pages it watches; a listener turns that off, so the
  // extension is the only thing that can answer the confirm().
  s.context.on('page', (p) => p.on('dialog', () => {}));
  s.replies.push(
    call([
      { type: 'click', button: 'left', x: 250, y: 120 }, // into the Notes field: not something this flow needs
      { type: 'type', text: 'oops' }, // blocked
      { type: 'keypress', keys: ['ENTER'] }, // blocked
      { type: 'click', button: 'left', x: 460, y: 120 }, // Save: blocked
      { type: 'click', button: 'left', x: 110, y: 190 }, // checkbox: blocked
      { type: 'click', button: 'left', x: 350, y: 255 }, // Delete inside a web component's shadow root: blocked
      { type: 'click', button: 'left', x: 170, y: 255 }, // "Next page": allowed (paging), but its confirm() gets Cancel
      { type: 'keypress', keys: ['TAB'] }, // allowed: only Tab and Esc
      { type: 'keypress', keys: ['PAGEDOWN'] }, // blocked: arrows/Page keys can change a focused control
      { type: 'scroll', x: 560, y: 195, scroll_x: 0, scroll_y: 100 }, // over a number field: blocked
      { type: 'click', button: 'left', x: 540, y: 248 }, // javascript: link: blocked
      { type: 'click', button: 'left', x: 565, y: 305 }, // "Next" that submits a form elsewhere: blocked
      { type: 'click', button: 'left', x: 655, y: 305 }, // unlabelled icon button: blocked
      { type: 'double_click', x: 170, y: 255 }, // blocked
      { type: 'click', button: 'right', x: 170, y: 255 }, // blocked
      { type: 'click', button: 'left', x: 170, y: 360 }, // "View details": harmless-sounding, but not in this flow's allowlist
    ]),
    fn('navigate', { url: 'https://example.com/' }), // blocked
    fn('submit_result', RO_RESULT),
  );
  await start(s);
  await finished(s, 20_000);

  const tab = flowTab(s);
  await expect(tab.locator('#q')).toHaveValue('');
  expect(await tab.locator('#cb').isChecked()).toBe(false);
  await expect(tab.locator('#out')).toHaveText('kept'); // Save, the js link, the form and the icon never ran; the confirm was cancelled
  await expect(tab.locator('#num')).toHaveValue('3');
  expect(tab.url()).toBe(`${ORIGIN}/guard`);

  expect(s.requests[0].instructions).toContain('READ ONLY');
  const note = s.requests[1].input.find((i: any) => i.role === 'developer');
  expect(note.content[0].text).toMatch(/doesn't need.*typing.*ENTER.*"Save".*changing a value.*"Delete".*PAGEDOWN.*scrolling over.*javascript: link.*submits or resets a form.*unlabelled button.*double-clicking.*right-clicking.*"View details".*doesn't need/s);
  expect(JSON.parse(s.requests[2].input[0].output[0].text)).toMatchObject({ ok: false });
  await s.panel.getByRole('button', { name: /^Steps/ }).click(); // the step log is folded by default
  await expect(s.panel.getByText('Blocked clicking "Save", which could change data')).toBeVisible();
  await expect(s.panel.getByText(/Dismissed a dialog \("Delete this RO\?"\)/)).toBeVisible();
  await expect(s.panel.getByText(/Blocked opening https:\/\/example.com/)).toBeVisible();
  await s.context.close();
});

test('network firewall: only what the page loaded by itself passes; writes never reach the DMS', async () => {
  apiHits.length = 0;
  const s = await launch({ startPath: '/net' });
  s.replies.push(
    call([
      { type: 'wait', ms: 300 }, // the page's own load-time POST happens before the agent acts
      { type: 'click', button: 'left', x: 170, y: 120 }, // Next: a search POST the page never made while loading
      { type: 'click', button: 'left', x: 330, y: 120 }, // Previous: the same POST the page made itself
      { type: 'click', button: 'left', x: 490, y: 120 }, // "2": its handler POSTs an update
      { type: 'click', button: 'left', x: 650, y: 120 }, // Load more: its handler sends a PUT
      { type: 'click', button: 'left', x: 170, y: 180 }, // "3": the list's own address, but a delete in the body
      { type: 'click', button: 'left', x: 330, y: 180 }, // "4": a GraphQL mutation hidden between quoted comments
      { type: 'wait', ms: 500 },
    ]),
    fn('submit_result', RO_RESULT),
  );
  await start(s);
  await finished(s, 20_000);
  expect(apiHits).not.toContain('POST /api/ro/search'); // path names don't make a request a read
  expect(apiHits.filter((h) => h === 'POST /api/ro/feed')).toHaveLength(2); // load + Previous (page 2), not the delete
  expect(apiHits.filter((h) => h === 'POST /api/graphql')).toHaveLength(1); // the page's own query, not the mutation
  expect(apiHits).not.toContain('POST /api/ro/7314021/update');
  expect(apiHits).not.toContain('PUT /api/ro/7314021');
  await expect(flowTab(s).locator('#out')).toHaveText('put refused 403'); // refused with a 403 (final: nothing retries it later)
  const note = s.requests[1].input.find((i: any) => i.role === 'developer');
  expect(note.content[0].text).toMatch(/127.0.0.1:8799\/api\/ro\/:id\/update/);
  await s.context.close();
});

test('network firewall: frames on other sites and workers are protected too', async () => {
  apiHits.length = 0;
  const s = await launch({ startPath: '/net/frames' });
  s.replies.push(
    call([
      { type: 'wait', ms: 800 }, // the frame and the worker load their own data, under protection
      { type: 'click', button: 'left', x: 170, y: 120 }, // Next: the frame and the worker both try to write
      { type: 'wait', ms: 800 },
    ]),
    fn('submit_result', RO_RESULT),
  );
  await start(s);
  await finished(s, 20_000);
  expect(apiHits).toContain('POST /api/frame/load');
  expect(apiHits).toContain('POST /api/worker/load');
  expect(apiHits).not.toContain('POST /api/frame/write');
  expect(apiHits).not.toContain('POST /api/worker/write');
  await s.context.close();
});

test('click allowlist: slotted links, numbers outside the pager, icons that say delete; real pager items still page', async () => {
  const s = await launch({ startPath: '/guard2' });
  s.replies.push(
    call([
      { type: 'click', button: 'left', x: 160, y: 120 }, // "Next" slotted into a link that closes an RO
      { type: 'click', button: 'left', x: 320, y: 120 }, // an RO number, not a page number
      { type: 'click', button: 'left', x: 450, y: 120 }, // a pager button labelled only by a delete icon
      { type: 'click', button: 'left', x: 550, y: 120 }, // Ant Design-style "Next Page": allowed
    ]),
    fn('submit_result', RO_RESULT),
  );
  await start(s);
  await finished(s, 20_000);
  const tab = flowTab(s);
  await expect(tab.locator('#out')).toHaveText('paged');
  expect(tab.url()).toBe(`${ORIGIN}/guard2`);
  const note = s.requests[1].input.find((i: any) => i.role === 'developer');
  expect(note.content[0].text).toMatch(/"Next" to another page.*"4521", which isn't part of the page's pager.*which could change data/s);
  await s.context.close();
});

test("network firewall: a page a click lands on (not the flow's) gets no trust for its own requests", async () => {
  apiHits.length = 0;
  const s = await launch({ startPath: '/net/nav' });
  s.replies.push(call([{ type: 'click', button: 'left', x: 170, y: 120 }, { type: 'wait', ms: 800 }]), fn('submit_result', RO_RESULT));
  await start(s);
  await finished(s, 20_000);
  expect(flowTab(s).url()).toBe(`${ORIGIN}/net/detail`);
  expect(apiHits).not.toContain('POST /api/detail/lock');
  await s.context.close();
});

test('read_page returns the page text and every dropdown option, without a screenshot', async () => {
  const s = await launch({ startPath: '/dashboard' });
  s.replies.push(fn('read_page', {}), fn('submit_result', RESULT));
  await start(s);
  await finished(s, 20_000);
  const out = s.requests[1].input[0];
  expect(out.type).toBe('function_call_output');
  expect(typeof out.output).toBe('string'); // text only: reading changes nothing on screen
  const page = JSON.parse(out.output);
  expect(page.text).toContain('Signed in as Dana Reyes');
  expect(page.dropdowns).toEqual([{ label: '', selected: 'Lakeside Honda', options: ['Lakeside Honda', 'Lakeside Toyota', 'Lakeside Kia'] }]);
  await s.context.close();
});

// A password manager's inline menu is another extension's iframe: Chrome ends our debugging
// session when it appears (reporting 'target_closed') and refuses to re-attach while it's there.
test('password manager popup on the sign-in page: steps back, asks to sign in, resumes after sign-in', async () => {
  const s = await launch({ startPath: '/login', passwordManager: true });
  s.replies.push(call([{ type: 'wait', ms: 2500 }]), fn('submit_result', RESULT)); // the popup appears during the wait
  await start(s);
  await expect(s.panel.getByText(/Your password manager is showing on this page/)).toBeVisible({ timeout: 20_000 });
  expect(await debuggerAttached(s)).toBe(false);
  await flowTab(s).goto(`${ORIGIN}/dashboard`); // signed in: no popup on the app
  await finished(s, 20_000);
  await expect(s.panel.getByRole('definition').filter({ hasText: 'Lakeside Honda' })).toBeVisible();
  await expect(s.panel.getByText('The tab was closed.')).toBeHidden();
  // The pending call was answered with the page as it is now.
  expect(s.requests[1].input[0]).toMatchObject({ type: 'computer_call_output', output: { type: 'computer_screenshot' } });
  await s.context.close();
});

test('another extension popup on a normal page: asks to close it, resumes on Continue', async () => {
  const s = await launch({ startPath: '/form?pm', passwordManager: true });
  s.replies.push(call([{ type: 'wait', ms: 2500 }]), fn('submit_result', RESULT));
  await start(s);
  await expect(s.panel.getByText(/Close it, then press Continue/)).toBeVisible({ timeout: 20_000 });
  await flowTab(s).evaluate(() => document.getElementById('fake-pm')?.remove()); // the user closes the popup
  await s.panel.getByRole('button', { name: 'Continue' }).click().catch(() => {}); // may already have resumed by itself
  await finished(s, 20_000);
  await expect(s.panel.getByRole('definition').filter({ hasText: 'Lakeside Honda' })).toBeVisible();
  await s.context.close();
});

test('a model that only talks gets one reminder to submit', async () => {
  const s = await launch();
  s.replies.push(say('You are Dana Reyes at Lakeside Honda.'), fn('submit_result', RESULT));
  await start(s);
  await finished(s, 20_000);
  await expect(s.panel.getByText('Jordan Ellis', { exact: true })).toBeVisible();
  expect(s.requests[1].input[0].content[0].text).toBe('Please call submit_result with what you found.');
  await s.context.close();
});

test('Stop mid-run releases the tab, and Run again starts fresh', async () => {
  const s = await launch();
  s.replies.push(() => new Promise(() => {})); // the model never answers
  await start(s);
  await expect.poll(() => s.requests.length).toBe(1);
  await expect.poll(() => debuggerAttached(s)).toBe(true);
  await s.panel.getByRole('button', { name: 'Stop' }).click();
  await expect(s.panel.getByText('You have control of the tab.')).toBeVisible(); // under the Stopped heading
  expect(await debuggerAttached(s)).toBe(false);

  // Stop closed the socket (the API has no cancel); the next run reconnects, in a new tab, from scratch.
  s.replies.push(fn('submit_result', RESULT));
  await start(s);
  await finished(s, 20_000);
  await expect(s.panel.getByRole('definition').filter({ hasText: 'Lakeside Honda' })).toBeVisible();
  expect(s.requests[1].previous_response_id).toBeUndefined();
  await s.context.close();
});

test('closing the panel mid-run releases the tab', async () => {
  const s = await launch();
  s.replies.push(() => new Promise(() => {}));
  await start(s);
  await expect.poll(() => debuggerAttached(s)).toBe(true);
  await s.panel.close();
  await expect.poll(() => debuggerAttached(s), { timeout: 5000 }).toBe(false);
  await s.context.close();
});

test('a bad API key shows a clear error and releases the tab', async () => {
  const s = await launch();
  s.replies.push(async () => ({ status: 401, body: { error: { message: 'Incorrect API key provided' } } }));
  await start(s);
  await expect(s.panel.getByText(/OpenAI rejected the API key/)).toBeVisible({ timeout: 20_000 });
  expect(await debuggerAttached(s)).toBe(false);
  await s.context.close();
});
