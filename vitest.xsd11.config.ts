import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/xsd11/**/*.xsd11.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
