import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'),
});
dotenv.config();

const databaseScriptEnvironmentSchema = z.object({
  DATABASE_URL: z.url().startsWith('postgresql://'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export function readDatabaseScriptEnvironment() {
  const result = databaseScriptEnvironmentSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid database configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
