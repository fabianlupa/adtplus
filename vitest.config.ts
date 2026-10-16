import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The daemon logs by default; tests that want a log set their own file.
    env: { ADTPLUS_LOG: '0' },
  },
});
