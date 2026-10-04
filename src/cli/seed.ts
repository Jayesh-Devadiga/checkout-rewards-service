import { loadConfig, loadEnvFile } from '../config';
import { createPool } from '../db/pool';
import { seedDatabase } from '../db/seed';

// npm run seed
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const inserted = await seedDatabase(pool);
    console.log(
      inserted > 0
        ? `Inserted ${inserted} product(s).`
        : 'Products already present. Nothing inserted.',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
