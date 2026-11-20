import { createDatabaseConnection } from '../db/client.js';
import { readDatabaseScriptEnvironment } from '../db/script-config.js';
import { runCleanup } from '../modules/maintenance/cleanup.js';

const environment = readDatabaseScriptEnvironment();
const connection = createDatabaseConnection(environment.DATABASE_URL);

try {
  const removed = await runCleanup(connection.sql, new Date());
  process.stdout.write(
    `${new Date().toISOString()} cleanup removed ${removed.accessTokens} access tokens, ` +
      `${removed.endowmentLookups} Endowment lookup rows\n`,
  );
} finally {
  await connection.close();
}
