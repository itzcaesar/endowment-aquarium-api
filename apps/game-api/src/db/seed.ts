import { sql } from 'drizzle-orm';

import { createDatabaseConnection } from './client.js';
import { readDatabaseScriptEnvironment } from './script-config.js';
import { fishSpecies, fishTiers } from './schema.js';
import { speciesSeed, tierSeed } from './seed-data.js';

const environment = readDatabaseScriptEnvironment();
const connection = createDatabaseConnection(environment.DATABASE_URL);

try {
  await connection.db
    .insert(fishTiers)
    .values([...tierSeed])
    .onConflictDoUpdate({
      target: fishTiers.code,
      set: {
        name: sql`excluded.name`,
        minAmount: sql`excluded.min_amount`,
        maxAmount: sql`excluded.max_amount`,
        rarityOrder: sql`excluded.rarity_order`,
        updatedAt: new Date(),
      },
    });

  await connection.db
    .insert(fishSpecies)
    .values([...speciesSeed])
    .onConflictDoUpdate({
      target: fishSpecies.code,
      set: {
        name: sql`excluded.name`,
        defaultTierCode: sql`excluded.default_tier_code`,
        unityAssetCode: sql`excluded.unity_asset_code`,
        active: true,
        updatedAt: new Date(),
      },
    });

  process.stdout.write('Seeded four fish tiers and four fish species.\n');
} finally {
  await connection.close();
}
