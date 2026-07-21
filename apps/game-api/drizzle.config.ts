/// <reference types="node" />

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import process from 'node:process';

import dotenv from 'dotenv';
import { defineConfig } from 'drizzle-kit';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'),
});
dotenv.config();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/endowment_aquarium',
  },
  strict: true,
  verbose: true,
});
