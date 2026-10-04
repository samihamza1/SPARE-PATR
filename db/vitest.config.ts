import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Tests share one database and create scratch databases; keep them serial.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
