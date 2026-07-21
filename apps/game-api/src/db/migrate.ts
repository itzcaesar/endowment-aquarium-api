import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { createDatabaseConnection } from './client.js';
import { readDatabaseScriptEnvironment } from './script-config.js';

const environment = readDatabaseScriptEnvironment();
const connection = createDatabaseConnection(environment.DATABASE_URL);
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

try {
  await migrate(connection.db, { migrationsFolder });
  process.stdout.write('Database migrations completed successfully.\n');
} finally {
  await connection.close();
}
