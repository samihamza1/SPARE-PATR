import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Need PostgreSQL: `pnpm test:db` (vitest.integration.config.ts) and `test:perf`.
    exclude: ['test/integration/**', 'test/perf/**'],
  },
});
