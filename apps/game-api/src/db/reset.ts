import { sql } from 'drizzle-orm';

import { createDatabaseConnection } from './client.js';
import { readDatabaseScriptEnvironment } from './script-config.js';

const environment = readDatabaseScriptEnvironment();

if (environment.NODE_ENV === 'production') {
  throw new Error('db:reset is disabled when NODE_ENV=production.');
}

const databaseName = new URL(environment.DATABASE_URL).pathname.replace(/^\//, '');
if (!databaseName || databaseName === 'postgres') {
  throw new Error('db:reset refuses to reset the default postgres database.');
}

const connection = createDatabaseConnection(environment.DATABASE_URL);

try {
  await connection.db.execute(sql`
    truncate table
      game_events,
      access_tokens,
      fish,
      donations,
      webhook_events,
      fish_species,
      fish_tiers,
      aquariums,
      donors
    restart identity cascade
  `);
  process.stdout.write('Development database data reset. Run npm run db:seed next.\n');
} finally {
  await connection.close();
}
