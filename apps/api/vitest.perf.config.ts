import { defineConfig } from 'vitest/config';

/** Search performance on a large synthetic catalog (non-blocking CI job; ADR 0015). */
export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    // The timings are the result: always print them.
    silent: false,
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
  },
});
