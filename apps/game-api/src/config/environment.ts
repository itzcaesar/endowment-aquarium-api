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
  GAME_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.url().startsWith('postgresql://'),
  ENDOWMENT_WEBHOOK_SECRET: z.string().min(16),
  ENDOWMENT_API_BASE_URL: z.url().startsWith('http'),
  ENDOWMENT_API_TICKET: z.string().min(1),
  ENDOWMENT_API_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  ADMIN_DASHBOARD_TOKEN: z.string().min(32).optional(),
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:8080'),
});

export interface GameApiConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  port: number;
  databaseUrl: string;
  webhookSecret: string;
  endowmentApiBaseUrl: string;
  endowmentApiTicket: string;
  endowmentApiTimeoutMs: number;
  /** Enables /api/v1/admin/stats for the ops dashboard when set. */
  adminDashboardToken?: string;
  webhookTimestampToleranceSeconds: number;
  corsOrigins: string[];
}

export function readGameApiConfig(environment: NodeJS.ProcessEnv = process.env): GameApiConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid Game API configuration: ${z.prettifyError(result.error)}`);
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    logLevel: result.data.LOG_LEVEL,
    port: result.data.GAME_API_PORT,
    databaseUrl: result.data.DATABASE_URL,
    webhookSecret: result.data.ENDOWMENT_WEBHOOK_SECRET,
    endowmentApiBaseUrl: result.data.ENDOWMENT_API_BASE_URL,
    endowmentApiTicket: result.data.ENDOWMENT_API_TICKET,
    endowmentApiTimeoutMs: result.data.ENDOWMENT_API_TIMEOUT_MS,
    adminDashboardToken: result.data.ADMIN_DASHBOARD_TOKEN,
    webhookTimestampToleranceSeconds: result.data.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    corsOrigins: result.data.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
