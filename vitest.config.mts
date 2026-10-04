import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Creates a fresh test database and applies the migrations, once per run.
    globalSetup: './test/globalSetup.ts',
    // All test files share that one database, so they run one file at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
