import { generateAccessToken, hashAccessToken } from '../modules/auth/token-service.js';
import { createDatabaseConnection } from '../db/client.js';
import { readDatabaseScriptEnvironment } from '../db/script-config.js';
import { PostgresStore } from '../store/postgres-store.js';

const externalIdFlagIndex = process.argv.indexOf('--donor-external-id');
const donorExternalId =
  externalIdFlagIndex >= 0 ? process.argv[externalIdFlagIndex + 1] : undefined;
if (!donorExternalId) {
  throw new Error('Usage: npm run dev:issue-token -- --donor-external-id <external-id>');
}

const environment = readDatabaseScriptEnvironment();
const connection = createDatabaseConnection(environment.DATABASE_URL);
const store = new PostgresStore(connection);
const rawToken = generateAccessToken();
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

try {
  await store.issueAccessToken(donorExternalId, hashAccessToken(rawToken), expiresAt);
  process.stdout.write(`${rawToken}\n`);
} finally {
  await store.close();
}
