import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Needs PostgreSQL; run by `pnpm test:db` (see vitest.integration.config.ts).
    exclude: ['test/integration/**'],
  },
});
