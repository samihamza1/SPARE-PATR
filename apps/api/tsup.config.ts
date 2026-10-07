import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript source, so they are bundled into the build.
// Dependencies listed in package.json (fastify, pg, ...) stay external.
export default defineConfig({
  entry: {
    main: 'src/main.ts',
    // Uploaded files are read in a separate process started from dist/read-worker.js
    // (src/catalog/import/read.ts).
    'read-worker': 'src/catalog/import/read-worker.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@autoparts\//],
});
