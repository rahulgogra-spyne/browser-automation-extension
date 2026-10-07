// Real OpenAI calls (a few cents) through the real relay. Skipped unless OPENAI_API_KEY is set
// in .env or the environment. Run with: pnpm test:live
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { debuggerAttached, finished, flowTab, launch, signIn, start, type Session } from './harness';

const hasKey = !!process.env.OPENAI_API_KEY || /^OPENAI_API_KEY=.+$/m.test(readFileSync(path.resolve(import.meta.dirname, '..', '.env'), 'utf8'));
test.skip(!hasKey, 'No OPENAI_API_KEY in .env');
test.describe.configure({ timeout: 240_000 });

const out = (name: string, ext: string) => path.join(process.env.CLAUDE_SCRATCH ?? tmpdir(), `vin-flow-live-${name}.${ext}`);

/** Keep the panel's screenshot and transcript before anything is asserted. */
async function keep(s: Session, name: string) {
  await s.panel.screenshot({ path: out(name, 'png'), fullPage: true });
  writeFileSync(out(name, 'txt'), await s.panel.locator('main').innerText());
}

test('live: Tekion RO list: signed out -> hands over -> user signs in -> reads every RO, read only', async () => {
  const s = await launch({ mockOpenAI: false, startPath: '/tekion/ro-list' });
  const t0 = Date.now();
  await start(s);
  await expect(s.panel.locator('[data-state="handoff"]')).toBeVisible({ timeout: 60_000 });
  const handoffMs = Date.now() - t0;
  expect(await debuggerAttached(s)).toBe(false);

  const tab = flowTab(s);
  await signIn(s); // the dealer signs in; Tekion returns to the list
  await finished(s);
  console.log(`handoff after ${handoffMs}ms; whole run ${Date.now() - t0}ms; ${s.turns.length} model calls`);
  await keep(s, 'tekion');

  const result = s.panel.getByTestId('result');
  await expect(result).toContainText('Lakeside Toyota');
  const rows = result.locator('table tbody tr');
  await expect(rows).toHaveCount(6);
  await expect(result.locator('table')).toContainText('7314023');
  await expect(result.locator('table')).toContainText('5TFDY5F17JX135791');
  await expect(result.locator('table')).toContainText('Waiting Parts');
  await expect(result).toContainText(/total/i); // the hidden column is reported as unavailable
  expect(tab.url()).toBe('http://127.0.0.1:8799/tekion/ro-list'); // it didn't wander off or change anything
  await s.context.close();
});
