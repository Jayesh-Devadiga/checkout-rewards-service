import type { Pool } from 'pg';

export type SeedProduct = {
  id: number;
  name: string;
  pricePaise: number;
  stock: number;
};

// Six products. Prices are in paise, so 64900 is Rs 649.00.
// Product 5 has a price that does not end in .00, to exercise the discount
// rounding. Product 6 has only 3 in stock, for the overselling tests.
export const seedProducts: SeedProduct[] = [
  { id: 1, name: 'Basmati Rice 5 kg', pricePaise: 64900, stock: 100 },
  { id: 2, name: 'Toor Dal 1 kg', pricePaise: 18950, stock: 80 },
  { id: 3, name: 'Filter Coffee Powder 500 g', pricePaise: 32500, stock: 50 },
  { id: 4, name: 'Coconut Oil 1 L', pricePaise: 41000, stock: 40 },
  { id: 5, name: 'Steel Water Bottle 1 L', pricePaise: 49999, stock: 25 },
  { id: 6, name: 'Brass Lamp (limited stock)', pricePaise: 249900, stock: 3 },
];

// Safe to run more than once. A product that already exists is left exactly
// as it is, so re-seeding never resets a price or refills stock.
// Returns how many products were inserted.
export async function seedDatabase(pool: Pool): Promise<number> {
  let inserted = 0;
  for (const product of seedProducts) {
    const result = await pool.query(
      `INSERT INTO products (id, name, price_paise, stock)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [product.id, product.name, product.pricePaise, product.stock],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}
