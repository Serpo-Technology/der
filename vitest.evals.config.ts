import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Behavioral eval runner: renders generated contracts and scripts real
// interactions against them. Separate config so `npm run test` never picks
// these up; they depend on stored generation results, and their failures
// grade model output rather than the codebase.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['evals/**/*.eval.tsx'],
    testTimeout: 30000,
  },
});
