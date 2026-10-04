import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    name: 'pos',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
