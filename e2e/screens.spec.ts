// Renders the panel's main states in light and dark for docs/ and design review.
import { chromium, expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ORIGIN, RO_RESULT, call, finished, fn, launch, signIn, start, type Session } from './harness';

const OUT = path.resolve(import.meta.dirname, '..', 'docs');

for (const scheme of ['light', 'dark'] as const) {
  test(`screens (${scheme})`, async () => {
    const s = await launch({ startPath: '/tekion/ro-list' });
    await s.panel.setViewportSize({ width: 400, height: 900 });
    await s.panel.emulateMedia({ colorScheme: scheme });
    await s.panel.waitForTimeout(400); // the intro fades in
    await s.panel.screenshot({ path: `${OUT}/start-${scheme}.png` });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.replies.push(
      call([{ type: 'wait', ms: 2500 }]),
      async () => (await gate, fn('wait_for_user', { message: "Please sign in to Tekion. I'll pick up once you're in." })),
      fn('read_page', {}),
      fn('submit_result', { ...RO_RESULT, repair_orders: FULL_LIST }),
    );
    await start(s);
    await s.panel.getByText('Wait', { exact: true }).first().waitFor();
    await s.panel.waitForTimeout(400);
    await s.panel.screenshot({ path: `${OUT}/working-${scheme}.png` });
    release();

    await s.panel.locator('[data-state="handoff"]').waitFor();
    await s.panel.waitForTimeout(300);
    await s.panel.screenshot({ path: `${OUT}/handoff-${scheme}.png` });
    await signIn(s); // signed in: Tekion returns to the list
    await finished(s, 20_000);
    await s.panel.waitForTimeout(1000); // the result fades in and the panel scrolls back to the top
    await s.panel.screenshot({ path: `${OUT}/result-${scheme}.png` });
    await s.context.close();
  });
}

// The other ends of a run, the full-size view, and the step log.
for (const scheme of ['light', 'dark'] as const) {
  test(`more screens (${scheme})`, async () => {
    const shoot = async (s: Session, name: string) => {
      await s.panel.waitForTimeout(400);
      await s.panel.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
    };
    const open = async () => {
      const s = await launch({ startPath: '/guard' });
      s.context.on('page', (p) => p.on('dialog', () => {})); // the extension answers the page's confirm(), not Playwright
      await s.panel.setViewportSize({ width: 400, height: 900 });
      await s.panel.emulateMedia({ colorScheme: scheme });
      return s;
    };

    let s = await open();
    s.replies.push(() => new Promise(() => {})); // the model never answers
    await start(s);
    await s.panel.getByRole('button', { name: 'Stop' }).click();
    await s.panel.getByText('You have control of the tab.').waitFor();
    await shoot(s, 'stopped');
    await s.context.close();

    s = await open();
    s.replies.push(async () => ({ status: 401, body: { error: { message: 'Incorrect API key provided' } } }));
    await start(s);
    await s.panel.getByText(/OpenAI rejected the API key/).waitFor({ timeout: 20_000 });
    await shoot(s, 'error');
    await s.context.close();

    // A click it's allowed (paging), a pause, then the result.
    s = await open();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.replies.push(call([{ type: 'click', button: 'left', x: 170, y: 255 }]), async () => (await gate, call([{ type: 'wait', ms: 10 }])), fn('submit_result', { ...RO_RESULT, repair_orders: FULL_LIST }));
    await start(s);
    await expect.poll(() => s.requests.length).toBe(2); // clicked, looked again, and is waiting on the model
    await s.panel.getByRole('button', { name: 'View full size' }).click();
    await s.panel.getByRole('button', { name: 'Earlier view' }).click(); // the view it clicked on
    await shoot(s, 'zoom');
    await s.panel.keyboard.press('Escape');
    release();
    await finished(s, 20_000);
    await s.panel.getByRole('button', { name: /^Steps/ }).click();
    await s.panel.getByRole('button', { name: /^Steps/ }).scrollIntoViewIfNeeded();
    await shoot(s, 'steps');
    await s.context.close();
  });
}

const FULL_LIST = [
  ['7314021', 'Open', 'Maria Lopez', '2021 Toyota Camry SE', '4T1G11AK5MU512345', 'J. Patel', '10/02/2026 8:12 AM', '10/02/2026 4:00 PM'],
  ['7314022', 'In Progress', 'Kevin Brooks', '2019 Toyota RAV4 XLE', '2T3P1RFV8KW123456', 'J. Patel', '10/02/2026 8:40 AM', '10/02/2026 2:30 PM'],
  ['7314023', 'Waiting Parts', 'Aisha Khan', '2023 Toyota Tacoma TRD', '3TMCZ5AN1PM654321', 'L. Chen', '10/01/2026 3:05 PM', '10/03/2026 12:00 PM'],
  ['7314024', 'Ready', 'Tom Nguyen', '2020 Toyota Highlander', '5TDGZRBH7LS987654', 'L. Chen', '10/01/2026 9:15 AM', '10/01/2026 5:00 PM'],
  ['7314025', 'Open', 'Priya Shah', '2022 Toyota Corolla LE', 'JTDEPMAE2NJ246810', 'R. Diaz', '10/02/2026 9:02 AM', '10/02/2026 1:00 PM'],
  ['7314026', 'Closed', 'Sam Carter', '2018 Toyota Tundra', '5TFDY5F17JX135791', 'R. Diaz', '09/30/2026 10:20 AM', '09/30/2026 3:00 PM'],
].map(([ro_number, status, customer, vehicle, vin, advisor, opened, promised]) => ({ ro_number, status, customer, vehicle, vin, advisor, opened, promised, total: null }));

// The reference front end (fe/index.html) in each state.
for (const scheme of ['light', 'dark'] as const) {
  test(`front end (${scheme})`, async () => {
    const plain = await chromium.launchPersistentContext(mkdtempSync(path.join(process.env.CLAUDE_SCRATCH ?? tmpdir(), 'vin-flow-')), { channel: 'chromium', headless: true, colorScheme: scheme, viewport: { width: 760, height: 560 } });
    const s = await launch({ panel: false });
    const bare = await plain.newPage();
    await bare.goto(`${ORIGIN}/fe?dms=tekion`);
    await bare.getByText('Install the Spyne Report Helper extension').waitFor();
    await bare.screenshot({ path: `${OUT}/fe-install-${scheme}.png` });
    await plain.close();

    const fe = await s.context.newPage();
    await fe.setViewportSize({ width: 760, height: 560 });
    await fe.emulateMedia({ colorScheme: scheme });
    await fe.goto(`${ORIGIN}/fe?dms=tekion`);
    await fe.getByText('Spyne Report Helper is installed').waitFor();
    await fe.screenshot({ path: `${OUT}/fe-ready-${scheme}.png` });
    s.replies.push(fn('wait_for_user', { message: "Please sign in to Tekion. I'll pick up once you're in." }), fn('submit_result', { ...RO_RESULT, repair_orders: FULL_LIST }));
    await fe.getByRole('button', { name: 'Start' }).click();
    await fe.getByText('Waiting for you in Tekion').waitFor();
    await fe.bringToFront();
    await fe.screenshot({ path: `${OUT}/fe-handoff-${scheme}.png` });
    await signIn(s);
    await fe.getByText('This is the data your backend would receive.').waitFor();
    await fe.screenshot({ path: `${OUT}/fe-done-${scheme}.png` });
    await s.context.close();
  });
}
