import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'),
});
dotenv.config();

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MOCK_API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  GAME_API_WEBHOOK_URL: z.url().startsWith('http'),
  ENDOWMENT_WEBHOOK_SECRET: z.string().min(16),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:8080'),
});

export interface MockApiConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  port: number;
  webhookUrl: string;
  webhookSecret: string;
  corsOrigins: string[];
}

export function readMockApiConfig(environment: NodeJS.ProcessEnv = process.env): MockApiConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success)
    throw new Error(`Invalid Mock API configuration: ${z.prettifyError(result.error)}`);
  return {
    nodeEnv: result.data.NODE_ENV,
    logLevel: result.data.LOG_LEVEL,
    port: result.data.MOCK_API_PORT,
    webhookUrl: result.data.GAME_API_WEBHOOK_URL,
    webhookSecret: result.data.ENDOWMENT_WEBHOOK_SECRET,
    corsOrigins: result.data.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
