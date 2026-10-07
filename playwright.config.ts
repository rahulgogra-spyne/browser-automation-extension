import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  reporter: 'list',
  workers: 1, // the fake relay (8798) and the real one (8797) are shared, fixed ports
  // The real relay for live runs (mocked runs use the harness's fake one). Reuses the relay
  // `pnpm dev` already runs.
  webServer: { command: 'node server/relay.ts', port: 8797, reuseExistingServer: true },
});
