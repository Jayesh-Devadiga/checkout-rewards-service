import { createApp } from './app';
import { loadConfig, loadEnvFile } from './config';
import { createPool } from './db/pool';

// npm run dev / npm start
function main(): void {
  loadEnvFile();
  // Throws, and so stops the process, if the configuration is invalid.
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = createApp({ pool });

  const server = app.listen(config.port, () => {
    console.log(`Listening on http://localhost:${config.port}`);
    console.log(`API docs at http://localhost:${config.port}/docs`);
  });

  // Stop taking new requests, let running ones finish, then close the pool.
  const shutdown = (): void => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

try {
  main();
} catch (err) {
  // For example an invalid COUPON_DISCOUNT_PERCENT. Print the reason and stop.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
