import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Files share one database; run them one at a time.
    fileParallelism: false,
    hookTimeout: 60_000,
  },
});
