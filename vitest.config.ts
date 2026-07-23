import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Only this project's tests; the working tree may hold unrelated
    // checkouts (a local llama.cpp clone, scratch dirs).
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
});