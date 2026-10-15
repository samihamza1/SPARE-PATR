import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript source, so they are bundled into the build.
// Dependencies listed in package.json (fastify, pg, ...) stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@autoparts\//],
});
