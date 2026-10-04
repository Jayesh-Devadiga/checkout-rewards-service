import { loadConfig, loadEnvFile } from '../config';
import { runMigrations } from '../db/migrate';
import { createPool } from '../db/pool';

// npm run migrate
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const applied = await runMigrations(pool);
    console.log(
      applied.length > 0
        ? `Applied: ${applied.join(', ')}`
        : 'Database is up to date. Nothing to apply.',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
