import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const alias = {
  '@': fileURLToPath(new URL('./web/src', import.meta.url)),
  '@modules': fileURLToPath(new URL('./modules', import.meta.url)),
  '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
  react: 'preact/compat',
  'react-dom': 'preact/compat',
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.test.ts', 'modules/*/server/**/*.test.ts', 'modules/_lib/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        plugins: [preact()],
        resolve: { alias },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/src/**/*.test.{ts,tsx}', 'modules/*/web/**/*.test.{ts,tsx}'],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
