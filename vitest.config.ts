import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __RELAY_URL__: '"ws://127.0.0.1:8798"', __FE_MATCHES__: '[]', __E2E_START_URLS__: '{}' },
  test: { include: ['__tests__/**/*.test.ts'] },
});
