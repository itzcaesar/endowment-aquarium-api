import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema.js';

export interface DatabaseConnection {
  db: PostgresJsDatabase<typeof schema>;
  sql: Sql;
  close: () => Promise<void>;
}

function needsSsl(databaseUrl: string): boolean {
  const hostname = new URL(databaseUrl).hostname;
  return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1';
}

export function createDatabaseConnection(databaseUrl: string): DatabaseConnection {
  const sqlClient = postgres(databaseUrl, {
    max: 10,
    prepare: false,
    ssl: needsSsl(databaseUrl) ? 'require' : false,
  });

  return {
    db: drizzle(sqlClient, { schema }),
    sql: sqlClient,
    close: async () => {
      await sqlClient.end({ timeout: 5 });
    },
  };
}
